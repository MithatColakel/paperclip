# Paperclip fork: upstream sync of 2026-11

> Fork release on top of upstream `master` at `d69631b01` (`beta/v2026.1023.0-beta.0`, which upstream's notes name as the source of the coming `v2026.1103.0`). Production still runs v2026.1012.0 plus patches (`deploy/2026.1012.0`), because the [sync of 2026-10-21](fork-upstream-sync-2026-10-21.md) never shipped. This note replaces that note's Upgrade Guide: production goes straight here.

This release merges 53 more upstream commits into the fork, on top of the 662 from the previous sync. The fork's own features (Claude account pool, devices and waits, Mac Fleet support, daily cap holds, dependency wakes, coordinator policy) are kept. For production it is mostly a database upgrade: every upstream migration since v2026.1012.0 runs at once. Read the whole Upgrade Guide before deploying.

## Breaking changes for operators

- **69 upstream migrations run on the first start.** They are `0306_familiar_titania` … `0374_rare_wolfpack`, followed by the fork's `0380_bored_ghost_rider`. They are forward-only and run one file at a time. Some take heavy locks:
  - `0312` rewrites seven tables to `numeric(24,7)` under ACCESS EXCLUSIVE locks;
  - `0309` locks `agents` and `projects`;
  - `0313` and `0314` backfill `heartbeat_runs`, `issues`, `execution_workspaces`, `workspace_operations` and `projects` in committed batches;
  - `0313`, `0332`, `0345` and `0369` build indexes `CONCURRENTLY`.

  A failure part-way leaves the database between versions. **Rolling back means restoring the database,** not redeploying the previous image.
- **Migrations need a direct database connection.** The runner holds a session advisory lock and runs `COMMIT` and `CREATE INDEX CONCURRENTLY` outside a transaction (doc/DATABASE.md).
- **The fork's migrations have new numbers again.** Production applied the first five as `0306`–`0310`. They are now `0375_faulty_the_executioner` … `0379_productive_veda`, with byte-identical SQL, and the runner recognises them by SHA-256.
  - **Never edit `0375`–`0379`.** A changed byte makes the runner treat the file as new. `0376`–`0378` would then stop the boot, and `0379` would silently rewrite account data.
  - `0380_bored_ghost_rider` has not been applied anywhere yet.
- **Use only Paperclip's migration runner on production:** the server's boot, `pnpm db:migrate`, or the rehearsal script. Never run `drizzle-kit migrate` or `drizzle-kit push`.
- **The overlay build as written would ship upstream's server.** The image now starts with `node server/dist-runtime/index.mjs`, a precompiled bundle. `Dockerfile.patch` overlays `server/dist` only, so a container built that way runs the base image's bundle with none of the fork's server code, against the fork's migrations. Before building:
  - rebuild the bundle in the overlay with `pnpm --filter @paperclipai/server build:runtime` and copy `server/dist-runtime`, or build with the repository Dockerfile;
  - make `build-patch.sh` fail unless the image's bundle contains fork code, for example by checking for `settleSupersededReusableLease`. Search all of `server/dist-runtime/*.mjs`: the bundle splits into chunks, and `index.mjs` alone never matches;
  - keep the base image equal to the source: `ghcr.io/paperclipai/paperclip:sha-d69631b`. The merged `pnpm-lock.yaml` is identical to upstream's at that commit.
- **New Claude agents stay on Legacy, and existing ones are not offered the Runner.** The account pool, device logins and usage-limit waits work only with `claude_local`. Upstream's "Upgrade runner" offer does not appear for them, and bulk editing does not change their connection. Codex, OpenCode and Pi follow upstream's automatic choice.
- **Upstream behavior that changes what people see** (from upstream's notes for `v2026.1103.0`):
  - agent-created tasks are hidden from task lists until "show agent-created tasks" is on, and Inbox "Mine" no longer includes automation you did not take part in;
  - `commentary:view` goes to every human role, including viewers, and startup re-grants it;
  - the run history API returns 200 rows by default and 1,000 at most, and Pipeline routes and `linkedCases` are gone (their tables stay);
  - a PATCH that replaces `executionPolicy` and sets `done` during a live review cycle returns `422 unexecuted_review_stage`;
  - run failures no longer reach Sentry unless `PAPERCLIP_SENTRY_RUN_FAILURES=unexpected` is set.
- **Workspace cleanup becomes more active.** Regenerable files in finished task trees are removed after one hour, and the reaper cooldown goes from 7 days to 1. Production sets neither variable today, so these defaults apply. Worktree expiry behind restore points stays off unless `PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED` and `PAPERCLIP_GIT_RESTORE_POINTS_ENABLED` are set; keep it off.

## What happens to open work

- Running runs are not cut. The cutover waits until none is running.
- Queued runs stay in the database and start after the restart.
- Monitors and routines due during the window fire after it.
- **Each open task's Claude session starts over once.** A session does not resume when its prompt bundle changed, and `skills/paperclip/` changed. Files, comments and documents stay; the conversation memory does not, and the agent spends tokens rebuilding context.
- Old wake requests are the remaining unknown. Rows on closed tasks and on interrupted runs sit idle on production today. The sweep that promotes orphaned deferred wakes skips done and cancelled tasks, as it does today, but other paths have not been proved to leave them idle. The dry boot below measures it.

## Upgrade Guide

Steps 1 to 4 run while production still runs the current image. Commands that read production settings must not print secrets. Do not build while another build runs on the droplet.

1. **Build the image** as described above.
2. **Check the database connection type.** In `/opt/paperclip/db.env`, look only at the host and port of `DATABASE_URL`. DigitalOcean's direct connection uses port `25060`. If it is a pool (`25061`), set `DATABASE_MIGRATION_URL` to the same cluster's direct URL and `DATABASE_PREPARED_STATEMENTS=false` for the runtime pool.
3. **Rehearse on a copy.** Follow step 2 of the [Claude account pool Upgrade Guide](fork-claude-account-pool.md#upgrade-guide) with the new image: a read-only `pg_dump` copy, a database name that contains `rehearsal` or `snapshot`, and `server/dist/scripts/ai-account-pool-rehearsal.js --snapshot`. Do not use a Paperclip built-in backup: it has no CHECK constraints. Do not copy the dump to a laptop.
   - **Expect** the 69 upstream migrations and `0380_bored_ghost_rider` as pending. None of `0375`–`0379` may be pending. If one is, stop.
   - **Record** the "Migrations: N applied in Xs" line, every constraint or trigger error, and the go/no-go. **The time it takes is the length of the maintenance window.**
4. **Dry boot on the copy, and try the Mac path.**
   - Start the new image against the migrated copy with the scheduler on, without `master.key` or `claude.env`, with another public URL, and with outbound network limited to the database. Compare open tasks with a list taken before the migration. No run may start on a done or cancelled task.
   - Rebuild the Mac Fleet plugin against the merged SDK, load it in a local dev instance, and do one real run on a Mac.
   - Drop the copy.
5. **Gate the cutover.**
   - Set `PAPERCLIP_MIGRATION_PROMPT=never`, and leave `PAPERCLIP_MIGRATION_AUTO_APPLY` unset. The new image then refuses to start while migrations are pending.
   - Set `PAPERCLIP_WORKSPACE_COMPACTION_ENABLED=false` and `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS=7` for the first week.
   - Save the list of open tasks, wait for 0 running runs, then stop the container. `deploy-when-no-run.sh` and `deploy-lock-drain.sh` swap the image in one go, so this needs a stop-only variant of their drain.
   - Note the managed database's point-in-time-restore timestamp.
6. **Migrate once, supervised.** Run `pnpm db:migrate` in a one-off container of the new image on the direct connection, and watch its log until it finishes.
7. **Start with agents off.** Start the new image with `HEARTBEAT_SCHEDULER_ENABLED=false`. Startup recovery, queued runs and timers stay off. Then check:
   - `GET /api/health`, the binding backfill report (`GET /api/instance/ai-accounts/migration`) and every plugin's status;
   - open tasks against the saved list;
   - a private task stays hidden from a member who cannot read it;
   - a new Claude agent is created as `claude_local`.

   This is the last cheap rollback point, because no agent has acted yet.
8. **Turn agents on.** Restart with the scheduler on and watch the first hour: one run on an SSH device and one on a Mac, and `memory.events` on the runner, because queued runs and due timers start together.

## Rollback

- **Before step 6,** start the previous image again. Nothing changed in the database.
- **After step 6,** restore the database to the timestamp from step 5, together with the previous image (`paperclip-patched:2026.1012.0-*`). Work done after that point is lost. Do not run the previous image on the migrated database.
- **After step 8,** a restore no longer undoes everything: git pushes, TestFlight uploads, Trello writes and production writes that agents made stay in place while the database forgets them. Prefer fixing forward.

## Follow-ups

- **Pin `0380` once it is applied.** Add its SHA-256 to `deployedForkMigrations` in `packages/db/src/fork-migration-receipts.test.ts`. From then on it is immutable like `0375`–`0379`.
- **Retire `deploy/2026.1012.0`.** Build production from `fork/main`, so hot fixes stop being backported by hand. Until then a production hot fix must land on both.
- **The decision e-mail branch** (`feat/email-decision-notifications`) moves its migration to the next free number (`0381` today) and regenerates its snapshot.
- **The next upstream sync renumbers the fork block again,** by renaming each file and its journal tag only. Generate the newest snapshot from upstream's newest one in a temporary folder: the SQL it would write must touch only the fork block's tables and drop nothing. Discard that SQL.
- **`packages/paperclip-runner/spec/capability/capabilities.yaml` has one fork row** (the board policy heading). Upstream's generator needs a private eval corpus, so at each sync its rows are moved to the merged skill files by heading, and `check-capability-inventory` must pass.

## Known residuals

These are unchanged from the [Claude account pool release](fork-claude-account-pool.md#known-residuals), for example: runs under one OS user on one device can read each other's environment.
