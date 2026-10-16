import { describe, expect, it } from "vitest";
import { ENVIRONMENT_UNAVAILABLE_SCHEMA, PluginEnvironmentUnavailableError } from "@paperclipai/plugin-sdk";
import {
  classifyEnvironmentError,
  classifySshStderr,
  environmentWaitsEnabled,
} from "../services/resource-waits/classify.js";
import {
  deferredWhileAssignee,
  describeWaitShort,
  firstHoldMs,
  isAdmissionWait,
  resourceWaitJitterMs,
  waitDelayMs,
} from "../services/resource-waits/deferral.js";
import { resourceKeyOf } from "../services/resource-waits/episodes.js";
import {
  RESOURCE_WAIT_TIMINGS,
  accountWaitDeferral,
  environmentWaitDeferral,
  type ResourceWaitTarget,
} from "../services/resource-waits/types.js";
import { formatWaitDuration } from "../services/resource-waits/notify.js";

const now = new Date("2026-10-16T12:00:00.000Z");

/** An `execFile` failure of ssh, wrapped the way the lease orchestrator wraps it. */
function sshLeaseError(stderr: string, code: number | null = 255) {
  const execError = Object.assign(new Error(`Command failed: ssh -p 22 runner@host\n${stderr}`), { code, stderr, stdout: "" });
  return new Error(`Failed to acquire lease for environment "Runner" (ssh): ${execError.message}`, { cause: execError });
}

function envelope(unavailable: Record<string, unknown>) {
  return { schema: ENVIRONMENT_UNAVAILABLE_SCHEMA, unavailable };
}

describe("classifyEnvironmentError: driver envelopes", () => {
  it("finds an envelope three levels down a cause chain and in JSON-RPC data", () => {
    const rpcError = Object.assign(new Error("lease refused"), {
      code: -32000,
      data: envelope({ scope: "target", reason: "offline", retryable: true, targetKey: "d-1", targetLabel: "Build box", message: "The machine is asleep." }),
    });
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: rpcError }) });
    expect(classifyEnvironmentError(wrapped, { now })).toEqual({
      action: "wait",
      scope: "target",
      reason: "offline",
      source: "envelope",
      retryAfter: null,
      message: "The machine is asleep.",
      targetKey: "d-1",
      targetLabel: "Build box",
    });
  });

  it("keeps the admission scope and retryAfter of a typed error", () => {
    const retryAfter = new Date(now.getTime() + 60_000).toISOString();
    const error = new Error("lease", {
      cause: new PluginEnvironmentUnavailableError({ scope: "admission", reason: "busy", retryable: true, retryAfter }),
    });
    expect(classifyEnvironmentError(error, { now })).toMatchObject({
      action: "wait",
      scope: "admission",
      reason: "busy",
      retryAfter: new Date(retryAfter),
    });
  });

  it("turns retryable:false into a refusal that carries the driver's text", () => {
    const error = Object.assign(new Error("refused"), {
      data: envelope({ scope: "target", reason: "other", retryable: false, message: "This lease does not belong to this machine." }),
    });
    expect(classifyEnvironmentError(error, { now })).toEqual({
      action: "refuse",
      reason: "environment_refused",
      source: "envelope",
      message: "This lease does not belong to this machine.",
      targetLabel: null,
    });
  });

  it("ignores a malformed envelope and plain errors", () => {
    expect(classifyEnvironmentError(Object.assign(new Error("x"), { data: envelope({ scope: "target", reason: "not_allowed", retryable: true }) }), { now })).toBeNull();
    expect(classifyEnvironmentError(new Error("Something else went wrong"), { now })).toBeNull();
    expect(classifyEnvironmentError(null, { now })).toBeNull();
  });
});

