# Mac Fleet: duplex channel for the callback bridge, incremental sync, cancellation

- Date: 2026-10-06
- Status: Ready to implement. The work runs in a separate session; deploy follows after review.
- Scope:
  - `packages/plugins/mac-fleet` (this repo).
  - The Mac app in `~/Documents/Projects/paperclip-mac-agent` (a separate repo).
- Related documents:
  - `packages/plugins/mac-fleet/docs/plans/2026-10-05-mac-fleet-runner.md`. This plan is its "Phase C", made concrete.
  - `packages/plugins/mac-fleet/docs/plans/2026-10-04-mac-fleet.md`.
- Core Paperclip change: none needed. The host side already exists.

## 1. Why: measured on prod, 2026-10-06

The Cleanio company (prefix `CLE`, id `35f4ebee-b18f-441b-bf5e-f92f5be51c56`) is the first company that runs agents through the Mac Fleet sandbox provider.

The setup:
- Environment: "Mac: TECHNOGRADE MacBook Air", id `5afba1ee-c2ec-483b-b2b3-4973c3ea979b`. Driver is `sandbox`, `config.provider` is `mac-fleet`, and `reuseLease` is `true`.
- Device: `5f2e4a22-c265-4cb3-a4df-1ca942fa0a25`. It runs macOS 27.0.1, Xcode 27.0, Flutter 3.47.5 and Mac agent 0.6.0. The prod plugin is version 0.3.0.
- Agents on it: ReleaseEngineer, QAEngineer and FlutterEngineer.

**What works:**
- Lease acquisition.
- `realizeWorkspace` and exec.
- Claude Code CLI on the Mac, using the long-lived token from the Mac's vault.
- Xcode and Flutter commands.
- The run-log tail.

**What does not work well.**

### Problem 1: every agent API call takes about 10 s and often times out

The callback bridge runs in file mode (`queue_v1`). For each request from the agent, the host does about 5 execs on the Mac:

1. `listJsonFiles` (list)
2. `readTextFile` (read)
3. `writeTextFile` of the `.tmp` response (write)
4. `rename`
5. `remove`

Every exec goes through the Mac Fleet long-poll path: the hub queues the command, the Mac's poll picks it up, the Mac runs it, and the Mac posts the result. Each exec takes about 2 s, so one API call takes about 9–10 s.

The host timeout for one bridge iteration is 10 s. It is `DEFAULT_BRIDGE_ITERATION_TIMEOUT_MS` in `packages/adapter-utils/src/sandbox-callback-bridge.ts:57`. The gateway on the Mac also has a 30 s response timeout, `DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS` at line 28.

Observed in run `5672b16f-9bfd-42db-b10a-caa1442d0171` (ReleaseEngineer, CLE-48):
- `GET /api/agents/me` returned HTTP 200 after about 9 s.
- `POST /api/issues/:id/checkout` failed with `Sandbox callback bridge ... timed out after 10000ms`, `outcome: indeterminate`, HTTP 409.
- The server logs show 11 bridge timeouts in 12 minutes.

Two fixes were considered and rejected:
- **A longer timeout (60 s):** it stops the errors, but every call still costs about 10 s. A run with 30–60 calls loses 5–10 minutes to transport. Requests also serialize inside one run, so the 30 s gateway timeout can still fire. This is only a stopgap.
- **"Submit a job, then poll its status":** this is what `queue_v1` already does. Another status poll adds round trips on the same slow channel.

### Problem 2: every run uploads the whole workspace (about 268 MB, 11–15 min)

Run-log lines from three Mac runs:

| Run | Sync start | Sync end | Size |
|---|---|---|---|
| `5672b16f` (ReleaseEngineer) | 10:50:40Z | 11:04:16Z | 268.2 MB |
| `faca218a` (ReleaseEngineer) | 10:51:51Z | 11:07:27Z | 267.9 MB |
| `5c8e072b` (QAEngineer) | 10:57:47Z | 11:09:15Z | 267.9 MB |

