-- Claude account pool: the pre-deploy report (spec 15.1). Strictly read-only.
--
-- Run it against production before deploying the account pool release, and
-- keep its output with the release:
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/ai-account-pool-report.sql > ai-account-pool-report.txt
--
-- Every statement is a SELECT inside one READ ONLY, REPEATABLE READ
-- transaction that ends with ROLLBACK, so the report cannot write anything,
-- even by mistake, and all sections see the same snapshot. Timeouts keep it
-- from waiting behind other work. It runs on the current schema (the host
-- pool tables of migration 0308) and on the upgraded one. It never reads
-- credential material: e-mail hints are masked, and the company pool match
-- compares stored hashes without printing them.
--
-- In local_trusted mode the local board user counts as a member of every
-- company, so section 8 can be ignored for its accounts.
--
-- Two checks are not SQL:
-- - The binding backfill dry run (spec 15.3): the rehearsal script. Copy
--   production with a read-only pg_dump (not a built-in backup, whose format
--   keeps no CHECK constraints) into a throwaway database whose name contains
--   "rehearsal" or "snapshot", then run, from /app in the new image:
--
--     PAPERCLIP_REHEARSAL_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<name> PAPERCLIP_DEPLOYMENT_MODE=<production's mode> node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/scripts/ai-account-pool-rehearsal.js --snapshot > ai-account-pool-rehearsal.json
--
--   It applies the migrations and the binding backfill to that copy only,
--   never reads DATABASE_URL, and starts no scheduler, heartbeat, plugin
--   worker or HTTP server. It prints the migration report: the proposed
--   bindings, the skips, the agents left unassigned or unbound with a
--   review note, the over-cap devices, and the go/no-go (exit code 0 go,
--   2 no-go, 1 error or refusal). Section 10 lists the agents the go/no-go
--   covers: each must plan to use its account, or only wait for its own
--   account's limit. The Upgrade Guide in
--   releases/fork-claude-account-pool.md has the full procedure.
-- - Plugin devices. An environment driver plugin keeps its own device owners
--   and project ticks, and reports them itself. Section 9 lists what the core
--   sees: sandbox environments, the agents pinned to them, the projects that
--   use them as their default, and the projects their runs worked on in the
--   last 14 days, to compare with those ticks.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;

SELECT
  '0 report' AS section,
  now() AS report_time,
  current_database() AS database,
  set_config('statement_timeout', '120s', true) AS statement_timeout,
  set_config('lock_timeout', '5s', true) AS lock_timeout;

-- 1. Accounts: creator, masked e-mail hint, host, status, pool flag and
-- reservations. The creator becomes the owner at deploy (0310); an account
-- without a creator has no owner and is usable nowhere until an instance
-- admin transfers it.
SELECT
  '1 accounts' AS section,
  a.id AS account_id,
  a.label,
  a.credential_type,
  a.created_by_user_id AS creator_user_id,
  creator.name AS creator_name,
  CASE
    WHEN a.email_hint IS NULL OR btrim(a.email_hint) = '' THEN NULL
    WHEN position('@' IN btrim(a.email_hint)) = 0 THEN left(btrim(a.email_hint), 2) || '***'
    ELSE left(split_part(btrim(a.email_hint), '@', 1), 2) || '***@' || split_part(btrim(a.email_hint), '@', 2)
  END AS email_hint_masked,
  h.name AS host,
  h.kind AS host_kind,
  a.status,
  a.pool_enabled,
  CASE
    WHEN a.status = 'active' AND NOT a.pool_enabled THEN 'becomes disabled (its owner can resume it)'
    WHEN a.status = 'auth_failed' THEN 'signed out (its owner must replace the token)'
  END AS at_deploy,
  a.exhausted_until,
  a.limit_reason,
  a.last_used_at,
  coalesce((
    SELECT string_agg(p.name || ' (' || c.name || ')', ', ' ORDER BY c.name, p.name)
    FROM ai_account_projects ap
    JOIN projects p ON p.id = ap.project_id
    JOIN companies c ON c.id = p.company_id
    WHERE ap.account_id = a.id
  ), '') AS reserved_for_projects
FROM ai_accounts a
LEFT JOIN ai_account_hosts h ON h.id = a.host_id
LEFT JOIN "user" creator ON creator.id = a.created_by_user_id
ORDER BY h.name NULLS LAST, a.label, a.id;

