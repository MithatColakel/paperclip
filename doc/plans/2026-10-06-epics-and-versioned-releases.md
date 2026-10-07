# Roadmap: epics, versions and the project flow for every project (paperclip.roadmap plugin)

- Date: 2026-10-07
- Status: proposed, **revision 5, checked against the code**. It replaces revision 4 in full. Revision 4 content that is still correct is restated here; nothing else carries over.
- Owner: board operator
- Applies to: fork `MithatColakel/paperclip`, branch `deploy/2026.1001.0` at `e6624f4bf`, and every company on the instance. The fork-owned plugin is `paperclip.roadmap`. **Cleanio (CLE) is the pilot**, and VPNProjects (VPN) and Presto VPN (PRE) follow.
- Inputs: the user's requirements 1–15 (§1); the user's follow-up of 2026-10-07: "continue with project types with components; vpn-node is really a separate project, so existing projects need some restructuring, which we do later"; the prod facts and Phase 0 state of 2026-10-06/07 (§2.3, §19.1); the Cleanio PM's roadmap draft rev1 (CLE-97 document `roadmap`); three design inputs (project types and components; roles, skill and rollout; multi-project UX); and a code review of revision 4 (30 findings, one blocker; §0.1 and §0.5). Every code reference was re-checked on this branch.

---

## 0. What changed

### 0.1 Since revision 4

| Area | Revision 4 | Revision 5 |
|---|---|---|
| Candidate staleness (blocker) | Any counted task completed after a candidate made it stale; Cleanio counted its build (CLE-48) and QA-round tasks, so the MVP could never be Ready | Builds, test runs and sign-offs are `release-ops`, never counted. Only a counted task with a **code deliverable** (an execution policy) makes a candidate stale. The Cleanio approval note converts those tasks (§7.2, §19.2). |
| Tag placement | Always the Ready candidate's sha | Per-component **`tag_rule`**: `candidate`, or `validation_commit` (the child commit that only adds the validation record, VPN-Node P8); candidates may be validated on a task branch (§3.5, §11.1) |
| Infrastructure gates | Canary before the tag | Release-test (or CI) → QA → checklist → board → tag; canary and fleet waves are distribution (§3.3) |
| Independent components | Trunk rule per project | **Trunk rule per component**; an independent component gets its own versions (§4.4) |
| Component of a task | Workspace = component | The default workspace is low confidence; multi-component version tasks need a `c:` label or a PM-confirmed component; ops tasks inherit the workspace from an **anchor task** (§3.5) |
| S6a | Optional, with a list fallback | **Required for 1a** (§0.4 item 9, §16) |
| Phase 0 bugs and hand-offs | QA and release managers file bug tasks | Only the PM (the coordinator) files tasks; a two-line Board-policy edit ships before 0b (§9, §14.4) |
| Profile document | JSON, rewritten with a header | Markdown with exactly one fenced `json` block; full `release-profile@1` schema with components, overrides, project gates, trains, lineage (§14.3, §14.6) |
| Profile discovery | `q=Roadmap:` search | Project + `release-ops` label + exact title; CLE-97 renamed "Roadmap: Cleanio iOS" (§14.3) |
| Migration 001 | — | No CHECK or NOT NULL on `ON DELETE SET NULL` columns; reusable retired tags; tag uniqueness for pending/tagged rows only; validator rules restated; quiet-window install (§13, §18.1) |
| Restructuring | Split before onboarding; Phase 0 form only before labels | Both orders; manual move after labels exist; lineage in the profile; config-copy checklist; in-flight tasks skipped per task (§17) |
| Presto node, VPN apps | Lockstep node; board as node release manager; QA submits apps | Node independent and CI-gated, the agent tags, the user dispatches the release workflow; `component.recordTag`; store gates belong to build owners (§18.5) |
| Mobile template, cherry-picks, effort | TestFlight-specific gates; local-only cherry-pick candidates; 26–31 days | Generic `beta_approved`/`store_submitted` per channel (§3.3); candidates pushed as non-branch refs (§6.3); **28–33 engineer-days** (§20) |

### 0.2 Revision 4 changes since revision 3 (still valid unless §0.1 says otherwise)

Every company and project, not Cleanio only (no code path, skill rule or UI string depends on a company, a store or an agent; those names live in catalog data and profiles); a **release profile** per project with a type, key, label style, version scheme, roles, checklist and gates, stored in the plugin (§3); **components** with their own channels, gates and role overrides (§3.5); generic **candidates, deployments and gate results** with gates snapshotted at Start (§7); **distribution** after the tag and a **Live** badge (§7.2); **release trains** in migration 001 (§8); **roles per project** and a pure policy builder (§10, §11.2); prefixed labels with one bare project per company (§4.2); **one shared `roadmap` skill** (§14); **component moves** with lineage (§17); company and project pages (§12.2); write-verb tool names (§0.4 item 2).

### 0.3 Revision 3 corrections that still hold

Each is restated where it applies:
1. Policies never name the executor (F24, §11.2).
2. Agents cannot park `blocked` tasks (F23); every park is one write, and half-parked tasks go to orphan recovery (F4) (§4.5).
3. Agents in `error` are still woken (F38); Mac-down mode is now the generic role-down mode (§10.2).
4. Epics carry no `v:` label; counting uses the nearest non-epic ancestor; `tasks_closed` covers open descendants (§4.3).
5. Labels are invisible on core kanban cards (F29): the Tags column in Phase 0, the plugin chip and card in 1a.
6. Label deletion cascades (F28): mirror and restore (§4.5). Plugin-created tasks skip core repair (F27): one re-wake, then a flag (§12.6).
7. No per-task `baseRef` (F30): cherry-pick patches, no branch pushed (§6.3).
8. Planning hand-over only after the PM's run ends (F43); "Send to PM" becomes "Request changes" while a proposal waits (F42) (§10.3).
9. Merge window: backstop wakes (F31), resubmission resumes at the approval stage (F25), no parking a PR in a stage (F26) (§11.3). Hotfix PRs are always eligible; priority is hidden, so `type:hotfix` is the marker (F29).
10. Board-only actions check `board_user_ids` (F32). Smaller: F33–F41 and F44 items, the PM's `gh` access check.

### 0.4 Corrections from checking the design against the code

1. **A merge must happen inside the last stage.** Approving the last stage with `status: done` completes the task (`server/src/services/issue-execution-policy.ts:786-805`). An "author merges after QA approves" mode would leave a done task with an unmerged PR. Merge owners are therefore always the participants of the approval stage (§11.2).
2. **Tool risk is inferred from the tool name** (`server/src/services/tool-gateway.ts:678-695`, applied to plugin tools at `:1187-1192`). Only `create|update|write|edit|patch|post|send|publish|merge|commit|apply` infer `write`. So revision 3's `roadmap_record_build`, `roadmap_propose`, `roadmap_report`, `roadmap_set_version` and `roadmap_insert_hotfix` would be classed `read`. Every mutating tool is renamed `roadmap_create_*` or `roadmap_update_*` (§12.5). No tool name contains `delete`, `remove` or `drop` (those infer `destructive`).
3. **Plugin task writes and workspaces** (corrected in revision 5). Plugin `issues.create` has no `projectWorkspaceId`, but core inherits it from `inheritExecutionWorkspaceFromIssueId ?? parentId` inside the same project, and reuses the source's execution workspace only when no execution-workspace field is given (G23). Without a source, a task lands on the default or primary workspace (G4). Component tasks are therefore created from a component **anchor task** (§3.5). The SDK type of `issues.update` omits `projectId`, `projectWorkspaceId`, `parentId` and `executionPolicy`; the worker and host pass the whole patch through anyway (G24), skipping the route's policy normalization, so the plan never uses that path. Project moves stay a core PATCH by the PM or the board (§17) until S10 (§16).
4. **`PluginWorkspace` has no `visibility` field** (`types.ts:372-393`). "Reference workspaces" (a repo bound in two projects) are marked in the plugin profile, not read from core.
5. **The migration validator** (`server/src/services/plugin-database.ts:57-114`, `170-245`) scans each **raw** statement for `from|join|references|into|update <schema>.<table>`, so no comment anywhere in the file (a header before the first statement included) may name a non-whitelisted `public` table. Text after the last `;` is a statement of its own and fails. `copy` and `call` are banned words outside comments and strings. Only `CREATE`, `ALTER`, `COMMENT` and `INSERT`/`UPDATE` backfills pass, so `SET lock_timeout` is rejected; `ALTER TABLE … DROP CONSTRAINT` passes. Migrations run in one transaction (`:546-547`). `public.project_workspaces` is not whitelisted (`packages/shared/src/constants.ts:1439-1453`), so component workspace ids carry no FK.
6. **Managed-skill adoption works by slug.** `importPackageFiles` with `replace` matches an existing skill by key **or slug**, then keeps the existing key and slug (`server/src/services/company-skills.ts:6058-6080`). `importDeclaredSkill` binds to that row (`server/src/services/plugin-managed-skills.ts:274-302`). A Phase 0 company skill with slug `roadmap` is therefore adopted in place, and no agent is re-attached (§14.4).
7. **A project move needs the workspace in the same PATCH.** Changing `projectId` re-validates the existing `projectWorkspaceId` against the new project and returns 422 (`services/issues.ts:7049-7073`, `:10698-10735`). A move sends `{projectId, projectWorkspaceId, executionWorkspaceId: null}`.
8. **An untracked v0.1 spike exists** at `packages/plugins/roadmap/`. It is read-only, has no database namespace and declares 8 capabilities. It derives lanes from `v:` label names on the tasks `ctx.issues.list` returns. Installing it on prod before Phase 1a would put 1a in `upgrade_pending` (F36). The spike is the starting point of the 1a UI. Its name parsing becomes the pre-binding fallback only (§12.1).
9. **The plugin cannot see labels without S6a.** Plugin `issues.list` has no label filter and the SDK has no labels client (G22). Without `labels` in the core read tables, a label no task carries (a new version label, or one recreated after a deletion) has no id the plugin can learn, bind or apply (§16).
10. **Issue documents are markdown only** (`ISSUE_DOCUMENT_FORMATS = ["markdown"]`, `packages/shared/src/validators/issue.ts:2108`). Machine-read documents (`release-profile`, `roadmap-index`, `readiness`) are markdown with exactly one fenced `json` block (§14.3).
11. **Plugin rows must not block core deletes.** Core hard-deletes projects and agents, and `ON DELETE SET NULL` re-checks CHECK and NOT NULL constraints (G29). Revision 4's `components_moved_ck` made deleting a move's target project fail (reproduced on Postgres 18). §13 rule 5 forbids that pattern.
12. **The fork's Board policy limits who creates tasks** (G30, fork commit `73a8b6c98`). Only the coordinator creates or assigns tasks, everyone else writes `Proposals`, and hand-offs set `in_review` and mention the coordinator. Revision 4 let QA owners and release managers file bug tasks, and on policy-routed code tasks the mention would wake the PM on every PR (§9, §14.4 step 7).
13. **Routines have no workspace** (G27), and **`project_workspaces.repo_url` is nullable** (G26): a move cannot find a component's routines by workspace, and a component's repo URL comes from the profile (§3.5, §17).
14. **The SDK `IssuesList` takes one `labelId`** and has no grouping hook (G28, §12.3).
15. **"Has a code deliverable" must be readable.** `issue_work_products` is not a core-read table, but `issues.execution_policy` is (G31). Every PR task gets a policy at hand-out (§11.2), so a policy marks a code deliverable (§7.2).

### 0.5 Suggestions not adopted

| Suggestion | Reason |
|---|---|
| `merge_mode = author_after_review` (QA reviews, the executor merges after approval) | Last-stage approval completes the task (§0.4 item 1). |
| `v:<prefix>/<key>` and `cmp:` labels | Two of three inputs chose `v:<key>-<ver>` and `c:`. The plugin binds by exact name, so the separator is cosmetic. `-` is used. |
| Released = every in-scope component *shipped* (store submitted, fleet rolled out) | User decision 4: releases are tags. Shipping can take days (fleet waves, store review), and it would hold the merge window and the trunk rule. Released = tagged. Distribution is tracked after the tag as **Live** (§7.2). |
| `roles` as one JSON blob per project | Ordered rows (`project_roles.ordinal`) give FKs on agents, component overrides and one validation path. |
| One "Roadmap daily" routine per project | One per PM per company covers all of that PM's projects. At VPN that is one run instead of four (§10.4). |
| An automatic project-type guess from repo contents | The board picks, or the PM proposes. |
| Review: S6a fallbacks (filter labels on listed tasks; or have the board UI pass label ids) | The first cannot see a label no task carries; the second adds a write path for a seam the fork carries anyway (§16). |
| Review: drop rarely used FKs to `public.issues` to shorten the install lock | Any one FK to `issues` takes the same lock; the quiet-window install is the remedy (§18.1). |
| Review: RC tags (`v1.0.1-rc.1`) for cherry-pick candidates | `git describe --match 'v*'` and tag-triggered workflows would pick them up; a non-branch, non-tag ref is used (§6.3). |
| Review: independent components release only through patch versions | Keeps node releases one at a time behind the backend's slot; the per-component trunk rule is adopted (§4.4). |
| Review: "onboard with components now, move later" as the fixed default | The user said only "later"; both orders are supported and the user picks (§17, question 4). |
| Review: `c:` labels for every component of every multi-component project | Only projects with a shared workspace need them; separate repos use PM-confirmed components (§3.5). |

---

## 1. Requirements and traceability

| # | Requirement | How it is met | Sections | Phase |
|---|---|---|---|---|
| R1 | It is a plugin | Fork-owned `paperclip.roadmap` with its own Postgres namespace; two carried fork changes: seam S6a and the Board-policy lines | §12, §13, §16 | 1 |
| R2 | Phase 0 starts now on Cleanio | 0a without the Mac agents (labels, CLE-97/98, approval, parking, epics, skill, daily routine); 0b for the code flow | §19 | 0a / 0b |
| R3 | ReleaseEngineer merges to `main`; no branch protection | Cleanio's merge owners = [ReleaseEngineer] strict + board fallback; merges happen in the approval stage; trailer + daily detection | §11 | 0b |
| R4 | Single `main`; releases are tags | One trunk per repo; one tag per component, placed by its tag rule on the ready candidate (or its validation commit); no other branch pushed | §6.3, §11.1 | 0b / 2 |
| R5 | Version visible on every task | `v:` label + Tags column (Phase 0); plugin chip and card in both task views (1a); component chip | §4.2, §12.2 | 0a / 1a |
| R6 | Page "Roadmap" in Work, Jira-like | One page slot with company and project views, Flow with Expedite/version/Ongoing/Routines lanes | §12.2–§12.3 | 1 |
| R7 | Normal work and routines stay outside versions | Ongoing and Routines lanes, never parked, counted or gated; lane budgets and aging | §4.3, §5 | 0a / 1 |
| R8 | Roadmap built with each project's PM | PM role per project; Plan-with-PM loop; one daily routine per PM; train owner for trains | §10 | 0a / 1b |
| R9 | Urgent fixes inserted any time | Insert hotfix into Ongoing, any open version or a new patch | §6 | 0a / 1b / 2 |
| R10 | Ready only with QA + TestFlight approval | `mobile_app` template: `tasks_closed` + `qa` + `beta_approved` (channel TestFlight) on one candidate | §3.3, §7 | 0b / 1b |
| R11 | Notes and bugs on a version, turned into tasks | `version_notes`, Report bug, `roadmap_create_report`, triage tree | §9 | 0a / 1b |
| R12 | The Roadmap is the complete project flow | Every visible task placed exactly once; Needs-you strip; company Overview | §4.3, §12.3 | 1a |
| R13 | Generic for all companies and projects | Types, roles, gates and labels are data; one skill with no parameters; rollout playbook; trains from day one; multi-repo tags | §3, §8, §10, §14, §18 | 0–2 |
| R14 | Project types with components on existing Projects | `project_profiles` + `components` in the plugin namespace; type is an editable template; type change re-seeds planned versions only; `operations` has no versions; Release profile tab | §3, §12.3, §13 | 1a / 1b |
| R15 | Later restructuring (vpn-node → own project) | Component-or-project both supported; trains link projects; a move keeps history, membership and tags; a manual Phase 0 move works before or after labels exist; the restructuring is a later rollout step whose timing the user picks | §8, §17, §18.6 | 0 (manual move); 3 (move tool) |

---

## 2. Verified facts

### 2.1 Revision 3 facts (re-checked; unchanged)

| # | Fact | Code |
|---|---|---|
| F1 | No assignment wake without an assignee or in `backlog` | `server/src/services/issue-assignment-wakeup.ts:43` |
| F2 | Timer heartbeats act only on `todo`/`in_progress` | `server/src/services/heartbeat.ts:781` |
| F3 | A comment wakes the agent assignee in every open status | `server/src/services/issue-comment-wakeup.ts:24-27` |
| F4 | Orphan recovery takes unassigned `todo`/`blocked` tasks with a creator agent | `server/src/services/recovery/service.ts:2070-2132` |
| F5 | Agents may edit any visible task except another agent's `in_progress` task | `server/src/routes/issues.ts:12779-12784`; `services/authorization.ts:1437-1496` |
| F6 | `labelIds` writes replace the whole set | `services/issues.ts:7120-7134` |
| F7 | Labels are unique per `(company, name)`, ≤ 48 chars, `#rrggbb`, no rename route | `packages/db/src/schema/labels.ts`; `packages/shared/src/validators/issue.ts:830-835`; `routes/issues.ts:8385-8416` |
| F8 | The issue list filters by one `labelId` and by `workspaceId` | `routes/issues.ts:8090`, `:8097` |
| F9 | Run queue order: `in_progress` continuation first, then priority, FIFO; no preemption | `heartbeat.ts:19880-19905` |
| F10 | Routine executions: `originKind='routine_execution'`; a paused project suppresses its routines | `services/routines.ts:1768-1771`, `:3137` |
| F11 | Plugin issue writes skip route side effects and wakes | `services/plugin-host-services.ts:1915-1986` |
| F12 | Plugin `requestWakeup` refuses unassigned, `backlog`, blocked and budget-stopped tasks | `plugin-host-services.ts:2164-2185` |
| F13 | Human-attributed plugin comments need their own capability | `plugin-host-services.ts:2381-2450` |
| F14 | Plugin UI actions carry the host-authenticated actor | `packages/plugins/sdk/src/protocol.ts:419-439` |
| F15 | Tools get `ToolRunContext {agentId, runId, companyId, projectId}` | `packages/plugins/sdk/src/types.ts:264-273` |
| F16 | `in_review` with a typed participant or user, and `blocked` on a user-owned leaf, are healthy waits | `doc/execution-semantics.md:534-596` |
| F17 | Stage routing is workflow-controlled and skips `tasks:assign` | `constants.ts:521`; `routes/issues.ts:13377-13378` |
| F18 | `suggest_tasks` and plan decompositions fire concurrent assignment wakes | `routes/issues.ts:12517`, `16250` |
| F19 | One plugin page catch-all; `PluginPage` passes only `{companyId, companyPrefix}`; `routePath` is one slug | `ui/src/pages/PluginPage.tsx:91-125`; `packages/shared/src/validators/plugin.ts:387-389` |
| F20 | The `sidebar` slot renders at the end of Work in both shells; the mobile bottom nav is fixed | `ui/src/components/Sidebar.tsx:223-231`; `MobileBottomNav.tsx:44-56` |
| F21 | Plugin SQL reads only whitelisted tables; `labels`, `issue_labels`, `project_workspaces`, `routines` are not listed | `constants.ts:1439-1453` |
| F22 | Namespace `plugin_roadmap_d0dfaa84c1` for `paperclip.roadmap` + slug `roadmap` | `services/plugin-database.ts:31-44` |
| F23 | Agents get 409 changing the status of a `blocked` task with open blockers | `routes/issues.ts:12895-12899`, `12951-12956` |
| F24 | Stage participant selection excludes the executor; no eligible participant → 422 | `services/issue-execution-policy.ts:484-499`, `811-817` |
| F25 | After "changes requested", resubmission resumes at that stage | `issue-execution-policy.ts:973-976` |
| F26 | A participant run ending without a decision gets one recovery wake | `doc/execution-semantics.md:551` |
| F27 | Plugin-created tasks have origin `plugin:<key>…`; core recovery skips them | `plugin-host-services.ts:1036-1046`; `recovery/successful-run-handoff.ts:69-71` |
| F28 | Any member or agent can delete a label; memberships cascade | `routes/issues.ts:8416-8443` |
| F29 | Kanban cards show no labels; the Tags column is off by default; priority UI is hidden; plugin chip/card render in both task views | `ui/src/components/KanbanBoard.tsx:322-375`; `ui/src/lib/inbox.ts:52`; `ui/src/pages/IssueDetail.tsx:7019` |
| F30 | `executionWorkspaceSettings` need `enableIsolatedWorkspaces` and replace the project strategy | `services/issues.ts:9655-9662` |
| F31 | Blocker-resolved wakes after plugin writes come from the 30 s dependency backstop | `routes/issues.ts:14745-14760`; `server/src/index.ts:1781` |
| F32 | Every human with company access is `actor.type = 'user'` | `server/src/routes/plugins.ts:728-738` |
| F33 | Delegation-cycle guard on children assigned to an ancestor's creator | `routes/issues.ts:7249-7278` |
| F34 | Core list visibility predicate | `services/issue-visibility.ts:4-6`; `services/issues.ts:2984-3005` |
| F35 | Plugins cannot read `routines` | `constants.ts:1439-1453` |
| F36 | A plugin upgrade that adds capabilities waits in `upgrade_pending` | `services/plugin-lifecycle.ts:64,73` |
| F37 | `canAssignTasks` alone changes nothing under standard trust | `authorization.ts:2144-2172` |
| F38 | Agents in `error` are assignable and invokable | `packages/shared/src/agent-eligibility.ts:67-70` |
| F39 | Plugin `requestWakeup` treats a `cancelled` blocker as open | `plugin-host-services.ts:2174-2177` |
| F40 | Plugin create takes `parentId`/`labelIds`; update takes `labelIds`/`blockedByIssueIds`; neither takes `executionPolicy` | `sdk/src/types.ts:1436-1485` |
| F41 | A task blocked by an unassigned task raises `blocked_by_unassigned_issue` | `recovery/issue-graph-liveness.ts:643-656` |
| F42 | A human-attributed plugin comment wakes only an agent assignee | `plugin-host-services.ts:2427-2460` |
| F43 | Reassignment does not stop a live run | `services/issues.ts:10765-10774` |
| F44 | `packages/plugins/mac-fleet/` is untracked | `git status` |

### 2.2 New facts for revision 4

