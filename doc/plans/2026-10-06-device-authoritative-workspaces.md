# Device-authoritative workspaces for SSH and Mac Fleet devices

- Date: 2026-10-06
- Status: Parts 0 and A implemented on 2026-10-06 (see section 11). Part B (Mac Fleet) is not started.
- Scope:
  - Core fork: `packages/adapter-utils`, `packages/adapters/claude-local`, `packages/shared`, `server`, `ui`.
  - `packages/plugins/mac-fleet` (its own nested repository), for Part B only.
- Related documents:
  - `doc/plans/2026-10-06-mac-fleet-duplex-channel.md`. That plan made Mac Fleet transfers cheaper. This plan removes the transfer for git-backed workspaces.

## 1. Why: measured on prod, 2026-10-06

**The setup:**
- Company: VPNProjects (`7a6a7811-…`).
- Agent: SecurezoneiOS.
- Environment: `mac-securezone` (`051374ed-…`).
  - Driver: `ssh`.
  - Connection: the runner tunnel `10.114.0.2:2201`.
  - `remoteWorkspacePath`: `/Users/mithatcolakel/Documents/Projects`. This is the user's own Mac and their real projects folder.
- `bernamanavmac` (port 2202, agent SecurefieldiOS) uses the same driver and has the same problems.

**What every run does today (copy mode):**
1. The server owns the worktree, for example `…/SecurezoneVPN/.paperclip/worktrees/VPN-146-…`.
2. `prepareRemoteManagedRuntime` (`packages/adapter-utils/src/remote-managed-runtime.ts:~121`) creates a new directory on the device for every run: `<remoteCwd>/.paperclip-runtime/runs/<runId>/workspace`.
3. `importGitWorkspaceToSsh` (`ssh.ts:~762`) uploads a bundle of the whole history reachable from HEAD.
4. `syncDirectoryToSsh` (`ssh.ts:~1316`) then uploads a tar of the whole tree.
5. After the run, `restoreWorkspaceFromSshExecution` (`ssh.ts:~1605`) pulls the history bundle and the whole tree back.
6. Nothing ever deletes the run directory.

**Measured runs (run logs):**

| Run | Git bundle up | Tree up | Tree back | Result |
|---|---|---|---|---|
| `503b0a78` 14:12Z | 159 MB | small | 324 MB | succeeded, 11 min, about 9 min of it transfer |
| `d9f9f7b4` 16:19Z | 159 MB | 1,918 MB (8 min) | failed at 6% of 2,114 MB | "Connection to 10.114.0.2 closed by remote host" |
| `33cdab8a` 16:37Z | 159 MB | 1,918 MB | — | `process_lost`: the server crashed at 16:45:45Z |
| `7c777d7f` 16:47Z | 159 MB | cancelled at 0% | — | cancelled by the operator |

**Why the tree grew to 2 GB.**
- Copy mode ignores `.gitignore`:
  - The upload excludes only `._*`, `.git` and `.paperclip-runtime` (`ssh.ts:~411`).
  - The pull-back excludes only `GIT_BACKED_WORKSPACE_BASELINE_EXCLUDES` (`remote-managed-runtime.ts:41`).
- The agent built SwiftPM packages on the Mac. The pull-back copied 1.8 GB of `.build/` into the server worktree: `SZFeaturePaywalls` 859 MB, `SZDesign` 800 MB and `SZAds` 151 MB.
- From then on, every run uploaded those build outputs and pulled them back.
- The sandbox lane already honours `.gitignore` (`sandbox-managed-runtime.ts:~1137-1165`). The SSH lane never got that fix.

**Other damage found on the same day:**
- **The device disk.** The Mac held 31 run directories totalling 25 GB, and its disk was 98% full.
- **An orphan process.** The `paperclip-bridge-server.mjs` of failed run `9fe6fd8e` was still alive 5.5 h later.
- **Cancel does not stop the transfer.** After `POST /heartbeat-runs/:id/cancel`, the server's `tar | ssh` and the device's `tar -xf` kept running.
- **The whole server crashes when an SSH transfer drops.** This happened at 12:06Z and again at 16:45:45Z, each time with `Error: write EPIPE … Unhandled 'error' event` on a Socket. The cause: nothing listens for errors on `ssh.stdin`:
  - `streamLocalFileToSsh`, `ssh.ts:~689`.
  - `syncDirectoryToSsh`, `ssh.ts:~1408`.
  - The crash kills every run on the instance, in every company.