-- 2. Hosts with their environment mappings, host:port and the device key
-- that 0310 derives ('local', or 'ssh:<lower host>:<port>').
SELECT
  '2 hosts' AS section,
  h.id AS host_id,
  h.name AS host,
  h.kind,
  h.max_accounts,
  (SELECT count(*)::int FROM ai_accounts a WHERE a.host_id = h.id) AS accounts,
  (SELECT count(*)::int FROM ai_accounts a WHERE a.host_id = h.id AND a.pool_enabled AND a.status = 'active') AS usable_accounts,
  e.id AS environment_id,
  e.name AS environment,
  e.driver,
  e.status AS environment_status,
  CASE WHEN e.driver = 'ssh' THEN btrim(e.config ->> 'host') END AS ssh_host,
  CASE WHEN e.driver = 'ssh' THEN coalesce(nullif(btrim(e.config ->> 'port'), ''), '22') END AS ssh_port,
  CASE
    WHEN e.driver = 'local' THEN 'local'
    WHEN e.driver = 'ssh'
      AND btrim(coalesce(e.config ->> 'host', '')) <> ''
      AND coalesce(nullif(btrim(e.config ->> 'port'), ''), '22') ~ '^[0-9]{1,5}$'
    THEN 'ssh:' || lower(btrim(e.config ->> 'host')) || ':' || coalesce(nullif(btrim(e.config ->> 'port'), ''), '22')::integer::text
  END AS derived_device_key
FROM ai_account_hosts h
LEFT JOIN ai_account_host_environments m ON m.host_id = h.id
LEFT JOIN environments e ON e.id = m.environment_id
ORDER BY h.name, e.name;

-- 3. Device key conflicts: hosts that 0310 leaves without a key. Their
-- mapped environments still reach them; a new SSH environment on the same
-- machine would get a device of its own until an instance admin maps it.
WITH keyed AS (
  SELECT
    m.host_id,
    CASE
      WHEN btrim(coalesce(e.config ->> 'host', '')) <> ''
        AND coalesce(nullif(btrim(e.config ->> 'port'), ''), '22') ~ '^[0-9]{1,5}$'
      THEN 'ssh:' || lower(btrim(e.config ->> 'host')) || ':' || coalesce(nullif(btrim(e.config ->> 'port'), ''), '22')::integer::text
    END AS device_key
  FROM ai_account_host_environments m
  JOIN ai_account_hosts h ON h.id = m.host_id
  JOIN environments e ON e.id = m.environment_id
  WHERE e.driver = 'ssh' AND h.kind IN ('ssh_host', 'mac')
), per_host AS (
  SELECT host_id, count(*) AS environments, count(device_key) AS keyed, count(DISTINCT device_key) AS keys, min(device_key) AS device_key
  FROM keyed
  GROUP BY host_id
), claims AS (
  SELECT device_key, count(*) AS hosts
  FROM per_host
  WHERE keyed = environments AND keys = 1
  GROUP BY device_key
)
SELECT
  '3 device key conflicts' AS section,
  h.name AS host,
  h.kind,
  CASE
    WHEN p.keyed < p.environments THEN 'an SSH environment has no usable host or port'
    WHEN p.keys > 1 THEN 'its SSH environments reach different host:port pairs'
    ELSE 'another host claims the same host:port'
  END AS conflict,
  p.device_key
FROM per_host p
JOIN ai_account_hosts h ON h.id = p.host_id
LEFT JOIN claims c ON c.device_key = p.device_key
WHERE p.keyed < p.environments OR p.keys > 1 OR c.hosts > 1
ORDER BY h.name;

-- 4. Agents with host-pool runs in the last 45 days: runs per attribution
-- scope, the environment drivers and devices they ran on. Overflow runs do
-- not count as history; an agent with only overflow runs gets no account
-- from its own history.
SELECT
  '4 host-pool agents (45 days)' AS section,
  c.name AS company,
  a.name AS agent,
  a.id AS agent_id,
  a.adapter_type,
  a.status,
  CASE WHEN jsonb_typeof(a.runtime_config -> 'aiConnection') = 'object' THEN a.runtime_config -> 'aiConnection' ->> 'mode' END AS ai_connection_mode,
  (count(*) FILTER (WHERE r.context_snapshot -> 'aiConnection' ->> 'scope' = 'project'))::int AS project_runs,
  (count(*) FILTER (WHERE r.context_snapshot -> 'aiConnection' ->> 'scope' = 'shared'))::int AS shared_runs,
  (count(*) FILTER (WHERE r.context_snapshot -> 'aiConnection' ->> 'scope' = 'overflow'))::int AS overflow_runs,
  (count(*) FILTER (WHERE coalesce(r.context_snapshot -> 'aiConnection' ->> 'scope', '') NOT IN ('project', 'shared', 'overflow')))::int AS other_runs,
  string_agg(DISTINCT coalesce(e.driver, 'unknown'), ', ') AS environment_drivers,
  string_agg(DISTINCT coalesce(h.name, r.context_snapshot -> 'aiConnection' ->> 'hostName', 'unknown'), ', ') AS devices,
  max(r.created_at) AS last_run_at