The upload runs at about 330 KB/s, and parallel runs share that bandwidth. `reuseLease` does not help here: the host still uploads the full tree.

Most of the bytes are `assets/` (135 MB) and the git data (about 144 MB). Code and config are small: `lib/` is 4 MB, `ios/` is 1 MB.

### Problem 3: cancelling a run does not stop the Mac side

Run `faca218a` was cancelled at 10:52:50Z, but its upload went on until 11:07:27Z.

There is no cancel path anywhere:
- `RunnerHub` (`src/gateway/runner-hub.ts`) has none.
- The provider (`src/runner/provider.ts`) has none.
- The Mac app (`Sources/FleetCore/Runner/RunnerLoop.swift`, `CommandExecutor.swift`) has none.

### Problem 4: concurrent runs of one agent share one directory

With `reuseLease`, `remoteCwd` is `<runnerRoot>/<environmentId>/<agentId>` (`provider.ts`, `leaseFor`). Two runs of the same agent therefore write into the same directory. That is what happened with `faca218a` and `5672b16f` above.

The current mitigation is `runtimeConfig.heartbeat.maxConcurrentRuns = 1` on the three Mac agents.

### Problem 5: after about 25 minutes of bridge traffic, the Mac app can no longer start any process

From about 11:17Z on, every command failed on the Mac. The `mkdir` that `realizeWorkspace` runs failed 12 times with:

```
Could not create /Users/technograde/PaperclipRunner/<env>/<agent> on the Mac:
could not start /bin/mkdir: The operation couldn’t be completed. Bad file descriptor
```

The Mac stayed online (heartbeats kept arriving), so the failure is inside the runner's process spawning, in `CommandExecutor.run` (`Process.run()` throws).

The prod container restarted at 11:16Z, outside this work. That restart killed the in-flight Mac runs with `process_lost`.

The file bridge in file mode calls `listJsonFiles` about every 100 ms per run, and the run-log tail polls as well. One Mac therefore runs thousands of short commands per hour. Each command creates 2–3 `Pipe`s, and stdin uses the shared `FileHandle.nullDevice`.

Two likely causes:
- **Leaked descriptors.** Pipe read handles are never closed explicitly. A child that leaves a background process holding stdout prevents EOF, so `CappedCollector.wait(timeout: 2)` returns while the handle stays open.
- **A closed `/dev/null` handle.** The shared `FileHandle.nullDevice` gets closed, after which `posix_spawn` file actions fail with `EBADF`.

Immediate remedy: quit and reopen the Paperclip Mac Agent app on the Mac. This frees the descriptors. Part D is the real fix.

## 2. Goals and acceptance criteria

1. **API latency:** an agent API call from the Mac completes in under 0.5 s at p50 and under 2 s at p95. A full Cleanio run has zero bridge timeouts.
2. **Incremental sync:** the second run of the same agent on an unchanged workspace syncs in under 30 s. After a commit, only the changed files move.
3. **Cancellation:** cancelling a run stops its Mac-side processes and transfers within 10 s.
4. **Isolation:** two runs never share a working directory at the same time.
5. **Security:**
   - Paperclip still stores no device credential.
   - Every new connection is authenticated with the device key (MF1).
   - Company boundaries are enforced: an environment can use only a device of its own company.
6. **Fallback:** if a Mac does not support the new stream, or the channel fails, the host falls back to the file bridge. Today's behaviour must not regress.

## 3. Part A: duplex channel (priority 1)

### 3.1 What the host already provides (no core change)

**Plugin SDK hooks.** `packages/plugins/sdk/src/define-plugin.ts:483–509` defines four hooks:
- `onDuplexChannelOpen`
- `onDuplexChannelWrite`
- `onDuplexChannelStop`
- `onDuplexChannelClose`