## 2. The structural problem

Paperclip treats every execution environment as disposable compute, and the server worktree as the only authoritative copy. That fits ephemeral sandboxes such as Daytona, E2B or Cloudflare, where nothing survives the lease. It does not fit a persistent device:
- **Heavy transfers.** Each run moves the full history and the full tree twice over a home uplink.
- **No build cache.** The Xcode and SwiftPM caches are thrown away every run, so every run is a cold build.
- **No session resume.** The per-run directory changes the cwd, so Claude session resume never matches (`claude-local/src/server/execute.ts:~779-789`).
- **Work can be lost.** Work that exists only on the device is lost when the pull-back fails. In run `d9f9f7b4`, the only copy sat in a run directory. In run `d86bbf50`, an agent created a local branch that was never restored.

Upstream already has the right idea in a partial form: `WorkspaceRealizationMode = "copy" | "in_place"` (commit `4e0081857`, "support in-place workspace realization (#10230)"). Today, though:
- Only a sandbox-provider plugin can produce `in_place` (`server/src/services/workspace-realization.ts:~186-199`). The SSH driver never produces it (`environment-runtime.ts:~1174-1227`).
- Only Codex honours it (`codex-local/src/server/execute.ts:~632, ~795-823`). Claude ignores it.
- There is a latent bug: for an SSH target in `in_place` mode, the orchestrator sets `executionTarget.remoteCwd` but not `spec.remoteCwd` (`environment-run-orchestrator.ts:~546-551`).
  - `overrideAdapterExecutionTargetRemoteCwd` then returns early because the top-level value already matches (`execution-target.ts:~512`).
  - The agent process runs `cd spec.remoteCwd` (`ssh.ts:~1296`), which is the wrong directory.

## 3. Goals and acceptance criteria

1. **A per-run transfer of at most 5 MB.** This applies once the issue's worktree exists on the device. Only runtime assets move: skills, MCP config and the Claude config seed.
2. **The first run of an issue uploads nothing from the server.** The device fetches from GitHub itself.
3. **Build caches survive between runs of the same issue.**
4. **A dropped device connection never crashes the server.** It fails only that run.
5. **Cancel stops the device-side transfer and the agent processes within 10 s.**
6. **The server view stays correct for pushed work.** After each run, close readiness, the workspace diff and file browsing reflect the pushed branch.
7. **Device disk stays bounded.**
   - Per-run runtime directories are removed at run end.
   - The worktree is removed when the execution workspace is archived.
   - Realize refuses to start when free disk is critically low.
8. **No regression.** Copy mode stays the default for every environment that does not opt in.
9. **Company boundaries hold.** A device directory is keyed by company and execution workspace, and an environment serves only its own company.

## 4. Part 0: stop the bleeding in copy mode (ship first, independent)

### 0.1 No server crash on a dropped SSH stream (P0)

- In `streamLocalFileToSsh`, `syncDirectoryToSsh` and `syncDirectoryFromSsh` (`packages/adapter-utils/src/ssh.ts`), attach `error` listeners to:
  - `ssh.stdin`
  - `ssh.stdout`
  - `tar.stdin`
  - `tar.stdout`
- Route each one to the existing `fail()`.
- Add `-o ServerAliveInterval=15 -o ServerAliveCountMax=4` to the transfer `ssh` arguments.
- **Test:** kill the `ssh` child in the middle of a transfer. The promise rejects, the run fails with a transport error, and the process stays alive.
- **Before starting:** a separate task was suggested after the 12:06Z crash. Check whether it already landed.

### 0.2 Honour `.gitignore` in the SSH lane

- **Upload (git-backed workspace):** stream the file list from `git ls-files -z --cached --others --exclude-standard` (minus deleted paths) into `tar --null -T -`, instead of tarring `.`.
- **Pull-back:** build the same list on the device, so ignored output never returns.
- **Reuse:** take the sandbox lane's logic and `SANDBOX_WORKSPACE_HEAVY_DIR_EXCLUDES` (`sandbox-managed-runtime.ts:61-66`). The two lanes then share one rule.
- **Test:** a fixture repo with an ignored `.build/` of 50 MB. Neither direction moves it.

