# Codex fallback on a device (2026-11-20)

Owner ask (2026-11-20): some devices also have the owner's Codex account. When
Claude's quota runs out, the Paperclip Mac agent should use that device's Codex
account. Owner chose the automatic switch over a one-click button. This is the
one exception to the fork's no-failover rule (AGENTS.md, core rule 3).

Spec: [AI Connections, "Codex fallback on a device"](../connections/AI-CONNECTIONS.md#codex-fallback-on-a-device-fork).

## What changes

- Agent setting `runtimeConfig.codexFallback` (`GET`/`PUT /api/agents/:id/codex-fallback`,
  company admins), shown under the Claude account field on the agent's Runtime page.
- While the agent's Claude account (pool account or device login) is at its
  limit, a claimed Claude run moves to `codex_local` on the same device
  (`server/src/services/heartbeat-codex-fallback.ts`, policy in
  `codex-fallback-policy.ts`). Limit waits are woken and the hold lets them
  through. After the reset the next run is Claude again.
- The Codex adapter's `deviceCodexLogin` mode: no host credential shipped, the
  run's `auth.json` links to the device's `~/.codex/auth.json`, no copy-back to
  the server, CLI engine only.
- A Codex limit or an early failure blocks the fallback on that environment
  (`device_login_limits.codex_fallback_*`, migration `0384`), and the task waits
  for Claude as before.

## Rollout

1. Build the patched image from this branch on top of the live image's base
   (live: `2026.1106.0-08a1e72`), same path as the 11-15 combined image.
2. Back up the database, apply migration `0384` (three nullable columns and a
   check constraint; additive, so the old image keeps working on it).
3. Switch the container when no runs are in flight. Rollback: the previous
   image, no database restore.
4. Check on each Mac that Codex is installed and signed in (`codex login status`).
5. Turn the fallback on per agent (owner decides which agents and which Codex
   model). Only Claude agents whose default environment is a device (Mac Fleet)
   qualify, whether they use the device's own Claude login or a pool account.

## Not covered

- SSH environments and the Local environment (Codex there would use the
  server's own login).
- A wait that is already parked for the Claude reset is not re-checked when a
  Codex block ends; new runs of the agent use Codex again from then on.