**Types.** `packages/plugins/sdk/src/protocol.ts:1193–1300` defines:
- `PluginDuplexChannelOpenParams`: `hostRouteId`, `driverKey`, `companyId`, `environmentId`, `providerLeaseId` and `command: string[]`.
- `PluginDuplexChannelOpenResult`: `hostRouteId` and `workerSessionId`.
- `Write` (data is base64), `Stop` and `Close`. Close is keyed by `hostRouteId`, may arrive without `workerSessionId`, and is idempotent.
- The worker sends output to the host as notifications:
  - `ctx.duplexChannel.data(hostRouteId, workerSessionId, chunk)`
  - `ctx.duplexChannel.exit(hostRouteId, workerSessionId, exitCode, transportClosed?)`
- `encodeChannelBytes` and `decodeChannelBytes` convert bytes to and from base64 on the JSON-RPC hop only. The provider's own wire format should carry raw bytes.

**Reference implementation.** `packages/plugins/sandbox-providers/daytona/src/plugin.ts:2981–3075` and `src/duplex-command-stream.ts`. Daytona needs a PTY with `stty raw -echo`. The Mac can use plain pipes instead, which give a clean 8-bit stream with no PTY.

**Capability gates.** Both gates must be true:
1. The manifest sets `environmentDrivers[].sandboxCapabilities.duplexCommandStream: true`. This is an opt-in key. It also needs the verified worker verb `duplexChannelOpen`; see `SANDBOX_CAPABILITY_PREREQUISITE_METHODS` in `server/src/services/environment-runtime.ts`.
2. The instance setting `experimental.enableSandboxDuplexBridge` is `true`. **On prod it is `false`.** The setting applies to the whole instance. Before enabling it, check that no other sandbox provider declares duplex; on 2026-10-06 the only installed plugin was `paperclip.mac-fleet`.

**What the host does when both gates pass.** See `packages/adapter-utils/src/execution-target.ts` around lines 4429–4720.
- It launches the bridge gateway through the channel. The command comes from `buildDuplexGatewayLaunchArgv`: `sh -c 'exec env … node <entrypoint>'`.
- It runs the HTTP/2 bridge (`http2_v1`) over the channel's stdin/stdout.
- The agent gets `PAPERCLIP_API_URL=http://127.0.0.1:<port>`, served by that gateway.
- **Readiness handshake:** `DEFAULT_DUPLEX_READINESS_TIMEOUT_MS = 10_000` (line 3206). On timeout, nonce mismatch or protocol contamination, the host falls back to the file bridge. The Mac must therefore attach the stream within 10 s, and **stdout must carry only gateway frames**: diagnostics and stderr must not reach it.
- **Forward budget per request:** 30 s (`DEFAULT_DUPLEX_BROKER_BUDGETS`).

### 3.2 Transport design between the plugin and the Mac

The Mac only makes outbound connections. Caddy already sends `/mac-fleet/*` to the plugin worker's own Node HTTP server on port 3199 (`/opt/paperclip/Caddyfile`, `handle /mac-fleet/* { reverse_proxy paperclip:3199 }`). Caddy's `reverse_proxy` passes WebSocket upgrades through.

**Recommended transport: a persistent stream socket per device.**

- **Endpoint:** `GET /mac-fleet/v1/runner/stream` with a WebSocket upgrade.
  - The upgrade request carries the usual MF1 headers (`x-mf-device`, `x-mf-timestamp`, `x-mf-nonce`, `x-mf-signature`). The body hash is the hash of an empty body.
  - The gateway accepts the upgrade only if three checks pass: the signature is valid, the device is `active`, and the nonce is new.
  - Implementation: handle `server.on("upgrade")` in `src/worker.ts`, next to the existing `createServer`.
- **Why a persistent socket:** an open must not wait for a long-poll delivery, so the 10 s readiness window is safe.
  - Fallback: if the device has no open socket, the plugin dispatches a `stream.connect` command through the existing poll path, then waits up to about 6 s for the socket.
