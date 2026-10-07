# Roadmap plugin for Paperclip

A Jira-like **Roadmap** for every company and project on the instance: the whole project flow on one page, with every task in exactly one lane. Version lanes come from task labels, so the plugin works for any project without setup.

Design: `doc/plans/2026-10-06-epics-and-versioned-releases.md` (revision 3, §3 Flow model, §10 The plugin). This package is **v0.1, the read-only first slice of Phase 1a**: no database tables, no migrations, no writes, no jobs, no agent tools, and no core changes.

## What v0.1 shows

| Where | What |
| --- | --- |
| Sidebar, Work section (both shells) | **Roadmap** link to `/<company>/roadmap`, active on every Roadmap route. |
| `/<company>/roadmap` | Header with a project switcher (All projects, or one project) and a **Flow \| List \| Overview** switch. It sticks to the top on desktop; on a phone it scrolls away so the host's menu bar stays usable. The URL keeps the choice, so links can be shared: `/roadmap/overview`, `/roadmap/flow?project=<id>`, `/roadmap/list?project=<id>` (plan §10.3). Links in the first v0.1 form (`/roadmap?project=<id>&view=<view>`) are rewritten to these. A bare `/roadmap` reopens the viewer's last project and view (browser storage), or the only project with versions. Overview always shows all projects. |
| Flow | A board with swimlanes. Each lane folds open and closed, and shows its status columns: Backlog, To do, In progress, In review, Blocked, Done (last 14 days). Cancelled tasks are only counted. The six columns share the lane width and stay aligned from lane to lane; all six fit from about 1280 px wide, and below that they scroll sideways inside the lane. The page never scrolls sideways. Lane headers show the key, the derived state, a progress bar and exact counts. Cards link to the task. |
| List | The same lanes as tables (on a phone, as cards), in "needs attention first" order. |
| Overview | One card per project: current version with progress, other versions, open/blocked/in-review counts, Ongoing, epics, release ops, hotfixes and routine health. A "No project" card counts tasks that have no project and lists routines whose runs have no project. |
| Project page → **Roadmap** tab | The project's lanes in one compact list, plus **Open Roadmap**. |
| Task page | A read-only chip **Version: mvp** (marked **inherited** when it comes from a parent task), **Hotfix**, **Epic** or **Release ops**. It is hidden for Ongoing tasks, routine runs and plugin operations. It links to the project's Roadmap. The chip runs the board's own classifier over the task and its parents, and stops at a parent in another project, so it always matches the board. |

On a phone (below 768 px) the lanes stack and each lane becomes a "needs attention first" list (Blocked, In review, In progress, To do, Backlog; Done folded into a count). Tap targets on the page are at least `--sz-44px`; the sidebar link keeps the host's row height.

The page keeps the last good data when a refresh fails and shows the error above it. It refreshes when the tab becomes visible again (at most every 30 s) and on **Refresh**.

## Label conventions

Labels are the source of truth. They are company-wide, so create each one once (`POST /api/companies/:id/labels` or the label picker).

| Label | Meaning |
| --- | --- |
| `v:<key>` | The task belongs to version `<key>`, for example `v:mvp`, `v:1.0`, `v:1.0.1`. Use at most one per task. Sub-tasks without their own `v:` label inherit the version of their nearest labelled ancestor (shown as "inherited"). A later project can prefix its keys, for example `v:onb-1.0`. Keys are matched without case: `v:MVP` and `v:mvp` are one version (shown with the lowercase spelling, and flagged under Label checks). |
| `type:epic` | An epic: an unassigned backlog task whose direct children are its stories. Epics are headers, not cards. A `v:` label on an epic is ignored. Label the stories instead. |
| `type:hotfix` | Urgent work. While open it sits in the **Hotfix** lane at the top. It still counts toward its version. |
| `type:bug` | Shown as a Bug marker on the card. |
| `release-ops` | Coordination work (build, QA, tag, merge window). It has its own lane and is never counted. |

Any task without a `v:` label is **Ongoing**: normal development outside the version flow.

## Lanes and rules

Lane order per project: **Hotfix → versions → Ongoing → Release ops → Routines**.

Each task is placed once. The first matching rule wins:

Plugin operations (`plugin:<key>:operation…` and the three legacy content-machine kinds) are left out first, as core lists do (plan F34).

1. `originKind = routine_execution` → **Routines** band. Its labels are ignored and it is never counted in a version.
2. `release-ops` → **Release ops**.
3. `type:epic` → epic header.
4. `type:hotfix` and still open → **Hotfix**.
5. A `v:<key>` label on the task, or inherited from a parent → that **Version** lane.
6. Everything else → **Ongoing**.

Version keys sort `mvp` first. Numeric keys follow in natural order, with a patch right after its base (`1.0`, `1.0.1`, `1.1`, `1.10`); a leading `v` is ignored (`v1.0` sorts with `1.0`). A pre-release suffix (`-rc1`, `-beta`, `-alpha.2`) sorts before the plain key and any other suffix after it (`mvp`, `mvp-2`, `mvp2`; `1.0-rc1`, `1.0`, `1.0-hotfix`). Other keys come next, then keys with a project prefix (`onb-1.0`); `mvp` and a bare `v` are never read as a prefix.

A version's state is derived from its tasks. It is **planned** when every open task is in backlog. It is **in development** when some open task is to do, in progress, in review or blocked. It is **done** when nothing is open.

Progress is `done / (total − cancelled)`. It counts only tasks that carry the `v:` label themselves, are not epics or ops tasks, and whose nearest countable parent (skipping epics, `release-ops` tasks and routine runs, which are never counted themselves) does not carry the same label. A copied label on a sub-task therefore never counts twice, and work under a `release-ops` tracking task that copies its `v:` label still counts. Epic progress counts the epic's direct children.

The **Routines** band lists each routine that ran in the last 30 days, with its last 5 run statuses and its last run time. A routine is flagged **failing** when its last two runs were cancelled or blocked. Plugins cannot read the `routines` table, so the band is built from routine executions.

**Label checks** below the header list tasks with two `v:` labels, `v:` labels that differ only in case, epics with a `v:` label, sub-tasks that only inherit a version, and open hotfixes without an assignee.

## Data and limits

- One data handler, `roadmap.snapshot` `{companyId, projectId?}`. With a `projectId` it returns that project's lanes. Without one it returns one summary per project.
- `roadmap.taskVersion` `{companyId, issueId}` serves the task chip. It walks parent tasks up to 8 levels.
- Reads go through `ctx.projects.list`, `ctx.agents.list` and `ctx.issues.list`, sequentially. Routine executions are read first, on their own (cap 1000). Then one list call is made per status, each keeping at most 2000 real tasks. The SDK cannot exclude routine runs from those calls, so each call asks for one extra row per routine run already known in that status, and routine runs do not use up the cap.
- In the overview, a status whose company-wide list is full is read again per project, so the cap applies per project. Tasks without a project only come from the company-wide list, so the "No project" numbers then read "at least".
- A list that comes back full is named on the page (with the projects concerned in the overview), and its counts are lower bounds. **The host returns tasks by priority, then by last activity, not by age**, so the tasks left out are lower-priority ones. The same holds for the routine list: past its cap, routines with a lower priority may be missing.
- Snapshots are cached in the worker for 15 s with single-flight. **Refresh** (page and project tab) bypasses the cache.
- The visible task set matches core lists: hidden, harness and conversation tasks are left out by the host, and plugin operations by the plugin. The host includes plugin operations whenever a list is filtered by project, so without this filter the project view and the overview would disagree.
- **Host bug worked around:** `ctx.issues.list` applies `offset` twice. `issueService.list` applies it in SQL, then `applyWindow` in `server/src/services/plugin-host-services.ts` applies it again, so every page after the first comes back empty. The plugin never pages. It reads from offset 0 and reports truncation.

### Core follow-ups (not in this package)

- Fix the double `offset` in `plugin-host-services.ts` `issues.list` (skip `applyWindow`, since SQL already windows the rows) and add a host-services test that pages with `offset > 0`.
- Forward `excludeRoutineExecutions`, `sortField: "updated"` and `updatedSince` through the SDK's `issues.list` (`packages/plugins/sdk/src/worker-rpc-host.ts` and the host handler). The Roadmap could then read real tasks without routine runs, the Done list newest first, and routine runs newest first within 30 days, instead of relying on caps.