FROM heartbeat_runs r
JOIN agents a ON a.id = r.agent_id AND a.company_id = r.company_id
JOIN companies c ON c.id = r.company_id
LEFT JOIN ai_account_hosts h ON h.id::text = r.context_snapshot -> 'aiConnection' ->> 'hostId'
LEFT JOIN LATERAL (
  SELECT l.environment_id
  FROM environment_leases l
  WHERE l.heartbeat_run_id = r.id
  ORDER BY l.created_at DESC
  LIMIT 1
) lease ON true
LEFT JOIN environments e ON e.id = lease.environment_id
WHERE r.created_at >= now() - interval '45 days'
  AND r.context_snapshot -> 'aiConnection' ->> 'mode' = 'host_pool'
GROUP BY c.id, a.id
ORDER BY c.name, a.name, a.id;

-- 5. Host-pool history per agent and account (45 days, overflow excluded):
-- what the backfill's "the account this agent used most" rule reads.
SELECT
  '5 history by account' AS section,
  c.name AS company,
  a.name AS agent,
  coalesce(acc.label, '(removed account)') AS account,
  acc.created_at AS account_created_at,
  h.name AS device,
  count(*)::int AS runs,
  max(r.created_at) AS last_run_at
FROM heartbeat_runs r
JOIN agents a ON a.id = r.agent_id AND a.company_id = r.company_id
JOIN companies c ON c.id = r.company_id
LEFT JOIN ai_accounts acc ON acc.id::text = r.context_snapshot -> 'aiConnection' ->> 'accountId'
LEFT JOIN ai_account_hosts h ON h.id::text = r.context_snapshot -> 'aiConnection' ->> 'hostId'
WHERE r.created_at >= now() - interval '45 days'
  AND r.context_snapshot -> 'aiConnection' ->> 'mode' = 'host_pool'
  AND r.context_snapshot -> 'aiConnection' ->> 'scope' IN ('project', 'shared')
GROUP BY c.id, a.id, acc.id, h.id
ORDER BY c.name, a.name, runs DESC, acc.created_at;

-- 6. Company pool agents and their pool members, with the pool account that
-- holds the same credential (the backfill binds to it when the member was
-- the one the agent used last, else to the first member's).
SELECT
  '6 company pool agents' AS section,
  c.name AS company,
  a.name AS agent,
  a.id AS agent_id,
  a.status,
  m.priority,
  tc.name AS connection,
  g.kind AS grant_kind,
  g.status AS grant_status,
  (
    SELECT max(r.created_at)
    FROM heartbeat_runs r
    WHERE r.agent_id = a.id
      AND r.company_id = a.company_id
      AND r.created_at >= now() - interval '45 days'
      AND r.context_snapshot -> 'aiConnection' ->> 'mode' = 'company_pool'
      AND r.context_snapshot -> 'aiConnection' ->> 'connectionId' = m.connection_id::text
  ) AS last_used_at,
  acc.label AS matching_pool_account,
  acc.created_by_user_id AS matching_account_creator
FROM agents a
JOIN companies c ON c.id = a.company_id
LEFT JOIN ai_connection_pool_members m
  ON m.company_id = a.company_id
  AND m.provider = coalesce(a.runtime_config -> 'aiConnection' ->> 'provider', 'anthropic')
LEFT JOIN tool_connections tc ON tc.company_id = m.company_id AND tc.id = m.connection_id
LEFT JOIN connection_grants g ON g.company_id = m.company_id AND g.id = m.grant_id
LEFT JOIN LATERAL (
  SELECT v.value_sha256
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(g.credential_secret_refs) = 'array' THEN g.credential_secret_refs ELSE '[]'::jsonb END) AS ref
  JOIN company_secrets s ON s.id::text = ref ->> 'secretId' AND s.company_id = g.company_id AND s.deleted_at IS NULL
  JOIN company_secret_versions v
    ON v.secret_id = s.id
    AND v.version = CASE WHEN ref ->> 'versionSelector' ~ '^[0-9]+$' THEN (ref ->> 'versionSelector')::integer ELSE s.latest_version END
  WHERE ref ->> 'configPath' = 'ai.credential'
  LIMIT 1
) credential ON true
LEFT JOIN ai_accounts acc ON acc.credential_fingerprint = credential.value_sha256
WHERE a.status <> 'terminated'
  AND a.runtime_config -> 'aiConnection' ->> 'mode' = 'company_pool'
ORDER BY c.name, a.name, m.priority;

-- 7. Each account creator's active memberships, per company. An account is
-- usable only in the companies where its owner is an active member.
SELECT
  '7 owner memberships' AS section,
  o.user_id AS owner_user_id,
  u.name AS owner_name,
  c.name AS company,
  m.membership_role