| # | Fact | Code | Consequence |
|---|---|---|---|
| G1 | `projects` has no type, key or kind column | `packages/db/src/schema/projects.ts:8-34` | Profiles live in the plugin; a later upstream `projects.kind` stays possible. |
| G2 | A project workspace binds one repo to exactly one project (`project_id` ON DELETE CASCADE). The workspace schema has no `projectId`, so a workspace cannot move. Visibility is `default`/`advanced`. | `packages/db/src/schema/project_workspaces.ts:14-45`; `packages/shared/src/validators/project.ts:44-61` | A component's identity is its normalized repo URL + path. A move creates a workspace in the target and hides the old one. |
| G3 | `ctx.projects.listWorkspaces` needs `project.workspaces.read`; events `project.updated` and `project.workspace_created/updated/deleted` exist | `sdk/src/types.ts:863`; `constants.ts:1326`, `1686-1689` | Components are validated through the SDK and reconciled on events. The capability joins the 1a set. |
| G4 | `issues.project_workspace_id` (FK, ON DELETE SET NULL, indexed) defaults on create to the policy default or the primary workspace | `packages/db/src/schema/issues.ts:37`, `:120`; `services/issues.ts:9923-9956` | The workspace is a component **hint**: reliable only when it maps to exactly one component and is not the default or primary workspace (§3.5). |
| G5 | Changing `projectId` re-validates the workspace (422 on mismatch) | `services/issues.ts:7049-7073`, `10698-10735` | Moves PATCH project and workspace together. |
| G6 | The SDK types of plugin `issues.create/update` have no `projectWorkspaceId` and no `projectId` change; plugins cannot create normal projects | `sdk/src/types.ts:891-895`, `1436-1485` | The PM or board performs project moves; the plugin plans, relabels and verifies (see also G23, G24). |
| G7 | Managed skills are a static `SKILL.md` plus files; `ctx.skills.managed` has `get`, `reconcile`, `reset`; reconcile never updates an existing skill | `packages/shared/src/types/plugin.ts:347-371`; `sdk/src/types.ts:947-951`; `services/plugin-managed-skills.ts:312-350` | The skill holds no per-project parameters. Content updates need `reset`. |
| G8 | Managed key = `plugin/<slug(pluginKey)>/<skillKey>`; replace-import matches by key or slug and keeps the existing key | `plugin-managed-skills.ts:25-31`, `274-302`; `services/company-skills.ts:6058-6080` | Phase 0 company skill (slug `roadmap`) is adopted in place. |
| G9 | Company skills: `POST /api/companies/:id/skills` creates `company/<companyId>/<slug>`; files via `PATCH …/skills/:skillId/files`; CLI `skills create --slug --body-file` and `skills agent sync <agent> --skill <ref> --mode add` | `services/company-skills.ts:575`, `681-689`; `routes/company-skills.ts:1014`, `1098`; `cli/src/commands/client/skills.ts:290-318`, `507-540` | Phase 0 needs no deploy. |
| G10 | Agents receive only skills in their own desired set; attach is `POST /api/agents/:id/skills/sync`; plugins cannot change existing agents | `routes/agents.ts:3932`; `sdk/src/types.ts:1660-1677` | The board attaches the skill; the plugin only shows who lacks it. |
| G11 | Instructions are per agent (`PUT /api/agents/:id/instructions-bundle/file`); heartbeat-context's `project` has only id, name, status, targetDate | `routes/agents.ts:5146`; `routes/issues.ts:8658-8664` | Parameters come from a tool or a document; one identical pointer stanza per agent. |
| G12 | Through the MCP gateway, a run with no project gives `projectId: ""` | `services/tool-gateway.ts:10337` | Tools take an explicit `projectId` or `scope: 'company'`. |
| G13 | Plugin tools are denied unless a tool profile allows them | `services/tool-access-policy.ts:1312` | One "Roadmap tools" profile binding per company. |
| G14 | Tool risk is inferred from the name | `tool-gateway.ts:678-695`, `1187-1192` | §0.4 item 2. |
| G15 | Core picks the **first** stage participant that is not the executor; approving the last stage completes the task | `issue-execution-policy.ts:484-499`, `786-805` | Ordered fallback lists; merges happen in the approval stage. |
| G16 | A managed routine exists once per `(company, plugin, kind, key)` | `packages/db/src/schema/plugin_managed_resources.ts:27-31` | Per-PM "Roadmap daily" routines are normal routines (`POST /api/companies/:id/routines`, `routes/routines.ts:157`, triggers `:464`). |
| G17 | Routines can be re-pointed (`updateRoutineSchema` includes `projectId`) | `packages/shared/src/validators/routine.ts:85`; `routes/routines.ts:363` | A move re-points the routines the board picks (G27). |
| G18 | Migration validator: `public.*` only as FROM/JOIN/REFERENCES of whitelisted tables; rejects a leading DROP/TRUNCATE, `DELETE FROM`, triggers, functions, GRANT, `copy`, `call`, `SET`; allows ALTER (including `DROP CONSTRAINT`), partial/expression indexes, generated columns; scans raw statements; one transaction | `services/plugin-database.ts:57-114`, `126-245`, `546-547` | §13 stays inside these rules (§0.4 item 5). Fixes are forward-only. |
| G19 | `AGENT_ROLES` includes `pm`, `qa`, `engineer`, `devops`, `general` | `constants.ts:46-59` | `agent.role` only *suggests* QA owners; PMs on prod have role `general`. |
| G20 | Project detail tabs are `?tab=plugin:<pluginKey>:<slotId>`; the header renders `toolbarButton` slots with `entityType: "project"` | `ui/src/pages/ProjectDetail.tsx:384`, `800-824` | "Roadmap" and "Release profile" tabs; a project header chip. |
| G21 | The v0.1 spike: 8 capabilities, no namespace, slots `sidebar`, `page`, project `detailTab`, issue `toolbarButton` | `packages/plugins/roadmap/src/manifest.ts` (untracked) | §12.1. |
| G22 | Plugin `issues.list` has no label filter (the worker forwards company, project, assignee, origin, status, paging only); the SDK has no labels client; `labels`/`issue_labels` are not core-read tables; manifest `coreReadTables` is a `z.enum` of that list | `sdk/src/worker-rpc-host.ts:801-813`; `sdk/src/types.ts:1424-1435`; `constants.ts:1439-1453`; `packages/shared/src/validators/plugin.ts:638` | S6a is required and must ship before the 1a manifest installs (§16). |
| G23 | Plugin `issues.create` inherits `projectWorkspaceId` from `inheritExecutionWorkspaceFromIssueId ?? parentId` inside the same project; it reuses the source's execution workspace only without an explicit execution-workspace field | `server/src/services/issues.ts:9786-9830`; `sdk/src/types.ts:1436-1462`; `worker-rpc-host.ts:820-846` | Component anchor tasks (§3.5). |
| G24 | Plugin `issues.update` forwards the whole patch and the host spreads it into `issues.update` without a key filter | `worker-rpc-host.ts:853-863`; `plugin-host-services.ts:1951-1970` | Not used; S5/S10 add a typed allowlist (§16). |
| G25 | Issue documents have one format, `markdown` | `packages/shared/src/validators/issue.ts:2108` | Profiles are markdown with one fenced `json` block (§14.3). |
| G26 | `project_workspaces.repo_url` is nullable; `source_type` defaults to `local_path` | `packages/db/src/schema/project_workspaces.ts:21-23` | The repo URL comes from the profile (§3.5). |
| G27 | Routines have no workspace column | `packages/db/src/schema/routines.ts:26-55` | The board picks the routines a move re-points (§17). |
| G28 | SDK `IssuesList` filters by one `labelId`, `workspaceId` and others; no grouping hook | `packages/plugins/sdk/src/ui/components.ts:326-352` | Version › Tasks (§12.3). |
| G29 | Core deletes projects and agents; `ON DELETE SET NULL` re-checks CHECK and NOT NULL | `server/src/routes/projects.ts:790`; `server/src/routes/agents.ts:5654` | §13 rule 5. |
| G30 | The fork's Board policy: only the coordinator creates or assigns tasks; hand-offs set `in_review` and mention the coordinator | `skills/paperclip/SKILL.md:14-22` | §9, §14.4 step 7. |
| G31 | `issues.execution_policy` is readable through the `issues` core-read table; `issue_work_products` is not readable | `packages/db/src/schema/issues.ts:69`; `constants.ts:1439-1453` | Code-deliverable marker (§7.2). |
| G32 | The issue list API filters by `projectId`, `labelId`, `workspaceId`, `status` and `q` | `server/src/routes/issues.ts:8080-8118` | Deterministic Phase 0 discovery (§14.3). |

### 2.3 Prod facts (read-only surveys 2026-10-06/07; not re-checked in this revision)

| # | Fact |
|---|---|
| P1 | **VPN Platform** has 4 git workspaces: `backend` (VPNProject, primary), `node` (VPN-Node), `ios-securezone` (SecurezoneVPN), `ios-securefield` (SecureField). **Securezone iOS** and **Securefield iOS** bind the same iOS repos as their primary workspaces, so one repo is bound in two projects. |
| P2 | VPN Platform: 110 tasks, no labels. By workspace: `node` 58 (12 open), `backend` 43 (20 open), `ios-securezone` 5 (1 open), none 4. Routine "Daily Server Check". |
| P3 | **Presto VPN**: 16 tasks, all on `presto-monorepo` (mobile, api, admin); `presto-vpn-node` has 0. |
| P4 | Leads: VPN Platform, Presto VPN and Cleanio iOS → each company's Project Manager. Securezone iOS, Securefield iOS and every Onboarding project have **no lead**. |
| P5 | Agents. **VPN**: QA (`qa`); BackendEngineer, NodeOps, SecurezoneiOS, SecurefieldiOS (`engineer`; SecurefieldiOS in `error`); Project Manager, SupportTriage, TrelloIntake (`general`). **PRE**: QA Tester (`qa`); iOS Engineer, Backend Engineer (in `error`), VPN Node Engineer (`engineer`); Project Manager. **CLE**: QAEngineer, ReleaseEngineer, FlutterEngineer (all in `error`, Mac); Project Manager, TrelloIntake. Only Cleanio has a release engineer. |
| P6 | Cleanio `main` carries unpublished tags `v1.1.0` and `v1.1.1`; `pubspec` = `1.1.1+74`; nothing was ever uploaded to App Store Connect. MVP is TestFlight-only. |
| P7 | Presto's `GITHUB_TOKEN` acts as the owner's admin account, so the `RELEASERS` guard in `vpn-node-release.yml` does not stop agents. PRE-8 pushed straight to `presto-vpn-node` `main`; the agent tags (`v2.0.2` after CI `vpn-node.yml` is green) and the user dispatches `vpn-node-release.yml`. Secondary repos on SSH runners arrive without `.git`. |
| P8 | VPN-Node: the validation verdict names the validated sha, and the tag sits on the commit that adds `.release-validation/<v>.json` on top of it ("HEAD or HEAD^" rule); a squash merge broke 3.0.32. Board rule (VPN-137): release only after a full pass on the release-test host, then canary `nuremberg-01`, then batches of 5. Only that host (users `nodeops`, `backend`) validates node releases. Node versions 3.0.30–3.0.33 came days apart. |

---

## 3. Release profiles, project types and components

### 3.1 Concepts

```
company ─┬─ project (core) ── release profile (type, project key, label style, version scheme, roles, checklist)
         │     ├─ component (repo + path + tag namespace + tag rule, kind, ship order, merge method, merge window, anchor task)
         │     │     ├─ channels (testflight, app_store, staging, production, release_test, canary, fleet, registry …)
         │     │     ├─ gate definitions (component scope; readiness | distribution)
         │     │     └─ role overrides
         │     ├─ gate definitions (project scope: integration QA, checklist, one board gate)
         │     └─ version (label-bound) ── version_components (in scope? component version, tag)
         │              └─ candidates (per component: sha + build ref) ── deployments (candidate → channel)
         │                                   └─ gate results (bound to a candidate or a candidate set)
         ├─ release train ── members → versions of several projects (≤ 1 open train per version)
         └─ repo tag registry; component lineage (predecessor → successor)
```

- **Component**: one codebase with its own tag namespace. Android and iOS built from one Flutter repo are **one** component with two channel families. A separate native Android repo is another component.
- **Channel**: where a candidate goes. `ships = true` marks the channel whose verified placement means "this component reached users" (store submission, production, fleet, registry).
- **Candidate**: one buildable thing of one component for one version: `(sha, build_ref)`. The build ref is a build number, an image digest, a package version or a commit sha. It generalizes revision 3's build.
- **Gate result**: an append-only verdict with evidence. A component gate binds one candidate; a project or train gate binds a **candidate set**.

### 3.2 The release profile

- One per project, in `project_profiles` (§13). Every project without a profile is shown as `operations` (Ongoing + Routines), so the page works for every company on day one.
- Fields: type and template key; **project key** (2–8 chars `[a-z][a-z0-9]`, unique per company, permanent once a label uses it); label style (`bare`|`prefixed`, at most one bare project per company); version scheme (`semver`|`calver`|`none`); roles; checklist; lane defaults; display words and aliases (for example `frozen` = stabilizing); reference workspaces.
- **Phase 0 equivalent**: the `release-profile` document on the project's Roadmap task: markdown with exactly one fenced `json` block in the `release-profile@1` schema (§14.3, §14.6). `phase0.import` maps it field by field (§12.4).

### 3.3 Types (templates, not cages)

The catalog lives in code (`src/catalog/<type>.ts`) as **data**, versioned (`mobile_app@1` …). Channel and store names (TestFlight, App Store, Play) appear only in that data and in profiles; no code path branches on them. Seeding writes rows with `source='template'`. The board can edit, disable or add (`source='custom'`) any channel, gate, role or checklist item, including a gate's phase. A new catalog revision is offered per project as a diff; it is never applied automatically.

| Type | Default components | Channels | Readiness gates (in order) | Distribution gates (after the tag) | Version / tag | Ship order |
|---|---|---|---|---|---|---|
| `mobile_app` | `app` (`build_number`, merge window `strict`) | beta: `testflight` (on), `play_internal` (off); store: `app_store` (ships, on), `play_store` (ships, off) | `tasks_closed` → `qa` → `beta_approved` (board; one per enabled beta channel; shown with the channel's name, "TestFlight approval") (+ `beta_review` with external testers); `release_checklist` advisory (`required = false`), so Ready is exactly the user's rule (R10) | `store_submitted` per enabled store channel; `store_live` informational | semver marketing version; tag `v{version}`; build number strictly increasing; every upload carries a marketing version, so a `milestone` (no tag) still records the one its builds carry | 40 |
| `backend_service` | `service` (`image_digest` or `commit_sha`, window `off`) | `staging`, `production` (ships) | `tasks_closed` → `qa` → `staging_verified` → `release_checklist` → `board` | `prod_deployed`; `prod_soak` disabled | semver or calver; `v{version}` | 10 |
| `web_app` | `web` | `preview` (disabled), `staging`, `production` (ships) | as backend; QA adds a browser smoke | `prod_deployed` | `v{version}` | 20 |
| `infrastructure` | `node` (`commit_sha` or `package_version`, window `off`, `independent`) | `release_test` (a test host; projects without one use the `ci_green` gate instead), `canary`, `fleet` (ships) | `tasks_closed` → `release_test_validated` (or `ci_green`) → `qa` (on that evidence) → `release_checklist` → `board` | `canary_healthy` (soak) → `fleet_rollout` (waves) | `v{version}`; `tag_rule` `candidate`, or `validation_commit` with merge method `merge` where the tag must sit on the commit that adds the validation record (P8) | 30 |
| `library` | `lib` (`package_version`) | `registry` (ships) | `tasks_closed` → `qa` (CI + API diff) → `release_checklist` → `board` | `published` | `v{version}` | 5 |
| `platform` | none; the wizard proposes one per git workspace, and a monorepo is split by path | per component kind | each component: its kind's gates **minus `board`**; project: `tasks_closed` (unresolved tasks), `integration_qa`, `release_checklist`, **one `board`** over all in-scope candidates | per component, in ship order | lockstep by default; a component may be `independent` (own versions, §4.4) | per component |
| `operations` | — | — | no versions | — | `none` | — |

- **Locked invariants of every versioned template** (requirement 13): the computed `tasks_closed`, at least one QA verdict owned by the `qa` role, and at least one board approval of distribution or deploy evidence. The editor allows changing their labels and owners, not removing them.
- **Infrastructure order** follows the VPN board rule "release only after a full pass on release-test, then canary and batches" (P8): validation and QA happen before the tag, canary and fleet waves after it. A project that canaries before tagging moves `canary_healthy` into readiness in the gate editor.
- **Default checklists** (editable). *Mobile*: version and build bumped, privacy manifest, store metadata and What's New, export compliance, in-app products approved, smoke on the latest OS. *Backend/web*: expand-then-contract migrations, rollback plan and previous tag, env and secret changes, API compatibility with shipped app versions, alerts. *Infrastructure*: rollback script tested, control-API compatibility, key or cert rotation impact, monitoring, connectivity matrix per region. *Library*: changelog, semver rationale.

### 3.4 Gate catalog

| Gate | Kind | Phase | Binds | Approver role | Required evidence |
|---|---|---|---|---|---|
| `tasks_closed` | tasks_closed | readiness | none | computed | Counted tasks of the scope closed, open descendants closed, candidate newer than the last completion of a counted task with a code deliverable (§7.2) |
| `qa` | agent_verdict | readiness | candidate | qa | `sha`, `buildRef`, `report {issueId, documentKey}`, `checks[]`, `notRun[]` |
| `beta_approved` | board_approval | readiness | candidate | board | `channel`, `buildRef`, `artifactVersion` (the marketing version the build carries), `providerState` (`ready_to_test` for TestFlight), `betaReview ∈ {not_needed, approved}`, `device`, `notes` |
| `beta_review` | external_review | readiness | candidate | release_manager | `channel`, `state='approved'`; enabled only with external testers |
| `staging_verified` | deployment_verified | readiness | candidate | qa | `deploymentId`, `deployedSha`, `url`, `smoke[]`, `migrations[]` |
| `release_test_validated` | deployment_verified | readiness | candidate | build_owner | `deploymentId`, `host`, `deployedSha`, `installLog`, `connectivity[{protocol, region, result}]`, `rollbackTested`, `validationRecord` (the record the tag commit adds) |
| `ci_green` | agent_verdict | readiness | candidate | build_owner | `workflow`, `runUrl`, `sha`, `conclusion='success'` |
| `integration_qa` | agent_verdict | readiness | candidate set | qa | as `qa`, over the set |
| `release_checklist` | checklist | readiness | candidate / candidate set | release_manager | `items {key: {done, link?}}`; every required item done |
| `board` | board_approval | readiness | candidate set | board | `note`; the sheet shows all evidence first |
| `canary_healthy` | soak | distribution | candidate | build_owner | `deploymentId`, `nodes[]` or `percent`, `startedAt`, `endedAt`, `successRate` (passes only after `params.minHours` and at `params.minSuccessRate`) |
| `store_submitted` | deployment_verified | distribution | candidate | build_owner | `channel`, `storeVersion`, `buildRef`, `submittedAt` |
| `store_live` | external_review | distribution | candidate | build_owner | `channel`, `state` (`ready_for_sale`, `published`) (not required) |
| `prod_deployed` | deployment_verified | distribution | candidate | build_owner | `deploymentId`, `deployedSha`, `healthCheck='pass'`, `rollbackRef` |
| `fleet_rollout` | deployment_verified | distribution | candidate | build_owner | `nodesTotal`, `nodesUpdated`, `nodesFailed[]`, `finishedAt` |
| `published` | deployment_verified | distribution | candidate | release_manager | `package`, `version`, `registryUrl` |
| `release_workflow` | board_approval | distribution | candidate | board | `workflow`, `runUrl`, `tag`, `conclusion='success'`; for repos whose release workflow only a person dispatches (Presto node, P7) |

- A `deployment_verified` or `soak` gate requires a `deployments` row for that candidate on the gate's channel in state `succeeded`. Its id goes into `gate_results.deployment_id`. Distribution gates bind the tagged candidate; under `tag_rule = validation_commit` the deployed sha is the tag sha.
- Store gates belong to the **build owner**: store submission needs the build machine and the store account, which a QA-default release manager lacks (VPN, PRE).

### 3.5 Components and task → component resolution

- **Fields**: key (immutable after the first version that includes it), kind, `workspace_id` (no FK, F21), normalized `repo_url` (`https://<host>/<owner>/<repo>`, lower case, no `.git`), optional `repo_path`, `versioning` (`lockstep`|`independent`), `tag_pattern` with a generated `tag_prefix`, **`tag_rule`** (`candidate`|`validation_commit`, with `settings.validationPath` such as `.release-validation/{version}.json`), build-ref kind, merge method (`squash`|`merge`|`rebase`), merge window (`strict`|`off`), ship order, state (`pending`|`active`|`retired`|`moved_out`), lineage, **anchor task**.
- **Repo URL**: required for an active component of a versioned profile. It is prefilled from the workspace when core knows it; otherwise the board enters it in the profile (workspaces default to `local_path` with no URL, G26). A missing URL raises `component_repo_unknown` and blocks Start.
- **Anchor task**: one board-owned `release-ops` task per component, "Component: <project> · <component>", filed on the component's workspace (the board creates it through core with `projectWorkspaceId`; in a single-component project the project's Roadmap task serves). The plugin creates every component ops task, and every bug report of that component, with `inheritExecutionWorkspaceFromIssueId = <anchor>` plus an explicit execution-workspace preference. The task then lands on the component's repo and does not reuse the anchor's execution workspace (G23; a 1b contract test pins this). In Phase 0 the PM sets `projectWorkspaceId` on component ops tasks directly.
- **Tag namespace**: a unique index on `(company, repo_url, tag_prefix)` over active components. One project owns a repo's tag namespace. This covers the repo bound in two projects (P1): only the app projects make SecurezoneVPN and SecureField components. VPN Platform's `ios-*` workspaces become **reference workspaces**, ignored by the plugin, and their tasks raise `task_on_reference_workspace`.
- **Resolution** (first match wins; stored in `roadmap_items.component_ids` and `component_source`):
  1. `c:` labels of the task's own project (`label`). Several are allowed.
  2. A component confirmed by the PM or the board, or set by the plugin on its own tasks (`manual`). Phase 0: the component column of the PM's classification. Phase 1: `roadmap_update_tasks {component}` or `task.setComponent`.
  3. The project has exactly one active component (`single`).
  4. `issues.project_workspace_id` maps to exactly one active component without a `repo_path`, and it is **not** the project's default or primary workspace (`workspace`, shown as "inferred").
  5. The same, but on the default or primary workspace, which core assigns when nobody chose one (G4) (`workspace_default`, shown as "inferred from default"). The task is placed there, but staleness treats it as unresolved, and a version task raises `component_unconfirmed`.
  6. Otherwise unresolved (`none`): counted at project level, makes every candidate stale (§7.3), and raises `component_unresolved` in platform projects (shown in an **Unsorted** sub-lane).
- **`c:` labels**: `c:<projectKey>-<componentKey>` exists for **every** component of a project in which two or more components share a workspace (a monorepo), so engineers mark tasks the same way everywhere. Presto gets `c:pre-mobile`, `c:pre-api`, `c:pre-admin` and `c:pre-node`, because all 16 tasks sit on the monorepo workspace, node work included (P3). Projects whose components have separate repos need no `c:` labels. There the PM confirms the component of every version task at classification and sets `projectWorkspaceId` when filing. VPN Platform's `backend` is the primary workspace, so its tasks are only "inferred from default" until confirmed.

### 3.6 Snapshots and type changes

- **Start freezes the gates.** `planned → active` copies the project gates into `versions.gate_snapshot` and each in-scope component's gates, `repo_url`, `repo_path`, `tag_rule`, rendered `tag_name` and `component_version` into `version_components`. Planned versions read the live definitions. Released versions keep their snapshot.
- **Type change** (`profile.changeType`): disables the old template rows, seeds the new ones, keeps custom rows and components, and re-evaluates **planned versions only**. Active or stabilizing versions keep their snapshot unless the board taps **Amend gates** with a reason. Amending supersedes their gate results and is logged.

