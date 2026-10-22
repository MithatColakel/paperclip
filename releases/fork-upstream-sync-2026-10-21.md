# Paperclip fork: upstream sync of 2026-10-21

> Fork release on top of upstream `master` at `8b873e011` (the
> `v2026.1021.0-nightly.0` / `v2026.1021.0-canary.5` build, not a stable
> release). The previous image is fork commit `c4cdbfeb2`
> (tag `fork-snapshot-20261021`), on top of v2026.1012.0.

This release merges 662 upstream commits into the fork. The fork's own
features (Claude account pool, devices and waits, Mac Fleet support, daily cap
holds, dependency wakes) are kept. The upgrade is mostly a database upgrade:
production gets every upstream migration since v2026.1012.0 at once. Read the
whole Upgrade Guide before deploying.

## Breaking changes for operators

- **65 upstream migrations run on the first start.** They are
  `0306_familiar_titania` … `0370_flimsy_lord_tyger`, followed by the fork's
  `0376_bored_ghost_rider`, which widens the company pool members' provider
  CHECK to every AI provider (it adds `google` and `github`). They are
  forward-only and run one file at a time.
  Some take heavy locks:
  - `0312` rewrites seven tables to `numeric(24,7)` under ACCESS EXCLUSIVE
    locks;
  - `0309` locks `agents` and `projects`;
  - `0313` and `0314` backfill `heartbeat_runs`, `issues`,
    `execution_workspaces`, `workspace_operations` and `projects` in committed
    batches;
  - `0313`, `0332`, `0345` and `0369` build indexes `CONCURRENTLY`.

  A failure part-way leaves the database between versions. **Rolling back
  means restoring the database,** not redeploying the previous image. The
  previous image does not know the new column types, triggers and
  constraints.