### 0.3 Clean up the per-run device directory

- **After a successful restore, or after a cancel before the agent started:** `rm -rf <remoteCwd>/.paperclip-runtime/runs/<runId>`.
  - Guard the run ID with `^[a-zA-Z0-9_-]+$`, like `githubOperationLauncherDirectory` does.
- **After a failed restore:** keep the directory, because it may hold the only copy of the work.
  - Record `remoteRunDir` and `restoreFailed: true` in the lease metadata.
  - Add a warning in the run log naming the path.
- **On process exit:** kill the processes that belong to the run. Start the remote agent with `setsid` so it has its own process group, and kill that group when the run ends.

### 0.4 Cancel reaches the transfer

- Thread an `AbortSignal` from the run's cancellation into:
  - `prepareRemoteManagedRuntime`
  - `restoreWorkspace`
  - the SSH stream helpers
- When the signal fires, kill `tar` first and let `ssh` close on EOF. Killing `ssh` first is what produces the EPIPE in 0.1.

## 5. Part A: device mode for SSH environments

### A.1 Configuration

- Add `workspaceMode: "copy" | "device"` (default `"copy"`) to `SshEnvironmentConfig` in these places:
  - The type: `packages/shared/src/types/environment.ts:14-23`.
  - The strict zod schema: `server/src/services/environment-config.ts:40-69`.
  - The UI form: `ui/src/pages/CompanyEnvironments.tsx`, next to "Remote workspace path" (~2303).
- **Recommendation:** device mode should use a dedicated root such as `~/PaperclipDevice`, not the user's own projects folder.
  - The UI shows a warning when the root contains non-Paperclip entries.

### A.2 Layout on the device

```
<root>/.paperclip-device/
  repos/<owner>__<repo>/                      one clone per repository (shared object store)
  worktrees/<companyId>/<executionWorkspaceId>/  git worktree on the issue branch (authoritative)
  runtime/<runId>/claude/{skills,mcp-config,config-seed,config}   per-run assets, removed at run end
  locks/<executionWorkspaceId>.lock           holds the run ID while a run is active
```

- **Runtime assets live outside the worktree.** Copied Claude credentials must never sit inside a git worktree.
- This needs a new `runtimeRemoteDir` input on `prepareRemoteManagedRuntime`. Today assets always go under `<workspaceRemoteDir>/.paperclip-runtime/<adapterKey>`.

### A.3 Realize (SSH driver `realizeWorkspace`, `environment-runtime.ts:~1211-1227`)

In device mode, run one idempotent script over SSH. Its inputs come from `WorkspaceRealizationRequest.source` (`workspace-realization.ts:~131-141`):
- **`repoUrl`:** the project's `repoUrl`. If that is null, use the scrubbed origin of the server worktree (`readSanitizedOriginRemoteUrl`).
- **`branchName`:** the issue branch.
- **`repoRef`:** the resolved base, for example `origin/main`.

The script:
1. **Disk check.** Run `df -k <root>`. Below 3 GB free, fail with a clear error. Below 10 GB, warn in the run log.
2. **Lock.** Take the lock for the execution workspace. If a different run that is still live holds it, fail with `workspace_busy`.
3. **Clone.** Ensure the clone exists: `git clone --no-checkout <repoUrl>` the first time, `git fetch origin --prune` after that.
4. **Worktree:**
   - **If it is missing**, run `git worktree add -B <branch> <path> <start>`. `<start>` is `origin/<branch>` if the branch exists on origin; otherwise it is the base ref.
   - **If it exists and is clean**, and `origin/<branch>` is strictly ahead (someone else pushed), fast-forward with `git merge --ff-only`.
   - **If it exists but is dirty or has diverged**, leave it alone and log that state. The device is authoritative.
5. **Report.** Return `metadata.workspaceRealization = { mode: "in_place", authoritativeRoot: <worktree path> }` with an explicit `authoritativeRoot`.

**Unpushed commits on the server branch.** This happens, for example, when the issue ran in another environment earlier.
- Detect with `git rev-list origin/<branch>..HEAD` on the server.
- If there are any, ship only those commits as an incremental bundle (`git bundle create x <branch> ^origin/<branch>`, usually kilobytes) and fetch it on the device before step 4.