- **Message framing:** binary WebSocket messages, each with a small header:

  ```
  byte 0      : type  (1=open, 2=stdin, 3=stdout, 4=exit, 5=stop, 6=close, 7=ack/error)
  bytes 1..16 : channelId (UUID, 16 raw bytes)
  bytes 17..  : payload (raw bytes for stdin/stdout, UTF-8 JSON for open/exit/error)
  ```

  - `open` carries the payload `{ command: string[], cwd, env? }`. The plugin builds `cwd` from the lease's `remoteCwd`, and must check that it stays under `runnerRoot`.
  - `exit` carries the payload `{ exitCode: number|null, signal?: string }`.
  - A socket that drops sends `exit` with `transportClosed: true` to the host for every channel that was open on it.
- **Advertise support:** the Mac sends `x-mf-capabilities: stream-v1` on poll requests. The gateway stores this on the device record or in memory. `onDuplexChannelOpen` **fails fast with a clear error** when the device lacks the capability, and the host then falls back to the file bridge.
- **Backpressure:** send stdin/stdout in chunks of at most 64 KB. Watch `bufferedAmount` on the plugin side and await `send` on the Mac side. Make sure the bandwidth limiter (`Network/Bandwidth`) either applies to the stream or explicitly exempts it.
- **Keepalive:** a WebSocket ping every 20 s. Close the socket when the device is revoked (`RunnerHub.disconnect`).

### 3.3 Plugin changes (`packages/plugins/mac-fleet`)

1. **`src/gateway/stream-hub.ts` (new).** Holds the stream sockets per device and the channel registry, in two maps: `byRoute` (hostRouteId → entry) and `bySession` (workerSessionId → entry). It handles frame encode/decode, open/write/stop/close, and cleanup on socket loss.
2. **`src/worker.ts`:**
   - Handle `upgrade` for `/mac-fleet/v1/runner/stream`, using the existing MF1 verification from `src/gateway/signature.ts`.
   - Implement the four `onDuplexChannel*` hooks, following Daytona:
     - **Open:** parse `deviceId` from `providerLeaseId` (`mac-fleet://<deviceId>/…`) and check that `companyId` owns the device. Mint `workerSessionId = duplex-<uuid>` and register the channel before sending `open`, so no early stdout is lost. Forward stdout through `ctx.duplexChannel.data` and the exit through `ctx.duplexChannel.exit`.
     - **Write and stop:** act only when the exact `(hostRouteId, workerSessionId)` pair matches.
     - **Close:** idempotent, keyed by `hostRouteId`.
   - In `onShutdown`, close every channel.
3. **`src/manifest.ts`:** add `duplexCommandStream: true` to `sandboxCapabilities`, and bump the plugin version (for example to `0.6.0`).
4. **`src/runner/provider.ts`:** when a lease is released or destroyed, close the channels for that `providerLeaseId`, as Daytona does in `closeDaytonaDuplexChannelsForLease`.
5. **Tests:**
   - Unit tests with a fake WebSocket and a fake `ctx.duplexChannel`: open, data before the open reply, write, stop, close idempotency, close before the open reply, socket loss → `transportClosed`, a company mismatch is refused, and a device without the capability is refused.
   - An end-to-end test with a local echo process standing in for the Mac.

### 3.4 Mac app changes (`~/Documents/Projects/paperclip-mac-agent`)

1. **`Sources/FleetCore/Runner/StreamClient.swift` (new).**
   - Opens and keeps the `URLSessionWebSocketTask` to `/mac-fleet/v1/runner/stream`, with an MF1-signed upgrade request.
   - Reuses the signing code from `GatewayClient`, which keeps the "no third-party dependencies" rule in `Package.swift`.
   - Reconnects with backoff.
   - Sends `x-mf-capabilities: stream-v1` on polls.
2. **`Sources/FleetCore/Runner/StreamExecutor.swift` (new).**
   - For each `open` frame it starts a `Process` with stdin/stdout/stderr `Pipe`s.
   - It uses the same environment as `CommandExecutor.environment(for:credentials:extraPath:network:)`: vault credentials such as `CLAUDE_CODE_OAUTH_TOKEN`, the PATH shim and the network proxy.
   - stdout goes out as `stdout` frames.
   - **stderr goes only to a log file** under `PaperclipRunner/logs/`, never into the stream.
   - `stdin` frames are written to the process.
   - `stop` terminates the process tree (`CommandExecutor.terminateTree`). When the process exits, the executor sends `exit`.
   - The `cwd` must stay under the runner root.