---

## 4. Flow model

### 4.1 Vocabulary

- **Version**: a plugin row for one project, bound to one `v:` label, with a kind (`main`, `patch`, `milestone`), a lifecycle and gates. A **milestone** has readiness gates only, no tag and no distribution: Cleanio's TestFlight-only MVP (P6). The UI shows "Reached" instead of "Released".
- **Version task**: a task carrying the version's label. **Ongoing**: every other task of the project. **Routine**: a routine execution.
- **Ops task**: a coordination task labelled `release-ops` (Roadmap, tracking, Candidate, QA, Deploy, Tag, merge window). Never counted.
- **Epic**: a top-level `type:epic` task, unassigned, permanently `backlog`, **no** `v:` label, created by the board or the plugin (F33). Its stories may span versions.
- **Hotfix**: an urgent `type:hotfix` task, handed out at once with priority `critical`.
- **Patch version**: kind `patch`, shipped from the tags of a released version.

### 4.2 Labels (company-wide, project-aware)

| Label | Format | Max length (limit 48, F7) | Applied by |
|---|---|---|---|
| Version (prefixed) | `v:<projectKey>-<versionKey>`, e.g. `v:vpn-1.4`, `v:sz-2.1`, `v:pre-1.3` | 2 + 8 + 1 + 32 = 43 | PM (Phase 0 by hand, Phase 1 by tool), board, plugin |
| Version (bare) | `v:<versionKey>`; at most one project per company | 34 | Cleanio iOS: `v:mvp`, `v:1.0`, `v:1.1` |
| Component | `c:<projectKey>-<componentKey>`; every component of a project with a shared workspace (§3.5) | 27 | PM, engineers at creation, plugin |
| Shared | `type:epic`, `type:bug`, `type:hotfix`, `release-ops`; one set per company | — | as revision 3 |
| Train | none on work tasks; optional `train:<key>` on train ops tasks | 38 | plugin |

- **Truth.** `versions.label_name` is unique per company, so a label resolves to at most one version. The plugin binds by exact name and never parses names (except the pre-binding fallback of the v0.1 spike). Labels are the source of membership; the plugin mirrors them (§4.5).
- **Bare-key guards** (worker): a bare version key must not start with `<any projectKey>-`, and a new project key must not equal the first `-` segment of an existing bare key.
- **Keys** follow `^[a-z0-9][a-z0-9._-]{0,31}$`. Only the board creates labels (plugins cannot until S4, §16). The profile tab lists missing labels with "Copy name". Every version needs one, including each version of a frequently released independent component (§4.4).
- **Sub-tasks and follow-ups** copy the parent's `v:` (and `c:`) labels. Counting ignores the copy.
- **Where the version shows** (F29): Phase 0, the properties panel, the Tags column and label filters. Phase 1a, the plugin chip "Version: Securezone iOS 2.1 · Component: app" and card in both task views and on phones.

### 4.3 Classification (lanes)

`classifyTask()` is pure and unit-tested. It places every task core lists show (F34). The first matching rule wins.

1. `originKind='routine_execution'` → **Routines**, grouped by `originId`.
2. `release-ops` → **ops**, attached to its version through its `v:` label, else the project. Builds, test execution, sign-offs, tracking and anchors are ops work, never version tasks (§10.3).
3. `type:epic` → **epic header** (a `v:` label on an epic raises `epic_with_version_label`).
4. A bound `v:` label **of the task's own project** → that **version lane**; patch lanes first. Inheritance from the nearest labelled non-epic ancestor (display only, depth 8, cycle-safe). Two bound labels → `label_conflict`.
   - 4a. A bound `v:` label of **another project**: on a closed task whose version is released or cancelled → history (no lane, no flag); otherwise `foreign_version_label`.
   - 4b. Platform: version lanes are sub-grouped by component; a multi-component task shows under its first component with chips for the others, so it still appears once.
5. Everything else → **Ongoing**. An unbound `v:*` label raises `unregistered_version_label`.

- **Expedite.** On Flow, open `type:hotfix` tasks render in an **⚡ Expedite** swimlane on top *instead of* their version lane (each task still appears once); the version header shows "+N in Expedite". Counting is unchanged.
- **Counted toward progress**: a rule-4 task carrying the label directly whose nearest non-epic ancestor does not carry the same label. `release-ops` tasks are never counted (rule 2 comes first). Progress = `done / (total − cancelled)`.
- **Code deliverable**: a counted task that carries an execution policy (`issues.execution_policy`, G31; every PR task gets one at hand-out, §11.2). Only these make a candidate stale (§7.2). Decision, research and docs tasks count toward progress and `tasks_closed`, not toward staleness.
- **`tasks_closed`**: every counted task is closed and every open descendant of a counted task is closed. Per component, it covers the counted tasks resolved to that component plus unresolved ones (§7.2).
- Tasks without a project show on Overview as "No project (N)" (`task_without_project`); `release-ops` tasks such as the company index task are exempt.

### 4.4 Version lifecycle

| State | Shown as | Phase 0 alias | Token | Meaning |
|---|---|---|---|---|
| `planned` | Planned | planning | `--status-task-backlog` | Tasks parked; gates read live definitions |
| `active` | In development | active | `--status-task-in_progress` | PM hands out; gates snapshotted |
| `stabilizing` | Stabilizing | frozen | `--status-task-in_review` | Scope frozen (only `type:bug`/`type:hotfix` join); candidates, QA, approvals; **Ready** badge |
| `released` | Released / Reached | released | `--status-task-done` | Every in-scope component tagged (milestone: board "Mark reached" after Ready). Read-only. **Live** badge when distribution passes. |
| `cancelled` | Cancelled | — | `--status-task-cancelled` | Read-only |

- **Trunk rule** (per component): a component is in scope of at most one `main` or `milestone` version that is `active` or `stabilizing`, and of at most one open patch. In a single-component project this means one such version per project. In a platform, lockstep components share versions. An `independent` component is out of scope by default in new main versions and gets its own versions (key `node-3.1`, label `v:vpn-node-3.1`), which start, stabilize and release without waiting for the other components' gates. `versionReady` only covers in-scope components (§7.2). The cost: each such version needs one board-created label until S4.
- Every transition is a CAS on `row_version`, writes `roadmap_events`, logs `roadmap.version.<verb>` and upserts the core `release` document on the tracking task. Side effects run sequentially with at most 3 wakes.

| Transition | Who | Preconditions | Side effects |
|---|---|---|---|
| create → `planned` | Board, or board applying a proposal | Key unique per project; label exists | none |
| Start → `active` | Board (a train member: also the train's Start) | Trunk rule; patch: base released; planned tags free in `repo_tags`; every in-scope component has a `repo_url`; mobile: the marketing version is decided | Snapshot (§3.6); tracking task "Release <project> <ver>" (first approver, `release-ops` + label); PM ops task "Hand out <ver> work" (1 wake) |
| Stabilize → `stabilizing` | Board; PM proposes; plugin suggests when `tasks_closed` holds or the target passed | Move-unfinished sheet confirmed; in-flight tasks stay | Merge-window task when a component has `merge_window='strict'`; ops tasks per gate (§7.4) |
| Reopen → `active` | Board, with a reason | — | Supersedes candidates; closes the merge-window task |
| Release → `released` | Release manager via `roadmap_create_release` per component; board `component.recordTag` when a person tags; board "Mark released" with a reason | Ready (§7.2); the tag sha satisfies the component's tag rule (§11.1); `tag` = the rendered `tag_name`; no unretired `repo_tags` row for it | Closes tracking and merge-window tasks; held work wakes (F31) plus ≤ 3 direct wakes; Needs-you "Plan / start the next version"; distribution ops tasks |
| Cancel | Board, with a reason | Move-unfinished confirmed | Cancels open ops tasks; sets its `version_components` rows to `skipped`, which frees their rendered tags |

A patch created by "Insert hotfix" starts in `active`; the tick stabilizes it when its `tasks_closed` holds.

### 4.5 Parking, drift and the label mirror (unchanged from revision 3)

- **Parked** = a task of a `planned` version that is unassigned and `backlog` (closes F1–F4). **Parking is one write**: `{status:'backlog', assigneeAgentId:null}`. In the task UI, status first, then assignee.
- **Who parks**: `todo`/`backlog` tasks → PM, board or plugin. `blocked`/`in_review` → board or plugin only (F23). In-flight tasks (`in_progress`, or `checkoutRunId`/`executionRunId` set) are never parked; a move may relabel them only. A **user-owned** task cannot wake an agent and needs no parking.
- **Cross-version blockers**: a parked task that blocks open work of an earlier lane raises `cross_version_blocker` and is skipped by moves (`skipped(blocks_active_work)`) unless the board ticks "park anyway". Inside a train, member versions count as one lane group (`cross_project_blocker`).
- **Detected, not prevented** (F5), within 5 minutes: `parked_task_moved`, `half_parked`, `run_on_parked_task`. Board **Re-park** (1b); `auto_repark` (Phase 2) only with no live run.
- **Label mirror** (`roadmap_items`): a bound label id disappears → critical `version_label_missing` → the board recreates the label, the plugin re-binds and re-applies it (read-modify-write, sequential, no wakes). A label removed from a mirrored task → `version_label_removed` with confirm or Restore. Phase 0: the PM's daily run writes each label's task list into the `roadmap` document.
- **Never used for version control**: project pause (suppresses routines, F10), tree holds, run cancellation, label deletion.

### 4.6 Epics and sub-tasks

Epics are created by the board (Phase 0) or the plugin (Phase 1). Stories are their children; the PM re-parents existing tasks through core (plugin update has no `parentId`, F40). Sub-tasks display under their parent and keep it open in `tasks_closed`. Epic rollup per lane is computed from the parent map. An epic whose stories all move to another project (§17) is recreated by the board in the target.

---

## 5. Scheduling: versions move, ongoing work and routines keep running

The levers are hand-out (assign + `todo`), priority stamps and explicit wakes (≤ 3 per action or tick). Nobody reorders core queues, cancels runs or pauses projects (F9).

| Lane | Budget per agent | Priority | Who hands out |
|---|---|---|---|
| Hotfix | Outside WIP; PM capped by `hotfix_daily_cap` (default 3) per version per day | `critical` | Board or PM at insertion |
| Version | `wip_version_per_agent` (default 1) top-level version tasks in `todo`/`in_progress` | PM's value; stabilizing bugs `high` | PM by next-up; board "Hand out now" |
| Ongoing | `wip_ongoing_per_agent` (default 1), flag only; aging | PM's value | PM, as today |
| Routine | Outside WIP, never touched | Routine's own | Core scheduler |
| Review and ops | Outside WIP | QA and candidate ops `high` while stabilizing | Workflow routing, plugin |

**Next-up** (computed by the plugin, executed by the PM): skip agents that are paused, terminated or in `error` (role-down mode, `owner_unavailable`); when the version slot is free, take the first unassigned `backlog` version task with that planned owner, ordered patch > stabilizing (bugs/hotfixes only) > active, then hotfix, bug, others, then rank, then `created_at`, skipping tasks with blockers that are not `done` (a cancelled blocker raises `cancelled_blocker`). Flags: `ongoing_over_wip`, `ongoing_aging` (no run for `ongoing_aging_hours` since `assigned_at`; the PM bumps one step, never to `critical`), `long_in_progress` (> 8 h while ongoing work or a routine of that agent waits), `needs_owner`.

- **The PM hands out** with one core `PATCH {assigneeAgentId, status:'todo', executionPolicy}` per task (§11.2). **Board "Hand out now"** pre-checks the owner (not `error`), open `budget_incidents` and blockers (F39), then plugin update + one `requestWakeup`; a failed wake leaves the assignment and raises `handout_not_woken`.
- **Bounds**: ongoing work has its own slot, but a queued `in_progress` continuation of the same agent always runs first (F9). Hotfixes start after the current run. Every wake passes budget checks (F12).
- **Wake safety** (2026-10-06 DB-pool deadlock): ≤ 3 sequential `requestWakeup` per company per action or tick; bulk applies create unassigned `backlog` tasks; the PM never accepts `suggest_tasks` or plan decompositions creating more than 3 assigned tasks (F18); closing a merge-window task wakes all held work, so keep held work small.

---

## 6. Hotfixes and patch versions

### 6.1 Definitions

- **Fix**: a bug in the current version found in the normal flow; `type:bug` + version label; normal order (bugs first while stabilizing).
- **Hotfix**: urgent (crash, data loss, store rejection, outage, a blocker in a shipped or candidate build); `type:hotfix` (+ version label unless it targets Ongoing), `critical`, handed out immediately, outside WIP, always merge-eligible.

### 6.2 "Insert hotfix" by target (board action, PM tool `roadmap_create_hotfix`)

| Target | Who | Effect |
|---|---|---|
| Ongoing | Board, PM | `type:hotfix`, `critical`, assigned, `todo`, 1 wake. If a strict merge window of the same component is closed and the change touches its paths, the sheet offers "into <stabilizing version> (resets Ready)" or "new patch" instead. |
| `planned` version | Board, PM | Becomes a normal parked `type:bug` task |
| `active` version | Board; PM within the cap | As Ongoing, with the label; FYI flag |
| `stabilizing` version | Board; a PM insertion becomes a proposal | As above; the component's Ready drops (§7.3) |
| New patch of the last released version | Board; PM proposes | Creates a `patch` version (`active`) after the board creates its label |

The PM recommends **patch** (shipped bug, blocker, next main version not within about 7 days of Ready) or **fix-forward**; the board decides. A hotfix may skip a gate (for example the canary soak or staging) only by a board **waiver** with a reason; QA and the board gate cannot be skipped.

### 6.3 Patch versions and git (no branch is pushed)

Every fix merges into `main` like any task. `patch_mode`:

- **`from_main`**: `main` has no unreleased changes of the component since its base tag (compare `<base tag>...main` scoped to the component path). Built from `main`; the component's merge window applies.
- **`cherry_pick`**: the release manager checks out the component's base tag (detached), runs `git cherry-pick -x <merge sha>…`, builds and records that commit as the candidate, and pushes it as the non-branch, non-tag ref `refs/roadmap/rc/<component>/<version>/<n>` so QA, build owners on other hosts and CI can fetch the sha (`candidates.candidate_ref`). The first use per remote checks that the host accepts the ref; if it does not, a `git bundle` attached to the candidate ops task replaces it (the release-test host already receives trees that way). After Ready the release manager tags it (`git tag -a <tag> <sha>`, `git push origin <tag>`) and may remove the RC ref. No branch reaches the remote; `main` already has the fix. A non-trivial conflict becomes a `release-ops` task "Backport <fix> onto <base tag>" for the fix's engineer, created by the plugin (Phase 1) or by the PM on the release manager's proposal (Phase 0) (a patch file or PR comment, never a branch), or the board switches to fix-forward. The merge window does not apply.

Where secondary repos arrive without `.git` (P7), the release manager uses a fresh clone or the GitHub API (`gh release create <tag> --target <sha>`).

---

## 7. Readiness, release and distribution

### 7.1 Candidates, deployments, gate results

| Revision 3 | Revision 4/5 |
|---|---|
| `version_builds (sha, build_number)` | `candidates (component, seq, sha, build_ref, build_ref_kind, source, artifact_version, candidate_ref)`: RC1, RC2 … per (version, component). `source` is `main`, `branch` (validated before merge; only under `tag_rule = validation_commit`) or `cherry_pick` |
| `qa_verdict`, `qa_report`, overrides | `gate_results` for gate `qa`; a board override is `gate.decide` with a reason |
| `testflight_state`, `beta_review_state` | `gate_results` for `beta_approved`, `beta_review`; external testers = `channels.settings.externalTesters` |
| — | `deployments`: a candidate placed on a channel (`started`/`succeeded`/`failed`/`rolled_back`, scope such as `{percent:10}` or `{nodes:[…]}`) |
| `versions.tag`, `tag_sha` | `version_components.tag_name`, `tag_sha` (the candidate sha, or its validation child) + the `repo_tags` registry |
| `qa_agent_id`, `release_agent_id`, `pm_agent_id` | `project_roles` (§10.1) |

Evidence is validated against the gate's `evidence_schema` (`roadmap_evidence_invalid` names missing fields). Document references `{issueId, documentKey}` are checked through `ctx.issues.documents`.

### 7.2 Ready, Released and Live (pure, unit-tested; never stored)

```
current(v,c)        = newest candidate of (v,c) not superseded
scoped(v,c)         = counted tasks of v resolved to c, plus those resolved only as workspace_default or none (conservative)
codeDone(v,c)       = completion times of scoped(v,c) tasks with a code deliverable (§4.3)
pass(g, scope)      = latest non-revoked result for (scope, g) is pass|waived, and g.depends_on pass on the same scope
componentReady(v,c) = in_scope(v,c) and current(v,c) exists
                      and scoped(v,c) closed with open descendants closed
                      and current(v,c).created_at > max(codeDone(v,c))   -- else "stale: built before X was merged"
                      and every enabled, required readiness gate of c's snapshot passes on current(v,c)
versionReady(v)     = every in-scope component Ready
                      and every enabled, required project readiness gate passes with candidate_set {c: current(v,c)}
                      -- 'board' comes from the train when v rides a train with board_gate = 'single'
trainReady(t)       = every required member versionReady (member 'board' skipped under 'single')
                      and every train gate passes with candidate_set {v: {c: current(v,c)}}
tagOk(v,c,sha)      = sha = ready(v,c).sha                                        -- tag_rule 'candidate'
                      or (parent(sha) = ready(v,c).sha and sha only adds validationPath(version)
                          and sha is reachable from the trunk)                    -- tag_rule 'validation_commit'
released(v)         = every in-scope component tagged with tagOk           (milestone: board "Mark reached")
live(v,c)           = every enabled, required distribution gate of c passes on the tagged candidate
```

- The Ready candidate `ready(v,c)` is fixed when the version (or its train under `single`) becomes Ready. Tags are only recorded against it.
- **Tag rule evidence** is self-reported until the Phase 3 verifier: `roadmap_create_release {tag, sha, evidence: {parentSha, changedPaths}}`. A `branch` candidate (VPN-Node validates the task branch before merge, "tested before proposed") must reach the trunk through its validation commit before the tag; the component's merge method is then `merge`, because a squash merge loses the validated commit (P8).
- **Ship order** applies to distribution, not to tags: `roadmap_create_deployment` to a `ships=true` channel is refused with `roadmap_ship_order` while a component with a lower `ship_order` in the same version, or (under `ship_policy='ordered'`) in any member of the same train, is not Live. `together`: nothing ships before `trainReady`; `independent`: no ordering. The board can override with a reason. Agents still hold deploy credentials, so this is detection plus tool refusal, not prevention.

### 7.3 Invalidation

- A new candidate for `(v,c)` supersedes the older one: `c` is no longer Ready, and project and train results whose candidate set names the old candidate stop matching. A new mobile build resets QA and the beta approval (revision 3); a new backend candidate resets QA, staging and the project's board approval.
- A code-deliverable task resolved to `c` and completed after the candidate makes only `c` stale. A code-deliverable task that is unresolved, or only inferred from the default workspace, makes every candidate of the version stale until the PM confirms its component. A task without a code deliverable (decisions, research, docs, ops) never makes a candidate stale.
- The board may **revoke** a result with a reason (for example a TestFlight approval after a crash report). Fails and revokes file bug notes with `component_id` and `candidate_id`. Only the board **waives**, always with a reason.

### 7.4 Sequence and ops tasks

Ops tasks carry `release-ops` + the version label, are created from the component's anchor task so they land on its repo (§3.5), send 1 wake, and at most 3 are created per tick. Board gates are Needs-you items, never tasks.

| Ops task | Owner role | Created when |
|---|---|---|
| "Candidate <proj> <ver> <component>" | build_owner | the component's `tasks_closed` holds |
| "QA <proj> <ver> <component> RC<n>" | qa | a candidate is recorded |
| "Deploy <component> RC<n> → <channel>" | build_owner | in readiness gate order (staging, release test) |
| "Tag <proj> <ver> <component>" | release_manager | the version (or train) is Ready; under `validation_commit` the task first adds the validation record commit |
| "Ship <proj> <ver> <component> → <channel>" | build_owner (release manager for `published`) | after the tag, in ship order (canary, fleet, production, store, registry) |

Mobile example (Cleanio, revision 3 §6.3 unchanged): stabilize → `tasks_closed` → candidate ops task (release manager builds `main@sha`, uploads, waits for "Ready to Test", `roadmap_create_candidate`) → QA ops task (`roadmap_create_gate_result` gate `qa`) and the Needs-you "Approve TestFlight build N" (gate `beta_approved`; the board installs and approves) → Ready → Tag ops task (`git tag -a v<x.y.z> <sha>`, push, `gh release create --verify-tag`, `roadmap_create_release`) → released, merge window closes → Ship ops task (`store_submitted`).

### 7.5 Phase 0 readiness record

The tracking task's `readiness` document holds one fenced `json` block (the source; §14.3) and a markdown table the PM regenerates above it for reading. It has one row per candidate (component, RC n, sha, source, build ref, artifact version, one column per gate of the profile, evidence links, Ready yes/no) and one row per **candidate set** for project and train gates (members as `{component: RC n @ sha7}`). Board gates use `request_board_approval` with these titles:

- component gate: `<gate>: <project> <ver> <component> RC<n> @ <sha7>`
- project gate: `<gate>: <project> <ver> {backend RC2 @ 1a2b3c4, node RC1 @ 5d6e7f8}`
- train gate: `<gate>: train <name> {<project> <ver>: {…}, …}`

Tags are created only from a "Ready: yes" row. `phase0.import` turns the rows into `candidates` and `gate_results` (`imported_from='phase0_readiness_doc'`, `approval_id` linked).

---

## 8. Release trains (cross-project, one company)

- **What**: `release_trains` + `train_members` (§13). A train holds at most one version per project; a version rides at most one open train. Trains are in migration 001; Phase 1a shows them read-only, 1b creates and edits them, Phase 2 enforces ship order.
- **Owner**: one agent (`owner_agent_id`; if that agent is deleted the column empties and the train raises `train_owner_missing`), by default the PM of the **anchor** project (the member the others depend on, for example VPN Platform, whose API the apps and nodes consume). The owner must be the PM of at least one member. **Member PMs keep authority over their own versions**; the owner files train proposals the board applies, or asks a member PM on that PM's planning task.
- **Lifecycle**: same five states. Start is board-only and requires every required member. Stabilize is suggested when every required member is stabilizing. Released when every required member is released; optional members may trail ("trailing").
- **Gates** (editable at creation, frozen at Start): `integration_qa` (the anchor's QA owner, over all members' candidates), `release_checklist` (API backward compatible with shipped app versions, minimum app version updated, node ↔ control protocol compatible, rollout and rollback order written), and `board` with `board_gate = 'single'` (default): one approval bound to every member's candidate set, replacing each member's project `board` gate. Component gates such as `beta_approved` stay per app; one sheet can record both (`gate.decide` with `alsoGateKeys`). `per_member` is the fallback when single approvals churn.
- **Ship order** across members uses component ship order (library 5 → backend 10 → web 20 → infrastructure 30 → mobile 40). For VPN: backend prod → node fleet → both apps submitted.
- **Tasks**: integration tasks live in the anchor project with the anchor version's label. The train tracking task "Train: <name>" is board-owned in the anchor project. Work tasks carry **no** train label; membership is version → train.
- **Cadence**: the train owner's daily run writes a train summary (members' states and gates, ship step, blockers) on the train task. Membership changes are proposed by the owner while no member is stabilizing; afterwards only the board decides.
- **Phase 0**: the company task "Roadmap: <Company> (company)" holds the `roadmap-index` document (one fenced `json` block) with `trains[]` (key, name, owner, anchor, members with label and ship order, board-gate mode, state, target). Train readiness lives in the `readiness` document of the train tracking task, with candidate-set rows and the train approval title of §7.5. `phase0.import` maps it field by field.