**One-time migration of an existing copy-mode issue:**
- If the server worktree has uncommitted, non-ignored changes, ship them once as `git diff HEAD --binary` plus a tar of the untracked files from `ls-files --others --exclude-standard`.
- Apply them on the device after the worktree is created.
- Record `migratedFromCopy: true` on the execution workspace, so it happens only once.

**Credentials (v1).**
- SSH runs use host-mode GitHub when there is no managed identity (`heartbeat.ts:~21254-21259`). The device uses its own `gh` auth, SSH agent, or the environment's `GH_TOKEN` env var.
- Realize runs before the managed launchers are staged. So in v1, device mode requires host-mode credentials.
- The environment "Test" probe runs `git ls-remote <repoUrl>` on the device, and realize fails with a clear message when it cannot read the repository.
- Managed-identity support, through the existing credential broker, is a follow-up.

**Fallback.** If the request has no git source (a plain-folder project), device mode falls back to copy mode and logs one warning line.

### A.4 Orchestrator fix

In `environment-run-orchestrator.ts:~546-551`, apply the `in_place` root through `overrideAdapterExecutionTargetRemoteCwd`, so `spec.remoteCwd` follows for SSH targets.

Add a test with an SSH target where `authoritativeRoot` differs from `remoteWorkspacePath`. The existing Codex SSH test hides the bug because its fixture already uses the same path (`execute.remote.test.ts:~586-606`).

### A.5 Claude adapter honours `in_place` (`packages/adapters/claude-local/src/server/execute.ts`)

Mirror Codex:
- **Workspace sync:** pass `syncWorkspace: mode !== "in_place"` to `prepareAdapterExecutionTargetRuntime` (~617-645).
- **Remote directories:** pass `workspaceRemoteDir: authoritativeRoot`, and the new `runtimeRemoteDir` (A.2).
- **Server-side directory:** keep `ensureAbsoluteDirectory(cwd)` (~215) on the server path. Never create the remote path on the server.
- **Log lines:** gate the "Syncing workspace…" and "Restoring workspace changes…" lines (~615, ~669, ~1366-1371).
- **Environment:** set `PAPERCLIP_WORKSPACE_REALIZATION_MODE` and `PAPERCLIP_WORKSPACE_AUTHORITATIVE_ROOT`, as Codex does (~961-962).
- **Bonus:** session resume starts working, because the cwd is stable per issue.

### A.6 Run end

1. **No workspace pull-back.** Only the asset `restore` hooks run.
2. **The device reports its state:**
   - HEAD
   - branch
   - the count of uncommitted, non-ignored files
   - the count of commits not on `origin/<branch>`

   The state is stored in the run result and in the execution workspace metadata (`deviceState`), with a one-line run-log summary, for example "pushed 3 commits; 2 files uncommitted on device".
3. **Push.** If there are new commits, `git push origin HEAD:refs/heads/<branch>` runs with the device's credentials.
   - It only ever pushes the issue branch, never the base branch.
   - This depends on decision 9.1.
4. **The server mirror follows.**
   - The server runs `git fetch origin <branch>`.
   - Then it runs `git merge --ff-only origin/<branch>` in its worktree, if the worktree is clean and HEAD is an ancestor.
   - This keeps the following correct for pushed work: close readiness (`execution-workspaces.ts:~791-930`), the delivery check (`~1377-1450`, which compares the PR head SHA with local HEAD), the workspace-diff plugin and file browsing.
   - If the server worktree is dirty (a legacy state), skip and warn.
5. **Device cleanup.** Remove `runtime/<runId>/` and release the lock.

### A.7 Server-side behaviour that changes in device mode

- **`refreshUnstartedWorktreeToBase`** (`workspace-runtime.ts:2536`) does `reset --hard` to a new base when the branch has no commits past base. That is harmless for the server mirror. The device applies the same rule itself in step A.3.4 (clean, no commits past base → fast-forward to the new base).
- **Close readiness** gets a new blocking reason, "device has unpushed or uncommitted work", from the last `deviceState`. This depends on decision 9.2.
- **Runtime services** (`ensureRuntimeServicesForRun`, `workspace-runtime.ts:~7469`) start on the server in the server worktree. In v1 they are skipped for device-mode targets, and the UI notes this.
- **Archiving** an execution workspace (`cleanupExecutionWorkspaceArtifacts`, `workspace-runtime.ts:~4010-4190`):
  - Over SSH, run `git worktree remove --force` on the device, plus `git branch -D <branch>` when the branch is pushed or merged.
  - If the device is offline, record `deviceCleanupPending` and retry on the next lease.
