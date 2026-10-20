# SSH workspace sync: runs that stay `running` forever

- Date: 2026-10-20.
- Status: root cause found and reproduced; adapter-side fix and tests committed on `claude/pensive-moore-4c8765`, **not deployed**. The server-side safety net (§6) is a follow-up.
- Applies to: fork branch `deploy/2026.1012.0` at `45eb677`, every SSH execution environment (runner droplet and the Macs on reverse tunnels).
- Paths and line numbers below are from this branch after the fix unless marked "before".

## 1. Summary

An SSH workspace upload that loses its ssh process while the pipe is backed up never settles. The upload pipes `tar.stdout → progress counter → ssh.stdin`. When ssh exits, Node destroys `ssh.stdin`. The counter is unpiped and paused, and `tar.stdout` stays paused behind it. Paperclip SIGTERMs tar and tar exits, but its stdout never reads EOF, so tar never emits `close`. The transfer waits for that `close` forever.

The adapter's `execute()` promise is still pending, so the run stays in memory and its controller lease keeps renewing. The orphan reaper skips it, and the silent-run watchdog only reports. The run stays `running` with no process anywhere, and with `maxConcurrentRuns: 1` it blocks every later run of the agent.

The counter is in the pipe only when a progress sink is set. Production always sets one (claude-local passes `onProgress`), and the existing drop test did not, so the test suite never exercised the production pipe.

## 2. Evidence (a production run of an iOS agent on a Mac SSH environment, 2026-10-19)

- The last log line is `[paperclip] Syncing workspace to ssh: 10% (6.4/67.4 MB)` at 2026-10-19 11:08:53Z. There is no `failed at` line and no error.
- The run is still `running` 35 h later. Execution phase is `reconnecting / Confirming execution`, and permittedActions is only `inspect_run`.
- No ssh child is left in the server container, and no claude process runs on the Mac.
- ssh runs with `ServerAliveInterval=15`, `ServerAliveCountMax=4` (`packages/adapter-utils/src/ssh.ts:461`).

Each point matches the wedge:

- ssh exited; ServerAlive ends a stalled tunnel in about 60–75 s.
- tar was killed and reaped.
- The reporter only emits when bytes pass through the counter (`ssh.ts:650`, `runtime-progress.ts`). With the pipe frozen, no further line is written.
- `progress.fail()` runs only after the transfer promise rejects (`ssh.ts:2020-2022`), and it never rejects, so no `failed at` line appears.

## 3. Root cause

### 3.1 The wedge

Call path: claude-local `execute()` (`packages/adapters/claude-local/src/server/execute.ts:641`, `onProgress: (line) => onLog("stdout", line)`) → `prepareAdapterExecutionTargetRuntime` (`execution-target.ts:1454`) → `prepareRemoteManagedRuntime` (`remote-managed-runtime.ts:197`) → `prepareWorkspaceForSshExecution` (`ssh.ts:2266`) → `syncDirectoryToSsh` (`ssh.ts:1851`, label `workspace`). The git-backed path imports the bundle first, then also uploads the working tree with `syncDirectoryToSsh`. The `Syncing workspace` line comes from that tar upload.

Before the fix, `syncDirectoryToSsh` (before: `ssh.ts:1853-1921`):

1. `tar.stdout.pipe(progress.counter).pipe(ssh.stdin)` (before: `:1897`).
2. The tunnel stalls, ssh stops draining stdin, and backpressure pauses the counter and then `tar.stdout`.
3. ServerAlive gives up and ssh exits with 255. Node's child `onexit` destroys `ssh.stdin`. `pipe()` reacts to the destination's `close` by unpiping, and the counter, now with no destination, pauses with full buffers.
4. The ssh `close` handler SIGTERMs tar (before: `:1920`). tar exits, so `exit` fires, but `close` waits for tar's stdout to close. That stdout is paused because the counter will never drain, so it never reads EOF. Node's `flushStdio` resumes it once, and the pipe pauses it again on the next chunk.
5. `maybeFinish()` needs `tarExited`, which is set only in tar's `close` handler (before: `:1910`). The promise never settles.

Without the counter (`onProgress` unset), the same drop settles. After the unpipe, `tar.stdout` has no destination, `flushStdio` drains it to EOF, and tar's `close` fires. That is why the existing test `fails the transfer instead of crashing the process when ssh drops mid-upload` passed.