## Capabilities

`companies.read`, `projects.read`, `agents.read`, `issues.read`, `ui.page.register`, `ui.sidebar.register`, `ui.detailTab.register`, `ui.action.register` (the task chip uses the `toolbarButton` slot).

Later phases add the database namespace, writes, jobs and agent tools. A version that adds capabilities waits in `upgrade_pending` until an operator approves it, or it is reinstalled (see Deploy).

## Styling

Host Tailwind does not compile plugin sources, so the UI uses inline styles with host tokens only, plus one scoped `<style id="rm-styles">` block for hover, focus, sticky and the phone breakpoint. Hex, rgb/hsl/oklch, raw px and numeric font sizes are not used, and every class is `rm-*`. `pnpm check:tokens` enforces this and checks every `var(--…)` name against `ui/src/index.css`. A test runs the same check.

## Develop

This package is **excluded from the root pnpm workspace** (`pnpm-workspace.yaml`). The prod overlay build requires the fork's `pnpm-lock.yaml` to be byte-identical to the official image's lockfile and installs with `--frozen-lockfile`. A workspace importer for this package would break one or the other. Do not commit lockfile changes for it.

Run the scripts from the package directory:

```bash
cd packages/plugins/roadmap
pnpm run build          # runs ensure-build-deps for the SDK first
pnpm run typecheck
pnpm run test
pnpm run check:tokens
```

On a fresh clone the package has no `node_modules` yet. To get them, temporarily remove the `!packages/plugins/roadmap` line from `pnpm-workspace.yaml` and run `pnpm install --filter @paperclipai/plugin-roadmap --no-frozen-lockfile`. Then restore both files with `git checkout pnpm-workspace.yaml pnpm-lock.yaml`. After that, `pnpm run preflight:workspace-links` at the root keeps the SDK and shared links current.

Install into a local dev instance (`pnpm dev`, board in `local_trusted` mode):

```bash
curl -X POST http://localhost:3100/api/plugins/install \
  -H 'content-type: application/json' \
  -d '{"packageName":"'"$PWD"'/packages/plugins/roadmap","isLocalPath":true}'
```

Then open `http://localhost:3100/<COMPANY-PREFIX>/roadmap`. The host watches local-path plugins and restarts the worker when `dist/` changes, so rebuild with `pnpm --filter @paperclipai/plugin-roadmap dev` while working.

## Deploy

The plugin deploys the same way as Mac Fleet: a tarball unpacked into the server's data volume and installed from a local path.

1. Pack it: `packages/plugins/roadmap/scripts/pack-deploy.sh`. This writes `dist-deploy/roadmap-plugin-<version>.tgz`, which contains a top-level `roadmap/` directory.
2. Copy the tarball to the server and unpack it inside the Paperclip container into `/paperclip/plugin-sources/roadmap`. Keep the previous build as `roadmap.prev`, and make the files readable by the container's `node` user.
3. **First install, or a version whose capabilities changed:** install it from that path. With a capability change, first soft-uninstall the old install (`DELETE /api/plugins/<id>`, no purge), then swap the files, then install. Do not use `POST /api/plugins/:id/upgrade` on v2026.1001.0, which can leave the worker stopped.

   ```bash
   curl -X POST https://<server>/api/plugins/install \
     -H 'content-type: application/json' -H 'authorization: Bearer <board token>' \
     -d '{"packageName":"/paperclip/plugin-sources/roadmap","isLocalPath":true}'
   ```
4. **Code-only update (same capabilities):** swap the directory. The host's file watcher restarts the worker. Hard-refresh the board so the new UI bundle loads.

Rollback: move `roadmap.prev` back into place, and reinstall if the capabilities differ.

## Not in v0.1

These come in later Phase 1a/1b slices (see the plan):

- version rows, lifecycle and readiness gates;
- the route sidebar and the Backlog and Version detail views;
- the card sheet and quick filters;
- the Needs-you strip and dashboard widget;
- moves, hand-out, PM planning and agent tools.

Known host limitation: the toolbar outlet keeps an empty slot container on task pages where the chip is hidden.
