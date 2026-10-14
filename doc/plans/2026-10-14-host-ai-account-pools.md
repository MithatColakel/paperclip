# Host AI account pools (Claude subscriptions per execution host)

Date: 2026-10-14. Status: implemented on `feat/host-ai-account-pools` (server, API, failover, UI).

## Problem

Claude subscriptions are company-scoped today. A connection, its grant, the
owner's vault secret, the fork's `company_pool` members and their quota
states all carry `company_id`, and the server refuses another company's
account on purpose. A new company (LumineAI) therefore lists nothing, and
the "from a Mac" token source lists only Macs enrolled in that company.

Meanwhile the real constraint the operator manages is per **machine**: the
Paperclip server container runs every Local-environment agent of every
company, and the `aidevops-runner` host runs every runner SSH environment of
every company. Account S is used on both hosts today.

## Operator decisions (2026-10-14)

- Accounts belong to an **execution host**, not to a company or a person:
  the Paperclip server is one host, the runner server another. Each host has
  at most **3** accounts. Hosts never share an account ("6 separate
  accounts" for server + runner).
- Each added account has a "usable in the pool" switch.
- **All agents of all companies** draw from the pool of the host they run on.
- Selection is **balanced** across the host's available accounts, not
  fill-first.
- When an account reaches its usage limit, the run moves to another account
  of the same host at once; the limited account rests until its reset.
- Macs come in a second step (the Mac agent currently replaces any token
  Paperclip sends with the Mac's own login).
- Stay within Anthropic's terms (see "Policy notes").

## Model

Instance-level tables (an explicit exception to company scoping, like
announcement dismissals; see AGENTS.md §5):

- `ai_account_hosts`: `id`, `name`, `kind` (`server` | `ssh_host` | `mac`),
  `max_accounts` (default 3, hard ceiling 3), timestamps.
- `ai_account_host_environments` (`environment_id` primary key, `host_id`):
  which host an environment runs on (a separate table, so the upstream
  `environments` table is unchanged). The single Local environment maps to the
  server host; the runner SSH environments map to the runner host. SSH
  environments that tunnel to a Mac (ports 2201/2202) stay unmapped.
- `ai_accounts`: `id`, `host_id`, `provider` (`anthropic`), `label`,
  `email_hint`, `plan`, `pool_enabled`, `status` (`active` | `auth_failed` |
  `disabled`), `credential_material` (local_encrypted material, instance
  master key), `credential_fingerprint` (unique: one token, one host),
  `exhausted_until`, `limit_reason`, `limit_source`, `limit_run_id`,
  `last_selected_at`, `created_by_user_id`, timestamps.

Only instance admins can read or change these rows. Token values are never
returned by the API.

## Run path

1. After the environment is chosen and before env resolution, if the agent
   has no explicit `runtimeConfig.aiConnection`, the adapter is
   `claude_local`, and the environment maps to a host with at least one
   pool-enabled account, the run is a **host-pool run**.
2. Host-pool runs strip AI auth variables from environment, agent, project
   and routine env (same stripping as managed bindings), then set
   `CLAUDE_CODE_OAUTH_TOKEN` to the selected account's token. No `HOME` or
   `CLAUDE_CONFIG_DIR` rewrite, so SSH runs are unaffected by the managed
   HOME issue.
3. Balanced selection: among `active`, pool-enabled accounts whose
   `exhausted_until` has passed, take the one with the fewest running
   host-pool runs, then the oldest `last_selected_at`. The choice is made
   under a row lock on the host so concurrent runs spread out.
4. Attribution goes to `contextSnapshot.aiConnection` with
   `mode: "host_pool"`, the account id, label and host, so run detail shows
   which account served the run, and the token is redacted like other
   secrets.
5. Every account limited: the run is deferred to the earliest reset through
   the existing `ai_connection_busy` wait (same as `company_pool`).
6. A run that ends with `provider_quota` marks its account limited until the
   provider's reset (60 minutes when none is given) and is retried at once
   with reason `ai_connection_failover`, capped at twice the host's account
   count, exactly like `company_pool`. Authentication failures mark the
   account `auth_failed` and stop selecting it.
7. Agents with an explicit `aiConnection` keep it (escape hatch). The rollout
   removes the one existing binding (VPN Project Manager) so every agent
   uses its host pool.

## API (instance admin)

- `GET /api/instance/ai-hosts`: hosts, mapped environments, accounts
  (masked), current limits and running counts.
- `POST /api/instance/ai-hosts`, `PATCH /api/instance/ai-hosts/:id`.
- `PUT /api/instance/ai-hosts/:id/environments` `{ environmentIds }`.
- `POST /api/instance/ai-hosts/:id/accounts` `{ label, emailHint, plan,
  token }` (Claude setup token) or `{ ..., importFrom: "server_env" |
  { connectionId } }` to move an existing token server-side without
  showing it.
- `PATCH /api/instance/ai-accounts/:id` (label, email, plan,
  `poolEnabled`), `POST .../clear-limit`, `DELETE`.

## UI

Instance settings → "Claude accounts": one card per host with its
environments and up to three account rows (label, masked email, plan,
state: available / limited until … / sign-in failed, pool switch, clear
limit, remove) and "Add account" (paste setup token, import the server
token, import my existing subscription, or get one from a Mac in any
company you manage).

## Policy notes (checked 2026-10-14)

- No official Anthropic statement of a "3 accounts per device" limit was found.
  The limit of three per host is the operator's own rule, enforced by the server.
- Claude Code's legal and compliance page: OAuth (subscription sign-in) is
  intended for purchasers of the plan and "designed to support ordinary use";
  advertised Pro/Max limits assume ordinary, individual usage; developers may not
  collect, store or intermediate Claude.ai credentials or session tokens. Customers
  may provision their own API keys for their own authorized users, billed to the key
  owner.
- Anthropic's Usage Policy forbids creating multiple accounts to circumvent
  guardrails.
- Max and Team plans include monthly API credits (support article, 2026-10-07)
  that cover `claude -p` and the Agent SDK with an API key from the linked Console
  organization.
- Operator decision: support both credential types; the operator chooses per
  account. Recommendation recorded: API keys on shared hosts.

## Phase 2 (Macs)

Mac Fleet hosts: map each Mac Fleet environment to a `mac` host; Mac agent
uses the token Paperclip sends for host-pool runs instead of its own vault
login; plugin import of a Mac's token for the instance page.
