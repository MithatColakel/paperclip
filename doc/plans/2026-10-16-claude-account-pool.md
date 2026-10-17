# Claude account pool, execution devices and waiting states

Date: 2026-10-16. Status: implementation in progress on the fork. The contract
is in [AI Connections](../connections/AI-CONNECTIONS.md#claude-account-pool-fork)
and the release notes are in
[releases/fork-claude-account-pool.md](../../releases/fork-claude-account-pool.md).

This plan replaces, for everything it covers, the balanced selection, the
failover and the admin-only pool of
[host AI account pools](2026-10-14-host-ai-account-pools.md).

## Goals

1. Users add their own Claude accounts: a subscription token or an API key.
   Every account has an owner, and no API ever returns a token.
2. An account is usable only in its owner's companies. The owner or a company
   admin binds it to an agent; agents never bind.
3. A device uses at most 3 distinct pool accounts, checked when an account is
   bound and again when a run starts.
4. Agents on a device's own login work as before and are never counted.
5. An agent has one pool account or the device login. The choice is read at
   every run start, applies from the next run and never interrupts a running
   one.
6. On a limit the task waits for the reset, the manager agent and the board get
   a notice, and nothing switches accounts.
7. An agent reaches a device through an environment. An environment driver
   plugin decides which companies and projects its devices serve.
8. An unavailable device gives a visible wait that resumes by itself, with a
   notice after 24 hours by default.
9. One code path serves both credential types, and no account is exposed outside
   its owner's companies.

## Product rule

Paperclip never moves a task to another account. There is no failover,
rotation, balancing or pre-emptive switching anywhere, and usage checks never
pick an account. When an account hits its limit, its tasks wait for the reset,
resume automatically on the same account, and the task's manager agent and the
board get a notice at once.

Owner decisions that shape the design:

- **Wait, do not block.** A problem that only a person can fix (a signed-out
  token, a paused account, an owner who left the company, a device that does not
  take the project, a credential type the device refuses) waits under a named
  reason with an immediate notice. Only invalid configuration blocks: a routing
  override, a refused or removed device, or a suspended run whose account is
  gone.
- **Who binds.** The account's owner, while an active non-viewer member of the
  agent's company, binds their own account. A company admin binds any eligible
  account. A company admin is the `local_trusted` board, a member with role owner
  or admin, or an instance admin with access to the company.
- **Migration.** Existing agents are bound by a deterministic rule and marked
  for review (see [Existing data](#existing-data)).
- **The Paperclip server stays a pool device**, as before. Its pre-existing
  exposure is recorded under [Risks](#risks).
- **Device ownership is for display only.** It never gates a run.

## Data model

Instance-level, because one machine serves every company's runs:

- `ai_accounts` (pool accounts): one encrypted credential, `owner_user_id`
  (the effective owner is the owner, else the creator), `origin` (`pool` or
  `legacy_host_pool`), the owner's `status` (active, auth_failed, disabled), a
  separate instance-admin flag (`admin_disabled_*`), and limit state
  (`exhausted_until`, `limit_source` provider or estimated, `limit_strikes`,
  `limit_episode_started_at`, `limit_probe_run_id`, `auth_suspect_*`). `host_id`
  becomes a nullable legacy hint with `ON DELETE SET NULL`. E-mail hints are
  unique per owner; credential fingerprints stay unique globally. `pool_enabled`
  is still written for older images. `ai_account_projects` reservations become a
  company restriction until the owner clears them.
- `ai_account_hosts` (execution devices): kinds Paperclip server, SSH host,
  computer over SSH and plugin device (`external`); `external_key` (`local` or
  `ssh:<host>:<port>`), `target_key` for plugin targets, the target's match
  rule and last reported state, the managing plugin, a display-only owner, and
  `over_limit_at`. The cap is `min(max_accounts, 3)`.
- `ai_account_host_environments`: explicit environment-to-device mappings.
- `environment_availability`: one row per environment for target-level states
  (available, unavailable, retired), with check times, backoff and a wake
  epoch. A missing row means available.
- `deferred_data_migrations`: markers for jobs that run after the migrations.
  The backfill's summary lists agents and accounts of every company, so only
  instance admins read it.

Company-scoped:

- `ai_account_agent_bindings`: one row per agent, mode `pool_account` (with an
  account, or none while it waits as unassigned) or `device_login`, plus
  `source` (manual or migrated), `migration_note` and `reviewed_at`. No row
  means the legacy path.
- `ai_account_run_slots`: one row per pool run, with its device and account.
  The running set of a device is its slots joined to running runs.
- `resource_wait_episodes`: at most one open wait per task (or per agent for
  runs without a task), with its kind, reason, scope, resource, start time,
  resume time and notice times.
- `resource_wait_notices`: one key per notice, so each posts only once.
- `execution_wait_settings`: notify-after hours and the two manager-wake
  switches.

Migrations: `0309` holds the DDL and `0310` four data backfills. `0310` inserts
no bindings; a boot job does that with the full binding checks.

## Flows

### Accounts

- An owner adds an account by pasting it, by importing their own saved Claude
  connection, or, as an instance admin, by importing the server's environment
  token. The actor owns the new account.
- The owner edits, pauses, resumes, replaces the token, clears a limit, clears a
  reservation or removes the account. Removing an account that agents use needs
  `release`, which leaves those agents waiting as unassigned.
- An instance admin disables or re-enables an account, clears a limit, deletes
  it, or transfers it to another existing user.
- Account events are logged in every company where the owner is an active
  member; an account whose owner has none logs in the companies whose agents
  use it, without its label. A transfer is logged in the old and the new
  owner's companies. Elsewhere an account shows only as "no longer available in
  this company".

### Binding

One transaction under an advisory lock checks, in order: who may bind; that the
agent is a Claude agent; eligibility (the owner is an active member, the account
is not paused or disabled, any reservation allows the company); the agent's
candidate environments (its pinned environment, else the project defaults and
the company, instance and Local fallbacks); a device for each candidate; the
credential type each device accepts; and the cap, counting the distinct accounts
bound to agents of any company on each device. It then writes the row, logs the
change in the agent's company and wakes the agent's waits.

An environment change of a pool-bound agent runs the same checks and writes the
environment in the same transaction. Default-environment edits at project,
company or instance level, plugin target reports and plugin-created environments
cannot be refused at once: they re-check the devices afterwards and flag a
device that went over its cap. New `company_pool` bindings, and router bindings
for Claude agents, are refused, because both choose between accounts by
themselves.

### Run start

1. Resolve the environment as today: agent pin, project, company, instance,
   Local.
2. Preflight: a retired environment refuses the run; an availability row that is
   `unavailable` and was checked less than 10 minutes ago makes the run wait.
3. Credential precedence: a persisted router selection for the same resumed run,
   then the binding row, then the upstream `aiConnection`, then the device
   login. Automatic host-pool selection is removed.
4. For a pool binding, plan the credential: the account exists, its owner is a
   member, no reservation excludes the company, it is not disabled or signed
   out, the environment maps to a device, the device accepts the credential
   type, and no limit is in force. Each failed check waits under its own reason.
5. Refuse routing overrides (base URLs, provider switches, proxies, TLS
   overrides, helper settings) before acquire, so a refused run takes no device
   slot and decrypts nothing, and again once the workspace is realized (on the
   target, for a remote one).
6. Acquire: lock the device row, re-check the account, count the accounts
   running on the device, and wait for a slot when a new account would exceed the
   cap. Write the slot and the attribution, commit, then decrypt.
7. Inject: strip and blank the other auth variables, set the account's variable,
   delete credential carriers and set the non-secret account marker.
8. Lease the environment. A typed "unavailable" answer from a driver plugin, or
   an SSH host that cannot be reached, makes the run wait; a driver refusal
   blocks it.

### Failures during a run

- Only the CLI's own result and error output can mark an account; a match in
  tool output or the transcript is a transient failure of that run.
- **Limit:** the account is limited until the typed reset (at most 7 days and 1
  hour ahead), or an estimate of 1 hour that doubles with each limit in a row up
  to 12 hours (24 hours for credit balance). The task waits in the account lane.
  At the reset one waiting run goes first as a probe; when the provider serves
  it, the limit clears and the other waits wake.
- **Sign-in:** a typed 401 or 403, or a second failure on another run within 2
  hours, marks the account signed out. A first untyped failure waits 10 minutes
  for that run only.
- **Company pool:** the member is marked limited and the task waits for that
  member's reset in its own lane. The pool stays pinned to the member the agent
  used last; a pinned member that fails a check fails the run instead of
  handing it to another member.

### Waiting

- A wait is a deferral plus a successor: the run is cancelled as expected before
  any provider work, and a `scheduled_retry` run in a wait lane
  (`environment_wait`, `ai_account_wait`, `device_slot_wait`) keeps the task's
  lock. The task stays in progress, the agent stays idle, and no failure budget,
  daily run cap or legacy reconciliation is touched.
- The episode carries the start time and notices across every replacement run.
- Each scheduler tick holds due waits with database reads only, re-checks the
  task's dispatch gate at most every 5 minutes, re-arms with a compare-and-set,
  and lets device slots go first in, first out.
- Events wake waits: plugin reports, checks, plugin restarts, account changes,
  binding changes, environment changes and Check now.
- A sweep runs availability checks, releases stale probes, prunes slots, ends
  orphaned episodes and sends notices.
- Notices go to the task (immediately for limits and for problems a person must
  fix; after the notify-after hours for device outages; once more when a notified
  wait ends), to the manager agent as one summary wake per resource and outage,
  and to the inbox.
- `PAPERCLIP_ENVIRONMENT_WAITS=off` switches device waits off after a restart.
  Account waits always stay, because they replace failover.

### Environment driver plugins

The SDK gains a typed "environment unavailable" envelope, a negotiated
`projectId` in driver parameters, an optional `environmentCheckAvailability`
call, `ctx.environments.reportTargets` (target state, accepted credential types,
display owner, served companies, hostname aliases, wake and retired flags) and
`ctx.environments.ensureCompanyEnvironment` (a company's environment, created
from a board user's action). Reports are accepted only from the sole plugin that
provides a sandbox provider key. An older host answers `METHOD_NOT_FOUND`, and
the plugin falls back.

### Devices

An environment maps to a device through an explicit mapping, the Local server
device, an SSH key derived from host and port, or the plugin target whose match
fields its config contains. An instance admin links one machine reached two ways
into one device; hostname aliases and matching labels flag likely duplicates.

## Existing data

1. **Before deploy:** run the read-only report script, restore a snapshot into
   a scratch database, rehearse the boot job on it with the heartbeat scheduler
   off (`HEARTBEAT_SCHEDULER_ENABLED=false`) on a host that cannot reach the
   devices or outside services, and pass the go/no-go: every Claude agent with a
   host-pool run in the last 7 days must plan to use its account. Fixes on the
   copy do not carry over: fix what the current image can fix on production,
   and pause each agent that still needs a deliberate binding, to bind it right
   after boot.
2. **`0310`:** owner = creator; origin `legacy_host_pool`; "Not in pool" becomes
   paused, which the owner can resume; device keys for hosts whose environments
   agree on one host and port, and `local` for the server host.
3. **Binding backfill (at boot, once, idempotent):** candidates are Claude agents
   without a binding that used a host pool in the last 45 days (overflow picks
   ignored), or that use a company pool. The account is the single reserved
   account of the agent's projects, else the agent's most-used account, else its
   company's most-used account on its devices, else none. A company-pool agent
   gets the account that holds the credential of the member it used last in
   those 45 days, else of the pool's first member. Every choice passes the
   binding checks in processing order. Passing agents are bound and marked for
   review; agents over a cap, and agents with history whose account fails a
   check, wait as unassigned with a notice; the rest stay as they are and are
   listed. A failure never blocks boot, and an instance admin can re-run the
   job.
4. **After deploy:** admins bind and resume the agents paused before the deploy,
   review migrated bindings, pin agents whose project defaults have no device
   and then choose their accounts (a re-run of the backfill skips agents that
   already have a binding row), transfer accounts that were added for someone
   else, and link duplicate devices.

## Rollout

1. **Preparation.** Run the report, rehearse on an isolated snapshot with the
   scheduler off and the go/no-go, and run the local checks: `pnpm -r typecheck`, the
   affected vitest suites, the OpenAPI coverage test, `pnpm check:token-gates`
   and `drizzle-kit check`. No npm dependencies are added, so `pnpm-lock.yaml`
   stays unchanged.
2. **Core release**, with the security fixes (remote-safe adapter environments,
   SSH secret staging and terminal-only classification) in the same release.
   Deploy in a quiet window; migrations and the boot job run at startup. Right
   after boot, bind and resume the paused agents, review bindings and run the
   go/no-go on production.
3. **Smoke checks.** A bound agent on the Paperclip server and one on an SSH host
   run with their accounts ("Using Claude account …", and no secret in the ssh
   command line). A stopped tunnel and a port that never sends a banner both
   make the task wait instead of failing; restoring the host resumes it within
   one backoff interval. Check now answers "Still unavailable" while it is down.
   A board comment on a waiting task keeps it in progress. An estimated limit
   makes exactly one probe attempt at the reset, notifies at once and never runs
   on another account; clearing the limit resumes every wait.
4. **Guardrails.** `PAPERCLIP_ENVIRONMENT_WAITS=off` needs a restart and gives
   existing device waits one real attempt. Account waits cannot be switched off.
5. **Monitor for 48 hours:** scheduler tick duration (holds, gate checks and the
   sweep), open episodes per lane, notices and inbox items, no `setup_failed`
   runs for unreachable SSH hosts, and no legacy reconciliation actions caused by
   waits.
6. **Environment driver plugins** that report targets upgrade after the core,
   with an upgrade-and-enable runbook when the new version adds a capability.
   Then admins link duplicate devices and bind accounts on plugin devices.
7. **After one stable release**, remove the legacy `host_pool` slot counting, the
   `ai_connection_failover` handling and the 410 routes. At the next upstream
   rebase, renumber `0309` and `0310` with byte-identical SQL.

## Rollback

Redeploying the previous image is for emergencies only, because it brings back
balanced host-pool selection and failover for mapped hosts.

- The schema stays; nothing is lost in either direction.
- The old image ignores bindings, owners, episodes and the registry, and it
  cannot see accounts without a host.
- Deleting a host no longer deletes its accounts. A duplicate e-mail hint from
  the same creator returns 500 instead of 409. Plugin devices show a raw kind.
- Driver plugins get `METHOD_NOT_FOUND` from the new host methods and fall back
  to creating environments through the admin REST API.
- Back on the new image, re-run the binding backfill, which binds only agents
  without a binding row (for example ones created meanwhile), and the go/no-go.
  An account switched out of the pool on the previous image is active again:
  its owner pauses it, or an instance admin disables it.

## Risks

- **Local trust.** Local runs inherit the server's environment and run as the
  server's OS user, so any Local run can read the master key and could decrypt
  every pool credential. This exists today; hardening Local execution is a
  separate project.
- **Shared OS users.** Runs under one OS user on one device can read each other's
  environment, including a concurrent pool run's token.
- **The backfill** can bind an agent to an account it never used (the company's
  most-used account on its device). Every migrated binding is marked for review.
- **Migration numbers** collide with upstream's and must be renumbered without
  changing the SQL, because the migrator matches on content.
- **Proxies.** A network that needs a proxy cannot run pool agents until a vetted
  proxy option exists.
- **SSH staging** adds one ssh round trip per command that carries a secret, and
  secrets are now sourced after the login profiles.
- **Device identity** needs a manual link for a machine reached two ways; until
  then its cap is split.
- **Scheduler cost** grows with waits, gate checks and the sweep.
- **Single probe.** At a reset one task runs first, so a backlog drains a few
  minutes later, in exchange for no fail loops.
- **Transfers** make an account eligible in the new owner's companies; bindings
  elsewhere start waiting with `owner_not_member`.
- **Company admin.** An instance admin with access to a company counts as its
  admin, even with a viewer membership. Confirming this rule is the one open
  question.
- **Retired modes.** Refusing new company-pool bindings and routers for Claude
  agents changes behaviour that upstream allows; existing bindings keep working.