- **Moving an issue to another environment** requires the work to be pushed. The UI and the run log say so when `deviceState` shows unpushed work.

### A.8 Tests

- **Realize script:** in the SSH env-lab fixture (`ssh.ts` `startSshEnvLabFixture`), cover a fresh clone, reuse, an existing remote branch, a dirty worktree, diverged history, low disk and a held lock.
- **Transfer size:** the second run moves no workspace bytes. Assert that the git and tar transfer functions are not called.
- **Run end:** push, then the server fast-forward, then close readiness reflects the new HEAD.
- **Migration:** a server worktree with uncommitted changes, and server commits that are not on origin.
- **Claude adapter:** an `in_place` unit test mirroring the Codex test.
- **Orchestrator:** the `spec.remoteCwd` test from A.4.

## 6. Part B: Mac Fleet uses device mode

The Mac Fleet sandbox provider can already return `in_place` through its realize metadata. It goes through the sandbox driver, which calls `realizeWorkspace`.

- **`realizeWorkspace`** (`packages/plugins/mac-fleet/src/runner/provider.ts:~350-357`):
  - Read `params.workspace.metadata.workspaceRealizationRequest.source`.
  - Run the same realize script as A.3 under `runnerRoot`, which is required by `isUnder(root, cwd)` (~192, ~235).
  - Return `metadata.workspaceRealization = { mode: "in_place", authoritativeRoot }`.
- **Keep the clone outside the lease's `remoteCwd`.** `destroyLease` runs `rm -rf remoteCwd` (~246).
- **Share the code.** The realize script and the run-end script live once in `packages/adapter-utils` (shell text plus parsers), and both the SSH driver and the plugin use them.
- **Keep the delta tar sync** from the duplex plan only for plain-folder projects.
- **Open question:** the Mac Fleet devices need GitHub credentials (decision 9.4).

## 7. Rollout

1. **Part 0.**
   1. Implement and test.
   2. Build with `./build-patch.sh <sha>`.
   3. Deploy with `/opt/paperclip/deploy-when-no-run.sh <image>`.
   4. Check: no EPIPE crash under a forced SSH drop, no `.build/` in transfers, and no run directories left on the Mac after a run.
2. **Part A** behind `workspaceMode: "device"`.
   1. Change `mac-securezone` to a dedicated root (decision 9.3) and set `workspaceMode: "device"`.
   2. Verify on VPN-146:
      - The first run fetches from GitHub, and the server log shows no "Importing git history" or "Syncing workspace" lines.
      - The second run moves 5 MB or less.
      - The build is incremental.
      - The branch is pushed, and the server worktree fast-forwards.
   3. Then switch `bernamanavmac`.
3. **Part B** for Mac Fleet (TECHNOGRADE), after the duplex rollout is verified.
4. **Rollback:** set `workspaceMode` back to `"copy"`. The next run uses today's path. Work that was pushed from the device is on origin, and the server fast-forward picks it up.

## 8. Risks

- **A run starting on the device while the user also edits the same worktree.** The worktree lives in a Paperclip-only root, so the user is not expected to edit it. Document this.
- **Silent loss of unpushed device work** when a workspace is archived. Archiving refuses while `deviceState` shows unpushed or uncommitted work, unless the operator forces it.
- **Auto-push of agent work** to a shared remote. This is limited to the issue branch. See 9.1.
- **Network:** device mode moves the GitHub traffic to the device. That is the intended trade.

## 9. Decisions needed from the user

1. **Push at run end.** Should Paperclip push the issue branch automatically at run end (recommended), or rely on the agent to push?
2. **Unfinished work and close.** Should unpushed or uncommitted device work block closing the issue (recommended), or only show as a warning?
3. **Remote root for `mac-securezone`.** Should it move to a dedicated folder such as `~/PaperclipDevice` (recommended), instead of `~/Documents/Projects`?
4. **Credentials.**
   - v1 uses the device's own GitHub login (`gh auth` or an SSH key). Is that acceptable for both Macs?
   - Do the Mac Fleet devices have one?

## 10. Operator cleanup done on 2026-10-06 (for the record)