The restore direction (`syncDirectoryFromSsh`, `ssh.ts:2027`) has the mirror image of the bug. If the local `tar -xf` dies, the counter is unpiped from `tar.stdin`, `ssh.stdout` stays paused, and ssh never emits `close`.

A user's **Stop** during an upload hits the same wedge. `registerRunTransferProcess` (`execution-target.ts:1443`) exposes the upload's ssh child to cancellation, and killing it is exactly step 3. The existing cancel test also ran without a progress sink.

### 3.2 Reproduction

A standalone Node script on Node 25 with the same wiring: real `tar -cf -` of 20 MB, and a fake `ssh` that reads 4 KB, sleeps 1 s and exits 255.

| wiring | result |
|---|---|
| `tar.stdout → counter → ssh.stdin` | ssh exits; tar `exit` (SIGTERM); tar `close` **never**; `tar.stdout.readableFlowing=false` |
| `tar.stdout → ssh.stdin` | settles in about 1 s |
| counter, plus `tar.stdout.destroy()` on ssh `close` | settles in about 1 s; the success path is unchanged |

In the test suite (§5.3), the three new progress-sink tests time out at 15 s with the fix removed and pass with it.

## 4. Why nothing caught it

- **Orphan reaper** (`server/src/services/heartbeat.ts:19736`). It skips a run that is `locallyTracked`, meaning `runningProcesses` or `activeRunExecutions` has it (`:20017-20020`, `:20064`). The wedged in-process promise keeps the run in `activeRunExecutions`, and the dead ssh child stays in `runningProcesses` because it is unregistered only when the transfer settles. The reaper also skips a run with a live legacy controller lease (`:20065`).
- **Legacy controller lease** (`server/src/services/legacy-controller-lease.ts:104`). A 10 s `setInterval` renews it independently of the adapter promise, so a hung `execute()` keeps a valid lease forever. The lease proves the controller process is alive, not that the run makes progress.
- **Silent-run watchdog** (`server/src/modules/active-run-watchdog/application/use-cases.ts:299`, thresholds at `server/src/services/recovery/service.ts:180-182`). It finds runs silent for more than 5 min, but only counts and folds them. It never fails or stops a run.
- **Adapter timeout.** claude-local's `timeoutSec` bounds only the CLI child process (`runChildProcess`). The SSH branch of `prepareAdapterExecutionTargetRuntime` (`execution-target.ts:1516-1532`) does not pass it to the transfers. No deadline covers the phase before the agent process exists.
- **"Confirming execution"** (`server/src/services/execution-projection.ts:406-422`) is only a derived label. A legacy run without `processPid` and without a native lease shows it. Nothing acts on it.

## 5. The fix (this branch)

### 5.1 Un-wedge the pipes (root cause)

- `syncDirectoryToSsh`, ssh `close` handler (`ssh.ts:1999-2012`): if tar has not closed, SIGTERM it **and destroy `tar.stdout`**. Nothing can consume tar's output once ssh is gone, so destroying it loses no deliverable data, and tar's `close` then arrives.
- `syncDirectoryFromSsh`, tar `close` handler (`ssh.ts:2171-2182`): when the local tar failed and ssh is still up, kill ssh **and destroy `ssh.stdout`**.

**Rejected: `stream.pipeline()`.** It also un-wedges, but it reports `ERR_STREAM_PREMATURE_CLOSE` when a consumer exits right after the last byte, which is normal for tar. It then destroys the other stages with that error, which reaches the existing `onPipeError` listeners and SIGTERMs a healthy ssh. That could fail a successful restore. The destroy-on-close change touches only streams whose other end is already gone, so the success path behaves exactly as before.

### 5.2 Stall timeout on every SSH stream (defense in depth)

`watchTransferStall` (`ssh.ts:670-715`) fails a transfer when no byte has moved for `SSH_TRANSFER_STALL_TIMEOUT_MS` (5 min, overridable per call with `stallTimeoutMs`). ServerAlive only detects a dead connection. This catches a transfer that stops moving while ssh stays connected: a stuck remote reader, or a tunnel that still answers keepalives. The timer resets on every chunk and covers only the streaming window:

- `syncDirectoryToSsh`: from spawn until `ssh.stdin` finishes.
- `syncDirectoryFromSsh`: from spawn until `ssh.stdout` ends.
- `streamLocalFileToSsh` (git bundle import): until the bundle is handed over. The remote `git fetch`/checkout that follows moves no bytes and is not timed.
- `streamSshToLocalFile` (git bundle export): from the **first** byte, because the remote builds the bundle before sending anything.

A slow but moving home upload never trips it, because the gaps between chunks are seconds, not minutes. `streamLocalFileToSsh` now also closes its file stream when ssh exits.

### 5.3 Tests (`packages/adapter-utils/src/ssh-transfer.test.ts`)

- `settles a progress-reporting upload when ssh drops with the pipe backed up`: the production failure. It also checks that the `failed` progress line is written.
- `settles a progress-reporting upload when the registered transfer process is killed`: Stop during an upload.
- `settles a progress-reporting restore when the local tar dies mid-transfer`: the mirror case. The local copy stays untouched.
- `fails an upload that stops moving while ssh stays connected` and `fails a git history upload that stops moving while ssh stays connected`: the stall timeout.
- `keeps a slow upload going while its bytes keep moving` and `does not time the remote work that follows a git history upload`: no false positives.

With the two `destroy()` lines removed, the first three time out (15 s). With them, all 16 tests in the file pass.

## 6. Not fixed here: a server-side net for the pre-process phase

With §5, every SSH transfer settles: on success, on ssh failure, or on a stall. The general gap remains, though: any adapter promise that hangs before the agent process exists keeps the run `running` forever, for the reasons in §4. A proposed follow-up, which needs its own review because it touches `executeRun` invariants:

1. In `executeRun`, while a legacy run has no `processPid` and its `lastOutputAt` is older than N minutes (proposal: 30), abort the execution control with a `startup_stalled` reason. `runChildProcess` already refuses to spawn on an aborted signal, so a late transfer cannot start an agent afterwards.
2. If the adapter promise does not settle within a grace period after the abort, finalize the run as `failed` with `errorCode: "startup_stalled"` through `setRunStatusFromLive(…, ["running"])`. Then release the issue lock and environment lease, and drop the run from `activeRunExecutions` and `runningProcesses`. A late settle then finds the run terminal and cannot overwrite it.
3. Optionally, let the silent-run watchdog escalate a pre-process run (no `processPid`) instead of only reporting it.

Also worth a look in the same pass: `TransferProgress.finish()`/`fail()` await the progress sink (`ssh.ts:658-666`). A sink that never resolves would hold the transfer too. That was not the case here: the transfer itself never settled.

## 7. Operations: clearing a run that is already wedged

The fix does not touch runs that are already wedged; a cancel or a server restart clears them.

- **Board API cancel works.** claude-local never registers an adapter execution control, so `cancelRunInternal` takes the `runningProcesses` path (`heartbeat.ts:30608`, `:30712`). It signals the PID of the long-dead ssh child (ESRCH, treated as gone) and marks the run `cancelled`. PID reuse would need a wrap past `pid_max` (4,194,304 on current Ubuntu) within the run's lifetime, so it is very unlikely.
- Agent concurrency is counted from the database (`countRunningRunsForAgent`, `heartbeat.ts:17771`), so the cancel frees the agent's slot immediately.
- The wedged promise stays in server memory until the next restart. That is harmless: every late write is guarded on status `running`.
- The half-uploaded per-run directory `<remoteCwd>/.paperclip-runtime/runs/<runId>/` may remain on the Mac, because the cleanup in `prepareRemoteManagedRuntime` runs only when the upload rejects. It is safe to delete by hand.

## 8. Verification

- `pnpm exec vitest run packages/adapter-utils/src/ssh-transfer.test.ts`: 16/16 pass.
- With the fix lines removed, the three progress-sink tests time out; restored, they pass.
- `tsc --noEmit` in `packages/adapter-utils`: clean.
- Full `@paperclipai/adapter-utils` vitest project: 72 files, 1569 passed, 11 skipped.
- Not run: the full repo `pnpm -r typecheck` / `pnpm test:run` / `pnpm build`. The change is confined to `packages/adapter-utils/src/ssh.ts` and its test.
