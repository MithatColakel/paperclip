# AI Connections

AI accounts use the existing Apps/Connections substrate. Manage them at
`/:company/apps`; select their use beside an agent's harness/model settings.
Onboarding, new-agent setup, account creation/reconnect, and inline task requests
reuse `AdapterLoginPanel`, its existing login controllers, and `AdapterLoginChrome`.
Onboarding and new-agent setup retain upstream's `SavedProviderKeySelect` and
`useSavedProviderKeys`, including saved-key references and account-specific Codex
homes. Managed default/shared accounts are additional choices in that same
selector. Selecting “Sign in to another account” survives background refreshes;
Claude authorization paste keeps upstream's immediate Connecting feedback.

New-agent Connect offers three persistent tiles: the provider's subscription,
the provider's API key, and Advanced. All three stay visible while the selected
mode's form is shown below. Advanced opens the existing compatible-connection
picker and provider setup. Execution environment selection lives in Configure.

Storybook's simulated controllers and page annotations do not run in the app.

## Compatibility and selection

The shared `AI_CONNECTION_CAPABILITIES` contract defines these combinations:

| Provider | Sign-in method | Existing harness |
| --- | --- | --- |
| Claude / Anthropic | Claude subscription token or Anthropic API key | Claude |
| OpenAI | ChatGPT/Codex subscription or OpenAI API key | Codex |
| OpenRouter (legacy, no routing metadata) | API key | OpenCode, with an `openrouter/` model |
| Google | API key | Gemini CLI |
| Grok / xAI | Grok subscription or xAI API key | Grok |

Native runner supports the corresponding existing Codex, OpenCode, and Claude
ACP profiles. Connections creation and reconnect mount `AgentProviderConnection`,
the same provider tiles, method controls, API entry, and `AdapterLoginPanel` used
by agent setup. Supported sandbox environments use onboarding's existing browser
sign-in controllers. Self-hosted Claude and Codex installations use the same
browser sign-in presentation with a local login runner and require no sandbox.
Environment selection does not change agent execution settings.
API keys are validated against fixed provider endpoints; redirects
and caller-supplied validation URLs are rejected.

`runtimeConfig.aiConnection` contains `provider`, `mode`, and `method`. For responsible-user selections, `method` is a legacy wire hint retained for rolling upgrades; the resolver uses the selected account’s actual method:

- `responsible_user`: resolve the run's responsible user's personal provider default, using that account's subscription or API key. The `method` hint does not restrict the responsible user's account.
- `shared`: use the named `connectionId` and `grantId`, with audience and agent
  access checks.
- `delegated`: an explicit personal account selection (the wire name is retained
  for compatibility). It cannot bypass human access; a personal credential
  remains available only for its owner’s tasks.

- `company_pool`: use the company's ordered pool of company-shared accounts
  for the provider (see [Company account pool](#company-account-pool-deprecated)
  below). `method` is a wire hint only; any method in the pool may serve the
  run. Deprecated (fork): new or changed `company_pool` bindings are refused,
  and an existing one stays on the member it used last.

“Which humans can use this credential?” is the sole permission for whose work
can use the account. “Just me” means the personal owner; shared accounts allow
selected company members or every company member. The separate agent-access
setting determines which agents can use it. There is no additional AI agent
authorization, and old delegation records do not override the human audience.

A connection choice never changes the harness or model. For a routed connection,
the selected connection owns its provider routing.
Changing those separately may make a binding incompatible; saving then requires
a compatible choice. Agent configuration cannot grant access to another account.

Personal defaults are unique per company, user, and provider. A Claude bot can use one user’s subscription and another user’s API key without changing its harness or model. Explicit shared selections remain pinned to the selected account and method.
The first successful personal connection sets a default only when none exists.
The additive `ai_provider_defaults` table preserves the legacy per-method preferences. Migration selects each user’s most recently updated provider preference (including unavailable accounts), and rerunning it never overwrites a provider default. New writes maintain the legacy table for older servers. A database trigger propagates older servers’ explicit default updates to the provider default. Inserting an additional method default does not replace an existing provider default.

Revocation retains the unavailable default; connecting another account does not
silently replace it. Change it explicitly on the account detail page.

Agent settings offer **Reconnect account** when the current personal default
needs attention. This repairs the same connection and keeps its default and
agent access. **Connect another account** states that the new account will
become the user's provider default. It selects the returned grant before
adopting the binding and retains the actual sign-in method. A failed default
update stays visible and can be retried without another login. New account
setup shows an agent-access checkbox, enabled for all company agents by default
for connection managers. The owner can limit access to the current agent. This access applies only to
the owner's tasks. Reconnect never expands existing access.

On an agent's page the dialog first offers **Only \<agent>** (the default
there): a company-shared account installed only for that agent and selected for
it with an explicit `shared` binding. It changes no one's default; **My account**
keeps the personal-default path above.

## Company account pool (deprecated)