- **Migrations need a direct database connection.** Upstream's runner holds a
  session advisory lock on a reserved connection, and it runs `COMMIT` and
  `CREATE INDEX CONCURRENTLY` outside a transaction (doc/DATABASE.md,
  "Apply these migrations through `pnpm db:migrate` using a direct
  connection"). Behind a transaction-mode pool, the lock can leak. A boot
  that retries then waits on it.
- **The fork's migrations have new numbers.** `0306_faulty_the_executioner` …
  `0310_productive_veda` are now `0371` … `0375`, with byte-identical SQL.
  - Production applied them under the old numbers.
  - Paperclip's runner recognises them by the SHA-256 of their content, so it
    does not run them again.
  - **Never edit `0371`–`0375`.** A changed byte makes the runner treat the
    file as new. `0371`–`0374` would then stop the boot, and `0375` would
    silently rewrite account data.
- **Use only Paperclip's migration runner on production.** That means the
  server's boot, `pnpm db:migrate` (`packages/db/src/migrate.ts`) or the
  rehearsal script. Never run `drizzle-kit migrate` or `drizzle-kit push`.
  drizzle's stock migrator orders by timestamp: it would skip about 48
  upstream migrations silently, then fail on `0371`.
  `packages/db/drizzle.config.ts` refuses both unless `DATABASE_URL` names a
  database on this machine. `PAPERCLIP_DRIZZLE_KIT_ALLOW_REMOTE=true`
  overrides that for a database that is not production.
- **The overlay build needs the matching upstream image.** The production
  overlay build (`build-patch.sh`) compares the fork's `pnpm-lock.yaml` with
  the base image's `/app/pnpm-lock.yaml` and stops on any difference. The
  merged lockfile is upstream's at `8b873e011`, so `BASE_IMAGE` must be the
  official image built from that commit. Otherwise build with the full
  Dockerfile.
- **New Claude agents stay on Legacy.** Upstream now picks Paperclip Runner
  automatically for new agents, but the fork's Claude account pool, device
  logins and usage-limit waits work only with `claude_local`.
  - A new Claude agent stays on Legacy unless Paperclip Runner is chosen
    explicitly.
  - Codex agents follow upstream's automatic choice.

## Upgrade Guide

Steps 1 to 3 run while production still runs the current image. Commands that
read production settings must not print secrets.

1. **Build the image.**
   - Set `BASE_IMAGE` to the official image built from `8b873e011`, then run
     `build-patch.sh <short-sha of the merge commit>`. Its lockfile
     comparison must pass.
   - If the base image's lockfile differs only by its resolution refresh,
     commit that copy, as fork commit `4d7a4ef24` did for v2026.1012.0.
     Otherwise build with the repository Dockerfile.
2. **Check the database connection type.** In `/opt/paperclip/db.env`, look
   only at the host and port of `DATABASE_URL`.
   - DigitalOcean's direct connection uses port `25060`.
   - A connection pool uses port `25061` and the pool's name as the database.

   If it is a pool:
   - set `DATABASE_MIGRATION_URL` to the same cluster's direct URL;
   - set `DATABASE_PREPARED_STATEMENTS=false` for the runtime pool (doc/DATABASE.md).
3. **Rehearse on a copy.** Follow step 2 of the
   [Claude account pool Upgrade Guide](fork-claude-account-pool.md#upgrade-guide)
   with the new image: a read-only `pg_dump` copy, a database name that
   contains `rehearsal` or `snapshot`, and
   `server/dist/scripts/ai-account-pool-rehearsal.js --snapshot`.
   - Do not use a Paperclip built-in backup: it has no CHECK constraints.
   - **Expect** the 65 upstream migrations and `0376_bored_ghost_rider` as
     pending. None of `0371`–`0375` may be pending. If one is, stop: the
     copy's ledger does not match production's, or a file changed.
   - **Record** the "Migrations: N applied in Xs" line, every constraint or
     trigger error, and the go/no-go.
   - **The time it takes** is the length of the maintenance window.
4. **Gate the cutover.**
   - In the production environment set `PAPERCLIP_MIGRATION_PROMPT=never`, and
     leave `PAPERCLIP_MIGRATION_AUTO_APPLY` unset. The new image then refuses
     to start while migrations are pending ("Refusing to start against a stale
     schema") instead of migrating by itself.
   - Stop the current container with `deploy-when-no-run.sh`, which waits
     until no `heartbeat_runs` row is `running`.
   - Note the managed database's point-in-time-restore timestamp, or take a
     `pg_dump`.
5. **Migrate once, supervised.**
   - Run `pnpm db:migrate` in a one-off container of the new image, with
     `DATABASE_MIGRATION_URL` (or `DATABASE_URL`) on the direct connection.
     Watch its log until it finishes.
   - Alternatively, boot once with `PAPERCLIP_MIGRATION_AUTO_APPLY=true` while
     tailing the logs, then remove the variable.
6. **Start the new image.** Then check:
   - `GET /api/health`;
   - the binding backfill report (`GET /api/instance/ai-accounts/migration`);
   - every plugin's status (`GET /api/plugins/:pluginId`: `status`,
     `version`, `lastError`). The Mac Fleet plugin is built against the fork
     SDK; check that its worker is `ready` and that a Mac takes a run;
   - one run on Local, one on an SSH device and one on a Mac;
   - a private task stays invisible on the Decisions desk and on Company
     settings → Devices to a member who cannot read it;
   - a new Claude agent is created as `claude_local`.

## Rollback

- **Before step 5,** start the previous image again. Nothing changed in the
  database.
- **After step 5,** restore the database to the timestamp noted in step 4,
  together with the previous image (fork commit `c4cdbfeb2`). Work done on
  the new image after the restore point is lost. Do not run the previous image
  on the migrated database.

## Follow-ups

- **The decision e-mail branch** (`feat/email-decision-notifications`) was
  written before this sync. Its migration `0311_spicy_epoch` must be
  renumbered to the next free number after the merged journal's last entry
  (`0377` today), and its snapshot regenerated. Do this before it is committed
  onto the merged `fork/main`.
- **Pin `0376` once it is applied.** After production applies
  `0376_bored_ghost_rider`, add its SHA-256 to `deployedForkMigrations` in
  `packages/db/src/fork-migration-receipts.test.ts`. From then on the file is
  immutable like `0371`–`0375`.
- **The next upstream sync renumbers the fork block again.** Upstream `master`
  already has its own `0371_furry_red_shift`.
  - The fork's `0371`–`0376` move behind upstream's last migration by renaming
    each file and its journal tag only. Their content stays byte-identical,
    and the receipts test checks it.
  - They are never regenerated.

## Known residuals

These are unchanged from the
[Claude account pool release](fork-claude-account-pool.md#known-residuals),
for example: runs under one OS user on one device can read each other's
environment.