describe("classifyEnvironmentError: SSH", () => {
  it.each([
    ["refused", "ssh: connect to host 10.0.0.5 port 22: Connection refused"],
    ["timed out", "ssh: connect to host mini.local port 2222: Operation timed out"],
    ["connection timed out", "ssh: connect to host mini.local port 2222: Connection timed out"],
    ["no route", "ssh: connect to host 10.0.0.5 port 22: No route to host"],
    ["unresolved host", "ssh: Could not resolve hostname nowhere.invalid: nodename nor servname provided, or not known"],
    ["banner timeout", "Connection timed out during banner exchange\r\nConnection to 127.0.0.1 port 2222 timed out"],
    ["connection to … timed out", "Connection to 10.1.2.3 port 22 timed out"],
  ])("waits on target scope when the host is unreachable (%s), without keeping stderr", (_, stderr) => {
    expect(classifyEnvironmentError(sshLeaseError(stderr), { now })).toEqual({
      action: "wait",
      scope: "target",
      reason: "unreachable",
      source: "ssh",
      retryAfter: null,
      message: null,
      targetKey: null,
      targetLabel: null,
    });
  });

  it.each([
    ["closed", "Connection closed by 10.0.0.5 port 22"],
    ["reset", "kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 10.0.0.5 port 22"],
    ["kex", "kex_exchange_identification: Connection closed by remote host"],
  ])("waits 30–60 s on admission scope when sshd throttles (%s)", (_, stderr) => {
    const low = classifyEnvironmentError(sshLeaseError(stderr), { now, random: () => 0 });
    const high = classifyEnvironmentError(sshLeaseError(stderr), { now, random: () => 1 });
    expect(low).toMatchObject({ action: "wait", scope: "admission", reason: "throttled", source: "ssh", message: null });
    expect(low?.action === "wait" && low.retryAfter?.getTime()).toBe(now.getTime() + RESOURCE_WAIT_TIMINGS.throttledMinMs);
    expect(high?.action === "wait" && high.retryAfter?.getTime()).toBe(now.getTime() + RESOURCE_WAIT_TIMINGS.throttledMaxMs);
  });

  it("leaves configuration errors and other exit codes alone", () => {
    expect(classifyEnvironmentError(sshLeaseError("runner@host: Permission denied (publickey)."), { now })).toBeNull();
    expect(classifyEnvironmentError(sshLeaseError("Host key verification failed."), { now })).toBeNull();
    expect(classifyEnvironmentError(sshLeaseError("ssh: connect to host 10.0.0.5 port 22: Connection refused", 1), { now })).toBeNull();
    expect(classifyEnvironmentError(sshLeaseError("ssh: connect to host 10.0.0.5 port 22: Connection refused", null), { now })).toBeNull();
    expect(classifySshStderr("Permission denied (publickey).\r\nConnection closed by 10.0.0.5 port 22")).toBeNull();
  });
});

describe("classifyEnvironmentError: provider plugin lifecycle", () => {
  it("waits 30 s while the provider plugin's worker restarts", () => {
    const error = new Error(
      'Failed to acquire lease for environment "Mini" (sandbox): Sandbox provider "box" is installed via plugin "acme.box", but its worker is not running.',
    );
    expect(classifyEnvironmentError(error, { now })).toMatchObject({
      action: "wait",
      scope: "admission",
      reason: "restarting",
      source: "plugin_lifecycle",
      retryAfter: new Date(now.getTime() + RESOURCE_WAIT_TIMINGS.restartingMs),
    });
  });

  it("waits while the plugin's upgrade is pending, and keeps error and disabled as configuration", () => {
    const pending = new Error('Sandbox provider "box" is installed via plugin "acme.box", but that plugin is currently upgrade_pending.');
    expect(classifyEnvironmentError(new Error("lease", { cause: pending }), { now })).toMatchObject({
      action: "wait",
      scope: "admission",
      reason: "plugin_upgrade_pending",
      retryAfter: null,
    });
    for (const status of ["error", "disabled"]) {
      const error = new Error(`Sandbox provider "box" is installed via plugin "acme.box", but that plugin is currently ${status}.`);
      expect(classifyEnvironmentError(error, { now })).toBeNull();
    }
    // The permanent "not installed" message is not a restart window.
    expect(classifyEnvironmentError(new Error('Sandbox provider "box" is not installed or its plugin worker is not running.'), { now })).toBeNull();
  });
});