> **Deprecated (fork).** The company account pool takes no new agents. Claude
> agents use the [Claude account pool](#claude-account-pool-fork) instead. The
> `/:company/apps` card titled "Company account pool (retired)" is this company
> pool; the new pool lives in Company settings → Claude accounts.
>
> - **Refused.** A new or changed `company_pool` binding returns 422
>   `ai_connection_company_pool_retired`, for every adapter. An agent-made hire
>   that names no connection and would inherit its hiring agent's
>   `company_pool` binding gets the responsible user's own connection instead
>   (see [Bindings](#bindings)).
> - **Still works during this release.** An agent that keeps its current
>   `company_pool` binding on the same adapter keeps running, and it can still
>   be renamed, reconfigured and pinned. It stays on the member it used last
>   (the first member by priority when it has used none, or when that member
>   left the pool) and waits for that member's reset. The pool never moves a
>   task to another member, and it no longer reads usage to skip one. The
>   tables and the pool routes stay; the order now only picks the member of an
>   agent that has used none.
> - **Moved by the backfill.** The one-time binding backfill binds a
>   `company_pool` agent to the pool account that holds the same credential as
>   its member (the one it used last in the last 45 days, else the pool's first
>   member), when such an account exists and passes the binding checks (see
>   [Binding backfill](#binding-backfill)).

A company orders its company-shared accounts for a provider in
`ai_connection_pool_members` (`/:company/apps` → the card titled "Company
account pool (retired)"). Only that company's own shared accounts can
join; composite foreign keys keep every member inside its company, and a run
never reaches another company's account.

Selection takes the member the agent used last (the connection of its latest
started `company_pool` run), otherwise (no member used yet, or that member left
the pool) the first member by priority, and applies the same checks as a
`shared` selection (health, grant status, human audience, agent access). A
pinned member that fails a check (for example a disabled or revoked
connection, or one no longer shared with the responsible user) fails the run
(`configuration_incomplete`, with the check's error) instead of being skipped;
the pool never moves on to another member. Before this fork release it walked
the pool in order and skipped an account that failed a check. Per-account usage
state lives in `ai_connection_quota_states`:

- **Limit after a failure.** A `company_pool` run whose CLI output reports
  `provider_quota` marks its account limited until the provider's reset time
  (at most 7 days and 1 hour ahead), or for 60 minutes when the provider gives
  none. A later reset always wins over a shorter one. The task then waits in
  the `ai_connection_pool_wait` lane until that reset, plus up to 2 minutes of
  jitter, and runs on the same account again. The `ai_connection_failover`
  hand-off to the next account is gone.
- **Limit before a run.** Removed. Selection no longer reads the account's
  usage (`api/oauth/usage`), and no usage level skips an account.
- **Pinned member limited.** Preparation raises `ai_connection_pool_exhausted`
  with that member's reset. The run is deferred through the existing
  `ai_connection_busy` wait until then; it does not need a reconnect. The
  deferral event reads: "This agent's account in the company AI pool is at its
  usage limit. Paperclip never moves a task to another account; this task
  resumes at \<reset>."
- **Old usage marks.** Marks that the usage probe of an older release left
  (quota source `usage_probe`) are no limit: they never hold a run, and never
  extend a later limit a run meets. The pool card shows no usage readings, and
  no limit badge for them.

Board users with `tools:manage_connections` reorder the pool and clear a
recorded limit; both write activity (`ai_connection.pool_updated`,
`ai_connection.pool_limit_cleared`). The heartbeat records
`ai_connection.pool_limit_reached`. Run detail shows the pool position that
served the run.

## Host account pools (fork, deprecated)

> **Deprecated (fork).** The [Claude account pool](#claude-account-pool-fork)
> replaces host pools: accounts belong to users, each agent is bound to one
> account, and hosts become [execution devices](#devices-and-ownership).
>
> - **Still works during this release.** Instance admins list hosts
>   (`GET /api/instance/ai-hosts`), add, rename and remove them, and edit their
>   environment mappings (`PUT /api/instance/ai-hosts/:hostId/environments`),
>   in Instance settings → Devices & Claude accounts. A mapping edit that would
>   give a device an account over its limit, or lowering a limit below the
>   accounts bound to the device, returns 409 `device_account_limit` (see
>   [Legacy host routes](#devices-and-ownership)). Host changes are logged only
>   in the companies whose agents use the device, no longer in every company.
>   Existing host accounts are pool accounts owned by
>   their creator; an account that was "Not in pool" is now "Paused by owner",
>   and its owner can resume it. An account without a recorded creator has no
>   owner and is not eligible anywhere until an instance admin transfers it or
>   deletes it. `PATCH`, `POST …/clear-limit` and
>   `DELETE /api/instance/ai-accounts/:id` are served by the account pool's
>   instance routes. `PATCH` takes only `{adminDisabled, reason, ownerUserId}`
>   (the old fields are refused), and `DELETE` answers 409 `ai_account_in_use`
>   while agents use the account, unless `?release=true`. `host_pool` runs
>   still running at deploy count toward their device's limit until they
>   finish.
> - **Removed.** Automatic selection, balancing and failover. An agent without a
>   binding never receives a pool token; the one-time
>   [binding backfill](#binding-backfill) bound the agents that used a host
>   pool.
> - **410.** `POST /api/instance/ai-hosts/:hostId/accounts` and
>   `PUT /api/instance/ai-accounts/:id/projects` return 410 to every caller,
>   with code `ai_account_route_moved` and the routes that replace them in
>   `details.replacements`. Accounts are added with `POST /api/me/ai-accounts`,
>   and only an account's owner clears its project reservation.

A host is a machine that runs agents: the Paperclip server (the single Local
environment), a runner server (its SSH environments), or another computer
reached over SSH. Each host held at most three credentials, and a credential
(by fingerprint) or an account email lived on one host only. The rules below
describe host pools before this release.

- **Who used it.** Every `claude_local` run without an explicit
  `runtimeConfig.aiConnection` whose environment was mapped to a host with at
  least one pool-enabled account. An explicit binding still won. Sandbox
  environments of environment driver plugins were not covered.
- **Credential types.** A subscription token from `claude setup-token`
  (delivered as `CLAUDE_CODE_OAUTH_TOKEN`) or a Claude Console API key (delivered as
  `ANTHROPIC_API_KEY`). The run's other auth variables are blanked, and every env
  layer's own auth variables are stripped, so an environment's old token cannot
  leak in. Pool accounts keep both types and this stripping; sandbox and SSH pool
  runs now also get a [per-account config directory](#ssh-secret-staging-and-the-per-account-config-directory).
- **Balanced selection.** Removed. Among active, pool-enabled accounts whose limit
  had passed, the run took the one serving the fewest running host-pool runs, then
  the least recently picked.
- **Usage limits.** Removed. A host-pool run that ended with `provider_quota`
  rested its account and retried at once on another account with reason
  `ai_connection_failover`, and a sign-in failure moved the task to another
  account. A limit or a sign-in failure now makes the task
  [wait](#waiting-states) for the same account.
- **Attribution and audit.** `contextSnapshot.aiConnection` recorded `mode:
  "host_pool"`, the account and the host; older runs keep it, and new runs record
  `mode: "pool_account"`. Host and account changes were logged in every company.
- **Imports.** An admin could add the server's own `CLAUDE_CODE_OAUTH_TOKEN` or
  their own personal Claude connection without the value reaching the browser.
  Both imports now create an account in the caller's own pool
  (`POST /api/me/ai-accounts`); the server token is for instance admins only.

## Claude account pool (fork)

Claude agents (`claude_local`) can run with an account from the Claude account
pool. Each pool account belongs to one user. The owner adds it once and can use
it in every company where they are an active member. The owner or a company
admin binds it to an agent, and the agent's runs then use it on whatever device
they run on. Pool accounts, execution devices and the availability registry are
instance-level; bindings, waits, notices and their audit are company-scoped
(see the fork exception to core rule 1 in [AGENTS.md](../../AGENTS.md)).

**Product rule.** Paperclip never moves a task to another account. There is no
failover, rotation or balancing between accounts, and a usage check never picks
an account. When an account hits its limit, its tasks wait for the reset, start
again automatically on the same account, and the task's manager agent and the
board get a notice at once. A task that waits for its device is never moved to
another device either; the notice tells people how to move the agent
themselves.

Pages:

- **Company settings → Claude accounts** (every member): "My Claude accounts",
  the accounts "Available in \<company>", and "Agent assignments" with a picker
  per agent and a "Review migrated assignments" banner.
- **Company settings → Devices**: the devices that run the company's agents,
  their availability, accounts in use and waits, plus "Waiting notifications"
  for company admins.
- **Instance settings → Devices & Claude accounts** (instance admins): every
  device and account, the migration report, and the legacy host pool section.
- **An agent's Configuration view → Adapter**: a Claude agent's Claude account
  field (see [Bindings](#bindings)), in place of the AI connection field. The
  overview's Change link opens it. A waiting task shows a banner.

### Accounts

- **Credential.** One encrypted credential per account: a subscription token
  from `claude setup-token` (delivered as `CLAUDE_CODE_OAUTH_TOKEN`) or a Claude
  Console API key (delivered as `ANTHROPIC_API_KEY`). It is stored with
  `local_encrypted` and decrypted only after the run has its device slot. No API
  response, activity row, run event, log line, plugin message or command line
  carries it; only the run environment delivered to the target does. A failed
  `POST`, `PUT` or `PATCH` to `/api/me/ai-accounts*` or
  `/api/instance/ai-accounts*`, or to the retired
  `POST /api/instance/ai-hosts/:hostId/accounts`, is logged without its error
  text, and a server error there answers only `Internal server error`, so an
  error that echoes a token never reaches a log line.
- **Adding.** `POST /api/me/ai-accounts` takes a pasted value, the caller's own
  saved Claude connection (`importFrom: {kind: "ai_connection", companyId,
  connectionId}`; never another member's or a shared one), or the server's
  environment token for the account's type (`importFrom: {kind: "server_env"}`,
  instance admins only; 403 otherwise). Imported values never reach the browser.
  The caller owns the new account in every case. The owner must be an active
  member of at least one company (422 otherwise), so the creation is always
  audited. A credential that is already in the pool, or an e-mail hint the owner
  already uses, returns a generic 409 `ai_account_duplicate` that names no other
  owner.
- **Owner actions** on `/api/me/ai-accounts/:id` (others get 404): edit the label,
  e-mail hint and plan; pause (`status: "disabled"`) or resume; clear the project
  reservation (`clearProjectRestriction: true`); replace the token
  (`PUT …/credential`, same type); clear a limit (`POST …/clear-limit`); remove
  (`DELETE`). A new token or a cleared limit also clears the strikes, the probe
  claim and an unconfirmed sign-in failure, and wakes the account's waits. A
  signed-out account cannot be paused (422): replace its token or remove it.
  Removing an account that agents use returns 409 `ai_account_in_use`; with
  `?release=true` those agents keep a binding without an account and wait as
  `unassigned`.
- **States**, in precedence order: "Disabled by admin", "Paused by owner",
  "Signed out", "Limited until …", active. Only an instance admin clears the
  admin flag, and only the owner resumes an account they paused.
  `pool_enabled` is kept in step with these states for older images.
- **Visibility.** `GET /api/me/ai-accounts` lists the caller's own accounts;
  `usedBy` names only the caller's companies and counts the rest. Agent keys get
  403. Label, owner name, masked e-mail, type and state are visible to the owner,
  to instance admins and to members of companies where the owner is an active
  member. Elsewhere the account shows as "an account that is no longer available
  in this company", with no label, owner or e-mail.
- **Instance admins** (`/api/instance/ai-accounts`) list every account, masked,
  including legacy and ownerless ones. They disable or re-enable an account
  (`PATCH {adminDisabled, reason}`), clear a limit, delete one (same `release`
  rule) and transfer it to another existing user (`PATCH {ownerUserId}`): 422
  `ai_account_owner_unknown` for an unknown user, 409 `ai_account_duplicate`
  when the new owner already has that e-mail hint. A transfer keeps the account's
  limit state and wakes its waits. Bindings in companies where the new owner is
  not a member then wait with `owner_not_member`.
- **Project reservations** from the host pool (`ai_account_projects`) stay as a
  company restriction: the account is usable only in companies that own one of
  the reserved projects, until its owner clears the reservation. The owner's
  list (`GET /api/me/ai-accounts`) names only the reserved projects of companies
  where the owner is an active member; the others come as a count
  (`otherReservedProjects`), and the clear action stays available.
- **Audit.** Account entries (`ai_account.created`, `updated`,
  `credential_replaced`, `limit_cleared`, `deleted`, `admin_disabled`,
  `admin_enabled`) go to every company where the owner is an active member.
  `ai_account.owner_changed` goes to the companies of the old and the new
  owner, without naming the new owner where they are not a member. An account
  whose owner has no active company logs instead in the companies whose agents
  use it, without its label. No other company gets an entry. The run path logs
  `ai_account.limit_reached` (once per limit) and `ai_account.signed_out` in
  the run's company.

### Bindings

An agent's binding (`ai_account_agent_bindings`) is read at every run start, so
a change applies from the next run; a running run is never touched. Only
`claude_local` agents take a binding. Hires never inherit one, and bindings are
never exported or imported.

| Binding | The agent's runs use |
| --- | --- |
| No row | The upstream `runtimeConfig.aiConnection`, otherwise the Claude credential variables of the agent's own environment, else the device's own login. An unbound agent never receives a pool token. |
| `device_login` | The device's own login, unless the agent's own environment sets a Claude credential variable, which still applies. It also overrides an upstream `aiConnection`. |
| `pool_account` with an account | That account, on any device the agent runs on. |
| `pool_account` without an account | No credential: runs wait as `unassigned` until an account is bound. They never fall back to the device's login. |

**The Claude account field.** An existing Claude agent's Configuration view has
one Claude account field in its Adapter section, in place of the AI connection
field; the overview's Change link opens it (`#claude-account`). The picker
offers the pool accounts with their state (an account the caller cannot choose
stays visible, disabled, with the reason), the device's own login, and the
agent's `aiConnection`, named as the AI connection picker names it (e.g.
"Responsible user's connection"), only while the agent has no row: once
another choice is saved, it is no longer offered there. The text under the
picker says what the runs use now, and what to do where they cannot run for
the viewer:

- A pool account: the account, with its owner, on the agent's device.
- A responsible-user connection: the connection of each task's responsible
  person, naming the viewer's own. While the viewer's own is missing or not
  connected, their tasks cannot run until they connect or reconnect it under
  Apps (a link to `/apps`) or choose a Claude account.
- Otherwise the Claude credential variables of the agent's own environment
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`),
  else the device's own login. A variable bound to a user secret
  (`user_secret_ref`, such as the saved Claude login a sign-in binds) holds
  each task's responsible person's own value from My secrets: the text says
  so, and whether the viewer has saved a Claude login
  (`GET /api/companies/:companyId/claude-oauth-token-status`); without one,
  under a required binding, their tasks cannot run. With the device's own
  login chosen these variables still apply, so the text names the ones to
  remove under Environment variables.

A choice saves at once (`PUT /api/agents/:agentId/ai-account`), apart from the
form's Save button, and applies from the next run. The field keeps the agent's
devices with their availability, the wait its tasks are in, the
migrated-assignment review and the reason it is read-only, and it links to
Company settings → Claude accounts to add an account. While the agent has no
row, the overview's Claude account row names its `aiConnection` as the picker
does (e.g. "Responsible user's connection"), or "Not set" without one. The
create flow, other adapters and a form switched to another adapter keep the AI
connection field; an agent moved to another adapter that still has a row shows
a notice there with Remove.

Sign-ins beside the field: the form shows no "Use saved login" bind for an
existing Claude agent. A sandbox environment whose Test reports missing
authentication (on a provider with a login terminal) still offers its sign-in
while the agent has neither a row nor an `aiConnection`: it saves the person's
Claude login under My secrets (or uses the one saved there) and binds
`CLAUDE_CODE_OAUTH_TOKEN` to each task's responsible person's saved login,
which the field then names. Once the agent has a row, the sign-in is hidden: a
pool run blanks the agent's own credential variables, and the variable would
override the device's own login.

Routes:

- `GET /api/companies/:companyId/ai-accounts[?agentId=]`: the accounts eligible
  in the company, with `canBind` per account; with `agentId` also `selectable`,
  `reason` and `warning`.
- `GET /api/companies/:companyId/ai-account-bindings`: every Claude agent and its
  binding. An agent moved off `claude_local` that still has a row is listed with
  `supported: false`. That row still holds a device slot, and removing it is
  always allowed.
- `GET /api/agents/:agentId/ai-account`: the binding with its candidate devices
  and options. Company members may read it, and an agent its own.
- `PUT /api/agents/:agentId/ai-account` with `{mode: "pool_account", accountId}`
  or `{mode: "device_login"}`, and `DELETE` to remove the row. A change answers
  with `appliesFrom: "next_run"`, the ids of running runs and any warnings, and
  wakes the agent's waits.
- `POST /api/agents/:agentId/ai-account/review`: a company admin confirms a
  migrated binding.

The two company lists are for board users; agent keys get 403.

**Audit.** Binding changes are logged in the agent's company as
`ai_account.binding_updated`, `ai_account.binding_cleared` (`DELETE`) and
`ai_account.binding_reviewed` (review). The boot backfill logs
`ai_account.binding_updated` as the system actor `ai-account-migration` (a
re-run, as the instance admin who started it), and an account removed with
`release` logs it for each released agent with reason `account_removed`.

**Who may bind.**

| Actor | May |
| --- | --- |
| An agent | Nothing: 403 `ai_account_binding_forbidden`, also through an environment change. |
| A company admin | Any change in the company: bind any eligible account, set `device_login`, remove the row. A company admin is the `local_trusted` board, a member with role owner or admin, or an instance admin with access to the company. |
| The account's owner (an active, non-viewer member) | Bind their own account while the agent is unbound, on `device_login`, on one of the owner's accounts, or in pool mode without an account. Set `device_login` or remove the row only while the agent is on one of the owner's accounts. |
| Anyone else | Read only. |

An instance admin who is not a member of the company gets 403 for binding
writes and for the company account and binding lists, and 404 for an agent's
binding.

**Eligibility.** An account is eligible in a company when its effective owner
(the owner, else the creator) has an active `user` membership there (in
`local_trusted` the local board counts as a member), it is neither paused nor
disabled by an admin, and any project reservation names a project of that
company. Listing, binding and every run start apply the same rule. When the
owner leaves the company, runs wait with `owner_not_member`. A signed-out
account cannot be chosen as a new selection; a limited one can, with a warning.

**The device limit.** A device uses at most 3 distinct pool accounts (its cap
is `min(maxAccounts, 3)`; instance admins may lower it). A binding is checked in
one transaction under an advisory lock:

1. who may bind (above), and that the agent is a `claude_local` agent;
2. eligibility;
3. the candidate environments: a pinned agent's environment, otherwise the
   inheritable defaults of the company's projects plus the company, instance and
   Local fallbacks;
4. each candidate maps to a device (otherwise 422 `ai_account_incompatible`,
   reason `device_unknown`) and accepts the account's credential type (reason
   `credential_type_unsupported`);
5. the cap: the distinct accounts bound to agents of any company whose
   candidate devices include the device, paused agents included. Over the cap:
   409 `device_account_limit` with `{deviceName, limit, inUse, accounts,
   otherCompaniesAccounts}`. `accounts` names only accounts eligible in the
   caller's company; other companies' accounts are a count.

Other refusals: 422 `ai_account_not_eligible` (a missing account and an account
that is not eligible here give the same answer; only `reserved_elsewhere` is
named), and 422 `ai_account_incompatible` with `adapter_unsupported`,
`account_signed_out` or `account_disabled`. At run time a slot table counts the
accounts running on the device, and an extra account waits for a free slot
(`device_slot_wait`).

An unpinned agent is checked against every candidate environment. One project
default without a device therefore refuses its bindings with `device_unknown`.
Pinning the agent to an environment fixes it.

**Moving a pool-bound agent.** A change of `defaultEnvironmentId` on a
pool-bound agent (`PATCH /api/agents/:id`, a revision rollback or a hire
approval) needs the account's owner or a company admin; agents get 403. The move
runs the binding checks for the new candidates under the bindings lock and is
saved in the same transaction; its config revision still records the
environment change. It can fail with 409 `placement_conflict` (the agent changed
meanwhile) or `device_account_limit`, or with 422 `ai_account_incompatible`
(`device_unknown`, `credential_type_unsupported`). An approval that moves a
pending hire holding a pool account runs these checks under the lock in the
transaction that decides the approval, and activation writes the environment
in that same transaction, so a refused check or a failed activation leaves the
approval pending and the hire where it was; other hires take their environment
at activation, as upstream does. Project, company and instance default-environment edits are never
refused for the cap; the devices are re-checked afterwards (see
[Over the limit](#over-the-limit)).

**Retired connection modes.** New or changed `company_pool` bindings are
refused for every adapter (422 `ai_connection_company_pool_retired`). A `router`
binding is refused for a `claude_local` agent (422
`ai_connection_router_unsupported`), because a router switches accounts by
itself. The checks cover agent create, update and hire, and a hire that would
inherit a router for a Claude agent. An existing agent that keeps its current
`company_pool` or router binding on the same adapter can still be renamed,
reconfigured and pinned. An agent-made hire that names no connection and would
inherit its hiring agent's `company_pool` binding gets the responsible user's
own connection (`responsible_user`, same provider and method); give it a Claude
account afterwards.

#### Binding backfill

Once, at boot, after the migrations and before the scheduler starts, a job binds
the agents that used a host pool or a company pool. Its marker is
`ai-account-bindings-v1` in `deferred_data_migrations`. A failure is logged and
recorded on the marker; boot continues, and the next boot tries again.

- **Candidates.** Non-terminated `claude_local` agents without a binding row
  that either have no `aiConnection` and have host-pool history (or run on a
  device with a usable legacy account), or have a `company_pool` binding. History
  means project- or shared-scoped host-pool runs in the last 45 days; overflow
  runs are ignored. Agents are processed by company, then creation time, then
  id. A re-run also takes the agents whose row an earlier run left unassigned
  while nobody has changed or reviewed that row, and gives the row an account
  only when the checks now pass.
- **Account choice**, first rule that applies:
  1. the agent's projects (from its runs in the last 45 days) map to exactly one
     reserved account;
  2. the account with the most history runs of this agent;
  3. the account with the most history runs of the agent's company on the
     agent's devices;
  4. none: the agent stays unbound, with a review note.

  A `company_pool` agent gets the pool account that holds the same credential
  (by fingerprint) as its member: the one it used last in the last 45 days,
  else the pool's first member by priority.
- **Checks.** Every choice passes the binding checks for a system actor: the
  owner's membership, reservations, an active account that no admin disabled, a
  device for every candidate environment (Local maps to the server device), the
  credential type, and the cap in processing order. A chosen account that fails
  a check never falls through to the next rule.
- **Outcomes.**
  - *Bound*: source `migrated_host_pool` or `migrated_company_pool`, with a note
    that names the rule. The row shows "review" until a company admin confirms
    it.
  - *Unassigned*: a binding without an account and the reason in the note, for
    agents over a cap and for agents with history whose account fails another
    check. They wait as `unassigned`, with a notice, instead of falling back to
    the device's login.
  - *Unbound*: agents without a choice, agents without history that fail a
    check, and `company_pool` agents that fail a check (they keep their pinned
    pool) stay as they are and are listed.

  `runtime_config` is never rewritten. `ai_account_projects`,
  `ai_connection_pool_members` and `ai_connection_quota_states` are not touched.

**Report and go/no-go.** `GET /api/instance/ai-accounts/migration` (instance
admins) returns the job's status and summary: bound agents, skips with reasons,
agents left unassigned or unbound with a review note, and devices over their
cap. Before the first run its status is `pending`. It also computes a go/no-go
list on every request. `POST /api/instance/ai-accounts/migration/run` runs the
job again: it adds missing bindings, and gives an account to the rows it left
unassigned (`pool_account` without an account, source `migrated_host_pool`)
that nobody has changed or reviewed since, once their checks pass, for example
after a plugin has reported the device of a sandbox environment that had none at
boot (the job runs before any plugin worker starts). Every other row stays as it
is. It answers 200 with the report even when the run failed (`status:
"failed"`, `lastError`). The instance page shows both, with "Run now" or "Run
again".

Go means every `claude_local` agent with a host-pool run in the last 7 days
plans to use its account, or only waits for that account's limit to reset
(`usage_limit` or `credit_balance`: the account resolved and passed every other
check, so the page lists it as a warning under "At their account's limit");
paused agents count too. Any other plan blocks go, and the instance page lists
the agent as "would wait: \<reason>", "would use its device's own login:
\<why>" or "would be refused: \<why>". Agents without a
binding row that use their own AI connection are left out, because their runs
never fall back to the device's login.

Before an upgrade, run the read-only report against the database:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/ai-account-pool-report.sql
```

It works on the schema before and after the upgrade.

**Snapshot rehearsal.** The rehearsal script runs the new image's migrations and
binding backfill on a restored copy of the database and prints the report with
its go/no-go. Copy production with a fresh read-only `pg_dump` (the 45-day and
7-day windows count back from the time of the run) into a throwaway Postgres
database whose name contains `rehearsal` or `snapshot`; on a cluster forked from
a backup, copy the database under such a name first (`CREATE DATABASE
paperclip_snapshot TEMPLATE <database>`). Do not use one of Paperclip's built-in
backups: their format keeps no CHECK constraints, and
`0374_smooth_killmonger` (applied in production as `0309`) drops the check on
`ai_account_hosts.kind`, so the rehearsal of a database without the pool would
stop there although production has the constraint. Fork: production applied the
five pool migrations as `0306`–`0310`; the upstream sync renumbered them,
byte-identical, to `0371`–`0375`, and the runner matches applied migrations by
hash, so a copy of that production database does not run them again. Its
pending set is upstream's `0306`–`0370` and the later fork migrations (`0376`).
Then run, from `/app` in the new image:

```sh
PAPERCLIP_REHEARSAL_DATABASE_URL='postgres://<user>:<password>@<host>:<port>/paperclip_rehearsal' \
PAPERCLIP_DEPLOYMENT_MODE=<production's deployment mode> \
  node --import ./server/node_modules/tsx/dist/loader.mjs \
  server/dist/scripts/ai-account-pool-rehearsal.js --snapshot > ai-account-pool-rehearsal.json
```

Pass production's deployment mode: without a config file the script falls back
to `local_trusted`, where the local board user counts as a member of every
company, so membership checks would differ from production's.

It applies the pending migrations as the server does at boot (the same runner,
journal repair first), runs the backfill as the system actor
`ai-account-migration`, and writes one JSON document to stdout
(`target`, `deploymentMode`, `migrations`, `backfill`, `report` with its
`goNoGo`, `verdict`, `error` and `exitCode`); progress and a readable summary go
to stderr. The exit code is 0 for go, 2 for no-go, and 1 for an error or a
refusal; a failed backfill exits 1 even when the go/no-go would pass. Because it
writes to the database it is given, it never reads `DATABASE_URL`, and it
refuses to run without `--snapshot`, without `PAPERCLIP_REHEARSAL_DATABASE_URL`,
with a URL that names several hosts, with a database name that lacks `rehearsal`
or `snapshot` (in the URL or as the server reports it), or on an empty
database. It starts no
scheduler, heartbeat, plugin worker or HTTP server, and prints no password or
credential. The deployment mode comes from `PAPERCLIP_DEPLOYMENT_MODE`, else the
config file, so run it in production's mode (the Docker image sets
`authenticated`).

As an optional extra check, for example to look at the pages, boot the new
image on a restored copy with the heartbeat scheduler off
(`HEARTBEAT_SCHEDULER_ENABLED=false`), on a host that cannot reach your devices
or outside services: a wake can still start a run, and installed plugins start
their workers. The boot runs the migrations and the binding backfill, unless the
rehearsal already ran them on that copy; then read the migration report. Fixes
made on a copy do not carry over: make them on the current image before the
deploy, or right after boot (see the
[Upgrade Guide](../../releases/fork-claude-account-pool.md#upgrade-guide)).

### Pool runs

At run start the binding decides the credential, in this order:

1. a persisted router selection keeps its upstream behaviour, but only while
   that same persisted run resumes;
2. the fork binding row of a `claude_local` agent: `pool_account` takes the pool
   path, `device_login` takes neither the pool nor an upstream binding;
3. the upstream `runtimeConfig.aiConnection`, including a pinned legacy
   `company_pool`;
4. the device's own login.

The pool path then checks the account again (the eligibility rule, the device,
the credential type and the limit) and takes a slot on the device: the device
row is locked, the accounts running there are counted, and an account that is
not yet running there waits when the device is full. A suspended (persisted)
native run keeps the credential it started with; it never waits and never
switches. If its pool account is no longer usable in the run's company
(removed, paused, disabled, signed out, or its owner left), the run is refused
with `ai_connection_changed`.

A pool run:

- strips the AI auth variables of the environment, agent, project and routine
  layers, blanks `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
  `CLAUDE_CODE_OAUTH_TOKEN`, and sets the account's own variable;
- deletes, never blanks, the credential carriers `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
  `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`,
  `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN`,
  `CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_HOST_CREDS_FILE`,
  `CLAUDE_CODE_HOST_AUTH_ENV_VAR`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and
  `ANTHROPIC_UNIX_SOCKET` (an empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` would
  select the device user's own stored login);
- sets the non-secret marker `PAPERCLIP_AI_CREDENTIAL_REF` (see
  [the per-account config directory](#ssh-secret-staging-and-the-per-account-config-directory));
- records `contextSnapshot.aiConnection` with `mode: "pool_account"`, the
  account, its owner and the device, and logs the run event `Using Claude
  account "<label>" (subscription | API key) on <device>`. The token is
  redacted like other secrets. The token's value is part of the session
  fingerprint (the `PAPERCLIP_*` marker is not), so another account, or a
  replaced token, starts a fresh provider session.

**Routing guard.** A pool run is refused (`ai_connection_incompatible`) when its
environment, agent, project or routine layer sets a routing override: a key
ending in `_BASE_URL` under `ANTHROPIC_` or `CLAUDE_CODE_`, any
`CLAUDE_CODE_USE_*` switch, `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` in any
case, `NODE_EXTRA_CA_CERTS` or `NODE_TLS_REJECT_UNAUTHORIZED`. It is also refused
when the project's `.claude/settings.json` or `.claude/settings.local.json` sets
such a key or a credential carrier in its `env` block, or sets `apiKeyHelper`,
`awsAuthRefresh` or `awsCredentialExport`. A remote target's project settings are
scanned on the target. A network that needs a proxy cannot run pool agents yet.
The blocked task gets the notice "AI account blocked by a conflicting setting",
which names the setting to remove.

**Limits.** Only the CLI's own result and error output (stderr) can mark an
account. A limit message found only in tool output or the transcript is a
transient failure of that run, and the account is unchanged. When both a limit
and a sign-in failure show, the limit wins.

- A typed reset is clamped to 7 days and 1 hour ahead (24 hours for an exhausted
  credit balance); a clamped value counts as estimated. Without a typed reset, a
  credit balance waits 24 hours, and other limits wait 1 hour, doubling with each
  limit in a row (1, 2, 4, 8, then every 12 hours). A provider reset replaces an
  estimate; between two values of the same kind the later one stays.
- Each run that hits the limit makes its task wait in `ai_account_wait`
  (`usage_limit` or `credit_balance`) until the reset plus up to 2 minutes of
  jitter. `ai_account.limit_reached` is logged once per limit episode.
- A run that the provider then serves on the account clears the limit and wakes
  the other waits, staggered.

**Sign-in failures.** A typed 401 or 403, or a second sign-in failure on another
run within 2 hours, marks the account signed out (`ai_account.signed_out`). Its
runs then wait as `signed_out` until the owner replaces the token. A first
untyped sign-in failure only makes that run wait 10 minutes as
`auth_unconfirmed`; the account is unchanged.

### Devices and ownership

An execution device (`ai_account_hosts`) is one machine. Environments reach it,
and several environments may reach the same device. Its kind is "Paperclip
server", "SSH host", "Computer over SSH" (a legacy host kind) or "Plugin
device" (a target an environment driver plugin reported).

**Identity.** The device of an environment is, in order:

1. an explicit mapping in `ai_account_host_environments`;
2. for Local, the Paperclip server device (key `local`), a pool device like any
   other;
3. for SSH, the device keyed `ssh:<host>:<port>` (host trimmed and lower-cased,
   port 22 when unset), created on first use. It is named `SSH · <environment
   name>` when the environment that first reached it is shared by every
   company, and `SSH host` when that environment is a company's own: every
   company that reaches the host sees the device's name, so a company's
   environment name never becomes it. Instance admins can rename it. The host
   and port appear only in the key and in instance-admin views;
4. for a sandbox, the plugin device of the same provider whose `configMatch`
   fields the environment's config contains, managed by the plugin that
   provides that sandbox;
5. otherwise none. Pool bindings to such an environment are refused, and pool
   runs on it wait as `device_unknown`.

Device names stay unique with a ` (n)` suffix. Migration
`0375_productive_veda` (applied in production as `0310`) set the keys of
existing hosts whose mapped environments agree on one host and port (and `local`
for the server host), so a new SSH environment on a known machine joins its
device. Hosts it could not key are listed by the pre-deploy report.

**Ownership is for display only.** A plugin may report a device's owner, and the
device pages show the owner's name or e-mail. Ownership never decides which runs
a device takes: any eligible pool account may run on any device, owned or not.
The plugin decides which companies and projects its devices serve. A report that
names an unknown user leaves the device unowned. Paperclip server and SSH devices
have no owner.

**Visibility.** A company sees a device when its agents' candidate environments
map to it, or when the plugin lists the company among those the device serves.
Other companies' accounts on it appear only as a count. The routes are for
board users only; agents get 403. `GET /api/companies/:companyId/devices` and
`…/devices/:deviceId` need company access and answer 404 for a device the
company cannot see. `GET /api/instance/devices` is for instance admins (keys,
environments, owner, cap, over-limit state, duplicate hints, and accounts with
labels). Instance admins rename a device and set its limit with
`PATCH /api/instance/devices/:id {name, maxAccounts}` (`maxAccounts` 1 to 3).
Only lowering a limit is refused: a `PATCH` that lowers `maxAccounts` below the
accounts bound on the device answers 409 `device_account_limit` with details
`{deviceId, deviceName, limit, inUse, accounts, otherCompaniesAccounts}`.
Raising a limit is never refused, also on a device over its limit, which stays
flagged until its bound accounts fit; a higher limit wakes its slot waits. A
name clash answers 409. The same limit rule holds for the legacy
`PATCH /api/instance/ai-hosts/:hostId`. A rename or limit change is logged as
`execution_device.updated` in the companies whose agents use the device.
A wait on a private task the viewer cannot read
([Private tasks](../ISSUE-PRIVACY.md)) shows under its agent, without the task's
id, identifier or title, and still counts in `waitingCount`; the inbox leaves
such waits out, and a PM's resource-wait summary lists only tasks the PM may
read.

**Mappings.** An explicit mapping is edited in Devices & Claude accounts → the
device card → Map environments (`PUT /api/instance/ai-hosts/:hostId/environments`).
Allowed drivers per kind: Paperclip server, local; SSH host, ssh; Computer over
SSH, ssh or sandbox; Plugin device, sandbox. An environment listed moves off
any other device, and one left out returns to the device Paperclip finds for
it. An edit is refused (409 `device_account_limit`, nothing written) only when
a device, including one an unmapped environment returns to, gains an account
over its cap; a device that already holds its accounts may take back an
environment, and a device already over its cap may keep its accounts and lose
environments. A mapping only places an environment for the cap; its leases and
availability still follow the target in its config.

**Legacy host routes.** Instance admins manage devices through
`/api/instance/ai-hosts` too: `GET` lists them, with each legacy account's
e-mail hint masked (`ab•••@example.com`) as `/api/instance/ai-accounts` does;
`POST` adds a Paperclip server, SSH host or Computer over SSH device (plugin
devices come only from their plugin's reports); `PATCH /:hostId` renames it or
changes its limit (the rule above); `DELETE /:hostId` removes it; and
`PUT /:hostId/environments` replaces its mappings. A malformed device id
answers 404 on `PATCH`, `DELETE` and `PUT …/environments`. Removing a device is
never refused: its mappings go with it, and afterwards every device is
re-checked, with the over-limit flag and notice. A rename, limit or mapping
change is logged as `execution_device.updated` (details `deviceName` and
`changedKeys`; for a mapping edit also the names of the environments that
company can see, and `otherEnvironments`, a count of the others), a removal as
`execution_device.deleted`, each in the companies whose agents use the device
(for a mapping edit, before or after it). A rename or limit change that changes
nothing logs nothing; `changedKeys` lists only the fields that changed. Adding
a device logs nothing, because no agent uses it before an environment is mapped
to it. The two retired account routes answer 410 with `details.replacements`
(see [Host account pools](#host-account-pools-fork-deprecated)).

**Linking duplicates.** One machine reached two ways, for example over an SSH
tunnel and as a plugin target, would be two devices with two caps. An instance
admin links them with `POST /api/instance/devices/:id/link-target {pluginId,
provider, targetKey}`. It writes the plugin target onto an existing SSH host or
Computer over SSH device, so later reports update that row, and it merges the
separate plugin device into it: run slots, mappings and open waits move, then
the plugin device is deleted. Only SSH host and Computer over SSH devices take a
link; other kinds get 409. The route answers 404 for an unknown device, or a
plugin that is not installed or does not provide the provider, and 409 when more
than one installed plugin provides it, the device is already linked to another
target, or the target is linked to another device. Linking the same target
again changes and logs nothing. Linking is never refused for the cap; an
over-cap result sets the over-limit flag. A link is logged as
`execution_device.linked` in the companies whose agents use the device.

A link-target merge moves the merged row's open waits to the linked device. A
slot wait keeps its episode, keyed by the linked device: its start, banner and
notices carry on, and it shares that device's over-limit inbox item. The
over-limit notice and `execution_device.over_limit` are recorded before the
waits are woken; a failed wake is only logged.

A plugin device that is likely the same machine as an SSH device, because a
hostname it reports matches the SSH key's host or its label equals an SSH
environment's name, shows "Likely the same machine as \<device>". Instance admins
can link it from that hint, on the instance page or on the company Devices page.

**Reinstalled plugins.** A target is identified by its provider and the plugin's
own target key. A reinstalled plugin (with a new plugin id) takes over the
devices of its uninstalled predecessor on its first report or link, with their
names, mappings, slots and links. A device of a plugin that is still installed is
never taken over. Until that first report its environments plan as
`device_unknown`.

#### Over the limit

Some changes cannot be refused at once: project, company and instance
default-environment edits, plugin target reports and environments a plugin
creates. They can leave a device with more bound accounts than its cap. After
such a change the devices are re-checked. A device over its cap gets
`over_limit_at` and shows "Over limit", and its runs wait for a device slot.
Each company whose agents count toward it gets one `execution_device.over_limit`
activity entry (actor: system `ai-account-pool`; details `{deviceName, limit,
inUse}`) and an inbox item "\<device> is over its Claude account limit" (source
"Waiting", high severity), once per flag. The item shows while the flag stays,
and the slot waits of that flag share it. The entry is written when the flag is
set, never when it clears. A device that fits again, for example after a
binding is cleared, loses the flag, so a later overflow is noticed again. A
link-target merge that leaves a device over its cap sets the same flag, with
the same entry and inbox item.

Device edits (`execution_device.updated`), removals (`execution_device.deleted`)
and links (`execution_device.linked`) are logged only in the companies whose
agents use the device, and a device check (`execution_device.checked`) only in
the company that asked for it. Adding a host logs nothing, because no agent
uses it before an environment is mapped to it.

### Waiting states

A run whose device, account or device slot is not available does not fail. It
ends as a deferral, and a waiting run takes its place:

- **The deferral** is the run, cancelled before any provider work. The
  cancellation is expected, the error code is `environment_unavailable`,
  `ai_account_unavailable` or `device_slots_full`, and
  `resultJson.executionRecovery` is `{kind: "resource_wait", providerWorkStarted:
  false}`. It uses no failure retry and no daily run cap slot, raises no error
  report and starts no legacy reconciliation. The run list shows it as "Waited".
- **The waiting run** is a `scheduled_retry` run in a wait lane. It keeps the
  task's execution lock, so the task stays in progress and the agent stays idle.
  Its `contextSnapshot.resourceWait` (version 1) names the kind, reason,
  environment, device, account and the expected resume time with its source.
- **The episode** (`resource_wait_episodes`) is the wait people see. A task (or an
  agent, for runs without a task) has at most one open episode, which keeps its
  start time and notice state across every replacement run. A deferral for
  another resource closes it and opens a new one.

The wait ends, with the event "Resumed" and `resource_wait.resolved`, only after
the step that waited succeeds for that run: the lease for a device wait, the slot
for an account or slot wait. The task shows a banner such as "Waiting for device
\<name> (offline since 13:02)" that says it starts automatically and names the
agent whose run waits, with a link to that run. The run ledger folds
consecutive deferrals into one "Waited: \<reason>" entry. A waiting task never
shows a failed run or the blocked status. A resolved interaction continuation
keeps its identity while it waits, and its usual claim checks still apply when
it runs.

| Lane | Scope | Reasons | Held until | Notice |
| --- | --- | --- | --- | --- |
| `environment_wait` | target | `offline`, `paused`, `maintenance`, `updating`, `unreachable` | The registry shows the target available, or a report or check changes it; once its row is 10 minutes old, the oldest wait makes one real attempt | After the notify-after hours |
| `environment_wait` | admission | `not_allowed`, `not_serving` | A plugin wake; otherwise an attempt every 5 minutes, doubling to 60 | At once |
| `environment_wait` | admission | `stopped` | As above | None |
| `environment_wait` | admission | `busy`, `throttled` | The driver's `retryAfter`, else 60 s (`busy`) or 30 to 60 s (`throttled`) | After the notify-after hours |
| `environment_wait` | admission | `restarting`, `plugin_upgrade_pending` | The plugin is installed, enabled, upgraded or loaded again; otherwise 30 s (`restarting`) or every 5 minutes, doubling to 60 | After the notify-after hours |
| `environment_wait` | admission | `other` | The driver's `retryAfter`, or 60 s doubling to 10 minutes | After the notify-after hours |
| `ai_account_wait` | account | `usage_limit`, `credit_balance` | The reset plus up to 2 minutes; at the reset one waiting run goes first as a probe | At once, once per limit |
| `ai_account_wait` | account | `auth_unconfirmed` | 10 minutes, for this run only | None |
| `ai_account_wait` | account | `signed_out`, `withdrawn`, `unassigned`, `owner_not_member`, `reserved_elsewhere`, `device_unknown`, `credential_type_unsupported` | A database check every 60 s ± 20 %, plus event wakes | At once |
| `device_slot_wait` | device | `slots_full` | A free slot, first in first out; checked every 60 s ± 20 % | At once |

A target-scope reason means the target is down for everyone: it is recorded in
the availability registry, and every company's runs on that environment wait. An
admission-scope reason concerns this run only.

**Refusals.** Only real configuration problems block a task (as
`configuration_incomplete`), each with a notice that names the fix:

- `environment_refused`: the driver refused the run with `retryable: false`, or
  the device was removed. Notice: "Execution device refused the run"; it names
  the device (or else the environment) and the move to another environment.
- `ai_connection_incompatible`: a routing override or a conflicting
  authentication setting (see [Pool runs](#pool-runs)). Notice: "AI account
  blocked by a conflicting setting".
- `ai_connection_changed`: the account of a suspended native run changed or is
  gone. Notice: "AI account of a suspended run changed"; start a new execution,
  because a suspended run never continues on another account.

For these three reasons the board recovery action's next action names the same
fix as the notice.

**Holding and waking.** Each scheduler tick checks the due waiting runs before
promotion, with database reads only. At most every 5 minutes it also checks the
task: a task that was closed, reassigned, blocked, paused or stopped by its
budget ends its wait, releases its lock and gets no notice. A wait is re-armed
with a compare-and-set, so a wake that arrives meanwhile is never lost. Waits
wake on events: a plugin report of an available target, a `wake` flag, a retired
target or a change of accepted credential types; a successful check; a
sandbox provider plugin that is installed, enabled, upgraded or loaded again
(its environments' `restarting` and `plugin_upgrade_pending` waits); an account
change (limit cleared, token replaced, resumed, re-enabled by an
admin, transferred, reservation cleared, a served run after a limit); a binding
set or cleared, or an agent's environment changed; and Check now. Membership
changes have no hook; the 60-second check picks them up. An issue monitor that
falls due while its task waits is moved past the wait, at least 15 minutes
ahead, without counting an attempt.

**Probes.** At an account's reset exactly one of its waiting runs goes first:
the one whose wait is oldest. The others hold. If the provider serves it, the
limit clears and the rest are woken, staggered over up to 2 minutes; if it hits
the limit again, the next, longer estimate starts within the same episode. A
probe that has not started within 15 minutes is released. Clearing the limit
releases every waiting run at once. So a limit without a typed reset costs one
failed attempt per estimate, not one per waiting task.

**Check now.** On a waiting task, Check now
(`POST /api/issues/:id/scheduled-retry/retry-now` for a lane run, board users)
first forces a check of the resource, then promotes the run only if the resource
is available. Otherwise it answers 409 `resource_still_unavailable` with the
fresh wait, shown as "Still unavailable (checked just now)". An admission-scope
wait gets one real attempt. It works once per minute per task (429
`check_now_rate_limited`, with `details.retryAfterMs`). The task banner and
Check now act on the same waiting run: the task's open wait's current run
first, then the task's execution run.

On a device card, Check now
(`POST /api/companies/:companyId/devices/:deviceId/check-now`) is for active
non-viewer members and company admins (an instance admin with access to the
company counts as one). It checks the device's environments that the company
can use, in that company's context, then wakes their waits, and answers
`{checkedAt, device, woken}`. It works once per minute per device and company
(429 `check_now_rate_limited`, with `Retry-After: 60` and
`details.retryAfterMs`), and answers 404 for a device the company cannot see.
Each device check is logged in that company as `execution_device.checked`.

**Comments on waiting tasks.** Only a person's comment on an in-progress task
assigned to an agent triggers a check. Such a comment leaves the task's status
and its waiting run as they are, and it never cancels a queued or running wait
run. It joins the wait and triggers a check: a forced check for a target outage,
a database check otherwise. It spends no admission attempt and never answers
409. A comment's check has its own once-a-minute slot per task, separate from
Check now's: Check now right after a comment still checks, and a second comment
within the minute skips its check (the comment itself is never refused).

**Notices.** All notices are company-scoped, and a key in
`resource_wait_notices` makes each one post only once.

- On the task: an immediate notice for limits and for problems a person must fix,
  which names the fix (replace the token, resume or choose an account, enable the
  project on the device, move the agent); a long-wait notice for device waits
  after the notify-after hours ("This task has been waiting for device \<name>
  for 24 h …"); and "Started after waiting \<duration>." when a notified wait
  ends. The limit notice says: "Waiting for Claude account \<label>: usage limit
  reached. Resumes automatically at \<time> (provider reset | estimated).
  Paperclip never moves a task to another account. The owner can clear the limit
  after checking."
- To the manager agent: one wake per manager, resource and outage, with reason
  `resource_wait_notice`, no task id, and up to 20 of the company's tasks that
  wait for that resource in `contextSnapshot.resourceWaitNotice`. It always
  gets a run of its own; a later wake merged into that queued run keeps the
  summary, and so does the run's successor if the summary run itself has to
  wait. The manager is the agent that created the task when that is not the
  assignee, otherwise the assignee's manager. The wake is skipped when the
  manager uses the same account or the same unavailable device.
- In the inbox (source "Waiting"): one item per resource episode. All tasks
  that wait for one account limit episode share an item; so do all waits on one
  environment outage (the registry's `unavailable_since`) and all waits under
  one device over-limit flag. Otherwise there is one item per task wait and
  reason. Limits are medium severity, everything else high. Limits and problems
  a person must fix appear at once; device waits appear only after the
  notify-after hours. There is no item for `stopped` or `auth_unconfirmed`, for
  closed or hidden tasks, or for waits the task check has ended. A dismissal
  holds for the whole resource episode, and the item disappears when its waits
  end. Inbox items for waits have subject kind `resource_wait`; the id is the
  item's dedup key. While its wait lasts, an item is a decision source:
  - board users who can read its task may set triage (decide-by, snooze), keep
    or archive it, and add it to decision queues; it is board-only when it has
    no task;
  - the PR seed queue may pick it up.

  Once the wait ends, writes on it answer 404 and queue rows for it are hidden.
- Activity: `resource_wait.started`, `resource_wait.long_wait_notified` and
  `resource_wait.resolved`.

**Notify hours.** Company settings → Devices → Waiting notifications, for
company admins (`GET` for members and `PUT` for admins on
`/api/companies/:companyId/execution-wait-settings`):

- "Notice after a task waits for its device for" (`notifyAfterHours`):
  "Instance default" (`null`), a number of hours up to 168, or "Never" (`0`);
- "Wake the task's manager agent right away for usage limits and problems a
  person must fix" (`notifyPmOnAccountWait`, on by default);
- "Also wake the task's manager agent when a device wait reaches the notice
  time" (`notifyPmOnDeviceWait`, off by default).

Changes are logged as `company.execution_wait_settings_updated`. The instance
default comes from `PAPERCLIP_RESOURCE_WAIT_NOTIFY_HOURS`: 24 when unset, 0 for
never, and values above 168 count as 168.

**Availability registry.** `environment_availability` holds one row per
environment, for target-level states only; a missing row means available. It is
written by classified target-scope lease errors, plugin reports, sweep checks,
and a successful lease after an outage. An `unavailable` row holds runs only
while its last check is less than 10 minutes old. Once it is older, the oldest
wait on the environment makes one real lease attempt, whose result refreshes
the row, and the others re-check every 60 s. Checks back off
`min(30 s × 2^failures, 10 min) ± 20 %`, never earlier than the driver's
`retryAfter`. When the last wait on an environment ends, its row is deleted,
unless the target was retired. A retired target refuses
new runs, and its existing waits end as `environment_refused` with the message
"\<device> was removed; move \<agent> to another device".

SSH lease errors (ssh exit 255) are classified from stderr. A host that cannot be
reached (connection refused or timed out, no route, network unreachable, host
down, a name that does not resolve, or a banner exchange that times out, as a
sleeping computer behind an open tunnel does) waits as target `unreachable`. A
closed or reset connection or a failed key exchange, the usual sign of sshd
`MaxStartups` during a burst, waits as admission `throttled` for 30 to 60 s and
leaves the registry alone. `Permission denied` and host key failures stay
configuration errors. A sandbox provider plugin whose worker is not running
waits as `restarting`, and one in `upgrade_pending` as `plugin_upgrade_pending`.

**Sweep.** A sweep runs on every heartbeat scheduler tick while scheduling is
not suppressed, under an advisory lock. It runs up to 5 availability checks
(15 s each: a plugin's `environmentCheckAvailability`, or the SSH environment
probe in a waiting run's company), releases probe claims whose run has not
started within 15 minutes, prunes the slots of runs that ended more than 24 hours
ago, abandons episodes whose run ended more than 10 minutes ago without a newer
waiting run, deletes idle registry rows and sends due notices.

A fault in the wait code never switches accounts: a failing preflight lets the
run go on to its lease, and a failing limit or sign-in handler falls back to the
normal retry path.

**Kill switch.** `PAPERCLIP_ENVIRONMENT_WAITS=off` (also `false`, `0` or
`disabled`) turns device waits off. The server reads it once at startup, so a
change needs a restart (a container restart in Docker). With it off, the
environment preflight and the classification of lease errors are off, so
environment errors fail runs as before this release (`setup_failed`), and every
waiting `environment_wait` run gets one real attempt on the next tick. Account
and slot waits cannot be switched off, because they replace failover.

### Plugin targets API

An environment driver plugin (one that declares a `sandbox_provider`) can take
part in waits and in device identity. Plugins bundle the SDK
(`@paperclipai/plugin-sdk`), so only a rebuilt plugin uses this API. It adds no
capability, error code or manifest field: the worker→host methods need the
existing `environment.drivers.register` capability.

**Unavailable envelope.** A driver throws `PluginEnvironmentUnavailableError`
from acquire, resume, realize, execute or checkAvailability when its target
cannot take the run now. The worker forwards only the validated envelope as
JSON-RPC error data (`paperclip/environment-unavailable/v1`):

| Field | Meaning |
| --- | --- |
| `scope` | `target`: the target is down for every company. `admission`: this run only. |
| `reason` | Target scope: `offline`, `paused`, `maintenance`, `updating` or `other`. Admission scope: `stopped`, `busy`, `not_allowed`, `not_serving`, `restarting` or `other`. |
| `retryable` | `false` is a refusal: the run fails as `environment_refused`. |
| `targetKey`, `targetLabel` | The target; the label is at most 80 characters. |
| `retryAfter` | An ISO time to try again, at most 7 days ahead. |
| `message` | Plain text for people, at most 300 characters; never provider internals or secrets. |

The host finds the envelope on the error, its `.cause` chain or JSON-RPC error
data, up to six levels deep. An older host ignores it.

**`projectId`, negotiated.** `PluginEnvironmentDriverBaseParams` has an optional
`projectId`. A plugin opts in with `definePlugin({ environmentDriverFeatures:
{ projectId: true } })`, and its worker then advertises
`feature:environment.projectId` in `supportedMethods`. Only then does the host
send the `projectId` key: the run's project (or `null` for a run without one)
on a run's acquire and resume, and `null` on checkAvailability. Probes, device
logins, setup-token leases and native export resumes never carry it. A worker
that does not advertise the marker never receives the key.

**`environmentCheckAvailability`** (host→worker, optional). Defining
`onEnvironmentCheckAvailability` advertises it. It must be cheap, free of side
effects and target-level only: no company or project admission. It returns
`{state: "available"}`, `{state: "unavailable", unavailable}` with a target-scope
envelope, or `{state: "unknown"}`. The host calls it only from the sweep while
runs wait, with a 10-second timeout. Without it, or with an unknown answer, the
registry row is left to go stale: once it is 10 minutes old, the oldest wait on
the environment makes one real attempt, and the others re-check every 60 s.

**`ctx.environments.reportTargets`** (worker→host). The plugin reports the state
of its targets:

```ts
{ driverKey: string; targets: Array<{
  targetKey: string; label: string; configMatch: Record<string, string>; // 1–3 entries
  state: "available" | "unavailable"; reason?: string; message?: string; retryAfter?: string;
  acceptedCredentialTypes?: Array<"subscription" | "api_key">;
  ownerUserId?: string | null; // display only
  servedCompanyIds?: string[]; // at most 200; device visibility only
  aliases?: string[];          // at most 5 hostnames; the duplicate hint
  wake?: boolean; retired?: boolean;
}> } // at most 500 targets → { accepted: number }
```

Host rules:

- `driverKey` must be a `sandbox_provider` the caller declares and no other
  installed plugin declares, and it may not be a built-in provider; otherwise
  `CAPABILITY_DENIED`.
- A malformed call or more than 500 targets refuses the whole call. Each target
  is validated on its own: invalid targets and repeated keys are dropped and
  logged without their values, and the rest are saved.
- `configMatch` lists top-level string config fields, never `provider`;
  `reason` is a target reason. A report is the full state of a target: an
  omitted owner, served companies or aliases means none.
- Each target upserts its device by target key, records the plugin and the
  report time, and writes its state onto the availability rows of every active
  environment of that provider whose config contains `configMatch`. Each target
  is saved in its own transaction.
- `acceptedCredentialTypes` says which pool credentials runs on the target
  accept. If it is omitted, or the last report is older than 15 minutes, binding
  and planning assume `subscription` only, so report well within that time.
- After the commit: a target that became available wakes the target-scope waits
  on its environments; `wake: true` and `retired: true` wake every wait there
  (a retired target's waits then refuse); a change of accepted types wakes the
  target-scope waits and the account waits for `credential_type_unsupported`
  there. An owner change alone wakes nothing. Woken runs start right away.
- New matches re-check the device caps (see [Over the limit](#over-the-limit)).
- If a valid target cannot be saved, or a wake fails, the call throws after the
  rest is saved; send the report again.

The call carries no company, so a plugin may also call it outside invocations,
for example from a timer.

**`ctx.environments.ensureCompanyEnvironment`** (worker→host). It finds or
creates the driver's environment for one company:
`{companyId, driverKey, name, description?, config, match}` →
`{environmentId, name, created}`.

- Allowed only inside a `performAction` invocation whose host-derived actor is a
  board user with write access to `companyId`: the local board in
  `local_trusted`, an active non-viewer member, or an instance admin with a
  membership. It is denied in `getData`, `onEvent` and `executeTool`.
- The caller must be the only installed plugin that provides `driverKey`, and it
  may not be a built-in provider.
- It is idempotent per company, driver and `match`, under an advisory lock: an
  active environment of the same company whose config contains `match` is
  returned with `created: false`. Shared and archived environments are not
  reused.
- `config.provider` is forced to the driver key. `config` is at most 4 KB as
  JSON and must contain `match` (1 to 3 fields). It may not hold `envVars`,
  secret references, or any value at a secret-ref field of the provider's config
  schema. The plugin's `validateConfig` is not called. The name is made unique
  with ` (n)`.
- The new environment's availability starts from its device's last report, read
  under a share lock, so a report still in flight lands first. Activity:
  `environment.created` with actor type `plugin`.

**Invocation facts.** The host adds `method` and `actor {type, userId}` to the
invocation scope, and `isInstanceAdmin` to the `performAction` actor context:
true for a board actor that is the local board or an instance admin, false for
other board actors, unset for others. Workers never supply these, and a plugin
reads a missing `isInstanceAdmin` as false.

**Error codes.**

| Code | When |
| --- | --- |
| `INVOCATION_SCOPE_DENIED` (-32005) | ensureCompanyEnvironment outside a `performAction` by a board user with write access to the company. |
| `CAPABILITY_DENIED` (-32001) | A driver key the plugin does not provide alone, a built-in provider, or a missing `environment.drivers.register` capability. |
| `INTERNAL_ERROR` (-32603) | Any other host error, with a message. |
| `METHOD_NOT_FOUND` (-32601) | Only from an older host that predates the methods. Stop calling them, and create environments through the admin REST API. |

Compatibility:

| Host | Plugin | Effect |
| --- | --- | --- |
| This release | Rebuilt, opted in | Everything above. |
| This release | Not rebuilt | No `projectId`. No envelope, so an unavailable target still fails runs as `setup_failed`. No reports, so its environments have no device and pool bindings to them get 422 `device_unknown`. |
| Previous image | Rebuilt | The envelope is ignored. Both host methods answer `METHOD_NOT_FOUND`. |

A rebuilt plugin installed from a local path that adds a capability cannot use
`POST /api/plugins/:pluginId/upgrade`: the route stops the plugin, then refuses
the new capability with a 400 and leaves the plugin `ready` without a worker.
Copy the new files into the plugin's directory and call
`POST /api/plugins/:pluginId/disable` and `POST /api/plugins/:pluginId/enable`
back to back; the activation reads the new manifest, and the instance admin who
enables the plugin approves its capabilities. See the release notes'
[Upgrade Guide](../../releases/fork-claude-account-pool.md#upgrade-guide) and
[Local plugin development](../plugins/LOCAL_PLUGIN_DEVELOPMENT.md#local-path-plugins-vs-npm-packages).

### SSH secret staging and the per-account config directory

**SSH secret staging.** Secret values never ride the ssh command line. Only
values under a short list of known non-secret names ride it: `PATH`, `HOME`,
`PWD`, `SHELL`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LANGUAGE`, `TZ`, `TMPDIR`,
`NVM_DIR`, `NODE_OPTIONS`, `NODE_PATH`, `LC_*`, `XDG_*`, `CLAUDE_CONFIG_DIR` and Paperclip's run identifiers
(`PAPERCLIP_RUN_ID`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`,
`PAPERCLIP_TASK_ID`, the wake, approval and linked-issue ids and
`PAPERCLIP_AI_CREDENTIAL_REF`), unless the name looks secret (the shared
`SENSITIVE_ENV_KEY` pattern) or the caller lists it in `secretEnvKeys`. Every
other value is staged first, because a secret can be bound to any name, such as
`DATABASE_URL` or `GH_PAT`. A separate ssh call writes them as
`KEY='value'` lines over stdin into a private file (`umask 077`, a `mktemp -d`
directory under `${TMPDIR:-/tmp}`), without sourcing any login profile. The main
command then sources the login profiles, unsets the run's unset list, exports the
staged values, deletes the directory and starts the command with only the
known non-secret keys on its command line. An exit trap removes the file when
the script stops early, and the host removes it best effort after an ssh
failure. The run's own values therefore win over values a profile exports.
Bridge start and other SSH commands stage values the same way. Staging costs one
extra ssh connection for each command that carries a value to stage, which
every SSH agent run already does for its API key.

A pool run on an SSH target also unsets, after the login profiles, the provider
routing keys (`*_BASE_URL` under `ANTHROPIC_` and `CLAUDE_CODE_`, every
`CLAUDE_CODE_USE_*`), the proxy and TLS keys (`HTTP_PROXY`, `HTTPS_PROXY` and
`ALL_PROXY` in any case, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`)
and the credential carriers. Names are matched by pattern as well as by list,
so a profile can neither route the run elsewhere nor hand it another credential.

**Remote targets get the run's environment only.** On sandbox and SSH targets,
install steps, resolvability probes and similar commands of claude-local and the
other audited local adapters are built from the run's environment, never from
the server's own process environment (`DATABASE_URL`, `BETTER_AUTH_SECRET` and the
server's `PAPERCLIP_*` keys stay on the server).

**Per-account Claude config directory.** The marker
`PAPERCLIP_AI_CREDENTIAL_REF` is the first 16 hex characters of
`sha256("paperclip-ai-account:" + accountId)`. It names the account and is not a
secret. When a run on a sandbox or SSH target carries it, claude-local uses the
account's own config directory, `config-<ref>`:

- on a sandbox, under the run's `.paperclip-runtime/claude`;
- on SSH, in a stable place on the host, outside every per-run directory and
  worktree: `<remote workspace>/.paperclip-runtime/claude/config-<ref>`, or
  `.paperclip-device/claude/config-<ref>` for device workspaces. Its sessions
  survive for `--resume`.

Each run seeds the directory again from settings with `env`, `apiKeyHelper`,
`awsAuthRefresh` and `awsCredentialExport` removed, and it removes
`.credentials.json` and `credentials.json` instead of copying them from `$HOME`.
With the marker this directory wins over an explicit `CLAUDE_CONFIG_DIR`. So on
these targets each account keeps its own directory and stored login per device,
and the device user's own login and user-level settings can never back a pool
run. Local pool runs keep today's config directory. Without the marker nothing
changes.

### Known residuals

- **Local trust (pre-existing).** The Paperclip server (Local) is a pool device,
  as before this release. Local child processes inherit the server's process
  environment, `DATABASE_URL` and `BETTER_AUTH_SECRET` included when the server
  has them; only the server's `PAPERCLIP_*` keys are removed, apart from its API
  URL, listen host and port. They run as the server's OS user, which can read
  the master key file; the local process sandbox is opt-in per agent. Any Local
  run, pool-bound or not, can therefore read the master key and could decrypt
  every pool credential. Local pool runs also keep the server user's config
  directory, so that user's stored login and user-level settings still apply to
  them. Carrier keys and proxy variables set
  on the server process itself are neither removed nor refused for Local runs:
  the routing guard checks only the run's own environment layers. Treat every
  agent that runs on the server as able to read every pool credential.
  Hardening Local execution is a separate project.
- **Upstream project-auth walk.** Pool runs also reuse upstream's managed
  project-auth check (`assertManagedAiProjectAuth`) unchanged. Its local and
  remote walks still pass through `$HOME`, with its own narrower pattern
  (`apiKeyHelper`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, …). A remote device user whose own
  `~/.claude/settings.json` sets one of these therefore blocks pool runs on that
  device, although the run reads its own `config-<ref>` directory.
- **Shared OS users.** Runs under one OS user on one device (the server, one SSH
  user, one computer) can read each other's environment, including a concurrent
  pool run's token. This release accepts that.
- **Pausing an agent.** `POST /api/agents/:id/pause` cancels the agent's waiting
  runs at once. Upstream's release-time recovery then records a stranded-task
  board escalation for each in-progress task, as it does for a paused agent's
  queued or running work. A pause that the next tick's task check sees ends the
  wait with no recovery entry.
- **A manager at its daily run cap** (`maxDailyRuns`) skips the summary run while
  the notice key stays claimed. The task notice and the inbox item remain.
- **User-continued legacy turns.** A user-continued legacy turn whose task claim
  was released before cleanup falls back to the provider-quota monitor. It still
  waits for the same account.

### Pool verification

```sh
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
pnpm exec vitest run packages/shared/src/ai-account-pool.test.ts server/src/__tests__/ai-account-pool.test.ts server/src/__tests__/ai-account-pool-routes.test.ts server/src/__tests__/ai-account-pool-migration.test.ts server/src/__tests__/ai-account-pool-migration-job.test.ts server/src/__tests__/execution-devices.test.ts server/src/__tests__/heartbeat-ai-accounts.test.ts server/src/__tests__/heartbeat-ai-account-pool.test.ts server/src/__tests__/heartbeat-resource-waits.test.ts server/src/__tests__/resource-waits-hold.test.ts server/src/__tests__/resource-waits-notify.test.ts server/src/__tests__/resource-waits-classify.test.ts server/src/__tests__/plugin-environment-targets.test.ts server/src/__tests__/app-ai-account-pool.test.ts server/src/__tests__/openapi-routes.test.ts
pnpm exec vitest run server/src/__tests__/execution-devices-routes.test.ts server/src/__tests__/ai-account-hosts.test.ts server/src/__tests__/attention-resource-waits.test.ts server/src/__tests__/issue-comment-resource-wait.test.ts server/src/__tests__/recovery-resource-wait-refusal.test.ts server/src/services/recovery/resource-wait-refusal-next-action.test.ts server/src/__tests__/ai-connection-pool-pinned.test.ts server/src/__tests__/ai-account-pool-rehearsal.test.ts
pnpm exec vitest run packages/plugins/sdk/src/environment-availability.test.ts packages/adapter-utils/src/ssh-secret-staging.test.ts packages/adapters/claude-local/src/server/execute.pool-config.test.ts
```

The server resolves the SDK through its build output, so build it after an SDK
change before the server suites run.

## Storage and API

AI connections pair `connectionPurpose: ai` with `transport: runtime_auth`.
Database checks and the shared discriminator enforce the pair. These entries
cannot participate in tool discovery, MCP gateways, execution, or channels.
Anthropic offers Claude subscription and Claude API key; the unsupported duplicate REST API option is excluded. Catalog
validation also pairs AI metadata with runtime authentication and rejects unsupported
sign-in methods. Provider artwork and source provenance live in
`ui/public/brands/apps/manifest.json`; OpenRouter uses its official sign-in assets,
and OpenAI/Grok reuse the repository's pinned Lobe Icons source and license.

Provider/method metadata lives in `config.ai`. Credentials live on the existing
grant through encrypted vault secret references, with existing consumer bindings.
Safe provider-reported account identity is optional; secret references, tokens,
and authentication paths are never account labels.

Company-scoped `/api/companies/:companyId/ai-connections` operations provide list,
API-key creation/reconnect, personal defaults, completed login references,
active-run attribution, and the
[company account pool](#company-account-pool-deprecated) (deprecated;
`GET`/`PUT .../pool`, `POST .../pool/:connectionId/clear-limit`). The list includes `canManageConnections`, evaluated by
the same server permission check as creation, including custom
`tools:manage_connections` grants. Existing Connections operations handle naming,
access, and revocation. Mutation authorization is enforced server-side. OpenAPI documents the new board-only
operations. Agent-originated configuration and environment tests resolve the
authenticated request’s responsible user; an agent ID is never a personal-account
owner. A missing responsible identity blocks personal-default resolution.

Subscription login attempts retain their company, owner, method, access intent,
and reconnect target in the existing durable authentication session. Duplicate
completion returns the same connection/grant. Abandoned or expired attempts cannot
save a healthy connection. Reconnect preserves the connection ID, bindings,
customized name, and access settings. A completed connection remains even if
subsequent agent creation fails or is cancelled.

Account adoption during Save and the agent runtime test use the selected agent
environment, or the instance default when no override is set. An unavailable
remote environment blocks validation rather than probing the server host. The
runtime test accepts the form’s prospective adapter selection before it is saved.
For a saved-agent test, omitting `environmentId` uses the agent’s saved override.
Sending `environmentId: null` tests a change back to the instance default.

## On-demand usage limits

The AI account detail has **Check usage**. It reads the selected account only
when requested; opening the account, listing connections, and starting either
runner do not invoke this probe. There is no scheduling, provider selection,
quota enforcement, credit purchase, or automatic retry attached to it.

`aiConnectionService(db).probeUsage(companyId, userId, connectionId, grantId?)`
is the common server operation for legacy and native runner connections.
`GET /api/companies/:companyId/ai-connections/:connectionId/usage?grantId=...`
exposes it to board users. The UI client calls `aiConnectionsApi.probeUsage`.
The optional grant ID must belong to this connection; omit it only when exactly
one authorized grant exists. The company membership, personal owner/shared human
audience, connection lifecycle, and credential ownership checks run before any
provider request. Agent API keys cannot call this board endpoint. Internal
execution callers must also use the normal runner connection selection checks
for agent installation and responsible-user authority before using its result.

The returned `AiConnectionUsage` contains a timestamp and probe status (`ok`,
`unsupported`, `unavailable`, or `error`), provider/source, every reported limit
window, model/feature scope, exact window duration when known, reset time,
utilization/remaining percentage, absolute allowance when reported, and overage
settings/balance. The list summary advertises `usageProbeSupported`.
`limitReached` describes that window; `allowed` preserves explicit provider
admission for its limit group. A model-specific exhausted window must not be
treated as an account-wide denial. Codex workspace spend controls are also
returned when present. Percentages remain provider percentages: 0.5 means 0.5%,
99.99 stays below exhaustion, and values above 100 remain visible.

Capability means the provider has a probe implementation, not that every token
has permission to read it. Claude `setup-token` credentials characterized in
this repo request only `user:inference`; the provider can require `user:profile`
for [usage access](https://github.com/anthropics/claude-code/issues/13724).
A 403 returns `permission_denied` with no limits, distinct from expired
authentication or exhausted capacity. Minting another inference-only token
does not establish usage access. This probe cannot add scopes to a stored token.

| Connection | Read-only source | Observations |
| --- | --- | --- |
| Codex subscription | `GET https://chatgpt.com/backend-api/wham/usage` with stored access token and account ID | Primary/secondary windows, additional feature/model limits, provider admission, workspace spend control, credit balance |
| Claude subscription | `GET https://api.anthropic.com/api/oauth/usage`, with stored OAuth token and `anthropic-beta: oauth-2025-04-20` | Legacy and structured session/weekly/scoped windows, monthly extra usage, structured spend when legacy extra usage is absent |
| Grok subscription | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, with stored token and `x-xai-token-auth: xai-grok-cli` | Included-plan utilization/period when reported, separately reported on-demand allowance and prepaid balance in USD cents |
| OpenRouter API key | `GET https://openrouter.ai/api/v1/key` | Key credit cap, reset cadence, free-model daily request cap when returned |
| Other API-key methods | No supported single-key allowance endpoint | Explicit `unsupported`; no provider or secret read |

These subscription sources are provider-client endpoints, not a promise of a
stable public API. Codex's current endpoint/shape is grounded in the official
[backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)
and [response models](https://github.com/openai/codex/blob/main/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs).
Claude uses the same OAuth endpoint as the existing adapter probe; official
[usage documentation](https://code.claude.com/docs/en/costs) describes plan windows,
extra usage, and usage-check rate limiting. Grok's endpoint, optional fields, and
USD-cent units follow its official
[billing implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs).
It prefers `creditUsagePercent` and `currentPeriod`, with `used`/`monthlyLimit`
as the legacy included-allowance fallback. The official
[Grok commands](https://docs.x.ai/build/modes-and-commands) describe its usage screen.
OpenRouter documents its
[key limits endpoint](https://openrouter.ai/docs/api/reference/limits).

Unknown values are `null`, never assumed zero. A present Grok `Cent` message `{}`
means zero under its documented proto3 encoding; an absent message or omitted
included-usage percentage remains unknown. Claude's `is_active` dashboard flag
does not establish whether requests are allowed. Named Claude limit groups keep
their own identities and scopes, including `session` and `weekly_all` groups.
They do not replace the legacy account-wide windows. An enabled extra-usage switch or remaining
spend allowance does not establish a funded usable balance; overage `available`
stays unknown unless the provider confirms it or reports it disabled/exhausted.
An unlimited OpenRouter key does not establish account balance. A Grok reset
timestamp alone does not establish weekly/monthly cadence. API rate limiting
of the *probe* is an error, not an exhausted subscription. Malformed/empty
responses and network failures return no fresh limits. Responses are `no-store`,
bounded to 256 KiB and 15 seconds, use fixed endpoints with redirects disabled,
and contain neither credentials nor raw provider errors. Expired credentials
report `authentication_required`; the probe does not exchange refresh tokens
or change connection health.

The Costs dashboard uses the company quota endpoint. It reads each authorized
managed subscription separately, retaining the last successful observation on
transient errors. For managed Codex accounts, a 401 can trigger one persisted
OAuth refresh; it defers while potentially competing OpenAI work is active.
Refresh takes the company secret-mutation lock before database row locks and
requires those row locks immediately, before exchanging a single-use token.
Reconnect and runtime credential write-back follow the same lock order.
Credential resolution checks its version after any database wait and reloads a
rotated value before giving it to a new run. Unknown utilization has no progress
bar, but any provider-reported reset time remains visible.

Verification:

```sh
pnpm exec vitest run server/src/services/ai-connection-usage.test.ts server/src/__tests__/ai-connections.test.ts ui/src/components/ai-connections/AiConnectionUsagePanel.test.tsx server/src/__tests__/openapi-routes.test.ts
pnpm check:token-gates
```

Fixtures prove normalization, credential isolation and manual UI behavior. Live
provider/account entitlement qualification is separate; provider-side omissions
remain unknown and must not be used downstream as proof of available capacity.
On 2026-10-02, a real local Codex access token was saved to an encrypted,
disposable test connection. The actual connection usage HTTP route returned 200
with `status: ok`, a weekly window at 100% used, its reset time, denied included
usage, and available overage credits. The same stored connection passed selection
checks for both `codex_local` and `paperclip_runner` with the native Codex provider.
This verifies the connection API/vault/provider path and both selection paths;
it does not claim a live runner turn or browser acceptance test. The disposable
database and vault home were removed after verification.
After the operator signed in again on 2026-10-02, real Claude Keychain and Grok
file credentials were saved to encrypted disposable connections. Both the
provider requests and actual connection usage HTTP route returned 200 with
`status: ok`. Selection checks passed for `claude_local`, native Claude,
ACP Claude, `grok_local`, and ACP Grok through `paperclip_runner`.
Claude returned session and weekly usage at 0%, a scoped weekly window, and
enabled extra usage. Grok returned a weekly period and zero on-demand allowance
and prepaid balance, but omitted included-plan usage; it remains unknown rather
than being reported as 0% or available capacity. The live shapes prompted
regressions for Claude structured limits/spend and Grok legacy usage, monetary
units, absent percentages, and proto3 zero messages. The disposable database
and encrypted vault were removed. These checks started no provider turn and
exchanged no refresh tokens.

## Runtime isolation

Provider authentication failures, including `acpx_auth_required`, adapter login
requirements, and expired/invalidated refresh tokens, create an AI connection
card as the failed run is finalized. The card names the provider and uses the
same inline connection/reconnect controls as missing-account setup. Pending
cards are deduplicated. Creating a repair card persists a blocked run classification
that suppresses immediate and periodic generic retries until the responsible user
repairs the connection. Unsupported providers and failures that could not create
a card retain their existing recovery path. Tool permission errors and provider quota failures do not
request model authentication.

Pre-dispatch `configuration_incomplete` failures also show this card when every
missing binding is a personal `user_secret_ref` for the same compatible AI
provider. This includes a teammate who has no value for an onboarding
`ANTHROPIC_API_KEY` definition. The card asks that person to connect their own
account. It does not use another teammate's secret. Mixed gaps, company secrets,
and unrelated tool credentials keep the existing operator recovery path.
After explicit, validated adoption, the durable delivery reopens only the
blocked task whose latest failure and active configuration recovery still match
the card. A newer failure, reassignment, manual hold, or restricted external chat
does not resume through an old card.

An attributed managed credential is marked as needing reauthorization only if
its stored generation still matches the failed run. Late failures cannot
invalidate a refreshed or reconnected credential. Repair preserves the selected
account and its permissions when the same sign-in method is selected. The card
also lets the user switch between API key and subscription authentication for
providers that support both. Switching creates a separate account, then selects
it as the user's provider default or validates and updates the agent's explicit
account binding. The original account is retained. Accepting the card resumes with a fresh session
through the existing durable continuation delivery.

For compatible legacy agents, the card offers the responsible person's provider
connection without changing authentication automatically. After connecting,
**Use connection and continue** checks agent-update permissions and validates in
the agent's execution environment before committing the agent binding, connection
install, audit, and card completion in one transaction. A failed validation or
completion leaves the request pending and the old agent configuration and access
intact. Unsupported harness/provider routes are not guessed.

Codex ACP terminal failures with category `limit` and explicit usage-exhaustion
wording enter provider-quota recovery. A supported reset clock uses the existing
Codex parser; when none is available, recovery uses its existing quota backoff.
Context, turn, rate, storage-capacity and configured-budget limits retain their
existing handling. The adapter inspects bounded provider text only in memory
and retains recovery labels and a parsed timestamp, without copying the text to
run results or logs. A historical generic terminal-limit message alone does not
establish quota exhaustion.

`prepareManagedAiRuntime` is shared by runs, environment tests, and adoption.
Test and Save mark the tested account as needing attention when its provider
hello test rejects authentication or its API-key check returns 401 or 403.
Network, quota, runtime, and environment failures
do not change credential health. The same generation check protects a newer
reconnect from a late test result. Claude ACP's typed `access` failure is its
provider `auth_required` signal and enters the existing sign-in recovery path,
including when only the generic terminal-access fallback message is available.
Claude ACP validates working directories on the selected execution target. A
sandbox directory does not need to exist on the Paperclip server. When the agent
has no configured directory, the test uses the remote target's working directory.
It checks responsible identity, membership, compatibility, connection health,
human audience and agent installation before reading credentials.
Missing credentials produce an actionable configuration failure; responsible-user
task runs use the existing connection-request interaction, marked `purpose: ai`.
A runtime-auth request cannot satisfy, reuse, or supersede a tool request for
the same provider. AI-only methods are excluded from agent tool discovery.

Each invocation receives a private authentication home and only the selected
grant's credentials. Inherited credential variables are cleared. Conflicting
project authentication and provider-routing overrides are rejected. Managed
failure cannot reactivate host or legacy credentials.

A subscription invocation takes no lease. Two invocations of one grant, from
the same or a different provider account, run at the same time. At cleanup,
each invocation re-reads the credential stored at that moment under a row
lock on the grant, then compares it against its own refreshed copy using the
provider's own freshness field: Codex compares `last_refresh` and bounds it
against the host clock; Grok compares `expires_at`. The newer credential
persists; a tie or an unparseable freshness value keeps the stored
credential, so a spent single-use refresh token never overwrites a good one.
Refreshes are merged only into the originating active grant, with a
revocation check. Temporary homes are removed on normal completion or
failure.

A fresh task execution cannot enter subscription contention. The freshest-write
rule above resolves the conflict instead. A run that already entered this wait
keeps a durable scheduled retry, checked every 60–120 seconds. The task shows
“Waiting for AI subscription”. It does not request a reconnect, and it does not
consume its provider-failure retry allowance.
Each attempt rechecks task eligibility, ownership, budget, and current credential
access. Revocation and other configuration failures still require user action.
Authorized comment wakes that started as non-assignee runs can resume without
claiming the assignee’s execution lock. Admission records this authority while
holding the task and run locks. A reassignment during preflight cannot grant it.
Assignee retries must still own that lock.
Already-started native sessions retain their existing same-run recovery path;
they must not be replaced by a fresh execution with a pre-provider receipt.

Session reuse includes grant identity, responsible user, and credential
generation. A changed identity starts a fresh provider session. Native Codex
(`paperclip_runner`) honors the configured warm lifecycle. It copies refreshed
credentials back to the current invocation before deleting that invocation's
private home. The session-owned credential stays private until idle timeout or
explicit closure. Each follow-up rechecks current authorization and account
identity before reusing the session; changing identity retires the previous owner.
Other managed harnesses retain per-turn cleanup. A suspended native execution
whose credential identity changed must restart as a new execution.

After a verified provider resume, plain-text Slack follow-ups send the new
authorized message delta instead of repeating the full task framing. The saved
run and current message identities and bodies must match. Actual brief edits
still arrive; historical Slack task titles are not repeated as new directions.
Attachments, omitted input, questions, approvals, and recovery retain their full
framing. A fresh provider session always receives the complete bootstrap.
Retained sandbox runner binaries are reused only after an exact SHA-256 match
with the controller artifact and the normal capability checks. Run-scoped
credential changes still require provider process rotation.


Warm sandbox execution requires both `reuseLease: true` and
`runnerLifecycleMode: "warm"` on the environment. `runnerIdleTimeoutMs` bounds
idle process retention. Chat tasks without a project reuse a sandbox only within
the same company, environment, task, agent, and runtime configuration. They do
not need an artificial project workspace. Other tasks, other agents, and ad-hoc
connection tests cannot claim that retained sandbox. Daytona verifies a matching
workspace sentinel before accepting either a workspace-scoped or task-scoped lease.

Revocation blocks new invocations and refresh persistence. A running provider
process may already hold credentials. The revoke confirmation lists attributed
active runs and exposes the existing Stop action; it does not promise immediate
provider-side revocation.

### Stop during sandbox preparation

ACPX startup registers cancellation while it materializes the remote auth home
and stages files. Stop requests termination of that run's sandbox. Daytona closes
admission and stops the sandbox before waiting for outstanding setup commands.
The host requires a receipt for the exact company, run, and provider lease before
abandoning the blocked setup RPC. Normal completion still drains work gracefully.

Late setup responses cannot launch the agent. A cancelled sandbox cannot resume
while its old provider requests are still settling; a retry receives an explicit
error instead. If termination cannot be verified, the adapter keeps ownership
until the outstanding operation settles, and Stop is not acknowledged as complete.
Local execution and cancellation of an already-running agent turn are unchanged.

## Legacy adoption

Migration `0273` indexes only explicitly owned personal secrets with a recognized
provider/method and matching agent configuration. It keeps original secret
references and leaves every agent's legacy authentication unchanged. Reconnecting
an indexed account creates a private grant credential instead of rotating the
legacy secret. Subsequent reconnects rotate that private credential. Unknown
ownership and filesystem-only subscriptions remain unresolved. The migration is
repeatable and does not classify unknown credentials as company-shared.

Imported accounts initially need validation. Agent settings show “Existing
authentication — not managed by Connections” until adoption. The adoption
confirmation names the binding and affected agent. Saving runs a provider hello
test in that agent's environment before replacing authentication. After adoption,
the server preserves the managed binding and will not restore legacy fallback.

## Local subscription sign-in

Local installations do not need a sandbox to connect a subscription. Connections,
onboarding, and agent setup share `LocalProviderLoginInstructions` and
`useLocalAiLogin`. Claude and Codex start a local provider process behind the
browser sign-in card. Claude accepts the authorization code in that card; Codex
displays its device code there. The user does not run a shell command. Each
local runner requires Python 3 for its pseudo-terminal (included in the Docker
image) and the corresponding provider CLI on the Paperclip host. Each
attempt retains a private credential home. The home is never seeded with the
operator's existing login: copying a rotating refresh token would
allow managed runs to invalidate credentials still used by legacy agents or the
operator's terminal. The user completes browser sign-in, then clicks Connect.
Grok retains its terminal sign-in flow until it has a local browser login runner.

Attempts reuse `adapter_auth_sessions`, binding company, owner, provider, access
intent, reconnect target, and a 30-minute expiry. Validation and completion are
serialized; duplicate completion returns the saved connection. Restart retains
the attempt. Cancellation and expiry remove the attempt home, and the startup/
periodic cleanup sweep retries expired directories. Successful completion persists
credentials to the encrypted grant and removes the temporary login home. Refreshes
subsequently update only that grant. Reconnect preserves IDs and access settings.

Starting an isolated attempt requires normal company-scoped AI-connection creation
permission. Checks, completion, cancellation, and resumption are owner-bound.
Authenticated users cannot import host credentials or use another user’s attempt.
A failed verification creates no healthy connection. Preview-era Codex/Grok managed connections without the
isolated-subscription marker require reconnect before another managed execution;
unmanaged legacy agents retain their existing authentication paths.

## Verification

`server/src/__tests__/ai-connections.test.ts` exercises storage, isolation,
defaults, human audiences, agent access, reconnect races, refresh ownership,
concurrent subscription write-backs, migration replay, and redacted API
failures against a real embedded database. Existing login, adapter, tool, and channel suites cover their
shared integration paths. The onboarding tests cover managed reuse and keeping a
successfully connected account after failed agent creation.

The [Storybook review index](http://localhost:6116/?path=/story/ai-connections-review--review-index)
retains deterministic authentication states and interaction checks. Run
`pnpm build-storybook`, then
`pnpm exec playwright test --config tests/ai-connections-review/playwright.config.ts`.
Also run token gates, repository typecheck, tests, and build before handoff.
Live connect → reuse → run → reconnect verification still requires valid provider
credentials and a supported login/runtime environment; fixtures do not prove it.

For an isolated running test drive, also run:

```sh
AI_CONNECTIONS_TEST_COMPANY_ID=<company-id> pnpm exec playwright test --config tests/ai-connections-app/playwright.config.ts
```

Set `AI_CONNECTIONS_TEST_URL` when the test drive uses a port other than 3100.

These browser checks exercise the production list/detail pages, rejected API-key
validation, cancellation, focus restoration, and adoption without saving agent
changes. They submit an explicitly invalid fixture key and do not prove successful
authentication with a live account.

### Local sign-in checks

Local subscription screens share the same credential check on entry and when the
window regains focus. Waiting screens also poll until sign-in verifies. A successful
check shows the account is signed in; only **Connect** creates or reconnects the grant.
Claude, Codex, and Grok check only their connection-specific login home. The
health response selects whether a self-hosted user may sign in.

Leaving and returning to a local sign-in screen resumes its active attempt. Navigation
does not delete its credential home. **Start sign-in again**
explicitly cancels the old attempt; abandoned attempts expire after 30 minutes.
Completed and expired attempts are cleaned up through the existing lifecycle.

### Disposable live inline-repair test

The normal app test configuration excludes `*.live.spec.ts`. To run the destructive
inline-repair scenario, set `AI_REPAIR_TEST_ALLOW_DESTRUCTIVE=1` and use a separate
loopback `local_trusted` instance. Set `AI_REPAIR_TEST_DISPOSABLE_MARKER` to a fresh
32-character lowercase hexadecimal value. The company, single Codex agent, single
personal OpenAI API connection, and issue must all be named `AI Repair QA <marker>`
(the issue uses that title). Supply their IDs with `AI_CONNECTIONS_TEST_COMPANY_ID`,
`AI_REPAIR_TEST_CONNECTION_ID`, and `AI_REPAIR_TEST_ISSUE_ID`, and the disposable
provider key with `AI_REPAIR_TEST_KEY`. The test verifies these boundaries before
revoking credentials or submitting work. Delete the disposable instance and revoke
its provider key after the test; failed tests may leave a paused task for inspection.

Authenticated public deployments must configure a trusted runtime host (`PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` or `PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST`) before offering server-host subscription login, matching the local stdio runtime boundary. Health reports this capability so setup can offer a supported environment or API key when local sign-in is unavailable. Private authenticated self-hosted instances support isolated local login without that extra setting. Isolated Claude credential files must be private, owned by the server user, bounded, and free of symlinks.

### Hiring and delegated work

When a managed agent creates or hires another agent without an explicit AI binding
or adapter auth setting, the server inherits its compatible managed connection choice.
Explicit credentials, blank overrides, credential directories, and provider routing
settings for the child provider take precedence. Unrelated provider keys do not
suppress the default. Unmanaged parents keep their existing authentication path. The new agent resolves
the responsible user's account at execution time; it never copies the parent's
credentials or identity. Same-provider hires preserve subscription/API-key choice.
A different provider selects the responsible user's default for that provider.
Native Codex and ACPX/Claude provider selections follow the same compatibility rules.

Hiring may succeed before that personal account exists or while it needs repair,
including hires awaiting board approval. The first assigned task then shows an AI
connection card. First-time setup presents the provider's subscription/API controls
inside the task. The inline form omits the connection name field and names new
accounts from the user's display name, provider, and selected authentication
method (for example, `dotta's Claude API account`). Reconnecting preserves the
existing account name. Connecting installs access for that agent and resumes the pending
work automatically. Explicit incompatible bindings and shared-account permission
denials still fail; hiring never expands a restricted shared account's audience.

Concurrent runs of one subscription do not hold a credential lease. A fresh
task can briefly wait when a credential rotation holds the company file lock or
a grant/secret database row lock. Lock timeouts become `ai_connection_busy`,
keeping the task on its automatic pre-provider scheduled retry path. It does
not request new credentials, and it does not consume the provider-failure retry
allowance. Each retry revalidates the account, and existing run-dispatch rules
still suppress cancelled, reassigned, or otherwise ineligible work. An assignee
retry must still keep execution-lock ownership at scheduling, promotion, and
dispatch.

`server/src/__tests__/agent-hire-ai-connections.test.ts` covers both creation routes,
both providers and methods, approval gates, native provider mapping, shared access
boundaries, and concurrent runs of one subscription for both providers. The opt-in
[`tests/hiring-ai-connections/README.md`](../../tests/hiring-ai-connections/README.md)
describes real browser hiring, subtask, connection, and automatic-resume checks on
local and Daytona environments, plus the production component Storybook checks.

### Managed session compatibility

Resume checks compare the selected account identity with the server-owned
metadata in the saved task session. Read this metadata before decoding the
adapter session: adapter codecs intentionally discard unknown fields. A missing
identity, a different grant or responsible user, or a changed credential generation
requires a fresh session. The metadata is removed before passing session params
to an adapter. Temporary authentication-home paths do not change the configuration
fingerprint. These checks do not relax current connection authorization.

Quota polling has a 20-second response deadline. Once a managed OAuth refresh
starts, it has its own 60-second request lifetime so the replacement token body
can still be read and committed after the dashboard stops waiting. A successful
refreshed observation uses the saved grant/secret revision as its cache identity.
A reconnect during credential resolution defers the poll instead of associating
one account's quota with another revision. Both Costs surfaces retain matching
successful observations on transient failures and clear them on authentication
failure or credential rotation.

Managed runtime token write-back retries a company-lock timeout twice (three
30-second acquisition attempts), so a slow quota exchange does not discard a
different account's replacement tokens. Any remaining write-back error preserves
the private runtime home for retry; cleanup deletes it only after a successful
transaction or an intentional freshness/authorization discard. These retained
homes are recovery evidence, not a background replay queue; persistent database
or lock failures still require operator intervention.

Quota OAuth replacement tokens are encrypted with the instance secrets master
key and fsynced under `<instance-root>/quota-credential-recovery/<company-id>/`
before vault, grant, or activity writes. Storage and encryption are checked before
exchanging a single-use refresh token. Failed saves retry without another OAuth
exchange; persistent failures keep the encrypted record for the next quota poll,
including after a restart. New OpenAI subscription runtimes serialize credential
reads with quota exchanges and recover a matching pending replacement before
materializing an auth home. Authentication-failure handling also recovers a
matching replacement before marking the grant invalid. A failed recovery save
defers these actions and leaves both the active grant and journal intact.
The journal is removed only after database commit (or
when an authorized newer credential makes it obsolete). Replay checks the grant,
connection, secret, and original credential fingerprint and cannot reactivate a
revoked grant or overwrite a reconnect. Back up this directory and the instance
secrets key with the instance data. Loss of durable storage while receiving a
provider token can still require reconnecting the account.

## Advanced provider routing (2026-10-02)

Use the regular rows on **Connectors** to add OpenRouter, Amazon Bedrock,
Google Gemini, a Responses API, Messages API, Chat Completions API, or local
endpoint connection. Each row has its own Connect action and saved accounts.
The catalog tags these entries `model-provider`; no category UI is shown.
Responses-compatible gateways such as Emissary use the Responses API row.
The native subscription/API-key onboarding remains the default. Provider choices
show the existing local brand artwork and reuse the existing access step. Custom
URLs, protocol, AWS region, and credential fields appear only after choosing the
corresponding connector. New connections default to everyone in the organization
and all agents when the actor has permission; the existing Advanced disclosure
contains the controls to narrow access, without a separate Access step. New-agent setup also offers the connection picker in its persistent
**Advanced / Custom Gateway** tile.

At **Agents → [agent] → Harness / Runtime**, **Connection** is a dropdown of
compatible saved connections, including explicit personal accounts. The existing
model picker uses that connection’s optional model IDs and accepts manual IDs.
Changing connections preserves the model for explicit review. URLs and
credentials belong to the connection; the model belongs to the agent.

| Harness | Implemented managed routes |
| --- | --- |
| Codex legacy and Codex New Runner (app-server) | OpenRouter; custom/local OpenAI Responses endpoints |
| Claude legacy and Claude New Runner (ACPX) | OpenRouter; custom/local Anthropic Messages; Bedrock API key |
| OpenCode legacy and New Runner | OpenRouter; custom/local Chat Completions |
| Hermes local | OpenRouter; custom/local Chat Completions |
| Gemini CLI, Grok | Their native API connections; custom routes are not advertised |

Migration `0306` adds Google to both account-default provider constraints. Local
Gemini connections seed the API-key auth choice in their disposable home before
environment probes and task execution. The settings file contains no credential.

OpenClaw Gateway, Hermes Gateway, Claude Managed, AWS AgentCore, Process, HTTP,
and legacy `acpx_local` are excluded: external agents retain their own model
configuration, and `acpx_local` is retired. Cursor/Pi/Copilot custom routing,
Vertex, ambient AWS identity, arbitrary authentication headers, and automatic
catalog discovery for custom gateways are not part of this implementation.

OpenRouter connections without an explicit model list automatically load its public
[model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
ordered with `sort=most-popular`. New-agent setup and agent settings share this
discovery path, preserve the provider's ordering, and adapt model IDs to the selected
harness. Explicit connection model lists take precedence. Catalog discovery sends
no credentials; a failed request offers refresh and manual model entry.

`config.ai.routing` stores only kind, protocol, URL, auth method, region, and
optional model IDs/labels. The vault stores provider API keys, including Bedrock API keys.
Fixed bindings contain only connection/grant identity. The server checks actual
connection metadata, company, owner/audience, installation, status, and protocol
before resolving secrets. Advanced connections cannot silently become native
personal defaults. Reconnect replaces credentials and preserves destination;
changing destination requires a separate connection. Credentials are never
submitted to a new URL as part of reconnect.

Native OpenCode custom gateways keep the reusable key in the runner process.
The harness configuration contains a session-scoped loopback capability, limited
to the configured model's Chat Completions endpoint. Streaming and provider error
status are preserved; redirects are rejected. Closing or failing the harness
revokes the capability and aborts outstanding requests. Upstream requests use
session-local Node HTTP/HTTPS agents with the runtime's HTTP_PROXY, HTTPS_PROXY,
ALL_PROXY fallback, NO_PROXY bypasses, and SSL_CERT_FILE/SSL_CERT_DIR trust. The
harness bypasses outgoing proxies for loopback broker/MCP calls. This bounds key exposure
from shell tools reading the configuration; it is not an OS isolation boundary
against a process debugger running as the runner user.

Only fixed official provider endpoints receive control-plane key checks. Custom
endpoints and Bedrock are exercised by the selected harness in the selected
execution environment, through **Run test**. Saving a custom connection records
configuration; it is not proof that the model can respond. HTTPS is required for
remote URLs; loopback endpoints may use HTTP. Localhost refers to the agent’s
execution environment, including when it is a sandbox. URLs cannot contain user
credentials, query parameters, or fragments.

Managed Grok uses a disposable runtime home. Paperclip does not retain or restore
Grok transcript files into host temporary directories: private file modes do not
isolate agents running as the same OS user. Archives from earlier development
builds are ignored. Provider session metadata still saves normally. If the selected
session has no history in its current execution environment, Grok starts a fresh
session with the Paperclip task handoff rather than attempting remote subscription
recovery. Transcript continuation requires an isolated provider history solution
and is not qualified by this change.

Runtime projection clears alternate provider credentials and routing overrides,
uses disposable homes, and never falls back to host authentication. Codex probes
retain the selected provider home. The new runner copies only the validated
Paperclip provider stanza into its isolated Codex home, preserves its own tool
and sandbox policy, and disables shell snapshots. TypeScript and Rust launch
boundaries explicitly allow only the corresponding provider credential and
routing fields. Keys remain outside model-issued command environments on the
new Codex runner. Hermes custom endpoints use an isolated `config.yaml` with an
environment reference for the key.

Primary configuration references consulted:
[Codex custom providers](https://developers.openai.com/codex/config-advanced/),
[OpenRouter Codex](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli),
[OpenRouter Claude](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration),
[Claude gateways](https://code.claude.com/docs/en/llm-gateway),
[Claude Bedrock](https://code.claude.com/docs/en/amazon-bedrock),
[OpenCode providers](https://opencode.ai/docs/providers/), and
[Hermes providers](https://hermes-agent.nousresearch.com/docs/integrations/providers).

Validation includes negative company/owner/revocation/protocol checks, no-auth
vault behavior, immutable reconnect destinations, credential projection, Codex
probe isolation, and new-runner home/environment boundaries. The isolated local
test-drive exercised live OpenRouter requests using the Codex and Claude CLI
probes, then completed real tasks using Codex, Claude, and OpenCode New Runner.
The app walkthrough verified connection selection, saving, and completed tasks.
A follow-up Codex/OpenRouter acceptance test ran a shell calculation, completed
the task, then resumed from a new user message and completed a second shell
calculation with the prior context. Reconnect coverage round-trips routing
through PostgreSQL JSONB and verifies that credential rotation retains identity
and agent access.
General AWS access keys are not accepted or forwarded to Claude; use a Bedrock
API key. Support for AWS roles requires a credential broker before it can ship.
The initial OpenCode tool-use check was denied terminal access. The native driver
now includes the assigned workspace and its canonical path in the allowed
directories while preserving the configured tool policy. Subsequent local
qualification verified tool use and follow-up on the affected OpenCode route.
Live Bedrock verification subsequently passed with a short-lived Bedrock API key,
region `us-east-1`, and `us.anthropic.claude-sonnet-4-6`. The saved connection
passed **Run test**. Claude legacy and Claude New Runner each ran a terminal
calculation, completed the task, and ran a context-dependent follow-up. Actual
tool output was verified for all four successful runs. Private gateways still
have deterministic mapping and validation coverage but need live verification
in the target deployment. Short-lived Bedrock keys must be rotated before expiry.

The repeatable provider connection campaign is documented in
[`tests/runner-e2e/PROVIDER-CONNECTIONS.md`](../../tests/runner-e2e/PROVIDER-CONNECTIONS.md).
It preserves actual tool outputs, downloaded artifacts, completion and follow-up
receipts, source provenance, cleanup, and provider failures. The retained local
qualification has 43 passing API/gateway cells out of 46; staging and all
subscription combinations remain unqualified. Gemini CLI 0.58.0 has an upstream
ACP new-file error conversion defect. The provider-free filesystem probe exposes
that defect without modifying the installed CLI. Provider overloads and one
follow-up timeout also remain live qualification limits.

### Gateway completion compatibility

Provider-facing `paperclip_finish` accepts an omitted or `null` continuation for
`done`, `completed`, and `needs_review`. This supports gateways that require all
declared tool properties to be present. Normalization removes only `null`;
non-yielding tool calls still reject a continuation object, and `yielded` still
requires a complete `response_wake` object.

Task-card account repair uses the provider reconnect form for routed accounts,
retaining the saved endpoint, protocol, model aliases, and connection identity.

## Subscription cost reporting

The Costs page shows metered API spend beside the **current monthly subscription
commitment**. API dollars and both token totals follow the selected date range;
monthly subscription fees do not. Tokens measure Paperclip work only, while a
subscription fee covers the entire provider account, including other usage.
Recorded subscription overages remain separate from the recurring fee.

Agent, user, project, and model cost rows use a right-aligned amount with any
estimate badge underneath. Each badge reflects that row's own ledger events in
the selected date range.

Discovery uses the managed AI connection actually selected for a run, or the
connected accounts visible to the user viewing Costs. An administrator cannot
probe another user's private credentials. OpenAI identity combines workspace and
seat claims from the exact bearer token accepted by its usage endpoint, with
the selected workspace checked against those claims. An editable ID token cannot
establish identity or grant price-edit access. Claude's OAuth profile combines
organization and account identity when the token allows profile access. Identity
keys are company-scoped hashes; reporting never exposes tokens, raw provider IDs,
or credential hashes. Multiple agents and connections sharing a known paid seat
count once. Distinct seats remain separate even in the same workspace. Before
provider verification, each connection grant has its own unconfirmed record;
local claims alone cannot combine another user's account or billing editors.

Supported exact plan identifiers with a stable account identity map to dated, USD, before-tax web list prices
in `packages/shared/src/subscriptions.ts`. The UI labels these **Estimated** (or
**Partially estimated** when combined with user-supplied prices). A generic
OpenAI Pro, Claude Max, team, or enterprise entitlement does not reliably
identify the price: it stays **Price unknown** until its owner enters an amount.
Annual prices are divided by 12 using exact decimal arithmetic. Supported
currencies are totaled separately; Paperclip does not estimate exchange rates.

Use **Subscriptions → View details → Edit price** to record the amount paid,
billing cadence, and tracking status. Personal prices are editable by their
owner; shared prices require AI-connection management permission. When the same
seat is connected both personally and shared, both its personal owners and
company connection managers can edit the single fee, regardless of discovery
order. These billing permissions survive disconnecting a connection; they do
not grant access to its credentials. Viewers cannot
edit. Updates append an immutable price revision and reject stale concurrent
edits. Ending or excluding tracking does not cancel the provider subscription.
Disconnecting a connection also does not prove that billing stopped, so the fee
continues until explicitly ended or excluded.

Claude setup tokens can lack profile permission. Grok plan observations currently
do not supply a verified billing identity. Such connections retain an unconfirmed
identity and may need manual linking after a credential change. An unconfirmed
identity requires a user-supplied price before contributing a monthly fee, so
credential rotations cannot multiply automatic list-price estimates. **Link accounts**
combines usage and keeps the selected account's price; it is restricted to accounts
the caller can edit and should only join the same subscription or paid seat.
Provider observations never overwrite a user-supplied price. Conflicting manual
prices prevent automatic linking rather than silently choosing one.

Monthly totals and account details include only accounts the viewer may see:
personal billing owners, company managers of shared fees, and the authorized
audience of active shared grants. Revoking a grant removes its audience's access
to the fee. Cost-read permission alone does not reveal
another member's personal plan, price, owner, or account-linked activity. Billing
editors retain visibility after disconnection so they can end tracking. Aggregate
API and subscription run-token totals remain company-wide, as in existing cost
reports; hidden private accounts are not mislabeled as missing attribution.
Fixed-price, credit-billed, and unknown usage remain in the inference ledger.
They are reported separately from API and subscription tokens as other or unknown
billing types; the API retains the `unknown` field name for this combined total.

Provider lookups run in the background, with a six-hour attempt cache shared by
server replicas, at most four active provider lookups per process, a 15-second
request deadline, and a 256 KiB response limit. Failed checks preserve the last
observed plan and price. The report reads the database only and loads just the
current price for each account; earlier revisions remain stored for auditing.
Accepted discovery requests wait for provider capacity instead of skipping accounts.
At most twenty discovery requests run per process; additional requests receive
HTTP 429 and can be retried using **Retry account check**.
Failed background UI reloads retain the last loaded values and show a short
status message. Failed discovery offers **Retry account check**.

Each new managed subscription run snapshots its subscription ID. Its cost receipt
inherits that server-derived ID, outside the immutable monetary receipt hash.
Switching accounts cannot move an earlier run to the new subscription. Linking
duplicates resolves historical IDs in reports without rewriting receipts.
Legacy and unmanaged subscription usage still contributes to the subscription
token total but is not retroactively assigned to a guessed account. Subscription
estimates never create finance events, change the inference ledger's dollar
amounts, or consume agent budgets.

The company-scoped API is documented in OpenAPI:

- `GET /api/companies/:companyId/costs/subscriptions`: current fees and usage for
  `from`/`to` (inclusive, matching existing cost reports), or `period=all`.
- `POST /api/companies/:companyId/costs/subscriptions/refresh`: request background
  discovery for the caller's authorized connections; returns `202` immediately.
- `PATCH /api/companies/:companyId/costs/subscriptions/:subscriptionId`: save a
  price with `expectedRevision`, plan, nullable `amountCents`, currency, cadence,
  and tracking status.
- `POST /api/companies/:companyId/costs/subscriptions/:subscriptionId/link`: link
  a duplicate using `targetId`, `expectedRevision`, and `targetRevision`.

Storybook **Costs / Subscriptions** renders the production Costs page with
interactive fixtures for normal estimates, unknown prices, provider failures,
and mobile layouts. Its edits affect fixture data only. Focused verification:

```sh
pnpm exec vitest run server/src/__tests__/subscriptions.test.ts \
  server/src/__tests__/subscription-routes.test.ts \
  ui/src/components/SubscriptionCostCard.test.tsx ui/src/pages/Costs.test.tsx
pnpm check:token-gates
pnpm storybook
```

These tests include real PostgreSQL persistence, migration replay, concurrent
updates, account changes, duplicate identity resolution, ownership, monetary
receipt replay, unknown prices, and failed provider observations. Provider payloads
are fixtures; live provider access still depends on the deployment's credentials
and scopes.