3. **`RunnerLoop.swift`:** start the `StreamClient` together with the poll loop, and show stream status in `RunnerActivity`.
4. **Tests:** echo through `/bin/cat` (bytes round-trip unchanged, including `\r`, `\n` and `0x00`), stop or kill, exit codes, and stderr kept out of the stream.
5. **Release:**
   - Bump `AgentVersion`.
   - Tag a release in the app repo. The Release workflow builds it, the plugin's `src/releases.ts` fetches it, and Macs update at their next update check.
   - Alternatively, run `curl -fsSL https://paperclip.dgtist.com/mac-fleet/v1/install.sh | bash` on the Mac.

## 4. Part B: incremental workspace sync (priority 2)

1. Implement `onEnvironmentSyncIn` and `onEnvironmentSyncOut`, which gives the `nativeSyncIn`/`nativeSyncOut` capabilities.
   - The contract is in `packages/plugins/sdk/src/protocol.ts:735–790` (`PluginSyncFileMapping`: `sourcePath`, `targetPath`, `kind`, `mode`, `exclude`, `followSymlinks`).
   - Reference implementation: `packages/plugins/sandbox-providers/daytona/src/file-sync.ts`.
2. Use a manifest diff:
   1. The Mac returns `path`, `size`, `mtime` and optionally a hash for the target directory.
   2. The plugin compares this with the host tree.
   3. It sends only changed files, as one tar of the changes, and deletes removed files. It must honour `exclude`.
   - Carry the tar over the new stream socket rather than inside base64 JSON poll results.
3. With `reuseLease`, the directory stays on the Mac, so after the first run only diffs move.
4. Measure the transfer before and after (`bytesTransferred` in `PluginEnvironmentSyncResult`). The targets are in section 2.

## 5. Part C: cancellation and isolation (priority 2)

1. **Cancel:**
   - Add a `cancel` command (or a `stop` frame on the stream) and track running commands per lease or run.
   - On lease release or destroy, or when the run is cancelled, terminate the processes that run in that `remoteCwd`, including in-flight sync transfers.
   - `RunnerHub` needs an abort path for queued and in-flight commands.
2. **Isolation:** either
   - lock the directory in `acquireLease`, so a second lease for the same `<env>/<agent>` directory waits or is refused with a clear reason, or
   - key the reuse directory per execution workspace instead of per agent.

   After either fix, `maxConcurrentRuns` on the Mac agents can go back up.

## 5b. Part D: robust process spawning in the Mac app (priority 1, together with Part A)

Do this in `~/Documents/Projects/paperclip-mac-agent/Sources/FleetCore/Runner/CommandExecutor.swift`.

1. **Reproduce first.** In a test, run 5,000 short commands such as `/bin/echo` and `ls`, then check the open descriptor count of the agent process (`lsof -p <pid> | wc -l`, or `proc_pidinfo`). Also include commands that start a background child that keeps stdout open (`sh -c 'sleep 30 & echo ok'`).
2. **Fix descriptor hygiene:**
   - Never share `FileHandle.nullDevice`. Open `/dev/null` per process, or give stdin a fresh `Pipe` and close its write end.
   - After `waitUntilExit`, explicitly close every parent-side handle: `outPipe.fileHandleForReading`, `errPipe.fileHandleForReading`, and the stdin pipe ends. Do this even when the collector times out.
   - Make `CappedCollector` remove its `readabilityHandler` and close the handle on timeout.
3. **Surface the problem instead of failing silently:**
   - Report the agent's open descriptor count, and the last spawn error, in `RunnerActivity` and the inventory.
   - Add a Mac Fleet health check that warns at about 70% of `RLIMIT_NOFILE`.
   - On repeated `EBADF`/`EMFILE` spawn errors, restart the runner loop, or the whole agent through launchd, rather than failing every command.