describe("kill switch", () => {
  it("turns every environment classification off", () => {
    expect(environmentWaitsEnabled({})).toBe(true);
    expect(environmentWaitsEnabled({ PAPERCLIP_ENVIRONMENT_WAITS: "on" })).toBe(true);
    expect(environmentWaitsEnabled({ PAPERCLIP_ENVIRONMENT_WAITS: "off" })).toBe(false);
    expect(environmentWaitsEnabled({ PAPERCLIP_ENVIRONMENT_WAITS: " OFF " })).toBe(false);
    const offline = Object.assign(new Error("x"), { data: envelope({ scope: "target", reason: "offline", retryable: true }) });
    expect(classifyEnvironmentError(offline, { now, enabled: false })).toBeNull();
    expect(classifyEnvironmentError(sshLeaseError("ssh: connect to host h port 22: Connection refused"), { now, enabled: false })).toBeNull();
    const refused = Object.assign(new Error("x"), { data: envelope({ scope: "target", reason: "other", retryable: false }) });
    expect(classifyEnvironmentError(refused, { now, enabled: false })).toBeNull();
  });
});

describe("wait timing and labels", () => {
  const base: ResourceWaitTarget = environmentWaitDeferral({
    reason: "offline",
    scope: "target",
    environment: { id: "e-1", name: "Runner" },
    device: { id: "d-1", name: "Build box" },
  }).wait;
  const hold = (wait: ResourceWaitTarget, checks = 0) => firstHoldMs({ wait, episode: { checks }, runId: "run-1", now, random: () => 0.5 });

  it("holds target waits briefly and doubles admission backoffs per episode, capped by the gate interval", () => {
    expect(hold(base)).toBe(RESOURCE_WAIT_TIMINGS.minHoldMs);
    const notAllowed = { ...base, reason: "not_allowed" as const, scope: "admission" as const };
    expect(hold(notAllowed, 0)).toBe(5 * 60_000);
    // 10 min and beyond would exceed the 5 min gate interval: the hold re-checks every 5 min.
    expect(hold(notAllowed, 1)).toBe(RESOURCE_WAIT_TIMINGS.gateIntervalMs);
    const other = { ...base, reason: "other" as const, scope: "admission" as const };
    expect(hold(other, 0)).toBe(60_000);
    expect(hold(other, 2)).toBe(240_000);
    expect(hold({ ...other, retryAfter: new Date(now.getTime() + 45_000) }, 3)).toBe(45_000);
    expect(hold({ ...base, reason: "busy", scope: "admission" })).toBe(60_000);
    expect(hold({ ...base, reason: "restarting", scope: "admission" })).toBe(30_000);
  });

  it("keeps the uncapped admission backoff for the episode: 5 min doubling to 60 min, `other` 60 s doubling to 10 min", () => {
    const delay = (wait: ResourceWaitTarget, checks: number) => waitDelayMs({ wait, episode: { checks }, runId: "run-1", now, random: () => 0.5 });
    const notServing = { ...base, reason: "not_serving" as const, scope: "admission" as const };
    expect([0, 1, 2, 3, 4, 5].map((checks) => delay(notServing, checks) / 60_000)).toEqual([5, 10, 20, 40, 60, 60]);
    const other = { ...base, reason: "other" as const, scope: "admission" as const };
    expect([0, 1, 2, 3, 4, 5].map((checks) => delay(other, checks) / 1000)).toEqual([60, 120, 240, 480, 600, 600]);
    expect(delay({ ...notServing, retryAfter: new Date(now.getTime() + 2 * 3_600_000) }, 0)).toBe(2 * 3_600_000);
    expect(isAdmissionWait(notServing)).toBe(true);
    expect(isAdmissionWait(base)).toBe(false);
  });

  it("waits for a limit's reset and re-checks other account and slot waits every 60 s ± 20 %", () => {
    const limit = accountWaitDeferral({
      reason: "usage_limit",
      accountId: "a-1",
      accountLabel: "Max-2",
      resumeAt: new Date(now.getTime() + 90_000),
      resumeAtSource: "provider",
    }).wait;
    expect(hold(limit)).toBe(90_000);
    expect(hold({ ...limit, reason: "auth_unconfirmed", resumeAt: null })).toBe(RESOURCE_WAIT_TIMINGS.gateIntervalMs);
    expect(hold({ ...limit, reason: "signed_out", resumeAt: null })).toBe(60_000);
    expect(firstHoldMs({ wait: { ...limit, reason: "signed_out", resumeAt: null }, episode: { checks: 0 }, runId: "r", now, random: () => 1 })).toBe(72_000);
  });

  it("spreads resumes per run, stable for one run", () => {
    const first = resourceWaitJitterMs("2c0b7c44-4f5e-4b8f-9b51-0d2f0f6f3f11");
    expect(first).toBe(resourceWaitJitterMs("2c0b7c44-4f5e-4b8f-9b51-0d2f0f6f3f11"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(120_000);
    const spread = new Set(Array.from({ length: 20 }, (_, index) => resourceWaitJitterMs(`run-${index}`)));
    expect(spread.size).toBeGreaterThan(10);
  });

  it("keys episodes by resource and never names a hidden account", () => {
    expect(resourceKeyOf(base)).toBe("environment:e-1");
    const hidden = accountWaitDeferral({ reason: "owner_not_member", accountId: "a-1", accountLabel: "Max-2" }).wait;
    expect(hidden.accountLabel).toBeNull();
    expect(resourceKeyOf(hidden)).toBe("account:a-1");
    expect(resourceKeyOf({ ...hidden, accountId: null })).toBe("account:none");
    expect(describeWaitShort(base)).toBe("Waiting for device Build box (offline)");
    expect(formatWaitDuration(45 * 60_000)).toBe("45 min");
    expect(formatWaitDuration(3 * 3_600_000 + 12 * 60_000)).toBe("3 h 12 min");
    expect(formatWaitDuration(52 * 3_600_000)).toBe("2 d 4 h");
  });
});

describe("assignee-ship of a deferred run", () => {
  it("comes from the authority the admission gate recorded, not the issue", () => {
    expect(deferredWhileAssignee({ runnerProfileJson: null, scheduledRetryReason: null, contextSnapshot: {} })).toBe(true);
    expect(deferredWhileAssignee({ runnerProfileJson: { aiConnectionNonAssigneeCommentWake: true }, scheduledRetryReason: null, contextSnapshot: {} })).toBe(false);
    expect(deferredWhileAssignee({ runnerProfileJson: { aiConnectionNonAssigneeCommentWake: false }, scheduledRetryReason: null, contextSnapshot: {} })).toBe(true);
    // A non-assignee wait that defers again stays non-assignee.
    expect(deferredWhileAssignee({ runnerProfileJson: null, scheduledRetryReason: "environment_wait", contextSnapshot: { resourceWaitDeferredWhileAssignee: false } })).toBe(false);
    expect(deferredWhileAssignee({ runnerProfileJson: null, scheduledRetryReason: "workspace_busy", contextSnapshot: { workspaceBusyDeferredWhileAssignee: false } })).toBe(false);
    expect(deferredWhileAssignee({ runnerProfileJson: null, scheduledRetryReason: "environment_wait", contextSnapshot: { resourceWaitDeferredWhileAssignee: true } })).toBe(true);
  });
});