---

## 9. Notes and bugs

- **Entry points**: board "Report bug" / "Add note" (version page, lane menu, comment menu "Report as bug or note"); agent tool `roadmap_create_report {versionKey, component?, candidateId?, kind, severity?, title, body, relatedIssueId?}`, 20 per agent per day (the plugin, not the agent, creates the task, so the Board policy holds); TrelloIntake and SupportTriage unchanged (they forward to the right PM with a `Proposed flow:` line).
- **Phase 0**: the fork's Board policy lets only the coordinator create tasks (G30), so **only the PM** creates a **top-level** task "Bug: …" (`type:bug` + version label when known), unassigned, `backlog`, first lines `Affects: <version label> <component> <build ref>` and `Related: <task>`, filed on the component's workspace. Everyone else, QA owners and release managers included, writes the bug under `Proposals` in their own task comment with the same `Affects:` line. For a blocker they mention the PM once (the policy allows one mention of the coordinator); otherwise the PM's daily run collects proposals. Backport requests (§6.3) follow the same path. Never file a bug as a child assigned to the PM (F33) or as a comment on a done task (a comment reopens it).
- **What a report creates**: a `version_notes` row; for a bug, a top-level `type:bug` task with priority from severity (blocker `critical`, major `high`, minor `medium`) and a target: `triage` (default; blocker/major assigned to the PM in `todo` with 1 wake), `this version` (resets that component's Ready), `hotfix now` (§6.2), `next version` (parked). Notes (`note`, `risk`, `decision`) stay notes until "Create task from note". Agent-visible notes mirror into the `version-notes` document; the release manager drafts release notes from it.
- **PM triage tree**: duplicate/not reproducible/won't fix → cancel with a reason; shipped build + blocker → hotfix (patch or fix-forward), else next version; release candidate + blocks release → hotfix into that version, else next version; unreleased scope → bug of the active version; not product behaviour → Ongoing. Recorded on the note and in a comment "Triage: <decision> — <reason>".

---

## 10. Roles and the PM loop

### 10.1 Role catalog

| Role | Scope | Responsibilities | Default (proposed once, confirmed by the board, then stored) |
|---|---|---|---|
| `pm` (roadmap owner) | Project, one agent | Plans with the board, triages, hands out with policies, daily run, proposes transitions, files bug and ops tasks in Phase 0. The project's **coordinator** under the fork Board policy (G30). | `projects.lead_agent_id`, else the company default PM |
| `qa` (QA owners) | Project, ordered; component override | Review stage; QA verdicts per candidate; integration QA | The single agent with role `qa` (G19) |
| `merge_owner` | Project, ordered principals; component override | Approval stage; **the only principals that merge**; enforce the window; write the trailer | Configured list, else [company release agent, QA owners…, PM] + always a board user last |
| `release_manager` | Project, one principal; component override | Tags, release records, release notes, cherry-pick patches, tracking task | First agent merge owner, else the PM; a board user when only a person may tag (`component.recordTag`) |
| `build_owner` | Component, one principal | Candidates, deployments and store submission in the right environment (Mac, release-test host, staging, store account) | The release manager; for `mobile_app` components the board sets it explicitly to the agent with the build machine |
| `developer` | Component | Planned-owner suggestions only | Most frequent assignee of closed tasks on the component's workspace in 90 days |
| `approver` | Project, board users | Board gates, proposals, transitions | The company's `board_user_ids` |
| Intake agents | Company list | Forward intake to the right project's PM | TrelloIntake, SupportTriage |
| Train owner | Train, one agent | §8 | The anchor project's PM |

Implementers are not a role: any agent with planned or assigned work. **Implementers never merge, and the implementer of app code is never its merge owner** (F24).

### 10.2 Resolution and role-down mode

```
pm(p)            = role pm ?? projects.lead_agent_id ?? company.default_pm ?? none            → pm_missing
qaOwners(p,c)    = component override ?: project rows ?: []                                     → [] : approvers record QA
mergeOwners(p,c) = component override ?: project rows ?: [company.release_agent] ++ [pm] ++ qaOwners   (only when nothing is stored and not strict; PM before QA, board decision 2026-10-07)
                   ++ [{user: approvers(p)[0]}]                                                  -- board fallback, always last
releaseManager   = component ?? project ?? firstAgent(mergeOwners) ?? pm;  buildOwner(c) = component ?? releaseManager
available(a)     = status not in (terminated, paused, error)       -- core routes to error agents (F38), so filter here
```

- **Only stored values count at runtime**, plus the board fallback. A newly hired `qa` agent never silently changes who merges.
- **Role-down mode** (generalizes Mac-down): when every agent merge owner is unavailable and the list is `strict`, the builder returns no policy (`merge_owner_unavailable`) and the PM hands out no code tasks for that component. When not strict, the next available principal is used, ending with the board (`merge_owner_is_board`).
- **Health flags** (Needs-you): `pm_missing`, `role_agent_unavailable`, `merge_owner_unavailable`, `merge_owner_is_board`, `qa_owner_missing`, `role_unfilled` (a gate's approver role is empty), `policy_missing`, `policy_stale` (roles changed; task not yet in review), `policy_names_unavailable_agent`, `merge_by_non_owner`, `skill_not_attached`, `profile_invalid` (the Phase 0 profile block does not parse or fails the schema), `train_owner_missing`.

### 10.3 Plan-with-PM loop (per project)

| Stage | Who | Artifact | Wakes |
|---|---|---|---|
| Kickoff | Board | "Plan roadmap: <project>" (template below), profile in place | 1 |
| Draft | PM | `roadmap` document with **measured facts and evidence** (trunk state, unmerged branches, CI/analyzer, environment health, task counts). The Cleanio draft rev1 is the reference shape. | — |
| Ask | PM | One `request_board_approval` + at most one `ask_user_questions` card (`human_only`, ≤ 4 questions); waits in `in_review` | 0 |
| Decide | Board | Approve (with a note for small corrections) or request a revision by comment. Phase 1b: proposal review with Apply / Request changes. | 1 |
| Apply | PM, then board | PM: labels (read-modify-write), parking of `todo`/`backlog`, `Planned owner:`/`Rank:` lines, cancellations with a reason. Board: labels, epics, parking list, profile `versions`. | 0 |
| Run | PM | Hand-out (≤ 3 per run, one PATCH each, with policies), triage, hotfixes, daily run | ≤ 3 per run |
| Transition | PM proposes, board decides | Start, Stabilize (with the move-unfinished list), Release, Cancel | per decision |

- **Phase 1b** (revision 3 §8.2–§8.3 unchanged): `roadmap_create_proposal` stores the proposal with `handover_run_id`; on the run's end the plugin moves the planning task to `in_review`, assigned to the first approver (never under a live run, F43). Apply is sequential and idempotent; the planning task returns to the PM in `todo` and a board-attributed comment is the 1 wake (F42). The "Send to PM" composer is state-aware (assigned to PM → comment; proposal pending → "Request changes with this message"; done → reopen; unassigned → assign) and each message costs one PM run.
- **Proposal body** covers versions, classification (with component), new tasks, re-parent items, cancellations, owners and ranks, and in 1b also profile, components, trains and `questions[]`. On a project with no profile, "Start planning" asks the PM to propose the profile too.

**Planning task template** (`references/templates/plan-roadmap.md`):

```markdown
Title: Plan roadmap: <project>      Assignee: <PM>   Status: todo   Parent: Roadmap: <project>   Labels: release-ops
Read first: the `roadmap` skill (roles/pm.md, types/<type>.md) and the `release-profile` document on the parent.
Write the `roadmap` document on the parent with:
1. Facts measured in this run, each with its evidence (command or API call).
2. Versions: key, label (from the profile, or "label needed"), goal, scope, components, version numbers
   and tags per tag pattern, target (date or relative), kind (main | milestone), gates from the profile.
3. Epics: names and scope only. The board creates them.
4. Classification of every open task except routine executions: version | ongoing | ops | cancel | board-owned;
   component (confirm it for every version task when the project has two or more components); epic;
   planned owner (never a merge owner or release manager for app code); rank (gaps of 10); status;
   park action (you | board list | none: in flight | none: user-owned). Builds, test execution and
   sign-offs are ops (release-ops), never version tasks: they run on a candidate after the code is done.
5. Board parking list (blocked/in_review future tasks) and every cross-version or cross-project blocker.
6. Project-specific exceptions to the skill (do not restate the skill).
7. Questions: at most 4, on one ask_user_questions card (human_only).
8. Timeline (Mermaid gantt).   9. Apply plan in two lists: "PM applies" and "Board applies".
Then file one request_board_approval linked to this task, set it in_review and end the run.
Never: create labels or epics; label an epic with a version; park a blocked or in_review task; hand out to an
agent in error or paused; give an engineer more than one version task in todo/in_progress; create more than
3 assigned tasks per action; cancel or reassign in-flight work.
```

### 10.4 Cadence: one "Roadmap daily" per PM per company

- A normal core routine (a managed routine exists once per company, G16): assignee = the PM; project = the PM's anchor project (gives tool context, G12); cron 09:00 company time; `concurrencyPolicy: skip_if_active`; `catchUpPolicy: skip_missed`; priority `medium`.
- Description (generic): "Follow the `roadmap` skill, section Daily, for every project where you are the PM."
- Duties per owned project: parse the profile; role health; file the bug proposals agents wrote in their task comments (Phase 0, §9); triage bugs and intake; confirm components of new version tasks; fill free version slots from next-up (**≤ 3 hand-out wakes per run across all projects**); readiness summary; drift and label checks plus the label backup; aging bumps; merge detection per component repo (trailer and `by=`); propose Stabilize when `tasks_closed` holds. **Mondays** add the weekly duties (dates, next-version draft, a proposal only when a decision is needed). Train owners also write the train summary.
- Check every agent's `maxDailyRuns` first: a wake skipped by the daily cap is dropped, not retried.

---

## 11. VCS: trunks, tags, merge owners, no branch protection

### 11.1 Trunks and tags

- One branch per repo on the remote, the profile's trunk (default `main`). Task branches `{{issue.identifier}}-{{slug}}` (`server/src/services/workspace-runtime.ts:3268`), one PR per task, deleted on merge. **No other branch is pushed.**
- Tags are per component: `tag_pattern` rendered with the component version at Start.
  - Alone in its repo → `v{version}` (Cleanio `v1.0.0`, VPN-Node `v3.1.0`).
  - Several components in one repo → `<componentKey>/v{version}` (`api/v1.3.0`); the wizard enforces it.
  - Lockstep components use the project's `version_number`; independent ones their own, monotonic along the lineage.
- **Tag rule** per component: `candidate` puts the tag on the Ready candidate's sha. `validation_commit` puts it on the child commit that only adds the validation record (`.release-validation/<v>.json` for VPN-Node, P8), reachable from the trunk; the component then merges with method `merge` (§7.2).
- **`repo_tags` registry** (company, repo, tag): `imported` (existing tags, pasted from `git ls-remote --tags` until the Phase 3 verifier), `recorded` (by `roadmap_create_release` or `component.recordTag`), `verified` (Phase 3), `retired` (deleted in git by the board; no longer blocks, and the name can be recorded again, §13). Start checks planned tags against it. Onboarding imports existing tags and derives each component's `tag_pattern` from them.
- Commands for release managers (runbooks): `git tag -a api/v1.4.0 <sha> -m "<project> <ver> api"`, `git push origin api/v1.4.0`, `gh release create api/v1.4.0 --verify-tag`, `git describe --match 'api/v*'`. Tags are never moved; a wrong tag is superseded by a patch.

### 11.2 Merge owners and the policy builder

A task gets an execution policy when its deliverable is a PR into a repo-backed component. `release-ops` tasks (merged by the release manager with `flow=release-ops`), decision/research/docs tasks without a PR, and routine executions get none.

```
expectedPolicy(task, executor):
  c = component(task); if task has no code deliverable → null
  reviewers = qaOwners(p,c).filter(available).filter(≠ executor)
  mergers   = mergeOwners(p,c).filter(user or available).filter(≠ executor)
  if strict and mergers has no agent → {policy: null, reason: 'merge_owner_unavailable'}
  if reviewers empty or reviewers[0] == mergers[0] → {stages: [{approval: mergers}]}           -- one run reviews and merges
  else → {stages: [{review: reviewers}, {approval: mergers}]}
```

| Project | Executor | Policy |
|---|---|---|
| Cleanio iOS | FlutterEngineer | `[review: QAEngineer] → [approval: ReleaseEngineer, board]` |
| Cleanio iOS | QAEngineer (test code) | `[approval: ReleaseEngineer, board]` |
| Securezone iOS (proposed) | SecurezoneiOS | `[approval: QA, PM, board]` (collapsed: QA reviews and merges) |
| Securezone iOS (proposed) | QA | `[approval: PM, board]` |
| Presto VPN `api` (proposed) | Backend Engineer | `[approval: QA Tester, PM, board]` |

- Core picks the first participant that is not the executor (G15), so ordered lists never 422, and a board user is always last.
- **Who sets it**: the PM at hand-out, in the same PATCH as the assignee. The engineer adds it before `in_review` if missing (`roadmap_context.task.expectedPolicy`). The plugin cannot (F40, until S5). **Never edit the policy of a task in `in_review`**: stage ids regenerate (`issue-execution-policy.ts:788-792`).
- **The merge happens in the approval run**: the merge owner merges (`gh pr merge`, method per component, or `merge` when the PM writes `Merge method: merge` on an integration task such as Cleanio's CLE-87), then approves the stage with "Merged #N as <sha>". A board user merges in GitHub and then approves.
- **Without a release engineer** (VPN, PRE): default merge owners [QA owner, PM] + board, release manager = QA owner (tags only; store submission and deployments stay with build owners, §3.4). QA reviews and merges in one run, and merges stay off the PM, who plans several projects. Cost: QA has one run slot, so reviews, merges and QA rounds share a queue; the remedy is hiring a release engineer (`hire_agent` approval) and setting `release_agent_id`. Open question 5.

### 11.3 Merge window per component and path

- Closed for a repo while a version containing a `merge_window='strict'` component of that repo is `stabilizing`, or while a `from_main` patch of it is open. Mobile is strict by default; sha-pinned services and nodes are `off`.
- A PR is eligible while closed when the task carries that version's label, is `type:hotfix` or `release-ops`, or every changed path (`gh pr diff --name-only`) lies outside the stabilizing components' `repo_path`. In a monorepo an `api/` PR merges while `mobile/` stabilizes.
- **Holding** (revision 3 unchanged): the engineer sets the task `blocked` on the board-owned merge-window task **before** `in_review` (a valid wait, F16; outside WIP). If a PR reaches the merge owner anyway, it requests changes "merge window closed"; it never leaves the stage pending (F26). On resume the task returns to the approval stage, not QA (F25), so the merge owner runs the component's checks on the rebased head and requests changes "needs fresh QA" when app code changed beyond trivial conflicts.
- **At release** the plugin closes the merge-window task; the backstop wakes held work within about 30 s (F31) and the plugin wakes up to 3 directly. Phase 0: the PM creates and closes it by hand.

### 11.4 Compensations without branch protection

All agents share one managed GitHub identity (`doc/execution-github-identity.md`), and Presto's token is the owner's admin identity (P7). These measures detect; they do not prevent.

1. Skill rule: only merge owners run `gh pr merge`; only release managers run `git tag` / `gh release create`; nobody pushes to `main`.
2. **Trailer** on every merge: `Release-Merge: <ISSUE> run=<PAPERCLIP_RUN_ID> flow=<version label|ongoing|hotfix|release-ops> component=<key> by=<merge_owner|board>`. Method `merge` puts it in the merge commit body; `rebase` puts it in a PR comment.
3. **Daily detection** per component repo (PM routine): PRs merged into `main` since the last check and commits without a PR (`gh api repos/{o}/{r}/commits/{sha}/pulls`); reports missing trailers, non-owner merges and non-eligible merges while a window was closed. Precondition: the PM can list PRs (else QA's routine or a weekly board CLI check).
4. **Phase 3 verifier**: tag shas, merges correlated with merge-owner runs, `repo_tags` verification.

---

## 12. The plugin

### 12.1 Identity, packaging, capabilities and the v0.1 spike

- Key `paperclip.roadmap`, `displayName: "Roadmap"`, `database.namespaceSlug: "roadmap"` → `plugin_roadmap_d0dfaa84c1` (F22), permanent after the first install. Location `packages/plugins/roadmap/`, packaged and deployed like mac-fleet (commit mac-fleet first or copy its scripts, F44).
- **Capabilities, all declared in the 1a manifest** (F36):
  - read: `companies.read`, `projects.read`, **`project.workspaces.read`** (new, G3), `agents.read`, `issues.read`, `issue.relations.read`, `issue.subtree.read`, `issue.comments.read`, `issue.documents.read`, `approvals.read`, `access.members.read`;
  - write: `issues.create`, `issues.update`, `issues.wakeup`, `issue.comments.create`, `issue.comments.create_human_attributed`, `issue.documents.write`;
  - platform: `database.namespace.migrate|read|write`, `events.subscribe`, `jobs.schedule`, `agent.tools.register`, `skills.managed`, `activity.log.write`, `ui.page.register`, `ui.sidebar.register`, `ui.detailTab.register`, `ui.dashboardWidget.register`, `ui.action.register`, `instance.settings.register`.
  - not requested: `approvals.respond`, `authorization.*` (only if protections are chosen), `telemetry.track`.
- **`coreReadTables`**: `companies`, `projects`, `agents`, `issues`, `issue_relations`, `issue_comments`, `issue_documents`, `heartbeat_runs`, `approvals`, `issue_approvals`, `budget_incidents`, plus `labels`, `issue_labels` (S6a). The manifest validator accepts only listed tables (G22), so the host must carry S6a before the 1a manifest installs.
- **The v0.1 spike** (untracked, G21) is the 1a UI starting point: its `classifyTask` lanes, routine grouping and per-status read caps carry over. Two changes: version lanes come from bound versions (name parsing stays only as the fallback before a version is bound, within the task's own project), and the manifest takes the full capability set before any prod install. Recommendation: do not install v0.1 on prod (§22).

### 12.2 Slots and routes

| Slot | Id | Purpose | Phase |
|---|---|---|---|
| `sidebar` | `roadmap-nav` | "Roadmap" at the end of Work (F20) with a Needs-you pill | 1a |
| `page` (`routePath: "roadmap"`) | `roadmap-page` | Every company and project view | 1a |
| `routeSidebar` (`routePath: "roadmap"`) | `roadmap-route-nav` | Company views; searchable project list grouped by type; the selected project's views. It is also the phone drawer (`ui/src/components/Layout.tsx:650-663`). | 1a |
| `detailTab` (project) | `project-roadmap` | Compact Versions pipeline + "Open in Roadmap" | 1a |
| `detailTab` (project) | `project-release-profile` | Type, key, labels, components, roles, gates, restructure (§12.3) | 1a read + setup wizard; 1b editors |
| `toolbarButton` (project) | `project-roadmap-chip` | "Mobile app · MVP In development · 9/16" or "Set up Roadmap" (G20) | 1a |
| `toolbarButton` (issue) | `task-version-chip` | "Version: … · Component: …" (inherited/inferred marked); Move sheet in 1b | 1a / 1b |
| `taskDetailView` (issue) | `task-roadmap-card` | Version, component, stage, train, hotfix/parked/merge-window notices | 1a |
| `commentContextMenuItem` | `comment-report-bug` | "Report as bug or note against a version" | 1b |
| `dashboardWidget` | `roadmap-needs-you` | Needs you across projects + next milestones; the phone entry point | 1b |
| `companySettingsPage` (`routePath: "roadmap"`) | `roadmap-settings` | Board users, WIP/aging/hotfix defaults, skill checklist, label health | 1b |

Routes are view-first, so breadcrumbs read the view name (the breadcrumb is the first splat segment; the page gets no project, F19):

| Path | View |
|---|---|
| `/:prefix/roadmap` | Last view (localStorage, inside try/catch), else Overview with ≥ 2 set-up projects, else that project's Versions |
| `/roadmap/overview`, `/roadmap/needs` | Company Overview; full Needs-you list (phone) |
| `/roadmap/trains`, `/roadmap/trains/<id>` | Train list; train view |
| `/roadmap/versions?project=`, `/roadmap/versions/<id>?tab=overview\|components\|tasks\|notes\|evidence\|history` | Versions pipeline; version detail |
| `/roadmap/flow?project=\|train=&group=lane\|component\|assignee\|epic&f=&q=` | Flow board |
| `/roadmap/backlog?project=&select=1`, `/roadmap/timeline[?project=]`, `/roadmap/plan?project=`, `/roadmap/proposals/<id>` | Backlog, Timeline, Plan with PM, proposal review |

### 12.3 Views

- **Company Overview**: the Needs-you strip (open `flags` with `needs_board`, by severity and age); **Release trains** (one card per open train; member rows with their own type strips aligned by readiness │ distribution; a slipping member shows ⚠ and the delta); **project cards** (color tile, type, PM with agent-status dot, current version strip and progress, next versions, **Ongoing** count/WIP/oldest wait, **Routines** last 5 runs, Needs-you count, planning state). Operations and not-set-up projects show Ongoing and Routines only; "Set up Roadmap" (board) opens the wizard. "No project (N)" footer.
- **Versions pipeline** (project default): versions are rows, the type's stages are columns (`│` marks the tag). Platform versions show component sub-rows plus the project's Integration QA · Board · Ready row and the ship order. Tapping a cell opens a stage sheet: gate, owner role and agent, evidence, history and the one valid action ("Approve TestFlight build 12", "Record staging sign-off", "Start fleet rollout", or "waiting for QAEngineer"). Lane order: patch → current → planned → Ongoing/Routines summary → released (collapsed). Operations projects redirect to Flow.

  ```
                   Plan  Dev          QA        TestFlight │ App Store
  MVP  active      ✓     ◐ 9/16       ○ —       ○ —        │ (milestone)     target 15 Oct
  1.0  planned     ◐ 6 parked
  2.0  stabilizing · train VPN 2.0 · Ready 1/2 · Integration QA ○ · Board ○ · ship backend → node
    ├ backend  Dev ✓ QA ✓ Staging ✓          │ Prod ○                     tag pending
    └ node     Dev ✓ Release-test ✓ QA ✓     │ Canary ○ · Fleet ○ 0/45    tag pending
  ```
- **Flow** (Jira-like): columns Backlog · To do · In progress · In review · Blocked · Done (14 days; cancelled folded). Swimlanes: **⚡ Expedite** → version lanes (header: stage strip, progress, Ready, train chip; a pinned uncounted stage row while stabilizing; platform component sub-lanes + **Unsorted**) → **Ongoing** → **Routines** band (routines with runs in 30 days, last 5 runs, link to `/routines/<id>`) → last 2 released. Train scope (`?train=`): one swimlane per member version. Cards: identifier (mono), title, version and component chips, type glyph, assignee with live dot, epic chip, sub-task count, "waiting Nd". Quick filters: Mine, Bugs, ⚡, Waiting > 1 day, Blocked, Unsorted, component chips. **No status drag** (F11): status changes happen on the task or in Version › Tasks (host `IssuesList`).
- **Backlog**: sections in lane order (and by component in platforms); rows by `roadmap_items.rank` with ↑/↓; select mode with Move, Set owner, Set component, Rank, Hand out now, Report bug (Cancel left, primary right).
- **Version detail** tabs: Overview (tiles, readiness card per component with stale/superseded explanations, distribution card with ship-order waits, epic breakdown); Components (platform: kind, workspace, path, version, tag @ sha, Ready, Live, include/exclude while planned or active); Tasks (the host `IssuesList` takes one `labelId` and no grouping, G28: single-component projects get one list with the version `labelId`; separate-repo components get one list each with `workspaceId`; monorepo components get a plugin list from `roadmap.version` data that links to the tasks, with the host list kept for the ungrouped view); Notes & bugs; Evidence (type-specific columns); History.
- **Train view**: header (state, Ready, owner, target); ship-order lane ("waits for #k−1"); readiness matrix members × gates; "Open board" → Flow train scope; notes union.
- **Timeline**: company mode shows trains as brackets with member bars, then other versions, ◆ Ready/Released/Live; project mode shows versions, component sub-bars, epics, hatched distribution windows. Data is versions and gate timestamps only. Phone: a vertical list by month.
- **Plan with PM**: right panel ≥ 1280 px, else `/roadmap/plan`: PM with status, the planning task and last 3 messages, the open proposal, the `roadmap` document via `MarkdownBlock` (Mermaid renders), the state-aware composer. Empty states: "Start planning with <PM>", "This project has no PM" (picker).
- **Release profile tab**: (1) type picker with the re-seed note; (2) project key (locked once labels exist), scheme, label style; (3) label status ✓/✗ with Copy name; (4) components editor (workspace picker from `listWorkspaces`, repo URL (prefilled when core knows it), path, tag pattern and tag rule, build owner, anchor task, include; warning when a shared workspace needs `c:` labels); (5) roles with agent health and a **policy preview by executor** (§11.2); (6) gate editor (Readiness | Distribution rows, owner role, evidence chips, dependencies; locked invariants; hotfix-skippable stages; "Reset to type defaults"); (7) Restructure (§17). Footer: Discard left, "Apply to: planned & new | also <active version> (resets gates)" and Save right; CAS conflict message. **Setup wizard** for projects without a profile: Type → Identity → Components → Roles → Review, with Save & exit left and the primary action right on every step (AGENTS.md §9). Agents change the profile only through PM proposals.
- **Mobile** (390 px): sticky header with a project select, a view select and `+`; Overview single column; Versions as cards with a vertical stepper; Flow lanes as accordions with a status segmented control (top 5 + "See all"); tabs become selects; bottom sheets with Cancel left and primary right; tap targets ≥ `--sz-44px`; `scrollWidth ≤ innerWidth`; identifiers, versions, build numbers, shas and node counts in `--font-mono`.

### 12.4 Board actions

Authorization: `actor.type === 'user'` **and** `userId ∈ company_settings.board_user_ids`, re-checked as an active member (F32); agents are always rejected. Every referenced id is re-checked against the company and project; every action logs `roadmap.<area>.<verb>` and a `roadmap_events` row.

| Area | Actions |
|---|---|
| Profile | `profile.setup`, `profile.update`, `profile.changeType`, `profile.acknowledgeCatalog`, `component.create/update/retire`, `component.setAnchor`, `channel.update`, `gate.define/update/disable`, `roles.set`, `tags.import`, `tags.retire` |
| Versions | `version.create/update/setState` (§4.4), `version.moveUnfinished`, `version.amendGates`, `version.markReleased {reason}` |
| Tasks | `tasks.move {issueIds[], target}` (read-modify-write, F6; parks non-in-flight tasks moving into `planned`; only bugs/hotfixes into `stabilizing`), `task.setComponent`, `tasks.setOwner`, `tasks.rank`, `tasks.handOutNow`, `tasks.removeCancelledBlockers`, `hotfix.insert` |
| Gates | `gate.decide {scope, gateKey, verdict, note, alsoGateKeys[]}` (replaces revision 3's TestFlight approve/reject and QA override), `gate.waive`, `gate.revoke`, `candidate.supersede`, `component.recordTag {versionId, componentId, tag, sha, evidence}` (when a person tags or dispatches the release; same checks as `roadmap_create_release`) |
| Notes | `bug.report`, `note.add`, `note.toTask`, `note.dismiss` |
| Planning | `proposal.apply` (order: create versions → relabel and mirror → park → create tasks unassigned in `backlog` → cancel → owners and ranks → return to PM with `reparent[]`), `proposal.requestChanges`, `pm.start/message/setAgent/link` |
| Trains | `train.create/update/addMember/removeMember/setState` |
| Integrity | `drift.repark`, `drift.dismiss`, `labels.restore` |
| Moves | `move.plan`, `move.approve`, `move.apply`, `move.cancel` (§17) |
| Import | `phase0.import` (dry run, then apply; no wakes; reads only the fenced `json` block of each document; refuses on schema errors, missing labels or key collisions): company index → settings and trains; `release-profile@1` → profile, components (workspace ids checked through `listWorkspaces`), anchors, role overrides, project gates, lineage (→ predecessor/successor components); repo tags; profile versions + labels → versions; `roadmap` classification and `Planned owner:`/`Rank:` lines → `roadmap_items`; `readiness` rows → candidates and gate results; tracking and merge-window tasks; `type:bug` tasks with `Affects:` → `version_notes`; the daily routine id; the company skill → managed binding (§14.4). |

### 12.5 Agent tools

Every tool checks the caller's role from `ToolRunContext` and the resolved roles (component override first). Mutating tools carry a write verb so the gateway infers `write` (G14).

| Revision 3 | Revision 4 | Caller |
|---|---|---|
| `roadmap_context` | `roadmap_context {projectId?, issueId?, scope?: task\|project\|company}`: profile and type, the caller's roles and `runbooks` to read, components, versions with gates and Ready per component, the task's lane, version, component and `expectedPolicy`, merge window, train and ship position, next-up, flags. `scope: company` returns the company index for intake and train owners. | any agent |
| `roadmap_propose` | `roadmap_create_proposal {projectId \| trainId, …}` | the project's PM; the train owner for trains |
| `roadmap_set_version` | `roadmap_update_tasks {issueIds[], target?, component?, plannedOwnerAgentId?, rank?}` (component alone confirms a component) | PM |
| `roadmap_insert_hotfix` | `roadmap_create_hotfix` | PM, within the cap |
| `roadmap_report` | `roadmap_create_report` | any agent, 20/day |
| `roadmap_note_to_task` | `roadmap_create_task_from_note` | PM |
| `roadmap_record_build` | `roadmap_create_candidate {versionId, component?, sha, buildRef, artifactVersion?, artifactUrl?, source?, candidateRef?}` | build owner or release manager |
| `roadmap_record_qa` | `roadmap_create_gate_result {candidateId \| versionId \| trainId, gateKey, verdict, evidence}` | holder of the gate's approver role; `board` gates refuse agents |
| — | `roadmap_create_deployment {candidateId, channel, state, scope?, evidence}` | build owner or release manager |
| `roadmap_record_release` | `roadmap_create_release {versionId, component?, tag, sha, evidence?}`: requires Ready, `sha` satisfies the tag rule (`evidence {parentSha, changedPaths}` under `validation_commit`), `tag` = the rendered `tag_name`, no unretired `repo_tags` row | release manager |

Error codes (paired with next steps in `references/tools.md`): `roadmap_role_required` (names role and component), `roadmap_in_flight`, `roadmap_version_state`, `roadmap_missing_label`, `roadmap_not_ready`, `roadmap_sha_mismatch`, `roadmap_blocks_active_work`, `roadmap_rate_limited`, `roadmap_evidence_invalid`, `roadmap_ship_order`, `roadmap_tag_taken`, `roadmap_component_unresolved`, `roadmap_train_state`, `roadmap_move_blocked`, `roadmap_tag_rule` (the tag sha is neither the candidate nor its validation child).

### 12.6 Tick, events, concurrency and performance

- **Job `roadmap-tick`** (5 min; dirty projects first, full sweep hourly): binds labels by name; refreshes the mirror; computes drift, next-up, liveness, role-health and train flags into `flags`; re-wakes a stranded plugin-created task once, then flags `stranded_task` (F27); performs proposal hand-overs whose run is terminal; creates ops tasks per gate (≤ 3 per tick); auto-stabilizes patches; `auto_repark` (Phase 2); reconciles components on `project.workspace_*` events (`workspace_missing`). ≤ 3 wakes per company per tick.
- **Events**: `issue.created`, `issue.updated` (assignee → `assigned_at`; project change → relabel during an applying move), `issue.relations.updated`, `approval.decided`, `agent.status_changed`, `agent.run.finished|failed|cancelled`, `budget.incident.opened|resolved`, `project.updated`, `project.workspace_created|updated|deleted`. After a 1.5 s debounce, one stream event per company `{projectIds, kinds}`; the UI refetches mounted keys only while visible. No interval polling.
- **Concurrency**: an in-process per-company async mutex shared by actions, tools and the tick (one worker process; the scheduler prevents job overlap, `server/src/services/plugin-job-scheduler.ts:292-298`). Scaling out needs a DB lease.

| Data key | Feeds | Cost | Cache |
|---|---|---|---|
| `roadmap.badge` | sidebar pill | 1 count on `flags` | 60 s |
| `roadmap.company` | Overview, route sidebar, widget | 4 sequential queries whatever the project count: plugin rows + latest results; one grouped issue count (`GROUP BY project_id, lane, status` via S6a, visibility predicate F34); routine health via `issues_company_origin_idx`; open flags + agent status | 30 s, single-flight |
| `roadmap.project` | Versions, Flow, Backlog | ≤ 6 sequential queries (revision 3's five + profiles/components/candidates/results); `project_workspace_id` already in the task row | 15 s, single-flight |
| `roadmap.cards`, `roadmap.version`, `roadmap.train`, `roadmap.timeline`, `roadmap.profile` | paging, detail views, timeline, profile tab | 1–3 queries (+1 `listWorkspaces` for the profile) | 0–60 s |

Budgets (fixture tests in 1a): company summary for 30 projects / 10,000 tasks ≤ 300 ms and ≤ 60 KB; project snapshot for 500 tasks ≤ 250 ms and ≤ 120 KB; first paint at 390 px < 2 s; 20 concurrent loads → one build per key per window. There is no mode without S6a (§16).

### 12.7 Styling

No Tailwind classes in plugin code (the host build does not scan plugins). Inline `var(--…)` only, with no literal fallbacks, plus one scoped `<style id="rm-styles">` for `.rm-*` hover, focus, sticky and `@media (max-width: 767px)`. State → token: version states as §4.4; gate pending `--status-task-todo`, in progress `--status-task-in_progress`, pass `--status-task-done`, fail `--status-task-blocked`, waived `--status-task-cancelled`, stale `--status-task-todo` + "stale" text; agent dots `--status-agent-*`; flags critical/warn/info `--destructive`/`--status-agent-paused`/`--muted-foreground`; project tiles use `project.color` as data; train accents `--chart-1..5`. `scripts/check-plugin-tokens.mjs` rejects color literals, raw `px`/`fontSize`, Tailwind strings and unknown `var(--x)` names (checked against the compiled host CSS); the host `check-token-gates` does not scan plugins. Copy says "task", never "issue", and "Version", never "Release".

---

## 13. Data model: `migrations/001_roadmap.sql`

Rules:

1. `company_id` always comes from the host context. Before any write the worker checks every referenced id against the company, and a component against the version's project.
2. No transactions. Multi-step writes are idempotent with CAS on `row_version`.
3. Forward-only (G18). Every enum is complete in 001; later widening is `ALTER TABLE … DROP CONSTRAINT x, ADD CONSTRAINT x CHECK (…)`.
4. No comment anywhere in a migration file names a `public` table after `from|join|references|into|update` unless the table is whitelisted; nothing but whitespace follows the last `;`; no identifier is named `copy` or `call`; no `SET` statements (§0.4 item 5).
5. No CHECK constraint and no NOT NULL may involve a column whose FK is `ON DELETE SET NULL` (G29). Such rules are worker checks that raise flags instead. Where a row is meaningless without its target, the FK is `ON DELETE CASCADE`.
6. CI runs the real `validatePluginMigrationStatement` over every migration file, and a Postgres test applies 001, inserts rows in every table, then deletes a project, an agent and a company through core. All three must succeed.

`NS` = `plugin_roadmap_d0dfaa84c1`. Common columns written as `…ts` = `created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()`, `…rv` = `row_version integer NOT NULL DEFAULT 1`, `…co` = `company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE`, `…actor(x)` = `x_actor_type text NOT NULL CHECK (x_actor_type IN ('user','agent','plugin_system')), x_actor_id text NOT NULL`.

```sql
CREATE TABLE NS.project_profiles (project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE, …co,
  enabled boolean NOT NULL DEFAULT true,
  project_type text NOT NULL CHECK (project_type IN ('mobile_app','backend_service','web_app','infrastructure','library','platform','operations')),
  template_key text NOT NULL CHECK (template_key ~ '^[a-z_]+@[0-9]+$'),
  project_key text NOT NULL CHECK (project_key ~ '^[a-z][a-z0-9]{1,7}$'), project_key_locked boolean NOT NULL DEFAULT false,
  label_style text NOT NULL DEFAULT 'prefixed' CHECK (label_style IN ('bare','prefixed')),
  version_scheme text NOT NULL CHECK (version_scheme IN ('semver','calver','none')),
  merge_owners_strict boolean NOT NULL DEFAULT false, reference_workspace_ids uuid[] NOT NULL DEFAULT '{}',
  roadmap_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  planning_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL, daily_routine_id uuid,
  checklist jsonb NOT NULL DEFAULT '[]', lanes jsonb NOT NULL DEFAULT '{}', words jsonb NOT NULL DEFAULT '{}',
  settings jsonb NOT NULL DEFAULT '{}', profile_version integer NOT NULL DEFAULT 1, …rv, …ts,
  CONSTRAINT project_profiles_key_uq UNIQUE (company_id, project_key),
  CONSTRAINT project_profiles_ops_ck CHECK ((project_type = 'operations') = (version_scheme = 'none')));
CREATE UNIQUE INDEX project_profiles_one_bare_uq ON NS.project_profiles (company_id) WHERE label_style = 'bare';

CREATE TABLE NS.components (id uuid PRIMARY KEY, …co, project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{0,15}$'), name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mobile_app','backend_service','web_app','infrastructure','library','other')),
  workspace_id uuid, repo_url text CHECK (repo_url IS NULL OR repo_url ~ '^https://[a-z0-9.-]+/[a-z0-9._-]+/[a-z0-9._-]+$'),
  repo_path text CHECK (repo_path IS NULL OR (repo_path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' AND repo_path !~ '(^|/)\.\.?(/|$)')),
  label_name text CHECK (label_name IS NULL OR (label_name LIKE 'c:%' AND char_length(label_name) <= 48)), label_id uuid,
  versioning text NOT NULL DEFAULT 'lockstep' CHECK (versioning IN ('lockstep','independent')),
  tag_pattern text NOT NULL DEFAULT 'v{version}' CHECK (tag_pattern ~ '^[A-Za-z0-9._/-]{0,40}[{]version[}][A-Za-z0-9._-]{0,16}$'),
  tag_prefix text GENERATED ALWAYS AS (split_part(tag_pattern, '{version}', 1)) STORED,
  build_ref_kind text NOT NULL DEFAULT 'commit_sha' CHECK (build_ref_kind IN ('build_number','image_digest','package_version','commit_sha')),
  merge_method text NOT NULL DEFAULT 'squash' CHECK (merge_method IN ('squash','merge','rebase')),
  merge_window text NOT NULL DEFAULT 'off' CHECK (merge_window IN ('strict','off')), ship_order integer NOT NULL DEFAULT 0,
  tag_rule text NOT NULL DEFAULT 'candidate' CHECK (tag_rule IN ('candidate','validation_commit')),
  anchor_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('pending','active','retired','moved_out')),
  predecessor_component_id uuid REFERENCES NS.components(id) ON DELETE SET NULL,
  successor_component_id uuid REFERENCES NS.components(id) ON DELETE SET NULL,
  settings jsonb NOT NULL DEFAULT '{}', sort_order integer NOT NULL DEFAULT 0, …rv, …ts,
  CONSTRAINT components_key_uq UNIQUE (project_id, key));
CREATE UNIQUE INDEX components_tag_namespace_uq ON NS.components (company_id, repo_url, tag_prefix) WHERE state = 'active' AND repo_url IS NOT NULL;
CREATE UNIQUE INDEX components_label_uq ON NS.components (company_id, label_name) WHERE label_name IS NOT NULL;
CREATE INDEX components_workspace_idx ON NS.components (company_id, workspace_id) WHERE state = 'active';

CREATE TABLE NS.gate_definitions (id uuid PRIMARY KEY, …co, project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  component_id uuid REFERENCES NS.components(id) ON DELETE CASCADE, key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$'), name text NOT NULL,
  gate_kind text NOT NULL CHECK (gate_kind IN ('tasks_closed','agent_verdict','board_approval','deployment_verified','soak','checklist','external_review')),
  phase text NOT NULL CHECK (phase IN ('readiness','distribution')), binds text NOT NULL CHECK (binds IN ('none','candidate','candidate_set')),
  approver_role text CHECK (approver_role IS NULL OR approver_role IN ('qa','merge_owner','release_manager','build_owner','pm','board')),
  channel_id uuid REFERENCES NS.channels(id) ON DELETE SET NULL, ordinal integer NOT NULL DEFAULT 0,
  required boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT true, locked boolean NOT NULL DEFAULT false,
  depends_on text[] NOT NULL DEFAULT '{}', evidence_schema jsonb NOT NULL DEFAULT '{}', params jsonb NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'template' CHECK (source IN ('template','custom')), template_gate_key text, …rv, …ts,
  CONSTRAINT gate_definitions_binds_ck CHECK ((gate_kind = 'tasks_closed' AND binds = 'none')
    OR (gate_kind <> 'tasks_closed' AND component_id IS NOT NULL AND binds = 'candidate')
    OR (gate_kind <> 'tasks_closed' AND component_id IS NULL AND binds = 'candidate_set')),
  CONSTRAINT gate_definitions_approver_ck CHECK (gate_kind = 'tasks_closed' OR approver_role IS NOT NULL));
CREATE UNIQUE INDEX gate_definitions_project_key_uq ON NS.gate_definitions (project_id, key) WHERE component_id IS NULL;
CREATE UNIQUE INDEX gate_definitions_component_key_uq ON NS.gate_definitions (component_id, key) WHERE component_id IS NOT NULL;

CREATE TABLE NS.versions (id uuid PRIMARY KEY, …co, project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]{0,31}$'), name text NOT NULL,
  kind text NOT NULL DEFAULT 'main' CHECK (kind IN ('main','patch','milestone')),
  base_version_id uuid REFERENCES NS.versions(id) ON DELETE SET NULL,
  patch_mode text CHECK (patch_mode IS NULL OR patch_mode IN ('from_main','cherry_pick')),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','active','stabilizing','released','cancelled')),
  label_name text NOT NULL CHECK (label_name LIKE 'v:%' AND char_length(label_name) <= 48), label_id uuid,
  version_number text CHECK (version_number IS NULL OR version_number ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  start_date date, target_date date, sort_order integer NOT NULL DEFAULT 0, gate_snapshot jsonb, snapshot_at timestamptz,
  tracking_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  merge_window_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  split_from_version_id uuid REFERENCES NS.versions(id) ON DELETE SET NULL,
  started_at timestamptz, stabilized_at timestamptz, released_at timestamptz, live_at timestamptz, cancelled_at timestamptz,
  …actor(created_by), …rv, …ts,
  CONSTRAINT versions_key_uq UNIQUE (company_id, project_id, key), CONSTRAINT versions_label_uq UNIQUE (company_id, label_name),
  CONSTRAINT versions_patch_ck CHECK ((kind = 'patch') = (patch_mode IS NOT NULL)),
  CONSTRAINT versions_number_ck CHECK (kind = 'milestone' OR state IN ('planned','cancelled') OR version_number IS NOT NULL),
  CONSTRAINT versions_dates_ck CHECK (target_date IS NULL OR start_date IS NULL OR target_date >= start_date));
CREATE INDEX versions_project_idx ON NS.versions (company_id, project_id, state, sort_order);

CREATE TABLE NS.train_members (train_id uuid NOT NULL REFERENCES NS.release_trains(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES NS.versions(id) ON DELETE CASCADE, …co,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE, required boolean NOT NULL DEFAULT true,
  joined_by_actor_id text NOT NULL, joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz, left_reason text,
  PRIMARY KEY (train_id, version_id));
CREATE UNIQUE INDEX train_members_one_open_train_uq ON NS.train_members (version_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX train_members_one_per_project_uq ON NS.train_members (train_id, project_id) WHERE left_at IS NULL;

CREATE TABLE NS.version_components (version_id uuid NOT NULL REFERENCES NS.versions(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES NS.components(id) ON DELETE CASCADE, …co, in_scope boolean NOT NULL DEFAULT true,
  component_version text CHECK (component_version IS NULL OR component_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  tag_name text CHECK (tag_name IS NULL OR char_length(tag_name) BETWEEN 1 AND 100), repo_url text, repo_path text, gate_snapshot jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','tagged','skipped','moved_out')),
  tagged_candidate_id uuid, tag_sha text CHECK (tag_sha IS NULL OR tag_sha ~ '^[0-9a-f]{40}$'),
  moved_to_version_id uuid REFERENCES NS.versions(id) ON DELETE SET NULL, tagged_at timestamptz, live_at timestamptz,
  …rv, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (version_id, component_id));
CREATE UNIQUE INDEX version_components_tag_uq ON NS.version_components (company_id, repo_url, tag_name) WHERE tag_name IS NOT NULL AND state IN ('pending','tagged');

CREATE TABLE NS.candidates (id uuid PRIMARY KEY, …co, version_id uuid NOT NULL REFERENCES NS.versions(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES NS.components(id) ON DELETE CASCADE, seq integer NOT NULL CHECK (seq > 0),
  sha text NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'), build_ref text NOT NULL CHECK (char_length(build_ref) BETWEEN 1 AND 200),
  build_ref_kind text NOT NULL CHECK (build_ref_kind IN ('build_number','image_digest','package_version','commit_sha')),
  source text NOT NULL DEFAULT 'main' CHECK (source IN ('main','branch','cherry_pick')), artifact_version text, candidate_ref text,
  artifact_url text, notes text,
  …actor(recorded_by), recorded_run_id uuid, superseded_at timestamptz, imported_from text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidates_seq_uq UNIQUE (version_id, component_id, seq), CONSTRAINT candidates_ref_uq UNIQUE (version_id, component_id, build_ref));
CREATE INDEX candidates_current_idx ON NS.candidates (version_id, component_id) WHERE superseded_at IS NULL;
ALTER TABLE NS.version_components ADD CONSTRAINT version_components_candidate_fk
  FOREIGN KEY (tagged_candidate_id) REFERENCES NS.candidates(id) ON DELETE SET NULL;

CREATE TABLE NS.gate_results (id uuid PRIMARY KEY, …co,
  version_id uuid REFERENCES NS.versions(id) ON DELETE CASCADE, train_id uuid REFERENCES NS.release_trains(id) ON DELETE CASCADE,
  component_id uuid REFERENCES NS.components(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES NS.candidates(id) ON DELETE CASCADE, candidate_set jsonb,
  gate_key text NOT NULL CHECK (gate_key ~ '^[a-z][a-z0-9_]{0,31}$'), gate_kind text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('pass','fail','waived')), evidence jsonb NOT NULL DEFAULT '{}',
  deployment_id uuid REFERENCES NS.deployments(id) ON DELETE SET NULL,
  report_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  approval_id uuid REFERENCES public.approvals(id) ON DELETE SET NULL, reason text,
  …actor(decided_by), decided_run_id uuid, revoked_at timestamptz, revoked_reason text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gate_results_scope_ck CHECK ((version_id IS NULL) <> (train_id IS NULL)),
  CONSTRAINT gate_results_binding_ck CHECK ((candidate_id IS NOT NULL AND component_id IS NOT NULL AND candidate_set IS NULL AND train_id IS NULL)
    OR (candidate_id IS NULL AND component_id IS NULL AND candidate_set IS NOT NULL)),
  CONSTRAINT gate_results_reason_ck CHECK (verdict <> 'waived' OR reason IS NOT NULL));
CREATE INDEX gate_results_candidate_idx ON NS.gate_results (candidate_id, gate_key, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX gate_results_version_idx ON NS.gate_results (version_id, gate_key, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX gate_results_train_idx ON NS.gate_results (train_id, gate_key, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE NS.component_moves (id uuid PRIMARY KEY, …co,
  source_project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  source_component_id uuid NOT NULL REFERENCES NS.components(id) ON DELETE CASCADE,
  target_project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  target_component_id uuid REFERENCES NS.components(id) ON DELETE SET NULL, target_workspace_id uuid,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','applying','applied','failed','cancelled')),
  plan jsonb NOT NULL, result jsonb NOT NULL DEFAULT '{}', requested_by_user_id text NOT NULL,
  approved_by_user_id text, approved_at timestamptz, applied_at timestamptz, …rv, …ts);
CREATE UNIQUE INDEX component_moves_open_uq ON NS.component_moves (source_component_id) WHERE state IN ('draft','approved','applying');
```

The remaining tables follow the same rules (`…co`, `…rv`, `…ts`, complete enums). File order: `company_settings`, `project_profiles`, `components`, `channels`, `gate_definitions`, `project_roles`, `versions`, `release_trains`, `train_members`, `version_components`, `candidates` (+ the FK), `deployments`, `gate_results`, `repo_tags`, `roadmap_items`, `proposals`, `version_notes`, `component_moves`, `flags`, `roadmap_events`.

| Table | Columns and constraints |
|---|---|
| `company_settings` | PK `company_id`; `board_user_ids text[]`, `intake_agent_ids uuid[]`, `default_pm_agent_id`, `release_agent_id` (agents, SET NULL), `company_roadmap_issue_id`; `wip_version_per_agent` 1–3 (1), `wip_ongoing_per_agent` 1–5 (1), `ongoing_aging_hours` 4–168 (24), `hotfix_daily_cap` 0–20 (3), `auto_repark`, `skill_hash`, `catalog_revision_seen` |
| `channels` | component FK (CASCADE); `key ^[a-z][a-z0-9_]{0,23}$` unique per component; `kind ∈ beta_distribution, store, environment, test_host, fleet_stage, registry`; `ordinal`, `ships`, `enabled`, `settings` |
| `project_roles` | project FK; optional component FK (override); `role ∈ pm, qa, merge_owner, release_manager, build_owner, developer, approver`; exactly one of `agent_id` (agents FK, **CASCADE**: a deleted agent's role rows go, and `role_unfilled` reports the gap) and `user_id`; `approver` must be a user; `ordinal`; unique `(project, COALESCE(component, zero uuid), role, principal)` |
| `release_trains` | `key` unique per company; the five states; `owner_agent_id`, `anchor_project_id` (both nullable, SET NULL; flags `train_owner_missing`, `train_anchor_missing`); `board_gate ∈ single, per_member` (`single`); `ship_policy ∈ ordered, together, independent` (`ordered`); `gates`, `gate_snapshot`, `checklist`; optional `train:` label; tracking and planning task FKs; dates; creator actor |
| `deployments` | candidate and channel FKs (CASCADE); `state ∈ started, succeeded, failed, rolled_back`; `scope`, `evidence`; recorder actor and run; index `(candidate_id, channel_id, created_at DESC)` |
| `repo_tags` | PK `id`; partial unique index on `(company_id, repo_url, tag_name) WHERE source <> 'retired'`, so retired rows stay as history and the name can be recorded again; `sha` (40 hex); `source ∈ imported, recorded, verified, retired`; `retired_at`, `retired_reason`; version and component FKs (SET NULL) |
| `roadmap_items` | PK issue FK (CASCADE); `project_id`; `version_id` (the mirror); `mirror_state ∈ in_sync, label_removed, label_missing`; `component_ids uuid[]` (GIN); `component_source ∈ label, manual, single, workspace, workspace_default, none`; planned owner (at most one of agent and user; the agent FK is SET NULL); `rank`; `assigned_at` |
| `proposals` | project xor train scope; author agent and run; `handover_run_id`, `handed_over_at`; `state ∈ submitted, applied, partially_applied, changes_requested, superseded`; `body`, `summary_md`, decision fields, `apply_result` |
| `version_notes` | version xor train scope; optional component and candidate; `kind ∈ note, risk, decision, bug`; `severity ∈ blocker, major, minor`; `build_ref`; related and created task FKs; `state ∈ open, converted, dismissed`; `agent_visible`; author actor and run |
| `flags` | scope ids without FKs; `kind`; `severity ∈ info, warn, critical`; `needs_board`; first and last seen; `resolved_at`, `dismissed_by`; partial index on open flags |
| `roadmap_events` | audit without FKs on scope ids, so it survives deletes; `kind`, actor, run, `details` |

The `…` shorthands are expanded in the real file. **Worker-enforced checks** that a CHECK cannot express: same company for every id; a component belongs to the version's project; bare-key guards (§4.2); no active tag prefix is a prefix of another in the same repo (`v` vs `v2/`); `train_members.project_id` equals the version's project; `component_version` greater than the lineage's last tagged version; `build_number` build refs strictly increasing per component; the trunk rule per component (§4.4); ≥ 1 locked `qa` and `board` readiness gate per versioned profile; an active component of a versioned profile has a `repo_url` (`component_repo_unknown`); `tag_rule = 'validation_commit'` requires `merge_method = 'merge'`; a `moved_out` component has a successor and a `pending`/`active` one has none (`lineage_broken`, which replaces revision 4's CHECK); a `branch` candidate only under `validation_commit`.

---

## 14. The shared `roadmap` skill

### 14.1 Design rule: the skill holds no parameters

The skill is the same text in every company: rules, procedures, one runbook per role and per type, tools and error codes. It contains **no** agent, label, project, gate or environment names and no dates. Everything that differs per project comes from `roadmap_context` (Phase 1) or the `release-profile` document (Phase 0). One source of truth: `packages/plugins/roadmap/skills/roadmap/` in the fork. A plugin `reset` therefore never destroys company knowledge.

### 14.2 Layout

```
roadmap/SKILL.md                     core rules for everyone (§14.5)
roadmap/references/roles/            pm, merge-owner, qa-owner, release-manager, build-owner, engineer, intake, train-owner
roadmap/references/types/            mobile_app, backend_service, web_app, infrastructure, library, platform, operations
roadmap/references/                  components, trains, moves, phase0 (manual formats), tools (errors → next step)
roadmap/references/templates/        plan-roadmap (§10.3), roadmap-daily (§10.4)
```

Role runbooks cover: the PM's planning loop, classification, parking, hand-out with policies, hotfixes, triage, daily duties and wake safety; the merge owner's approval-stage procedure, eligibility, merge method, trailer, bounce rules and API-only merges; QA's review stage, verdicts, `qa-report` and integration QA; the release manager's tags, release records, notes, cherry-pick patches and store submission; the build owner's candidates and deployments; the engineer's PR flow, policy check and merge-window hold; intake routing; the train owner's proposals and summary. Type runbooks hold the channel procedures (TestFlight and store; staging, migrations and rollback; release-test, canary and waves; publishing).

`roadmap_context.you.runbooks` tells the agent which files to read, so runs stay cheap. Skill use is model-driven (the instructions list only skill keys, and the `description` triggers it), so the description names the triggers.

### 14.3 Runtime parameters

- **Phase 1**: `roadmap_context` (read risk; 15 s snapshot; once per run; explicit `projectId` or `scope: 'company'`, G12).
- **Phase 0**: the document **`release-profile`** on the project's Roadmap task ("Roadmap: <project name>", board-owned, `release-ops`, filed in that project). Issue documents are markdown only (G25), so the document is short prose followed by **exactly one fenced `json` block** in the `release-profile@1` schema (§14.6); every parser reads only that block. Only the board edits it; the PM may update `versions[].state` to apply a board-approved transition, citing the approval in `changelog`. **Discovery** (deterministic, G32): `GET /api/companies/{id}/labels` (id of `release-ops`) → `GET /api/companies/{id}/issues?projectId=<the task's project>&labelId=<id>` → the task whose title is exactly "Roadmap: <project name>" and that holds a `release-profile` document → read it. The profile names the company index task (`tasks.companyIndex`, "Roadmap: <Company> (company)", document `roadmap-index`), so intake and train owners need no search. Three calls; a profile stays under ~5 KB. A block that does not parse or fails the schema → the PM's daily run raises `profile_invalid`; agents use the previous document revision.
- **Phase 1 fallback and export**: on every settings change the plugin rewrites the same document: a prose line "Generated by Roadmap; edit in the Release profile tab", then the same single `json` block with `"_generated": {"at": …, "by": "paperclip.roadmap"}` inside it. Agents use it when the tool is denied (G13) or the worker is down, and it carries the profile through company export (plugin rows are not exported).

### 14.4 Packaging across phases without re-attaching agents

1. **Phase 0, per company**: `npx paperclipai skills create --name "Roadmap" --slug roadmap --description "<frontmatter description>" --body-file packages/plugins/roadmap/skills/roadmap/SKILL.md`, then one `PATCH /api/companies/:id/skills/:skillId/files {path, content}` per reference file (G9). Key: `company/<companyId>/roadmap`. Use `npx`, never `pnpm`, for content-bearing arguments. Guard: no other company skill may use slug `roadmap`.
2. **Attach** to every agent that touches any project of the company (role holders, implementers, intake): `npx paperclipai skills agent sync <agent> --skill roadmap --mode add`, one at a time; check with `skills agent list`.
3. **Phase 1a manifest** declares `skills: [{skillKey: "roadmap", slug: "roadmap", displayName: "Roadmap", markdown, files}]`. On setup and each plugin version change the worker calls `ctx.skills.managed.reconcile('roadmap', companyId)`; the import finds the Phase 0 row **by slug**, replaces its content, keeps its key and binds to it (G8). The worker stores a hash of the declared files (`company_settings.skill_hash`) and calls `reset` when it changes, because reconcile never updates content (G7). Agents keep `company/<companyId>/roadmap`; nobody is re-attached.
4. Companies onboarded after Phase 1 get `plugin/<slug>/roadmap` and are attached as usual.
5. **Updates**: Phase 0 → edit the repo source and PATCH each changed file per company (`company_skill_versions` keeps revisions). Phase 1 → a plugin release triggers `reset`; board edits in the UI are overwritten, so changes go to the repo and company wishes go into the profile. Version pins (beta experiment) are not used.
6. **Pointer stanza**, added to every agent the skill is attached to (§18.2 C4), identical everywhere (instructions are per agent, G11):

   ```markdown
   ## Roadmap
   This company plans work with the `roadmap` skill. On any run that touches a task in a project,
   follow that skill: it tells you how to read your project's release profile and which of its
   runbooks apply to you. Do not keep roadmap rules in this file.
   ```
7. **Board-policy edit** (G30): two lines in the fork's bundled `skills/paperclip/SKILL.md` Board policy, carried as a fork change next to S6a (§16). It ships with the deploy that precedes Phase 0b, which the mac-fleet fix needs anyway: the bundled skills ship inside the server image (the Dockerfile copies the repo), so only a deploy changes them.
   - "If the `roadmap` skill is enabled for you, the roles it resolves apply; a project's PM is that project's coordinator."
   - "When a task carries an execution policy, `in_review` routes it to the stage participant; do not mention the coordinator for that hand-off."

   Bug filing is not widened: in Phase 0 only the PM files bugs (§9), and in Phase 1 the plugin creates them through `roadmap_create_report`. Until the edit ships (Phase 0a), the roadmap skill asks nothing the policy forbids: only the PM creates tasks, and no code task carries a policy yet.

### 14.5 `SKILL.md` core (draft)

```markdown
---
name: roadmap
description: >
  Versions, releases and the project flow for projects that use a Roadmap. Use on every run that
  touches a task in a project: version (v:), component (c:), type: or release-ops labels, hand-outs,
  review or merge stages, builds and candidates, QA verdicts, deploy or distribution evidence, tags
  and releases, bug reports, intake routing, roadmap planning and the Roadmap daily routine.
---
# Roadmap
A project's roadmap groups its tasks into versions. Ongoing work and routine runs stay outside
versions and keep running. Everything that differs per project (type, components, roles, labels,
gates, words) comes from the project's release profile. Never guess a label, a role or a gate.

## 1. Load your parameters (once per run)
- If the tool `roadmap_context` exists, call it with the task's projectId and issueId (pass them
  explicitly; use scope "company" for intake and trains). Otherwise read the `release-profile`
  document as described in references/phase0.md. No profile or "enabled": false → no roadmap.
- Read only the runbooks for your roles and for the project type.
- Skip this on routine executions other than "Roadmap daily", and when the task has no roadmap
  label and you hold no role, and you are not merging, building, recording, filing a bug or
  forwarding intake.

## 2. Rules for everyone
1. Labels are the truth: a version label puts a task in that version; no label means ongoing.
   Use only label names from the profile.
2. Never create, delete, recreate or rename labels. Never remove a version label from a task you
   do not own; ask the PM.
3. Relabel by read-modify-write: send the full labelIds list, then re-read the task.
4. Copy the parent's version and component labels onto every sub-task and follow-up.
5. Never touch a parked task (a task of a planned version: unassigned, backlog): do not assign it,
   move it out of backlog or @-mention an agent on it.
6. Parking is one write {"status":"backlog","assigneeAgentId":null}. Only the PM parks, and only
   todo/backlog tasks; blocked and in_review tasks go on the board's parking list.
7. Epics are created by the board or the plugin, never by an agent, and never carry a version label.
8. type:hotfix marks urgent work: handed out at once, always merge-eligible.
9. Bugs: Phase 1 use roadmap_create_report. Phase 0 only the PM creates a top-level "Bug: …"
   task (type:bug + version label, unassigned, backlog, first lines "Affects: <label> <component>
   <build ref>" and "Related: <task>"). Everyone else writes the bug under "Proposals" in their own
   task comment with the same "Affects:" line, and mentions the PM once only for a blocker.
   Never comment a bug on a done task.
10. A project's PM is that project's coordinator under the Board policy.

## 3. Code flow
1. One trunk per repo (the profile's trunk, default main); releases are tags. Push only your
   task branch.
2. Only the project's merge owners merge, and only inside the approval stage of the task's
   execution policy. Only release managers tag.
3. Before in_review, check the task carries the expected execution policy; set it if missing.
   Never change the policy of a task already in review. With a policy, in_review routes the task;
   do not mention anyone for that hand-off.
4. Merge window: while a version containing your component is stabilizing, your PR is eligible only
   with that version's label, type:hotfix, release-ops, or when every changed path lies outside the
   stabilizing components. Otherwise block your task on the merge-window task before in_review.
5. Every review or approval run ends with a decision. Never leave a stage pending.

## 4. Words
planned → active → stabilizing → released (or cancelled). "Ready" is a badge: counted tasks closed
and every gate passed on the same candidate. "Live": every distribution gate passed. Profile aliases
(for example "frozen" = stabilizing) mean the same states.

## 5. When unsure
Call roadmap_context again or re-read the profile, then ask the PM in your task comment.
Tool errors and next steps: references/tools.md.
```

### 14.6 Phase 0 profile format (`paperclip.roadmap/release-profile@1`)

The JSON Schema lives in `references/phase0.md` and in the plugin (`src/catalog/release-profile.schema.json`). `phase0.import` and the PM's daily check validate against it. Principals are `{type: agent|user, id, name}`: the id is the truth, the name is for people. Workspaces are referenced by id, with the name alongside.

| Field | Content |
|---|---|
| `schema`, `enabled` | `"paperclip.roadmap/release-profile@1"`; `false` = no roadmap |
| `project` | `id`, `name`, `type`, `templateKey`, `key`, `labelStyle`, `versionScheme`, `trunk` |
| `roles` | `pm`, `qa[]`, `mergeOwners[]`, `mergeOwnersStrict`, `releaseManager`, `approvers[]`, `intake[]` |
| `components[]` | `key`, `name`, `kind`, `workspaceId`, `workspaceName`, `repoUrl` (normalized), `path`, `versioning`, `tagPattern`, `tagRule`, `validationPath`, `buildRef`, `mergeMethod`, `mergeWindow`, `shipOrder`, `anchorTask`, `roles` (overrides: `qa`, `mergeOwners`, `releaseManager`, `buildOwner`, `developer`), `channels {key: {enabled, ships, settings}}`, `gates[]`, `advisory[]`, `distribution[]`, `settings` |
| `projectGates[]` | platform: `{key, approverRole, required, params}`; `integration_qa` takes `params.minComponents: 2`, so a one-component version skips it |
| `labels` | `versions {key: label}`, `components {key: label}`, `epic`, `bug`, `hotfix`, `ops` |
| `versions[]` | `key`, `kind`, `state`, `components` (in scope), `numbers {component: x.y.z}`, `artifactVersion` (mobile milestone), `target`, `train` |
| `referenceWorkspaces[]`, `repoTags[]` | ignored workspace ids; `{repoUrl, tag, sha?, source: imported \| retired}` |
| `lineage` | for a project made from a moved component: `{predecessorProjectId, predecessorProjectKey, componentKey, lastTag}` |
| `rules`, `aliases`, `checklist`, `tasks`, `changelog[]` | WIP, aging and hotfix cap; words; checklist items; `roadmap`, `planning`, `companyIndex`; `{at, by, change, approval?}` |

**Worked example: VPN Platform as it is today** (ids elided as `…`; the `<owner>` part of each repo URL comes from the workspace). Presto VPN differs in three ways: its monorepo components carry `path` and `<key>/v{version}` tags plus `c:` labels for every component; `node` uses `ci_green` instead of `release_test_validated`; and its distribution starts with `release_workflow` (§18.5).

```json
{"schema": "paperclip.roadmap/release-profile@1", "enabled": true,
 "project": {"id": "…", "name": "VPN Platform", "type": "platform", "templateKey": "platform@1",
             "key": "vpn", "labelStyle": "prefixed", "versionScheme": "semver", "trunk": "main"},
 "roles": {"pm": {"type": "agent", "id": "…", "name": "Project Manager"},
           "qa": [{"type": "agent", "id": "…", "name": "QA"}],
           "mergeOwners": [{"type": "agent", "id": "…", "name": "Project Manager"}, {"type": "agent", "id": "…", "name": "QA"}],
           "mergeOwnersStrict": false, "releaseManager": {"type": "agent", "id": "…", "name": "Project Manager"},
           "approvers": [{"type": "user", "id": "…", "name": "board"}],
           "intake": [{"type": "agent", "id": "…", "name": "TrelloIntake"}, {"type": "agent", "id": "…", "name": "SupportTriage"}]},
 "components": [
  {"key": "backend", "kind": "backend_service", "workspaceId": "…", "workspaceName": "backend",
   "repoUrl": "https://github.com/<owner>/vpnproject", "path": null, "versioning": "lockstep",
   "tagPattern": "v{version}", "tagRule": "candidate", "buildRef": "image_digest", "mergeMethod": "squash",
   "mergeWindow": "off", "shipOrder": 10, "anchorTask": "VPN-…",
   "roles": {"buildOwner": {"type": "agent", "id": "…", "name": "BackendEngineer"}},
   "channels": {"staging": {"enabled": false}, "production": {"ships": true}},
   "gates": ["tasks_closed", "qa", "release_checklist"], "distribution": ["prod_deployed"]},
  {"key": "node", "kind": "infrastructure", "workspaceId": "…", "workspaceName": "node",
   "repoUrl": "https://github.com/<owner>/vpn-node", "path": null, "versioning": "independent",
   "tagPattern": "v{version}", "tagRule": "validation_commit", "validationPath": ".release-validation/{version}.json",
   "buildRef": "commit_sha", "mergeMethod": "merge", "mergeWindow": "off", "shipOrder": 30, "anchorTask": "VPN-…",
   "roles": {"buildOwner": {"type": "agent", "id": "…", "name": "NodeOps"},
             "releaseManager": {"type": "agent", "id": "…", "name": "NodeOps"}},
   "channels": {"release_test": {"settings": {"host": "release-test"}},
                "canary": {"settings": {"nodes": ["nuremberg-01"], "minHours": 24}},
                "fleet": {"ships": true, "settings": {"batchSize": 5}}},
   "gates": ["tasks_closed", "release_test_validated", "qa", "release_checklist"],
   "distribution": ["canary_healthy", "fleet_rollout"]}],
 "projectGates": [{"key": "integration_qa", "approverRole": "qa", "params": {"minComponents": 2}},
                  {"key": "release_checklist", "approverRole": "release_manager"},
                  {"key": "board", "approverRole": "board"}],
 "referenceWorkspaces": ["<ios-securezone id>", "<ios-securefield id>"],
 "labels": {"versions": {}, "components": {}, "epic": "type:epic", "bug": "type:bug",
            "hotfix": "type:hotfix", "ops": "release-ops"},
 "versions": [], "repoTags": [], "lineage": null,
 "tasks": {"roadmap": "VPN-…", "planning": null, "companyIndex": "VPN-…"},
 "changelog": [{"at": "<date>", "by": "board", "change": "profile v1"}]}
```

---

## 15. Governance and invariants

| Invariant | How it holds |
|---|---|
| Company scoping | Every table has `company_id` from the host; every id re-checked before a write; trains and moves stay inside one company. |
| Single assignee, atomic checkout | Untouched. A version or train is never an assignee; each ops task has one owner; no reassignment under a live run (F43). |
| Approval gates | The plugin never requests `approvals.respond`; board decisions require `board_user_ids` (F32); Phase 0 approvals stay native and are linked later (`gate_results.approval_id`). |
| Budget hard stop | Every plugin wake goes through `requestWakeup` (F12); hand-out pre-checks `budget_incidents`. |
| Activity log | Every plugin mutation logs `roadmap.<area>.<verb>` and a `roadmap_events` row; core logs `ctx.issues.*` writes. |
| Liveness | Epics are `backlog` containers; held work blocks on a board-owned task; proposals wait on a user owner; no half-parked tasks; plugin-created work is re-woken once then flagged (F27). |
| Label integrity | Labels are the truth; the mirror detects and restores (§4.5). |
| Core deletes | Plugin rows never block deleting a project, an agent or a company (§13 rules 5–6). |
| Portability | Plugin rows are not exported; the `release-profile`, `release` and `version-notes` documents are core documents and are. |
| Data paths | Activity log and run log only; no Telemetry (AGENTS.md §5.7). |
| Wake safety | ≤ 3 sequential wakes per company per action or tick; no bulk assign-to-`todo`. |
| Never | Pause projects, use tree holds, cancel runs, delete labels or workspaces, or reassign in-flight tasks for version control. |

**Worker down or uninstalled**: labels, tasks and documents are core data and keep working; parked tasks stay parked.

---

## 16. Core seams, fork changes and upstream

| Carried fork change | Change | Without it |
|---|---|---|
| **S6a** (required before the 1a install) | Add `labels`, `issue_labels` to `PLUGIN_DATABASE_CORE_READ_TABLES` (`packages/shared/src/constants.ts:1439-1453`) with a test | No 1a: the manifest fails validation (G22), and the plugin could not bind, re-bind or apply a label that no task carries (§0.4 item 9). The spike's "filter the labels on listed tasks" stays a display fallback of the v0.1 UI only. |
| **Board-policy lines** (before Phase 0b) | Two lines in the bundled `skills/paperclip/SKILL.md` (§14.4 step 7) | Every policy-routed hand-off also wakes the PM; role precedence between the two skills stays implicit |

Upstream PRs, not carried (each follows `.github/PULL_REQUEST_TEMPLATE.md`): S6a; **S4** `ctx.labels.list/ensure`, which would let the plugin create version labels itself (worth carrying in the fork if components that release every few days onboard before the restructuring, §4.4); **S5** `parentId` and a normalized `executionPolicy` in plugin create/update (F40); **S10** `projectId`, `projectWorkspaceId` and `executionWorkspaceId` in plugin `issues.update`, which would let the plugin apply component moves itself (§17). The worker and the host already pass the whole update patch through (G24), so S5 and S10 mainly type that passthrough, add a host-side key allowlist that routes `executionPolicy` through the route's normalization, and add contract tests. The passthrough is also reported upstream, because today a plugin can set an unnormalized policy; the plan never uses it. Also: **S1** a plugin contribution to heartbeat-context; **S7** label chips on kanban cards; **S8** a plugin "work" origin that core recovery treats as normal (F27); an SDK `IssueStatusControl`; later, `projects.kind`. Before the next upstream sync: resolve the fork's 0284/0285 migration collision, and make sure role holders file bugs through `roadmap_create_report` (synced core checks `tasks:assign` on every agent create).

---

## 17. Restructuring: moving a component into its own project (requirement 15)

Both shapes are supported from day one: a component inside a project (Presto VPN `node`) and a separate project that joins a company train (a future "VPN Node"). On 2026-10-07 the user confirmed that vpn-node is really its own project and that the restructuring comes later. **Nothing is restructured now**, and nothing in the pilot or in Phase 1 waits for it. Three forms exist, by timing:

| When | Form | Cost |
|---|---|---|
| Before the company has `v:` labels | Core-only split (§17.4) | Board PATCHes; nothing to relabel |
| After Phase 0 onboarding, before the Phase 3 tool | Manual move after labels exist (§17.4, `references/moves.md`) | Board and PM steps; relabelling by hand, one task at a time |
| After Phase 3 | The move tool (§17.2–§17.3) | The board approves a plan; the PM (or, with S10, the plugin) applies it |

### 17.1 Preconditions (blockers in the dry run)

1. The board created the target project in core, added the same repo as its workspace (G6), and copied the configuration the new project needs: lead, `env`, `executionWorkspacePolicy` (including its default workspace), `defaultEnvironmentId`, goal, any project budget, and the workspace's setup command and runtime config. The target workspace is matched by the `repoUrl` in the source component's profile entry, or picked by the board (G26).
2. No source version with the component in scope is `stabilizing`.
3. The target project key is unique, and the labels to create are listed by exact name (plugins cannot create labels).

Work in flight is **not** a blocker. A task that is in flight (`in_progress`, or a checkout or execution run set) or in `in_review` with an open PR is skipped as "move after merge", because moving it would drop its execution workspace and worktree (G5). The plan lists those tasks, and the tick (Phase 3) or the PM's daily run (Phase 0) moves each one after it closes or merges. This matters at VPN, where 12 node tasks are open (P2).

### 17.2 What the plan computes

- **Versions**: for each planned or active source version V with the component in scope, a target V′ in the same state with `version_number` = the component's version, and a train linking V and V′ (joining V's train or creating `<srcKey>-<V.key>`). An independent component's own versions (§4.4) move whole.
- **Tasks**: open tasks resolved to the component as `label`, `manual` or `workspace`. Tasks resolved only as `workspace_default`, or not at all, are listed for the PM to confirm first. Each move has the core PATCH body `{projectId, projectWorkspaceId: <target ws>, executionWorkspaceId: null}` (G5) and a label change: remove `v:<src>-<V>` and `c:<src>-<comp>`, add `v:<tgt>-<V′>`.
- **Configuration**: roles, channels and gates to copy; project gates seeded from the target type.
- **Routines** to re-point, **picked by the board** from the source project's routines (found through their execution tasks, `originKind='routine_execution'`, `originId`), because routines have no workspace (G27).
- **Epics** whose stories all move (the board recreates them in the target).

### 17.3 Apply (Phase 3 tool; sequential, idempotent, result per step in `component_moves.result`)

1. Create the target profile and the target component as `pending` (same kind, repo, path, tag pattern, tag rule, build-ref kind); copy channels, gates, roles; set the target's anchor task.
2. Set the source component `moved_out` with `successor_component_id`; set the target `active` with `predecessor_component_id`. The `pending` state avoids colliding on the tag-namespace index; the namespace now belongs to the successor.
3. For each mapped V: `version_components(V, src)` → `moved_out`, `moved_to_version_id = V′`; create V′ and its row (same pattern, so the tag series continues); create or join the train.
4. **Core project moves**: the plugin creates the ops task "Apply component move: <component> → <target>" for the PM with a `move-plan` document. The PM (or the board CLI) applies one PATCH at a time. On each `issue.updated` showing the new project, the plugin relabels (read-modify-write) and updates `roadmap_items`; `foreign_version_label` is suppressed for tasks of an applying move. Tasks still in the source raise `move_incomplete`; skipped in-flight tasks raise `move_waiting_for_merge`. With S10 (§16) the plugin applies these PATCHes itself.
5. The board re-points the picked routines (`PATCH /api/routines/:id {projectId}`, G17) and may set the old workspace's visibility to `advanced`. **Do not delete the old workspace**: deletion nulls `issues.project_workspace_id` on its history (G4).
6. Mark the move `applied`; `roadmap_events` `component_moved`; activity `roadmap.component.moved`.

**Preserved**: released versions keep their `version_components`, candidates, gate results and tags where they were made; the target's History walks `predecessor_component_id` ("As component *node* of VPN Platform: 1.2 (v1.2.0), 1.3 (v1.3.0)"). Closed tasks keep their old labels and project (identifiers never change; they come from a company counter). `repo_tags` refuses reuse; the next `component_version` must exceed the lineage's last tag. **Rollback**: before step 2, cancel; after step 2, a reverse move. There is no destructive undo.

### 17.4 Phase 0 forms (`references/moves.md`)

**Before any `v:` label exists** (cheapest): the board creates the project and workspace with the configuration of §17.1, moves the open tasks with the PATCH of §17.2 one at a time (in-flight tasks after their merge), re-points the picked routines, and writes the new profile by hand. Nothing needs relabelling.

**After labels exist** (the user restructures after onboarding):

1. The board creates the target project (§17.1) and the labels `v:<tgt>-<key>` for each mapped version.
2. The board writes the target's `release-profile` with `lineage {predecessorProjectId, predecessorProjectKey, componentKey, lastTag}`, the copied roles, channels and gates, the repo tags and the mapped versions. It removes the component from the source profile with a `changelog` entry "moved to <project>", and adds the new project to the trains in `roadmap-index` (or creates a train).
3. The PM moves each task with one PATCH (project, workspace, `executionWorkspaceId: null`), then relabels it with read-modify-write: drop `v:<src>-…` and `c:<src>-…`, add `v:<tgt>-…`. One task at a time; in-flight tasks wait for their merge.
4. The PM moves the component's readiness rows to the target tracking task's `readiness` document, marked "moved from <source> <version>".
5. The board re-points routines and hides the old workspace (`advanced`); it never deletes it.
6. `phase0.import` later reads `lineage` and links the target component to its predecessor, so History shows the component's earlier releases.

---

## 18. Rollout playbook

### 18.1 Order and safety

1. Finish the Cleanio pilot through Phase 0a (§19).
2. Commit the skill sources (`packages/plugins/roadmap/skills/roadmap/`), docs-only, so Phase 0 skills come from one source.
3. **The user's restructuring** (vpn-node, presto-vpn-node; question 4). If it is ready before VPNProjects and Presto VPN are onboarded, use the core-only split of §17.4 first: nothing needs relabelling. If onboarding comes first, onboard with components now (§18.5) and use the manual move after labels exist (§17.4) or the Phase 3 tool later. Both orders work; the user picks.
4. Onboard VPNProjects, then Presto VPN, one planning thread at a time.
5. **Phase 1a install on prod** (and every plugin upgrade with a new migration): in a quiet window, with no active runs and agents paused if needed. Migration 001 runs in one transaction (§0.4 item 5) and adds foreign keys to `public.issues`, `agents`, `projects`, `approvals`; each takes a lock that blocks writes to that table until commit. Behind a long transaction this queues every issue write, the lock-convoy pattern of the 2026-10-06 pool starvation, and the validator does not allow `SET lock_timeout`. The deploy checklist checks `pg_stat_activity` for long transactions first.

Safety for every step: `npx paperclipai` for content-bearing arguments; one write at a time; never bulk-assign (≤ 3 wakes per action); close tasks with `PATCH {status, comment}` (a separate board comment reopens a done task); check `maxDailyRuns` before adding routines.

### 18.2 Company onboarding (once per company)

| Step | Action |
|---|---|
| C1 Survey | Projects and workspaces (repo bound in two projects? repo URL known?), agents (role, status, environment, `maxConcurrentRuns`, `maxDailyRuns`), routines, existing labels, existing skills (slug `roadmap` free?), board user ids, existing repo tags (`git ls-remote --tags`; they become `repoTags` and decide each component's `tag_pattern`) |
| C2 Decide | Versioned projects and their types (type guide: store-distributed app → `mobile_app`; deployed API/worker → `backend_service`; deployed web UI → `web_app`; fleets/nodes → `infrastructure`; packages → `library`; several shipped together from one project → `platform`; onboarding/support/routine-only → `operations`); project keys; trains |
| C3 Labels | `type:epic`, `type:bug`, `type:hotfix`, `release-ops` if missing |
| C4 Skill | §14.4 steps 1–2, then the pointer stanza (step 6) on every attached agent, one `PUT …/instructions-bundle/file` at a time |
| C5 Company index | Only with ≥ 2 versioned projects or a train: task "Roadmap: <Company> (company)" (board-owned, `release-ops`, no project, so exempt from `task_without_project`) with `roadmap-index` (one fenced `json` block: board users, default PM, intake agents, project list with keys, Roadmap task identifiers and intake aliases, trains) |
| C6 Phase 1+ | Enable the company in Roadmap settings, set board users, bind a "Roadmap tools" tool profile (`tool_name = paperclip.roadmap:<tool>`, G13), dry-run `phase0.import` |

### 18.3 Project onboarding (per versioned project)

| Step | Action | Wakes |
|---|---|---|
| P1 | Draft the profile (§14.6): type, components (workspace id, repo URL, path, tag pattern from the existing tags, tag rule, merge method, gates), key and label style, roles (§10.2 defaults confirmed by the board), rules; import existing repo tags | 0 |
| P2 | Create the version labels the board already knows (at least the first) and, in a project with a shared workspace, one `c:` label per component | 0 |
| P3 | Task "Roadmap: <project name>" in that project (board-owned, `release-ops`) with `release-profile` (`npx paperclipai issue document:put …`) | 0 |
| P4 | Multi-component projects: one anchor task per component on its workspace ("Component: <project> · <component>", board-owned, `release-ops`); record the identifiers in the profile | 0 |
| P5 | Attach the skill and the pointer stanza to **every** agent that touches the project (roles, implementers, intake); remove any older roadmap addenda | 0 |
| P6 | "Plan roadmap: <project>" from the template (§10.3), assigned to the PM, `todo`, child of P3 | 1 |
| P7 | Board decides the approval card and question card, then applies its part (labels, epics, parking list, Tags column, profile `versions`) | ≤ 1 per decision |
| P8 | "Roadmap daily" once per PM (§10.4), or confirm the PM's routine covers the new project | 0 |
| P9 | Acceptance checks (§18.4) | — |
| P10 (0b) | When merge and build owners are available and the Board-policy edit is live: policies at hand-out; first PR through the generated policy; first merge with the trailer | per task |

### 18.4 Generic acceptance checks

- [ ] Every open task (routine executions excluded) carries exactly one version label, is listed as ongoing or ops, or is cancelled with a reason. No epic carries a version label. Builds, test runs and sign-offs are `release-ops`.
- [ ] No task of a `planned` version is agent-assigned or in `todo`/`blocked`/`in_progress`, except listed in-flight tasks and user-owned tasks (a user-owned task cannot wake an agent). No half-parked task. No `blocked_by_unassigned_issue` points at a parked blocker.
- [ ] In a multi-component project every version task has a confirmed component (`c:` label or the PM's classification).
- [ ] Every agent that touches the project shows the skill enabled and carries the pointer stanza; no agent instruction holds other roadmap rules.
- [ ] The PM's run read the profile (transcript) and uses its words and label names. Intake still reaches the right project's PM; existing routines are untouched.
- [ ] Roadmap daily reports drift, next-up, merge detection per component repo and profile parse status, files collected bug proposals, and starts no parked work.

### 18.5 Prod mapping now (no restructuring)

| Company · project | Type | Key / labels | Components (repo · path · tag) | Roles (proposed) | Notes |
|---|---|---|---|---|---|
| CLE · Cleanio iOS | `mobile_app` | `cle`, **bare**: `v:mvp`, `v:1.0`, `v:1.1` | `app`: `https://github.com/mithatcolakel/cleanio` · — · `v{version}`; tag rule `candidate`; build number; strict window | §19.3 | MVP = milestone; import `v1.1.0`, `v1.1.1` (P6); CLE-97 is the anchor |
| CLE · Onboarding | `operations` | `onb` | — | — | Ongoing and Routines only |
| VPN · VPN Platform | `platform` | `vpn`, `v:vpn-<key>`; node versions `v:vpn-node-<x.y>` | `backend`: VPNProject · — · `v{version}` (backend_service, 10, lockstep, `staging` only if one exists, question 8); `node`: VPN-Node · — · `v{version}` (infrastructure, 30, **independent** with its own versions, tag rule `validation_commit`, merge method `merge`; readiness release-test → QA → checklist; distribution canary `nuremberg-01` → fleet in batches of 5) | pm = Project Manager; qa = QA; merge owners [PM, QA] + board; release manager PM (backend) and NodeOps (node); build owners BackendEngineer and NodeOps | Profile: §14.6. `ios-*` workspaces are reference workspaces (§3.5); 1 open task there → `task_on_reference_workspace`. No `c:` labels (separate repos); `backend` is the primary workspace, so the PM confirms components. "Daily Server Check" in Routines. |
| VPN · Securezone iOS | `mobile_app` | `sz`, `v:sz-<key>` | `app`: SecurezoneVPN · — · `v{version}` | pm set explicitly (no lead, P4); qa = QA; merge owners [PM, QA] + board; release manager PM (tags); build owner SecurezoneiOS (Mac `mac-securezone`: builds, beta uploads, store submission) | — |
| VPN · Securefield iOS | `mobile_app` | `sf`, `v:sf-<key>` | `app`: SecureField · — · `v{version}` | as Securezone; build owner SecurefieldiOS (in `error` → `owner_unavailable`) | — |
| VPN · train | — | — | VPN Platform (backend versions) + Securezone iOS + Securefield iOS; `single`, `ordered`: backend (10) → apps (40). A node version joins only when a release needs it (then backend → node → apps) | owner = Project Manager, anchor VPN Platform | Works without restructuring |
| PRE · Presto VPN | `platform` | `pre`, `v:pre-<key>`; `c:pre-mobile`, `c:pre-api`, `c:pre-admin`, `c:pre-node` | `mobile` / `api` / `admin`: presto-monorepo · `<path>` · `<key>/v{version}` (40 strict / 10 / 20, lockstep); `node`: presto-vpn-node · — · `v{version}` (30, **independent**, pattern from the existing `v2.0.x` tags; readiness `tasks_closed` → `ci_green` (`vpn-node.yml`) → `qa` → `board`; distribution `release_workflow` (the user dispatches `vpn-node-release.yml`) → `fleet_rollout`) | pm = Project Manager; qa = QA Tester; merge owners [PM, QA Tester] + board; release manager PM, for node the VPN Node Engineer (it tags after CI is green, P7); build owners: mobile iOS Engineer (**no Mac environment**, question 9), api/admin Backend Engineer (in `error`), node VPN Node Engineer | All 16 tasks sit on the monorepo (P3), so every version task needs a `c:` label; paths to confirm. A tag made by a person is recorded with `component.recordTag`. |
| VPN, PRE · Onboarding | `operations` | `onb` | — | — | — |

### 18.6 After the user's restructuring (later rollout step)

| Company | Change | Result |
|---|---|---|
| VPN | `node` → new project **VPN Node** | `infrastructure`, key `node`, labels `v:node-<key>` (open `v:vpn-node-*` versions map 1:1, §17), same repo, `v{version}` continues, `lineage` points at VPN Platform; roles NodeOps (build owner, release manager) and a QA owner with release-test access (question 10). VPN Platform keeps `backend` and becomes `backend_service` (or stays `platform` if api/worker/admin deploy separately, question 8). Stray `ios-*` tasks move to the app projects; those workspaces are hidden. Train: VPN Platform (10), VPN Node (30), Securezone iOS (40), Securefield iOS (40). |
| PRE | `node` → **Presto VPN Node** | `infrastructure`, key `pnode`, labels `v:pnode-<key>`; `c:pre-node` is retired. Presto VPN stays `platform` (mobile, api, admin). Train: Presto VPN (api 10, admin 20, mobile 40) + Presto VPN Node (30). Later, mobile may move to "Presto iOS" the same way. |
| CLE | none | A future Android app from the same Flutter repo enables the `play_*` channels; a separate backend becomes a new prefixed project. |

**VPN Node gates** (the board rule "tested before proposed" and VPN-137, P8): release-test validation of the candidate (a full pass with the AmneziaWG legs, the stack lock held, evidence attached; the verdict names the validated sha, which may be a task-branch head) → QA verdict by an owner with release-test access → release checklist → board approval → **tag** on the commit that adds `.release-validation/<v>.json` on top of the validated sha (tag rule `validation_commit`, merge method `merge`) → canary on `nuremberg-01` (`canary_healthy`, distribution) → rollout in batches of 5 (`fleet_rollout`). Ship order applies to the fleet channel.

---

## 19. Phase 0 on Cleanio (pilot)

### 19.1 State on 2026-10-07

- Company Cleanio `35f4ebee-b18f-441b-bf5e-f92f5be51c56` (CLE): **Cleanio iOS** `3e7bb400-1fa5-4c96-953f-c283c99be85c` (lead = Project Manager) and **Onboarding** (no lead). One routine, "Trello intake poll" (TrelloIntake). Prod runs `deploymentMode=authenticated`; the board CLI credential is instance admin.
- Agents: Project Manager and TrelloIntake work; FlutterEngineer, QAEngineer and ReleaseEngineer are in `error` (dead Mac default environment) and still invokable (F38). All five have `canCreateAgents=true`. No protections applied (TrelloIntake forwards by reassigning to the PM).
- **Applied 2026-10-06**: labels `v:mvp`, `v:1.0`, `type:epic`, `type:bug`, `type:hotfix`, `release-ops`; **CLE-97** "Cleanio Roadmap" (board-owned, `release-ops`); **CLE-98** "Draft the Cleanio roadmap with the board (MVP → v1.0)" (PM); **addenda v1** on all five agents (words planning → active → frozen → ready → released, manual QA → RE hand-off, "no release branches").
- **The PM's draft rev1** is on CLE-97 (`roadmap`), waiting for approval. It measured: `main` carries the CLE-3 merge and unpublished tags `v1.1.0`/`v1.1.1`; 4 branches hold unmerged work; `flutter analyze` on `main` = 873 errors, all from one file deleted on every branch; no TestFlight build ever; the Mac runner is down for all three Mac agents. It proposes MVP (TestFlight-only), v1.0 (first App Store release), v1.1 (needs a label), epics E1–E6, a classification of 30 open tasks, and Q1–Q6 (Mac, version numbers, dates, payments defects placement, `v:1.1`, cancel CLE-1).
- **Amendment posted by the board on CLE-98 (2026-10-06)**, effective after approval: (1) the PM creates no epics; the board creates E1–E6 and then asks for parents; (2) the PM creates no labels; the board creates `v:1.1`; relabels keep every other label; (3) the PM parks only `todo`/`backlog` tasks (CLE-37, CLE-41) in **one** write with `Planned owner:` and `Rank:` lines; `blocked`/`in_review` future tasks (CLE-38, CLE-40, CLE-39) go on a board parking list; blockers of MVP or ongoing work are not parked; (4) **Mac-down mode**: no assignment, wake or mention of the three Mac agents until the board clears their errors; (5) the word **stabilizing** replaces "frozen", and Ready = all version tasks closed + QA PASS + board TestFlight approval on the same build.

### 19.2 Remaining steps

**Phase 0a (now; board, PM, TrelloIntake)**

1. **Approve the PM's card with a short note** (no extra PM run), carrying what the amendment does not cover:
   - **build and QA work become ops work** (this removes the Ready deadlock, §0.1): CLE-48 becomes the candidate ops task "Candidate Cleanio MVP app" (add `release-ops`, keep `v:mvp`, owner ReleaseEngineer). CLE-13, CLE-84, CLE-88, CLE-86, CLE-16 and CLE-53 become QA ops work on the release candidate (add `release-ops`, keep `v:mvp`). Checks that ran on an earlier sha are cited with that sha or re-run, and the QA verdict lists them in `checks[]` and `notRun[]`. The MVP's counted tasks are then the code and decision tasks, which can all close before the build;
   - app-code tasks get FlutterEngineer as planned owner, not ReleaseEngineer: CLE-87 (integration, §0.3 item 1), CLE-18, CLE-47, CLE-59. ReleaseEngineer stays the build owner (CLE-48) and merges. CLE-87's integration PRs merge with method `merge` (the PM writes `Merge method: merge` on them), because the branches are integrated as real merges;
   - board decision items (CLE-3, CLE-28, CLE-31, CLE-39) end **assigned to the board user** with their version label (draft step 5); the board reassigns CLE-39 itself because it is `blocked` (F23). A user-owned task cannot wake an agent, so CLE-39 needs no parking (§18.4 exempts it);
   - MVP is a **milestone**: TestFlight-only, no tag. Its builds still carry a marketing version, so **Q2 must be answered before the first MVP upload**; the candidate and the TestFlight evidence record it (`artifactVersion`);
   - bugs: only the PM files bug tasks; QAEngineer and ReleaseEngineer write them under `Proposals` (§9).

   Answer the question card: Q1 Mac (recommendation (c)), Q2 version numbers (decides the tag registry and the MVP's marketing version, §19.3), Q3 dates, Q4 payments defects.
2. **The PM applies its part** one task at a time: labels (including `release-ops` on the build and QA tasks above), parking of CLE-37 and CLE-41, `Planned owner:`/`Rank:` lines, cancel CLE-1 with a reason, summary on CLE-97. MVP becomes active with the approval, so the PM also creates the tracking task "Release Cleanio MVP" (board-owned, `release-ops` + `v:mvp`, §4.4 Start). Never `suggest_tasks` or plan acceptance for more than 3 assigned tasks (F18).
3. **The board applies its part**: create `v:1.1` (bare, grandfathered); create E1–E6 ("Epic: <name>", `type:epic`, unassigned, `backlog`, no `v:`), then ask the PM to re-parent; park CLE-38 and CLE-40 with one `PATCH /api/issues/:id {"status":"backlog","assigneeAgentId":null}` each; turn on the Tags column per device.
4. **Skill migration (replaces revision 3's addenda v2)**: rename CLE-97 to **"Roadmap: Cleanio iOS"** and check that it sits in project Cleanio iOS (discovery needs both, §14.3); create the CLE skill `roadmap` (§14.4); write `release-profile` (§19.3) and `addenda-v1-archive` (the five agents' roadmap sections) on CLE-97; attach the skill to all five agents; replace each addendum with the pointer stanza (5 sequential `PUT …/instructions-bundle/file`; wakes nobody). Mapping: labels, lifecycle words, one active version, parking → `SKILL.md` + profile aliases; PM duties → `roles/pm.md`; "only ReleaseEngineer merges" → `SKILL.md` §3 + profile `mergeOwners` strict + `roles/merge-owner.md`; manual QA → RE hand-off → **replaced** by the generated execution policy (0b); Ready rule → `types/mobile_app.md` + profile gates; RE build and tag duties → `roles/build-owner.md`, `roles/release-manager.md`; QA verdicts → `roles/qa-owner.md`; TrelloIntake's `Proposed flow:` → `roles/intake.md`; Cleanio facts (Mac device, Adapty, simulator-only ruling) stay in that agent's own AGENTS.md or the `roadmap` document. Anything that maps nowhere goes to the board first. Rollback: restore the archived sections and `--mode remove` the skill.
5. **Roadmap daily**: PM, project Cleanio iOS, 09:00, `skip_if_active`, `skip_missed`, `medium` (§10.4, duties §19.4).
6. **PM GitHub access check**: one PM run lists the last merged PRs of the Cleanio repo; otherwise merge detection moves to QAEngineer's routine in 0b or to a weekly board CLI check.
7. **Onboarding**: no profile (shown as operations). Nothing to apply.

**Phase 0b (after the mac-fleet fix is live)**

8. The deploy that carries the mac-fleet fix also carries the Board-policy lines (§14.4 step 7). Then clear the Mac agents one at a time (`POST /api/agents/:id/clear-error`), checking one small run each.
9. The PM sets execution policies by executor at hand-out (§11.2); at most one version task in `todo`/`in_progress` per engineer, one PATCH at a time.
10. First MVP epic E1 "Integrate the delivered branches" (CLE-87), after CLE-31 is answered (the branch choice decides it): FlutterEngineer executes one task per branch in the PM's merge order; QA reviews; ReleaseEngineer merges (method `merge`) with the trailer.
11. MVP end game (§19.5).

### 19.3 Cleanio release profile (`release-profile` on CLE-97)

The document is one prose line ("Release profile of Cleanio iOS. Edited by the board; see the `roadmap` skill, references/phase0.md.") followed by this block:

```json
{"schema": "paperclip.roadmap/release-profile@1", "enabled": true,
 "project": {"id": "3e7bb400-1fa5-4c96-953f-c283c99be85c", "name": "Cleanio iOS", "type": "mobile_app",
             "templateKey": "mobile_app@1", "key": "cle", "labelStyle": "bare", "versionScheme": "semver", "trunk": "main"},
 "roles": {"pm": {"type": "agent", "id": "0cfbad0d-…", "name": "Project Manager"},
           "qa": [{"type": "agent", "id": "…", "name": "QAEngineer"}],
           "mergeOwners": [{"type": "agent", "id": "…", "name": "ReleaseEngineer"}], "mergeOwnersStrict": true,
           "releaseManager": {"type": "agent", "id": "…", "name": "ReleaseEngineer"},
           "approvers": [{"type": "user", "id": "…", "name": "board"}],
           "intake": [{"type": "agent", "id": "…", "name": "TrelloIntake"}]},
 "components": [{"key": "app", "name": "Cleanio app", "kind": "mobile_app", "workspaceId": "…", "workspaceName": "<workspace name>",
   "repoUrl": "https://github.com/mithatcolakel/cleanio", "path": null, "versioning": "lockstep",
   "tagPattern": "v{version}", "tagRule": "candidate", "buildRef": "build_number",
   "mergeMethod": "squash", "mergeWindow": "strict", "shipOrder": 40, "anchorTask": "CLE-97",
   "roles": {"buildOwner": {"type": "agent", "id": "…", "name": "ReleaseEngineer"},
             "developer": {"type": "agent", "id": "…", "name": "FlutterEngineer"}},
   "channels": {"testflight": {"enabled": true, "settings": {"externalTesters": false}}, "app_store": {"enabled": true, "ships": true},
                "play_internal": {"enabled": false}, "play_store": {"enabled": false}},
   "gates": ["tasks_closed", "qa", "beta_approved"], "advisory": ["release_checklist"], "distribution": ["store_submitted"],
   "settings": {"buildCommand": "flutter build ipa --build-name=<version> --build-number=<n>", "environment": "Mac"}}],
 "projectGates": [],
 "labels": {"versions": {"mvp": "v:mvp", "1.0": "v:1.0", "1.1": "v:1.1"}, "components": {},
            "epic": "type:epic", "bug": "type:bug", "hotfix": "type:hotfix", "ops": "release-ops"},
 "versions": [{"key": "mvp", "kind": "milestone", "state": "active", "components": ["app"], "numbers": {},
               "artifactVersion": "<Q2: 1.0.0 | 1.2.0>"},
              {"key": "1.0", "kind": "main", "state": "planned", "components": ["app"], "numbers": {"app": "<Q2: 1.0.0 | 1.2.0>"}},
              {"key": "1.1", "kind": "main", "state": "planned", "components": ["app"], "numbers": {}}],
 "referenceWorkspaces": [],
 "repoTags": [{"repoUrl": "https://github.com/mithatcolakel/cleanio", "tag": "v1.1.0", "source": "imported"},
              {"repoUrl": "https://github.com/mithatcolakel/cleanio", "tag": "v1.1.1", "source": "imported"}],
 "lineage": null,
 "rules": {"wipVersionPerAgent": 1, "wipOngoingPerAgent": 1, "hotfixDailyCap": 3, "ongoingAgingHours": 24},
 "aliases": {"planning": "planned", "frozen": "stabilizing", "ready": "Ready badge"},
 "tasks": {"roadmap": "CLE-97", "planning": "CLE-98", "companyIndex": null},
 "changelog": [{"at": "2026-10-07", "by": "board", "change": "profile v1 (migrated from addenda v1)"}]}
```

`repoTags` are blocking imports. **Q2 (a)** 1.0 ships as 1.0.0; the board deletes `v1.1.0`/`v1.1.1` in git and marks them `retired`; the retired rows stay as history and 1.1 can record `v1.1.0` again (§13). **Q2 (b)** 1.0 ships as 1.2.0 (key `1.0`, `version_number` 1.2.0) and the old tags stay. Either way the MVP's TestFlight builds carry the 1.0 marketing version.

### 19.4 Phase 0 daily checks (PM routine)

Using `GET /api/companies/:id/issues?projectId=&labelId=&status=` (F8, G32):

- **Parking**: a future-version task assigned to an agent or out of `backlog` (user-owned tasks excepted); a half-parked task; a parked task blocking MVP or ongoing work.
- **Labels**: more than one `v:` label; an epic with a `v:` label; a new sub-task or follow-up without its parent's label; a build, test or sign-off task without `release-ops`.
- **WIP and waiting**: more than one version task or ongoing task in `todo`/`in_progress` per engineer; an ongoing `todo` waiting > 24 h (bump priority); version work held by an agent in `error`.
- **Hotfixes and bugs**: a hotfix that is not `critical` or not assigned; bug proposals in agents' comments not yet filed; a `type:bug` task untriaged > 24 h.
- **Code flow (0b)**: a code task in `in_review` without the policy; a merge without the trailer or a non-eligible merge while the window is closed.
- **Profile**: the `release-profile` block parses and matches the schema; roles point at existing, available agents.
- **Label backup**: each `v:` label's task list into the `roadmap` document; a vanished label is reported to the board at once.

### 19.5 MVP end game in Phase 0 (milestone)

1. **Stabilize** (board tells the PM): unfinished `v:mvp` tasks not in flight move to `v:1.0` (parked; blocked ones by the board) or Ongoing; the PM creates "Merge window: Cleanio MVP" (board-owned). The tracking task "Release Cleanio MVP" exists since Start.
2. **Candidate**: when every counted task and its open descendants are closed (`release-ops` tasks are not counted), the PM hands the candidate ops task (CLE-48) to ReleaseEngineer, who builds with the marketing version decided in Q2, uploads, waits for "Ready to Test", posts `RC<n> build <b> (<marketing version>) @ <sha40>` and adds a `readiness` row.
3. **QA and approval**: QAEngineer runs the QA ops tasks on that build and posts one verdict for it with a `qa-report` document; ReleaseEngineer files `request_board_approval` "beta_approved (TestFlight): Cleanio iOS MVP app RC<n> @ <sha7>"; the board installs, tests and approves.
4. **Reached**: the row reads "Ready: yes"; the board marks MVP reached (milestone: no tag); the PM closes the merge-window and tracking tasks; held work wakes. A code fix merged after the build means a new candidate, a new row and both approvals again; a closed decision or QA task does not.
5. Version 1.0 follows the same steps, plus the tag (`v<number>` at the approved sha) and the `store_submitted` distribution step.

---

## 20. Phases, acceptance checks and effort

Effort is for one engineer working with an AI agent.

| Phase | Scope | Effort |
|---|---|---|
| **0a / 0b** Cleanio | §19 | board time + PM runs |
| **0** other companies | §18, after the user decides; before or after the restructuring (§17.4) | board time + PM runs |
| **1a** read-only, every company | mac-fleet committed (F44); **S6a deployed first**; manifest with the full capability set incl. `project.workspaces.read`; **all of migration 001** with the validator CI test and the core-delete test (§13 rule 6); catalog v1 (generic beta and store gates, infrastructure order, tag rules) and invariants as code; `release-profile@1` schema; profile read view and setup wizard; component resolution with confidence levels; snapshots and company summary with `flags`; Overview, Versions pipeline (read-only), Flow, Backlog, Version detail, route sidebar, project tab and chip, task chip and card; trains read-only; label mirror (read and flag); `phase0.import`; token lint | **9–11 days** |
| **1b** planning, readiness, editors | lifecycle with the per-component trunk rule and Move-unfinished; move/owner/rank/component; Hand out now; Insert hotfix; notes and bugs; proposals with run-end hand-over and review; Plan-with-PM panel; drift and Re-park; label restore; tick with stranded check, mutex and wake cap; **generic gate engine** (candidates incl. `branch` and cherry-pick refs, deployments, gate results, evidence validation, code-deliverable staleness, supersede, tag rules); component anchors and workspace inheritance (contract test); all tools; board actions; roles and the policy builder; profile, component, channel and gate editors; train create/edit and `single` board gate; managed skill with reset-on-hash; settings page; widget; comment Report bug; contract tests for protections | **13–15 days** |
| **2** | merge-window automation per component and path; patches in both modes; distribution tools, ship-order enforcement and Live; `auto_repark`; `release` document mirror; company and project Timeline with trains | **6–7 days** |
| **3** à la carte | component move tool (§17.3) **3–4 days** (less with S10); GitHub verifier filling `repo_tags` (~2 days); assignment protections (2–3 days); automatic feed (~2 days); forecast and burndown; drag-rank; mac-fleet release automation (own plan) | — |

**Total to the full flow (1a–2): about 28–33 engineer-days.** Revision 5 adds about 2 days: the per-component trunk rule, tag rules, anchors and workspace inheritance, the profile schema, and the migration tests.

**Acceptance checks.**

- **0a**: the generic checks of §18.4 on Cleanio; the list filtered by `v:mvp` shows the MVP scope with the Tags column on, with CLE-48 and the QA-round tasks as `release-ops`; an agent run finds the profile through the discovery calls of §14.3; a board comment without a mention on a parked `v:1.0` task starts no run; a Trello test card still reaches the PM.
- **0b**: the Board-policy lines are live; one FlutterEngineer task routes `in_review` → QA review → RE approval → `done` after the merge with the trailer, and the PM is not woken by that hand-off; one QA test-code task routes `in_review` → RE approval → `done`; the first CLE-87 branch reaches `main` this way.
- **1a**: every prod company opens `/<prefix>/roadmap` (set-up projects show stage strips, others Ongoing and Routines; nothing names Cleanio, a store or an agent outside the catalog data and profile data); every visible task classified exactly once, routine executions only under Routines, Ongoing and Routines never change a version's percentage (unit test + hand count); fixtures show Dev · QA · TestFlight │ App Store (mobile), Dev · QA · Staging │ Prod (backend), Dev · Release-test · QA │ Canary · Fleet (infrastructure) and one sub-strip per component plus Integration QA · Board (platform); a monorepo task without `c:` sits in Unsorted, a task on a non-default component workspace shows "inferred" and one on the default workspace "inferred from default"; migration 001 passes the real plugin migration validator, and deleting a project, an agent and a company with plugin rows present succeeds; the §12.6 budgets hold; at 390 px `scrollWidth ≤ innerWidth` and tap targets ≥ 44 px; `phase0.import` on a copy of prod data reproduces the Phase 0 state with no wakes, and the Phase 0 skill is adopted by slug with no re-attach.
- **1b**: Ready only when `tasks_closed`, QA and the template's board gate pass on the **same** newest candidate; a code-deliverable task completed after the candidate makes only its component stale, and a closed decision or `release-ops` task makes nothing stale; a node-only version of an independent component starts and releases while a backend version is active in the same project; `roadmap_create_release` accepts a validation-commit tag only when its parent is the ready candidate and it only adds the validation record; a plugin-created component ops task lands on the component's workspace; a new candidate resets that component and every candidate set naming the old one; `roadmap_create_release` with a wrong sha or a taken tag is refused; the editor cannot remove the QA or board gate; a type change re-seeds planned versions only; the policy builder reproduces the §11.2 table and never names the executor; every mutating tool is classed `write`; proposal hand-over only after the PM's run ends, apply sends ≤ 1 wake and reports skipped items, "Send to PM" yields exactly one PM run in each state; a hotfix shows in Expedite with one wake; label deletion → `version_label_missing` within 5 min → restore; a stranded plugin task gets one re-wake, then `stranded_task`; board actions are refused for non-allowlisted members and agents; every mutation has a `roadmap.*` activity row; `pnpm -r typecheck`, `pnpm test:run`, `pnpm build` and the plugin token check pass.
- **2**: release closes the merge-window task and held tasks wake within 60 s; an `api/` PR merges while `mobile/` stabilizes; patch `1.0.1` in `cherry_pick` mode tags the cherry-picked sha with no branch on the remote, and QA fetches the candidate through its RC ref; a train member deploying out of order is refused with `roadmap_ship_order` unless the board overrides with a reason; dogfood: Cleanio MVP reached and 1.0 released at the approved sha.

---

## 21. Risks

1. **Parking and ship order are detect-only.** Default-open writes (F5), mentions, shared GitHub credentials and Presto's admin token (P7) mean violations are flagged, not prevented. Hardening: protections (question 2), the Phase 3 verifier.
2. **No branch protection, one shared GitHub identity.** The trailer, daily detection and verifier find problems afterwards. Direct pushes have already happened (PRE-8).
3. **DB-pool deadlock remains in core.** The plugin caps its own wakes; `suggest_tasks`, plan acceptance and closing a merge window with much held work can still starve the pool. Installing migration 001 behind a long transaction can queue every issue write (§18.1 step 5).
4. **Labels**: company-wide, permanent names, deletable by anyone (F7, F28). More labels (`v:` per project and per independent-component version, `c:` for monorepo projects) mean more to protect and more board work until S4; typos create phantom versions or Unsorted tasks.
5. **Component inference is weak**: core defaults the workspace (G4), so a task on the default workspace counts as unconfirmed, and multi-component projects depend on `c:` labels or the PM's confirmations. Unconfirmed code tasks make every candidate of the version stale (rebuild churn). Plugin-created tasks land on the right repo only through anchor tasks (§3.5).
6. **Configuration surface**: types, gates, channels, roles and tag rules add real complexity. Templates may assume channels that do not exist (staging at VPN/PRE, a canary mechanism), so Ready is never reached until the board edits the gates. Invariants and the wizard contain this.
7. **Single train approvals churn**: any new candidate in any member invalidates the board approval; `per_member` is the fallback. Ordered shipping lengthens releases (apps wait for backend prod and node fleet; store review adds days).
8. **Role holders unavailable**: all three Cleanio Mac agents, SecurefieldiOS and the Presto Backend Engineer are in `error`; Securezone/Securefield iOS have no lead; Presto mobile has no Mac environment. Gates stall (`role_unfilled`, `owner_unavailable`).
9. **QA as default merge owner** (VPN, PRE) concentrates reviews, merges, tags and QA rounds on one agent with one run slot.
10. **Skill adoption depends on core import semantics** (match by slug, keep key). A change upstream would force one re-attach per agent. Skill use is model-driven; agents can skip it, which the pointer stanza, tool errors and daily checks detect. Until Phase 1 there are three skill copies to keep in sync by hand, and hand-edited profile blocks can be invalid or stale.
11. **Two skills can disagree**: the fork's Board policy and the `roadmap` skill. Until the Board-policy lines ship (before 0b), Phase 0 keeps all task creation with the PM; if the edit is declined, every policy-routed hand-off also wakes the PM.
12. **Component moves** depend on core PATCHes by the PM or board and can stay half-applied (`move_incomplete`, `move_waiting_for_merge`); a hidden old workspace still invites mis-filed tasks (`task_on_reference_workspace`). A manual Phase 0 move after labels exist is many single writes.
13. **Evidence is self-reported** (deployments, soaks, connectivity, store state, validation-commit tags) until the Phase 3 verifier; fleet and store state are never verified automatically.
14. **Migrations are forward-only and the namespace and project keys are permanent**; 20 tables raise the cost of an enum mistake (widen by ALTER).
15. **Hotfixes cannot preempt** a running run or a queued `in_progress` continuation (F9). **Trunk-only stabilization** leaves engineers without version work and holds strict-window merges.
16. **Plugin data is not exported** (core documents carry the history); **the in-process mutex assumes one worker process**; **the seven types may not fit** future projects (desktop apps, data pipelines) until a catalog revision.
17. **Effort grows** to 28–33 engineer-days; strict staging (1a read-only first) keeps the pilot's value early.
18. **Smaller**: the route sidebar replaces the main sidebar in the phone drawer and needs search; plugin UI depends on host token names (lint); each "Send to PM" costs a PM run; S6a touches a warm file; installing the v0.1 spike first costs one upgrade approval; a remote that refuses non-branch refs forces the bundle path for cherry-pick candidates.

---

## 22. Open questions for the board

**Cleanio pilot (now)**

1. The PM's Q1–Q4 on CLE-98 (Mac environment; 1.0.0 vs 1.2.0, which also decides whether `v1.1.0`/`v1.1.1` are retired and which marketing version the first MVP TestFlight build carries; dates; payments defects placement), plus the approval note of §19.2 step 1.
2. Revision 3's questions, still open: **protections** opt-in Phase 3 (recommended) or Phase 1; **strict stabilization** (recommended); **PM hotfix authority** up to 3 per version per day (recommended); **cherry-pick patches** onto the base tag (recommended); **TestFlight internal testers only** (recommended); whether Claude performs the board-side Phase 0a steps with the board credential after approval.
3. **Board-policy edit**: may the fork's bundled `paperclip` skill carry the two lines of §14.4 step 7, shipped with the 0b deploy (recommended)?

**Before onboarding VPNProjects and Presto VPN**

4. **Restructure timing**: split `vpn-node` and `presto-vpn-node` with the core-only form before onboarding those companies (cheapest when the restructuring is ready by then), or onboard with components now and move later (§17.4)?
5. ~~**Merge owners without a release engineer**~~ **Decided 2026-10-07: the project's PM merges** (PM first) in companies with no release engineer (VPNProjects, Presto VPN). Profiles set `mergeOwners` to the PM; expect two PM runs per PR (hand-off and merge).
6. **Labels for frequent releases**: VPN-Node ships every few days, and each version needs a board-created label until S4. One label per node version (recommended while releases stay a few per week), coarser versions, or carry S4 in the fork so the plugin creates labels?
7. **Project keys** (permanent once used): `cle` (bare), `vpn`, `sz`, `sf`, `pre`, `onb`, later `node`, `pnode`.
8. **VPN Platform backend**: one deployable, or api/worker/admin deployed separately? Is there a staging environment?
9. **Presto**: exact monorepo paths; lockstep for mobile/api/admin (recommended at first); who builds and uploads mobile builds without a Mac environment (a Mac Fleet device, the board, or defer mobile versions)?
10. **VPN Node**: give QA release-test access, or let BackendEngineer verify NodeOps releases? Canary soak (default 24 h)?
11. **Trains**: one board approval per train (recommended) or per member; is backend → node → apps the right ship order; should "Start fleet" and "Prod deploy" need a board tap?

**Before Phase 1**

12. ~~**The v0.1 spike**~~ **Decided 2026-10-07: installed on prod now.** Plugin `paperclip.roadmap` 0.1.0 (read-only, 8 capabilities, no namespace) runs from `/paperclip/plugin-sources/roadmap`, plugin id `e7e0f620-d615-4e4c-b373-48c606588d20`. Phase 1a adds capabilities, so its upgrade waits for one operator approval (or a soft uninstall + reinstall like mac-fleet).

Phase 0 bug filing is no longer a question: the fork's Board policy decides it (§9).