4. **Raise the soft limit.** Call `setrlimit(RLIMIT_NOFILE)` at agent start to at least 4096. A launchd agent defaults to 256.
5. **Reduce the load.** Part A removes the 100 ms exec polling, and Part B removes the big tar uploads, so exec volume drops by orders of magnitude. Part D is still needed on its own.

## 6. Rollout

1. Commit the current uncommitted state first (see section 8).
2. **Mac app (Parts A and D):** implement, test, tag the release, and confirm the TECHNOGRADE Mac reports the new version and `stream-v1`.
3. **Plugin:** implement and test, then package with `packages/plugins/mac-fleet/scripts/pack-deploy.sh`.
   - Because the manifest capabilities change, **`scripts/deploy-worker.sh` is not enough** (see the warning at the top of that script). Install the package with `POST /api/plugins/install {"packageName": "<dir>", "isLocalPath": true}` after you copy it into the data volume. Confirm the upgrade path for an already installed plugin.
   - Do this only while no run uses a Mac Fleet environment: in-flight runner commands fail when the worker restarts.
4. **Turn on the instance flag:** set `experimental.enableSandboxDuplexBridge = true` on prod.
5. **Verify on Cleanio:**
   - The next ReleaseEngineer run log no longer shows the file-mode "Starting sandbox callback bridge" line, and shows the duplex channel open instead.
   - `checkout`, comment and status calls succeed in under 2 s.
   - The server logs show zero `callback bridge … timed out` errors.
6. **Rollback:**
   - Setting `enableSandboxDuplexBridge = false` sends runs back to the file bridge immediately.
   - For the plugin, inside the container: `cd /paperclip/plugin-sources && mv mac-fleet mac-fleet.bad && mv mac-fleet.prev mac-fleet`, then restart the worker.

## 7. Temporary settings applied on 2026-10-06 (review after the rollout)

- **ReleaseEngineer, QAEngineer, FlutterEngineer:**
  - `defaultEnvironmentId = 5afba1ee-…`.
  - `adapterConfig.engine = "cli"`. The Mac has no `claude-agent-acp`, and the ACP engine failed with `adapter_engine_unavailable`.
  - `runtimeConfig.heartbeat.maxConcurrentRuns = 1` (Problem 4).
- **Project Manager and TrelloIntake** still run in the "Local" environment, which is the prod container.
- **State at 11:29Z:**
  - The three Mac agents are in `error` status, because Problem 5 made every Mac run fail.
  - Cleanio has 11 active `stranded_assigned_issue` recovery actions owned by the board: CLE-13, 16, 17, 43, 48, 54, 60, 83, 84, 86 and 88.
  - After the fixes are deployed, clear the agents' errors (`POST /api/agents/:id/clear-error`), then resolve each recovery with `POST /api/issues/:id/recovery-actions/resolve` and `{outcome: "restored", sourceIssueStatus: "todo"}`. Resolve them one at a time, a few seconds apart, so the wakes do not starve the 10-connection DB pool.
- **The TECHNOGRADE Mac:**
  - It has 20 GB free disk, which is tight for three agent workspaces plus iOS builds.
  - It is a laptop running on battery. If the lid closes or it sleeps, runs stop.
  - It has only the iOS 27.0 simulator runtime, while the app's minimum is iOS 18.

## 8. Coordination and risks

- **Uncommitted work in progress:**
  - `packages/plugins/mac-fleet` is **not committed** on branch `deploy/2026.1001.0`, and its `dist/` was rebuilt at 2026-10-06 10:34Z.
  - The Mac app repo has uncommitted changes, including `GatewayClient.swift`, `AgentRuntime.swift` and `AgentVersion.swift`.
  - Another session may be editing these. Check before you start, and commit the current state.