FROM (SELECT DISTINCT created_by_user_id AS user_id FROM ai_accounts WHERE created_by_user_id IS NOT NULL) AS o
LEFT JOIN "user" u ON u.id = o.user_id
LEFT JOIN company_memberships m
  ON m.principal_type = 'user'
  AND m.principal_id = o.user_id
  AND m.status = 'active'
LEFT JOIN companies c ON c.id = m.company_id
ORDER BY u.name, o.user_id, c.name;

-- 8. Accounts that ran a company's host-pool work in the last 45 days but
-- whose owner is not an active member there: those agents would wait as
-- owner_not_member. Add the owner to the company, or transfer the account.
SELECT DISTINCT
  '8 accounts used outside their owner''s companies' AS section,
  c.name AS company,
  acc.label AS account,
  acc.created_by_user_id AS owner_user_id,
  CASE
    WHEN acc.created_by_user_id IS NULL THEN 'the account has no owner'
    ELSE 'its owner is not an active member of this company'
  END AS problem
FROM heartbeat_runs r
JOIN companies c ON c.id = r.company_id
JOIN ai_accounts acc ON acc.id::text = r.context_snapshot -> 'aiConnection' ->> 'accountId'
WHERE r.created_at >= now() - interval '45 days'
  AND r.context_snapshot -> 'aiConnection' ->> 'mode' = 'host_pool'
  AND NOT EXISTS (
    SELECT 1
    FROM company_memberships m
    WHERE m.company_id = r.company_id
      AND m.principal_type = 'user'
      AND m.principal_id = acc.created_by_user_id
      AND m.status = 'active'
  )
ORDER BY company, account;

-- 9. Sandbox environments (plugin devices): the agents pinned to them, the
-- projects that use them as their default, and the projects their runs worked
-- on in the last 14 days. The backfill runs at boot, before any plugin reports
-- its devices, so an unpinned Claude agent with host-pool history in a company
-- that has such a project default is left unassigned ("cannot tell which
-- device the environment runs on") until the plugin reports; re-run the
-- backfill after that report.
SELECT
  '9 sandbox environments' AS section,
  e.config ->> 'provider' AS provider,
  e.name AS environment,
  e.status,
  (
    SELECT string_agg(pa.name || ' (' || pc.name || ')', ', ' ORDER BY pc.name, pa.name)
    FROM agents pa
    JOIN companies pc ON pc.id = pa.company_id
    WHERE pa.default_environment_id = e.id AND pa.status <> 'terminated'
  ) AS pinned_agents,
  (
    SELECT string_agg(dp.name || ' (' || dc.name || ')', ', ' ORDER BY dc.name, dp.name)
    FROM projects dp
    JOIN companies dc ON dc.id = dp.company_id
    WHERE dp.default_environment_id = e.id AND dp.archived_at IS NULL
  ) AS project_defaults,
  (
    SELECT string_agg(DISTINCT p.name || ' (' || rc.name || ')', ', ')
    FROM environment_leases l
    JOIN heartbeat_runs r ON r.id = l.heartbeat_run_id
    JOIN companies rc ON rc.id = r.company_id
    LEFT JOIN issues i ON i.company_id = r.company_id AND i.id::text = r.context_snapshot ->> 'issueId'
    JOIN projects p ON p.company_id = r.company_id AND p.id::text = coalesce(r.context_snapshot ->> 'projectId', i.project_id::text)
    WHERE l.environment_id = e.id
      AND r.created_at >= now() - interval '14 days'
  ) AS projects_last_14_days
FROM environments e
WHERE e.driver = 'sandbox'
ORDER BY provider, e.name;

-- 10. The go/no-go population: Claude agents with a host-pool run in the
-- last 7 days. After the backfill, every one of them must plan to use its
-- account, or only wait for its own account's limit. Before the deploy, the
-- rehearsal script (see the header) prints their plans for a restored copy;
-- after it, GET /api/instance/ai-accounts/migration lists them.
SELECT
  '10 go/no-go agents (7 days)' AS section,
  c.name AS company,
  a.name AS agent,
  a.id AS agent_id,
  a.status,
  a.default_environment_id IS NOT NULL AS pinned,
  count(*)::int AS host_pool_runs,
  max(r.created_at) AS last_run_at
FROM heartbeat_runs r
JOIN agents a ON a.id = r.agent_id AND a.company_id = r.company_id
JOIN companies c ON c.id = r.company_id
WHERE a.adapter_type = 'claude_local'
  AND a.status <> 'terminated'
  AND r.created_at >= now() - interval '7 days'
  AND r.context_snapshot -> 'aiConnection' ->> 'mode' = 'host_pool'
GROUP BY c.id, a.id
ORDER BY c.name, a.name, a.id;

ROLLBACK;