- **Runs:**
  - Retry run `7c777d7f` was cancelled; it was still uploading at 0%.
  - Its orphan server-side `tar` was stopped. Only `tar` was killed, to avoid the EPIPE crash.
  - The orphan `paperclip-bridge-server.mjs` from run `9fe6fd8e` was killed on the Mac.
- **Backups** are in `~/PaperclipRunBackups/2026-10-06/` on the Mac (161 MB):
  - `vpn146-duplicate-local-backup.bundle` holds 3 VPN-146 commits that existed only on the Mac. Its base is `6ee9dc5`. To recover: `git fetch <bundle> vpn146-duplicate-local-backup:vpn146-duplicate-local-backup`.
  - Patches and untracked files from 7 run directories with working changes: `changes.patch`, `untracked.tgz` and `info.txt` per run.
  - Every other run-directory HEAD was present on the server or on GitHub.
- **Deleted:**
  - All 31 run directories under `~/Documents/Projects/.paperclip-runtime/runs/`, about 25 GB.
  - The 5 `.build/` directories in the server worktrees: VPN-146 (3), VPN-5's nested SecurezoneVPN copy, and SecureField VPN-129. VPN-146 went from 2.0 GB to 162 MB.

## 11. Implementation status (2026-10-06)

The user accepted every recommendation in section 9:
- Push the issue branch at run end.
- Block closing a workspace while the device holds unpushed or uncommitted work.
- Use a dedicated device folder.
- Use the device's own GitHub login.

**Part 0** is in commit `fix(ssh): …` on `feat/device-authoritative-workspaces`:
- **Pipe errors:** every SSH transfer stream now has a pipe-error listener (`ssh.ts`). A dropped tunnel fails the transfer instead of crashing the server.
- **`.gitignore`:** ignored paths stay out of the upload and out of the pull-back. Local ignored paths come from `readGitWorkspaceSnapshot`, which keeps `.paperclip-repositories` in the transfer. Remote ignored paths are read on the host and filtered against the baseline. Long lists travel as `tar -X` files.
- **Cancel:** the upload's ssh process is registered in `runningProcesses` for the run (`execution-target.ts`), so cancel and shutdown stop it.
- **Cleanup:** after a successful restore, `removeRemoteRunScratchDir` (`remote-managed-runtime.ts`) removes the run's remote copy and stops processes still running from it. After a failed restore the copy is kept.
- **Keepalive:** SSH connections send `ServerAliveInterval=15`.

**Part A** adds device mode:
- **The device side** lives in `packages/adapter-utils/src/device-workspace.ts`:
  - Realize: clone or fetch, send an incremental bundle of server commits, create or fast-forward the worktree, and seed the server copy's uncommitted changes once (the server keeps a stash backup).
  - Finish: push the issue branch (never `main`, `master` or the remote default), fast-forward the server copy from an incremental bundle, and write `paperclip-device-state.json` into the server worktree's git dir.
  - Remove the worktree on archive.
  - Git on the device adds `gh auth git-credential` as an extra credential helper for github.com when `gh` exists.
- **Config:** `SshEnvironmentConfig.workspaceMode: "copy" | "device"`, in the shared type, the zod schema and the environment form ("Keep workspaces on the device").
- **SSH driver:** `realizeWorkspace` returns `in_place` with the device worktree as `authoritativeRoot`. This only happens for git-worktree workspaces with a branch; everything else stays in copy mode.
- **Orchestrator:** an in-place root now moves `spec.remoteCwd` too.
- **`prepareAdapterExecutionTargetRuntime`:** recognises a device root (`/.paperclip-device/worktrees/`). It skips the workspace sync, stages assets under `.paperclip-device/runtime/<runId>`, and runs the finish step before the asset restore. The Claude adapter logs the device path.
- **Close readiness:** blocks while the device state shows uncommitted or unpushed work. Archive (route and terminal-issue cleanup) removes the device worktree, and the device refuses while work is pending.

**Not done:**
- The device lock from A.2.
- Skipping runtime services for device workspaces (A.7).
- Part B (Mac Fleet).

**Tests:**
- `ssh-transfer.test.ts`, `device-workspace.test.ts` and `remote-managed-runtime.test.ts` all use a stand-in `ssh` plus real git and tar.
- A Claude adapter device-mode case.
- An orchestrator SSH in-place case.