- **PrestoVPN:** the session "PrestoVPN ajanları Runner'a taşı" may move PrestoVPN agents onto the Mac Fleet device "Esinti MacBook Air". It will hit the same problems until this plan lands.
- **Open questions to answer early:**
  - Can the plugin worker hold long-lived WebSocket connections on its own HTTP server through the plugin host restarts? A worker restart drops them; that case must map to `transportClosed`.
  - Does the readiness handshake (10 s) fit when the stream socket must first be opened through the poll path?

## 9. Implementation status (2026-10-06, end of the implementing session)

Implemented, tested and committed locally. Nothing is pushed, released or deployed; section 6 is still to do.

- **Plugin** (`packages/plugins/mac-fleet`, its own repository, branch `duplex-stream` from `claude-token-requests`): version 0.6.0, 83 tests, `tsc` clean.
- **Mac app** (`paperclip-mac-agent`, branch `duplex-stream` from `claude-token-requests`): version 0.8.0, 63 tests. The 0.7.0 Claude-token work found uncommitted is its own commit below.

| Part | Where | Notes |
|---|---|---|
| A: duplex channel | `src/gateway/stream-hub.ts`, `stream-protocol.ts`, `websocket.ts`, `src/runner/duplex.ts`; Mac `StreamClient.swift`, `StreamExecutor.swift` | Frame format as in 3.2, plus type 8 (stderr frames, only for channels opened with `stderr: "stream"`). The open fails fast for a Mac without `stream-v1`. Provider commands also use the socket when the Mac has one. |
| B: incremental sync | `src/sync/` | Paperclip ships finished tars plus opaque wipe-and-extract commands (no per-file contract), so the delta works on the tar: the receiver keeps the last tar per target, the sender sends COPY ops and literals, the receiver rebuilds and SHA-256-checks it, then the commands run unchanged. Files of 1 MB and more use content-defined chunks. Measured on a 180 MB shallow-clone tar: 0.9 MB on the wire unchanged, 9.3 MB after three commits. |
| C: cancel and isolation | `src/runner/provider.ts`, `runner-hub.ts`; Mac `CommandExecutor.swift` | Every release or destroy closes the lease's channels, cancels its commands and stops every process working in its directory; a receipt is returned once the Mac confirmed it. Concurrent runs of one agent get `<agent>.2`, … |
| D: process spawning | Mac `Spawner.swift` | posix_spawn with CLOEXEC_DEFAULT, per-child process groups, no shared /dev/null handle, descriptors closed by the reader thread; open-file limit raised; restart after repeated EBADF/EMFILE. 1,500+ commands leak no descriptor (test). |

Verified live on this Mac against a local gateway with a real 0.8.0 agent: the host's own `startAdapterExecutionTargetPaperclipBridge` selected `http2_v1` (ready in about 120 ms), ten agent API calls from the Mac took 2–13 ms each, a released lease with `cancelActiveWork` left no process behind, and sync moved 1 MB instead of 8.6 MB on the second run.

Found on the way and fixed in the same branches:
- Health checks reported a probe that could not run (the TECHNOGRADE Mac's spawn failures) as "Command Line Tools selected", "No iOS simulator runtime", "No Claude credential". Xcode 27 also dropped the Apple ID from its account list, so "No Apple ID in Xcode" showed for signed-in Macs.
- The app now checks again every 2 minutes while a check warns or fails, and on activation; "Check again" replaces "Report now" and its notice clears itself.

Rollout additions to section 6:
- Environments need `bridgeRequestTimeoutMs` of at least 10 minutes (new ones get 30) for native sync. Without it the host cuts sync RPCs at 30 s, so such leases keep the host's own transfer (`nativeFileSyncUnsupported`). Set it on the Cleanio environment `5afba1ee-…`.
- The Mac app release is v0.8.0 (0.7.0 was never tagged).
- After the agent update, `maxConcurrentRuns = 1` on the three Mac agents can be raised (Problem 4).
- This Mac's own background agent points at an App Translocation path that no longer exists (`launchctl` state "spawn scheduled"). Move the app to /Applications and press Start.
