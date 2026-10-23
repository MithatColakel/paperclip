import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

// Mock the shared logger, so a retirement test reads the exact error the
// manager logs. The child logger returns the same mock object.
vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { logger } from "../middleware/logger.js";
import {
  createDuplexRouteSlotController,
  createPluginWorkerHandle,
  createPluginWorkerManager,
  type PluginWorkerHandle,
  type WorkerHandleEvents,
  type WorkerStatus,
} from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DUPLEX_CHANNEL_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-duplex-channel.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

function makeDuplexHandle(extra?: Record<string, unknown>) {
  return createPluginWorkerHandle("test.plugin", {
    entrypointPath: DUPLEX_CHANNEL_WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    ...extra,
  });
}

// The test directive rides in `providerLeaseId`, an opaque field the manager
// forwards to the worker unchanged. The duplex channel is generic, so the
// command is a plain fixed string with no allowlist.
function duplexOpenInput(directive: unknown, companyId = "company-1") {
  return {
    driverKey: "daytona",
    companyId,
    environmentId: "env-1",
    providerLeaseId: JSON.stringify(directive),
    command: "bridge-callback",
  };
}

describe("plugin worker manager duplex channel route", () => {
  it("fails closed and retires the worker on a forged worker session id", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          // The frame carries the bound host route id but a forged worker session
          // id, so its pair matches no live route.
          data: [{ chunk: "forged", sid: "ws-EVIL" }],
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // The forged pair is an ownership violation. The host reaches no listener and
      // retires the worker, so the wait settles with the fixed non-secret null exit.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual([]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("fails closed and retires the worker on a forged host route id", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          // The frame carries the bound worker session id but a forged host route
          // id, so its pair matches no live route.
          data: [{ chunk: "forged", rid: "duplex-route-forged" }],
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual([]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("routes input to the worker and back to the listener", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", echoInput: true }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      session.write(new TextEncoder().encode("callback-payload"));
      // The worker echoes the input as one data notification for the bound
      // session, so the listener receives it.
      await vi.waitFor(() => expect(chunks).toContain("echo:callback-payload"));
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("buffers early data in order until a listener attaches and drains it in order", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          data: [{ chunk: "one" }, { chunk: "two" }, { chunk: "three" }],
          exitCode: 0,
        }),
      );
      // The worker writes the three data notifications and the exit in one
      // stdout write. The host reads worker stdout line by line, so it buffers
      // all three data frames before it reads the exit. The exit settles the
      // wait, so the wait is a deterministic barrier: once it resolves, the
      // host holds all three frames and no listener has attached yet. This
      // barrier replaces a fixed sleep, so the test does not race the
      // subprocess start or the stdio latency.
      await session.wait();
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      expect(chunks).toEqual(["one", "two", "three"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("isolates a throwing listener during live delivery so later chunks still route", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [{ chunk: "ok-1" }, { chunk: "boom" }, { chunk: "ok-2" }],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      // The listener throws on one chunk. The manager catches the throw, so it
      // does not escape the worker stdout notification handler. The later chunk
      // still routes and the route still settles.
      session.onData((chunk) => {
        const text = new TextDecoder().decode(chunk);
        chunks.push(text);
        if (text === "boom") throw new Error("listener failure");
      });
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      expect(chunks).toEqual(["ok-1", "boom", "ok-2"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("carries a transport-close exit through to the wait result", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // Batch the exit with the open response to exercise the pre-bind hold
          // and prove its normalized representation retains the discriminator.
          batchWithOpenReply: true,
          workerSessionId: "ws-A",
          data: [{ chunk: "one" }],
          // The worker reports a reason-less transport close with no exit code.
          transportClosed: true,
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // The discriminator survives the worker exit notification, so the host wait
      // resolves with the transport-close mark and no exit code.
      await expect(session.wait()).resolves.toEqual({ exitCode: null, transportClosed: true });
      expect(chunks).toEqual(["one"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("isolates a throwing listener during the buffered replay so every buffered chunk routes", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          data: [{ chunk: "one" }, { chunk: "boom" }, { chunk: "three" }],
          exitCode: 0,
        }),
      );
      // The worker writes the three data notifications and the exit in one
      // stdout write. The host reads worker stdout line by line, so it buffers
      // all three data frames before it reads the exit. The exit settles the
      // wait, so the wait is a deterministic barrier for "the host holds every
      // pre-bind frame and no listener has attached". This barrier replaces a
      // fixed sleep, so the test does not race the subprocess start or the
      // stdio latency.
      await session.wait();
      const chunks: string[] = [];
      // The listener throws on one buffered chunk. The manager catches the throw
      // inside the drain, so it does not escape `onData` and every buffered chunk
      // still routes.
      expect(() =>
        session.onData((chunk) => {
          const text = new TextDecoder().decode(chunk);
          chunks.push(text);
          if (text === "boom") throw new Error("listener failure");
        }),
      ).not.toThrow();
      expect(chunks).toEqual(["one", "boom", "three"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("binds the worker session id one time and ignores a duplicate open reply", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          mode: "duplicate-open-reply",
          workerSessionId: "ws-A",
          data: [{ chunk: "hello" }],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // The duplicate open reply never rebinds or reopens the route, so the
      // session runs normally on the one bind.
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      expect(chunks).toEqual(["hello"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("terminalizes and fails closed on a malformed open reply, then admits a later open", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      await expect(
        handle.openDuplexChannel(duplexOpenInput({ mode: "malformed-open" })),
      ).rejects.toThrow("DUPLEX_CHANNEL_OPEN_FAILED");
      // The terminalize closed the route by the host route id and the worker
      // acknowledged the close, so a later open is admitted.
      const session = await handle.openDuplexChannel(duplexOpenInput({ mode: "normal" }));
      expect(session).toBeDefined();
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("routes two concurrent cross-company duplex routes by the exact pair with no cross-talk", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const routeA = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", data: [{ chunk: "a-1" }], exitCode: 0 }, "company-A"),
      );
      const routeB = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-B", data: [{ chunk: "b-1" }], exitCode: 0 }, "company-B"),
      );
      const aChunks: string[] = [];
      const bChunks: string[] = [];
      routeA.onData((chunk) => aChunks.push(new TextDecoder().decode(chunk)));
      routeB.onData((chunk) => bChunks.push(new TextDecoder().decode(chunk)));
      await expect(routeA.wait()).resolves.toEqual({ exitCode: 0 });
      await expect(routeB.wait()).resolves.toEqual({ exitCode: 0 });
      // The host routes each frame by the exact pair, so each route receives only
      // its own data. Neither route sees the other's chunk.
      expect(aChunks).toEqual(["a-1"]);
      expect(bChunks).toEqual(["b-1"]);
      await routeA.close();
      await routeB.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("reports an explicit route-busy result when the aggregate ceiling is full", async () => {
    // A process-scoped ceiling of one slot. The manager injects one shared
    // controller into every worker; the test injects a small one directly.
    const handle = makeDuplexHandle({ duplexRouteSlots: createDuplexRouteSlotController(1) });
    try {
      await handle.start();
      const first = await handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-A" }));
      // The ceiling is full, so the second open rejects with the fixed route-busy
      // error before it reaches the worker. An active channel never downgrades.
      await expect(
        handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-B" })),
      ).rejects.toThrow("DUPLEX_CHANNEL_ROUTE_BUSY");
      // Closing the first route releases its slot, so a later open is admitted.
      await first.close();
      const third = await handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-C" }));
      await third.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops a late frame for a tombstoned pair and keeps the worker for a new open", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const first = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", emitAfterCloseChunk: "after-close" }),
      );
      const chunks: string[] = [];
      first.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // Close the route. The host installs the tombstone atomically before the slot
      // frees. The worker then emits one late frame for the closed pair.
      await first.close();
      // Give the late frame time to arrive. The host drops it, so it reaches no
      // listener and does not retire the worker.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(chunks).toEqual([]);
      // The worker is still alive: a new open on the same worker succeeds and
      // delivers its own data.
      const second = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-B", data: [{ chunk: "b-1" }], exitCode: 0 }),
      );
      const secondChunks: string[] = [];
      second.onData((chunk) => secondChunks.push(new TextDecoder().decode(chunk)));
      await expect(second.wait()).resolves.toEqual({ exitCode: 0 });
      expect(secondChunks).toEqual(["b-1"]);
      await second.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // The five explicit bounds. Each bound ends the route when it is exceeded.
  // -------------------------------------------------------------------------

  it("ends the route when the post-bind buffered bytes pass the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedChars: 10 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // Hold these frames until the fixture acknowledges a host write. A
          // write can only come from the returned session, so this makes the
          // post-bind path deterministic instead of depending on pipe batching.
          emitScriptedFramesAfterFirstWrite: true,
          data: [
            { chunk: "aaaaa" }, // total 5 → buffered
            { chunk: "bbbbb" }, // total 10 → buffered
            { chunk: "ccccc" }, // total 15 > 10 → end route
          ],
        }),
      );
      session.write(new TextEncoder().encode("emit"));
      // No listener attaches, so the post-bind data buffers. The cumulative bytes
      // pass the bound and the route ends. The channel wait resolves with a null
      // exit code.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the pre-bind buffered frame count passes the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedFrames: 2 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          data: [{ chunk: "a" }, { chunk: "b" }, { chunk: "c" }],
        }),
      );
      // No listener attaches, so the data buffers. The third frame passes the
      // frame-count bound and the route ends.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the pending request count passes the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPendingRequests: 2 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "no-write-reply", workerSessionId: "ws-A" }),
      );
      const waitResult = session.wait();
      // The worker never replies to a write, so each write stays pending. The
      // third write passes the pending-request bound and the route ends.
      session.write(new TextEncoder().encode("one"));
      session.write(new TextEncoder().encode("two"));
      session.write(new TextEncoder().encode("three"));
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the pending host-to-worker write bytes pass the route bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPendingWriteBytes: 10 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "no-write-reply", workerSessionId: "ws-A" }),
      );
      const waitResult = session.wait();
      // The worker never replies to a write, so each write's bytes stay charged
      // against the route. The second write brings the cumulative bytes past
      // the 10-byte bound and ends the route.
      session.write(new TextEncoder().encode("aaaaa")); // 5 bytes → 5, under the bound
      session.write(new TextEncoder().encode("bbbbbb")); // 6 bytes → 11 > 10, ends the route
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("returns the pending write bytes to the route bound after a failed write", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPendingWriteBytes: 10, openTimeoutMs: 100 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "no-write-reply", workerSessionId: "ws-A" }),
      );
      let routeEnded = false;
      session.wait().then(() => {
        routeEnded = true;
      });
      // The worker never replies, so each write's own request times out and
      // rejects. The rejection must release this write's charged bytes, the
      // same as a reply would. Wait past the first write's timeout before the
      // second write sends.
      session.write(new TextEncoder().encode("12345678")); // 8 bytes, under the 10-byte bound
      await new Promise((resolve) => setTimeout(resolve, 200));
      // If the first write's bytes had not released on its timeout, this
      // second 8-byte write would bring the route to 16 bytes, past the
      // 10-byte bound, and end the route at once, synchronously, in this call.
      session.write(new TextEncoder().encode("87654321"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(routeEnded).toBe(false);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when one host-to-worker write passes the size bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxWriteChars: 8 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A" }),
      );
      const waitResult = session.wait();
      // One write is larger than the size bound, so the host rejects it and ends
      // the route before it reaches the worker.
      session.write(new TextEncoder().encode("this-write-is-too-large"));
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the protocol error count passes the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxProtocolErrors: 2 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [
            { chunk: "e1", sid: "ws-EVIL" },
            { chunk: "e2", sid: "ws-EVIL" },
            { chunk: "e3", sid: "ws-EVIL" },
          ],
        }),
      );
      // Each mismatched-session data frame is a protocol error. The third frame
      // passes the error bound and the route ends.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the total data bytes pass the cap for a bound listener", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxTotalDataBytes: 10 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [
            { chunk: "aaaaa" }, // total 5 → deliver
            { chunk: "bbbbb" }, // total 10 → deliver
            { chunk: "ccccc" }, // total 15 > 10 → end route
          ],
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // A listener is bound, so the host forwards each chunk until the cumulative
      // bytes pass the cap. The third chunk passes the cap, so the host drops it
      // and ends the route. The listener never receives data past the cap.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual(["aaaaa", "bbbbb"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("counts inbound bytes, not characters, against the total cap", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxTotalDataBytes: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          // "€" is one character but three bytes in UTF-8. The first chunk is 3
          // bytes (≤ 4), so the host delivers it. The second chunk brings the
          // total to 6 bytes (> 4), so the host ends the route. A character count
          // would admit both chunks (2 ≤ 4), so one delivered chunk proves the
          // host counts bytes.
          data: [{ chunk: "€" }, { chunk: "€" }],
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual(["€"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drains a buffered valid chunk to a listener that binds after the byte cap ends the route", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxTotalDataBytes: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          // "€" is three bytes in UTF-8. The first chunk is 3 bytes (≤ 4), so the
          // host counts and buffers it. The second chunk brings the total to 6
          // bytes (> 4), so the host ends the route.
          data: [{ chunk: "€" }, { chunk: "€" }],
        }),
      );
      // Wait so both data frames arrive and the route ends on the byte cap before
      // a listener binds. The first chunk is a valid buffered frame. The host must
      // keep it, so the late listener drains it. This proves the host does not
      // drop a buffered valid chunk when the route ends before a listener binds.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      expect(chunks).toEqual(["€"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the active route when the lifetime timer expires", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxDurationMs: 100 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "normal", workerSessionId: "ws-A" }),
      );
      const waitResult = session.wait();
      // The route sends no exit. The lifetime timer expires, so the host ends the
      // route and resolves the wait with the fixed null exit code.
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route at once when one inbound chunk passes the per-chunk limit before a listener binds", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxChunkChars: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [{ chunk: "this-one-chunk-is-too-large" }],
        }),
      );
      // No listener attaches. One inbound chunk is larger than the per-chunk
      // limit, so the host ends the route at once. The default protocol-error
      // budget is far above one, so a single chunk that ends the route proves the
      // host does not treat it as a protocol error.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route at once when one inbound chunk passes the per-chunk limit after a listener binds", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxChunkChars: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [{ chunk: "this-one-chunk-is-too-large" }],
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // A listener is bound. One inbound chunk is larger than the per-chunk
      // limit, so the host ends the route at once and never forwards the chunk.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual([]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // The open reply and a frame arrive in one read batch.
  // -------------------------------------------------------------------------

  it("holds and replays a data frame that arrives in the open-reply read batch", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // The worker writes the open reply and the data and exit frames in one
          // stdout write. The host reads them in one batch, so the data and exit
          // frames arrive before the route binds. The host must hold the frames
          // and replay them after the bind, not drop them.
          batchWithOpenReply: true,
          workerSessionId: "ws-A",
          data: [{ chunk: "batched-one" }, { chunk: "batched-two" }],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      expect(chunks).toEqual(["batched-one", "batched-two"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when a batched frame passes the per-chunk limit before the bind", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxChunkChars: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // The worker batches the data frame with the open reply, so the frame
          // arrives before the route binds. The replay after the bind applies the
          // per-chunk limit, so the one large chunk ends the route.
          batchWithOpenReply: true,
          workerSessionId: "ws-A",
          data: [{ chunk: "this-one-chunk-is-too-large" }],
        }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when batched pre-bind frames pass the frame count bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedFrames: 2 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // The worker batches the three data frames with the open reply, so all
          // three frames arrive before the route binds. No listener attaches, so
          // the replay buffers them. The third frame passes the frame-count bound
          // and the route ends. The pre-open hold must not drop the third frame
          // before the buffered bound can end the route.
          batchWithOpenReply: true,
          data: [{ chunk: "a" }, { chunk: "b" }, { chunk: "c" }],
        }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the pre-bind hold bytes pass the route input bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedChars: 10 },
    });
    try {
      await handle.start();
      // The worker batches the three data frames with the open reply, so all
      // three frames arrive before the route binds and land in the pre-bind
      // hold, not the post-bind buffered queue. The frame-count bound stays
      // far above three frames, so only the byte bound can end the route
      // here: this proves the hold itself counts bytes, not only frames. The
      // hold ends the route before the bind completes, so the open call
      // itself fails, the same way a malformed open reply fails it.
      await expect(
        handle.openDuplexChannel(
          duplexOpenInput({
            batchWithOpenReply: true,
            data: [
              { chunk: "aaaaa" }, // total 5 → held
              { chunk: "bbbbb" }, // total 10 → held
              { chunk: "ccccc" }, // total 15 > 10 → end the route in the hold
            ],
          }),
        ),
      ).rejects.toThrow("DUPLEX_CHANNEL_OPEN_FAILED");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route on the frame count bound even when a caller raises that bound well past the module default", async () => {
    // Regression test: the pre-open hold ceiling must track
    // maxDuplexChannelPreBindFrames, not a fixed value. A fixed ceiling at or
    // below this bound would drop the 13th frame in the hold before the replay
    // ever applies the buffered bound to it, and the route would never end.
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedFrames: 12 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          batchWithOpenReply: true,
          data: Array.from({ length: 13 }, (_, i) => ({ chunk: String(i) })),
        }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route on the frame count bound even when an exit notification arrives before the overflow data frame", async () => {
    // Regression test: an exit notification must never share the pre-open hold's
    // capacity with data frames. The worker here batches exactly
    // maxPreBindBufferedFrames valid data frames (no violation), then its exit,
    // then one more data frame that should trip the buffered-frame bound. If the
    // exit consumed a hold slot, that last data frame would be dropped by the
    // hold before the replay ever applies the buffered bound to it, and the
    // route would end normally on the exit (exitCode: 0) instead of on the
    // bound (exitCode: null).
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedFrames: 3 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          batchWithOpenReply: true,
          data: [{ chunk: "a" }, { chunk: "b" }, { chunk: "c" }],
          exitCode: 0,
          dataAfterExit: [{ chunk: "overflow" }],
        }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("delivers a batched pre-bind chunk that a later listener drains before the byte cap ends the route", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxTotalDataBytes: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // The worker batches the two data frames with the open reply, so both
          // frames arrive before the route binds and before a listener attaches.
          // "€" is three bytes in UTF-8. The first chunk (3 bytes ≤ 4) buffers.
          // The second chunk brings the total to 6 bytes (> 4), so the route ends.
          // The route end must not discard the buffered first chunk. The listener
          // attaches after the open resolves and drains the first chunk.
          batchWithOpenReply: true,
          workerSessionId: "ws-A",
          data: [{ chunk: "€" }, { chunk: "€" }],
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual(["€"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // Byte fidelity across the worker remote-procedure-call hop.
  // -------------------------------------------------------------------------

  it("test_worker_channel_preserves_all_byte_values", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", echoInput: true }),
      );
      const allByteValues = Uint8Array.from({ length: 256 }, (_, value) => value);
      const received: Uint8Array[] = [];
      session.onData((chunk) => received.push(chunk));

      session.write(allByteValues);

      // The fixture echoes the write as one data notification, prefixed with the
      // five ASCII bytes "echo:". It builds the echo on the decoded byte buffer,
      // not a string, so the round trip through the base64 JSON-RPC wire form
      // (`ChannelBytesWireValue`) carries every one of the 256 byte values
      // unchanged, including the byte value zero, which a UTF-8 string hop would
      // not preserve reliably end to end.
      await vi.waitFor(() => expect(received.length).toBe(1));
      const echoPrefix = new TextEncoder().encode("echo:");
      const echoed = received[0]!;
      expect(echoed.byteLength).toBe(echoPrefix.byteLength + allByteValues.byteLength);
      expect(echoed.subarray(0, echoPrefix.byteLength)).toEqual(echoPrefix);
      expect(echoed.subarray(echoPrefix.byteLength)).toEqual(allByteValues);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // Authoritative closure and worker retirement.
  // -------------------------------------------------------------------------

  it("closes the route with a fixed exit when the worker exits", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(duplexOpenInput({ mode: "normal" }));
      const waitResult = session.wait();
      await handle.stop();
      // A worker exit closes the one route and resolves the wait with the fixed
      // non-secret exit.
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("retires the worker on an unconfirmed close acknowledgement", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { closeTimeoutMs: 200 },
    });
    try {
      await handle.start();
      const exited = new Promise<void>((resolve) => {
        handle.on("exit", () => resolve());
      });
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "normal", closeMode: "bad-ack" }),
      );
      await session.close();
      // The close acknowledgement carried a mismatched host route id, so the host
      // fails closed and retires the worker before any reuse.
      await exited;
      await expect(
        handle.openDuplexChannel(duplexOpenInput({ mode: "normal" })),
      ).rejects.toThrow();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed retirement and crash-recovery restart.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(
  handle: PluginWorkerHandle,
  wanted: WorkerStatus,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (handle.status !== wanted && Date.now() < deadline) {
    await sleep(20);
  }
  expect(handle.status).toBe(wanted);
}

function nextExit(handle: PluginWorkerHandle): Promise<void> {
  return new Promise((resolve) => {
    const listener = () => {
      handle.off("exit", listener);
      resolve();
    };
    handle.on("exit", listener);
  });
}

// Resolve true once the worker process exits, or false after `ms`. A test that
// expects no retirement must not hang when one does happen, and the reverse.
function exitsWithin(handle: PluginWorkerHandle, ms: number): Promise<boolean> {
  return Promise.race([nextExit(handle).then(() => true), sleep(ms).then(() => false)]);
}

function recordCrashes(handle: PluginWorkerHandle): WorkerHandleEvents["crash"][] {
  const crashes: WorkerHandleEvents["crash"][] = [];
  handle.on("crash", (payload) => crashes.push(payload));
  return crashes;
}

// Retire the worker the way production did: a bound channel whose close the
// worker does not acknowledge. Resolves once the retired process has exited.
async function retireOnUnacknowledgedClose(handle: PluginWorkerHandle): Promise<void> {
  const exited = nextExit(handle);
  const session = await handle.openDuplexChannel(duplexOpenInput({ closeMode: "bad-ack" }));
  await session.close();
  await exited;
}

// The messages the mocked logger received at one level, so a test can prove a
// log line is absent as well as present.
function loggedMessages(level: "info" | "warn" | "error"): string[] {
  return vi
    .mocked(logger[level])
    .mock.calls.map((call) => (typeof call[1] === "string" ? call[1] : String(call[0])));
}

const CLOSE_NOT_ACKNOWLEDGED = "retired: duplex channel close not acknowledged";

describe("plugin worker manager fail-closed retirement", () => {
  it("restarts a worker retired on an unacknowledged close, and ends every channel the old worker held", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const crashes = recordCrashes(handle);
    try {
      await handle.start();
      const oldPid = handle.diagnostics().pid;
      // A second channel the retirement must end along with the worker.
      const other = await handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-1" }));
      const otherWait = other.wait();
      await retireOnUnacknowledgedClose(handle);
      await expect(otherWait).resolves.toEqual({ exitCode: null });
      expect(crashes).toEqual([
        expect.objectContaining({ willRestart: true, reason: CLOSE_NOT_ACKNOWLEDGED }),
      ]);

      // Crash recovery brings a fresh worker up after its backoff (about 1 s).
      await waitForStatus(handle, "running");
      expect(handle.diagnostics().pid).not.toBe(oldPid);
      expect(handle.diagnostics().retiring).toBe(false);

      // The fresh worker may mint the same worker session id: the old pair's
      // tombstone went with the old worker, and the host route id is new.
      const fresh = await handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-1" }));
      await fresh.close();
      expect(handle.status).toBe("running");
      expect(crashes).toHaveLength(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 20_000);

  it("never delivers a host reply meant for the retired worker to the restarted one", async () => {
    let releaseSlowReply!: () => void;
    const slowReplyGate = new Promise<void>((resolve) => {
      releaseSlowReply = resolve;
    });
    let slowHandlerReturned!: () => void;
    const slowHandlerDone = new Promise<void>((resolve) => {
      slowHandlerReturned = resolve;
    });
    const handle = makeDuplexHandle({
      duplexChannelLimits: { closeTimeoutMs: 200 },
      hostHandlers: {
        "test.slowAnswer": async (params: { tag: string }) => {
          await slowReplyGate;
          // Settle after the host sees the result: the reply decision runs in
          // the microtask that follows this return.
          setImmediate(slowHandlerReturned);
          return { answeredFor: params.tag };
        },
        "test.answer": async (params: { tag: string }) => ({ answeredFor: params.tag }),
      },
    });
    vi.mocked(logger.warn).mockClear();
    try {
      await handle.start();
      // The old worker asks the host something slow; its request id is 1.
      await expect(
        handle.call("requestHost" as never, { method: "test.slowAnswer", params: { tag: "old" } } as never),
      ).resolves.toEqual({ sentId: 1 });
      await retireOnUnacknowledgedClose(handle);
      await waitForStatus(handle, "running");

      // The host answers the old worker's request only now, while a fresh worker
      // runs. That fresh worker also numbers its first request 1.
      releaseSlowReply();
      await slowHandlerDone;
      expect(loggedMessages("warn")).toContain(
        "dropping a host reply: the worker process that asked is gone",
      );
      const before = await handle.call("health", {});
      expect(before.details).toEqual(expect.objectContaining({ hostReplies: [] }));

      // The fresh worker's own request still gets its own answer.
      await expect(
        handle.call("requestHost" as never, { method: "test.answer", params: { tag: "new" } } as never),
      ).resolves.toEqual({ sentId: 1 });
      const deadline = Date.now() + 2_000;
      let replies: unknown = [];
      while (Date.now() < deadline) {
        const health = await handle.call("health", {});
        replies = (health.details as { hostReplies: unknown[] }).hostReplies;
        if (Array.isArray(replies) && replies.length > 0) break;
        await sleep(20);
      }
      expect(replies).toEqual([{ id: 1, result: { answeredFor: "new" }, error: null }]);
    } finally {
      releaseSlowReply();
      await handle.stop().catch(() => undefined);
    }
  }, 20_000);

  it("stops restarting once the retirement budget is spent: a fourth retirement within the window leaves the worker crashed", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const crashes = recordCrashes(handle);
    vi.mocked(logger.error).mockClear();
    try {
      await handle.start();
      for (let retirement = 1; retirement <= 4; retirement += 1) {
        if (retirement > 1) await waitForStatus(handle, "running");
        await retireOnUnacknowledgedClose(handle);
      }
      // Each fresh worker started cleanly, so the consecutive-crash counter was
      // reset every time; only the retirement budget stops the loop.
      expect(crashes.map((crash) => crash.willRestart)).toEqual([true, true, true, false]);
      expect(crashes.every((crash) => crash.reason === CLOSE_NOT_ACKNOWLEDGED)).toBe(true);
      expect(handle.status).toBe("crashed");

      // No restart follows, even after the longest backoff a retirement gets.
      await sleep(2_000);
      expect(handle.status).toBe("crashed");
      expect(handle.diagnostics()).toEqual(
        expect.objectContaining({ pid: null, nextRestartAt: null }),
      );
      // One loud error names the reason and the count.
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: CLOSE_NOT_ACKNOWLEDGED,
          retirementsInWindow: 4,
          maxRetirements: 3,
          willRestart: false,
        }),
        expect.stringContaining("worker retired 4 times within 30 minutes; not restarting it"),
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 30_000);

  it("counts retirements in a rolling window that a successful start does not reset", async () => {
    // The budget runs on an injected monotonic clock, so the window edges are
    // exact and do not depend on how long a restart takes.
    let clock = 0;
    const handle = makeDuplexHandle({
      duplexChannelLimits: { closeTimeoutMs: 200 },
      retirementBudget: { maxRestarts: 1, windowMs: 60_000, now: () => clock },
    });
    const crashes = recordCrashes(handle);
    try {
      await handle.start();
      await retireOnUnacknowledgedClose(handle);
      await waitForStatus(handle, "running");
      // The first retirement has just left the window: the next one restarts.
      clock = 60_000;
      await retireOnUnacknowledgedClose(handle);
      await waitForStatus(handle, "running");
      // This one follows a successful start, but the retirement before it is
      // still inside the window, so the budget is spent.
      clock = 60_000 + 59_999;
      await retireOnUnacknowledgedClose(handle);
      expect(crashes.map((crash) => crash.willRestart)).toEqual([true, true, false]);
      await sleep(1_500);
      expect(handle.status).toBe("crashed");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 30_000);

  it("measures the retirement window on a monotonic clock, so a wall-clock step does not refill the budget", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { closeTimeoutMs: 200 },
      retirementBudget: { maxRestarts: 1, windowMs: 60_000 },
    });
    const crashes = recordCrashes(handle);
    const realNow = Date.now.bind(Date);
    let wallClock: { mockRestore(): void } | null = null;
    try {
      await handle.start();
      await retireOnUnacknowledgedClose(handle);
      await waitForStatus(handle, "running");
      // The wall clock jumps an hour ahead (an NTP step, a suspended host).
      wallClock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * 60 * 1_000);
      await retireOnUnacknowledgedClose(handle);
      expect(crashes.map((crash) => crash.willRestart)).toEqual([true, false]);
    } finally {
      wallClock?.mockRestore();
      await handle.stop().catch(() => undefined);
    }
  }, 20_000);

  it("retries a crash-recovery start that fails after a retirement, instead of leaving the worker down", async () => {
    const marker = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "plugin-worker-init-")),
      "fail-next-initialize",
    );
    const handle = makeDuplexHandle({
      duplexChannelLimits: { closeTimeoutMs: 200 },
      env: { FAIL_INITIALIZE_ONCE_FILE: marker },
    });
    const crashes = recordCrashes(handle);
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.error).mockClear();
    try {
      await handle.start();
      // The next initialize, the one crash recovery runs, fails once.
      fs.writeFileSync(marker, "fail");
      await retireOnUnacknowledgedClose(handle);
      expect(crashes).toEqual([
        expect.objectContaining({ willRestart: true, reason: CLOSE_NOT_ACKNOWLEDGED }),
      ]);
      // The failed start is retried after a longer backoff, and the retry works.
      await waitForStatus(handle, "running", 12_000);
      expect(fs.existsSync(marker)).toBe(false);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: CLOSE_NOT_ACKNOWLEDGED,
          willRestart: true,
          consecutiveCrashes: 2,
        }),
        "restart after backoff failed; retrying after backoff",
      );
      // A failed start is not an operator stop.
      expect(loggedMessages("info")).not.toContain(
        "restart after backoff cancelled by an operator stop",
      );
    } finally {
      await handle.stop().catch(() => undefined);
      fs.rmSync(path.dirname(marker), { recursive: true, force: true });
    }
  }, 25_000);

  it("does not restart a worker retired on an ownership violation", async () => {
    const handle = makeDuplexHandle();
    const crashes = recordCrashes(handle);
    vi.mocked(logger.error).mockClear();
    try {
      await handle.start();
      const exited = nextExit(handle);
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", data: [{ chunk: "forged", sid: "ws-EVIL" }] }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      await exited;
      expect(crashes).toEqual([
        expect.objectContaining({
          willRestart: false,
          reason: "retired: duplex channel ownership violation (data frame pair)",
        }),
      ]);
      expect(handle.status).toBe("crashed");
      await sleep(2_000);
      expect(handle.status).toBe("crashed");
      expect(handle.diagnostics().pid).toBeNull();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "retired: duplex channel ownership violation (data frame pair)",
          willRestart: false,
        }),
        "retired worker exited; not restarting it, an operator must restart the plugin",
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 15_000);

  it("keeps the worker stopped when an operator stops it during the restart backoff", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const ready = vi.fn();
    try {
      await handle.start();
      handle.on("ready", ready);
      await retireOnUnacknowledgedClose(handle);
      expect(handle.status).toBe("backoff");
      await handle.stop();
      expect(handle.status).toBe("stopped");
      // The cancelled backoff timer never brings the worker back.
      await sleep(2_000);
      expect(handle.status).toBe("stopped");
      expect(ready).not.toHaveBeenCalled();
      expect(handle.diagnostics()).toEqual(
        expect.objectContaining({ pid: null, nextRestartAt: null }),
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 15_000);

  it("keeps every worker stopped when the manager stops all workers during the restart backoff", async () => {
    const manager = createPluginWorkerManager();
    try {
      const handle = await manager.startWorker("plugin-1", {
        entrypointPath: DUPLEX_CHANNEL_WORKER_ENTRYPOINT,
        manifest: TEST_MANIFEST,
        config: {},
        instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
        apiVersion: 1,
        hostHandlers: {},
        duplexChannelLimits: { closeTimeoutMs: 200 },
      });
      const ready = vi.fn();
      handle.on("ready", ready);
      await retireOnUnacknowledgedClose(handle);
      expect(handle.status).toBe("backoff");
      await manager.stopAll();
      expect(handle.status).toBe("stopped");
      await sleep(2_000);
      expect(handle.status).toBe("stopped");
      expect(ready).not.toHaveBeenCalled();
      expect(handle.diagnostics().pid).toBeNull();
    } finally {
      await manager.stopAll();
    }
  }, 15_000);

  it("keeps the worker stopped when an operator stops it while the fresh worker is starting", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const statusesAfterStop: WorkerStatus[] = [];
    let stopRequested = false;
    let stopping: Promise<void> | null = null;
    try {
      await handle.start();
      await retireOnUnacknowledgedClose(handle);
      handle.on("status", ({ status }) => {
        if (stopRequested) statusesAfterStop.push(status);
        if (status === "starting" && !stopRequested) {
          // Stop right after the fresh worker spawned and its initialize call
          // went out, while the start still waits for the reply.
          queueMicrotask(() => {
            stopRequested = true;
            stopping = handle.stop();
          });
        }
      });
      const deadline = Date.now() + 8_000;
      while (stopping === null && Date.now() < deadline) await sleep(20);
      expect(stopping).not.toBeNull();
      await stopping;
      expect(handle.status).toBe("stopped");
      await sleep(1_000);
      expect(handle.status).toBe("stopped");
      expect(statusesAfterStop).not.toContain("running");
      expect(handle.diagnostics().pid).toBeNull();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 15_000);

  it("keeps the worker stopped when an operator stops it between the kill and the exit", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const crashes = recordCrashes(handle);
    vi.mocked(logger.warn).mockClear();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(duplexOpenInput({ closeMode: "bad-ack" }));
      await session.close();
      // The worker was just sent SIGKILL; its exit has not been handled yet. The
      // handle reports the retirement, although the status still reads running.
      expect(handle.status).toBe("running");
      expect(handle.diagnostics().retiring).toBe(true);
      await handle.stop();
      expect(handle.status).toBe("stopped");
      expect(handle.diagnostics().retiring).toBe(false);
      // The stop won over the pending restart, and the log says so with the
      // retirement's reason.
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ reason: CLOSE_NOT_ACKNOWLEDGED, willRestart: false }),
        "retired worker exited after an operator stop; not restarting",
      );
      await sleep(1_500);
      expect(handle.status).toBe("stopped");
      expect(crashes).toEqual([]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 15_000);

  it("refuses new work between the kill and the exit of a retired worker", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    try {
      await handle.start();
      const exited = nextExit(handle);
      const session = await handle.openDuplexChannel(duplexOpenInput({ closeMode: "bad-ack" }));
      await session.close();
      // Still inside the window: the status has not changed yet.
      expect(handle.status).toBe("running");
      await expect(handle.call("health", {})).rejects.toThrow(/is retiring/);
      await expect(
        handle.openDuplexChannel(duplexOpenInput({ mode: "normal" })),
      ).rejects.toThrow(/is retiring/);
      await expect(
        handle.openLoginPtySession({
          driverKey: "sandbox",
          companyId: "company-1",
          environmentId: "env-1",
          providerLeaseId: JSON.stringify({ mode: "normal" }),
          loginCommandKey: "claude",
          sessionHome: "/tmp/session-home",
        }),
      ).rejects.toThrow(/is retiring/);
      await exited;
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("accepts a route-only close acknowledgement once the worker reported the exact pair's exit", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const crashes = recordCrashes(handle);
    const exit = vi.fn();
    try {
      await handle.start();
      handle.on("exit", exit);
      const pid = handle.diagnostics().pid;
      // The worker reports the exit for the exact pair, then forgets the
      // channel, so its close reply echoes the host route id only.
      const ended = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", exitCode: 0, forgetOnExit: true }),
      );
      await expect(ended.wait()).resolves.toEqual({ exitCode: 0 });
      await ended.close();
      // The same holds when the exit arrived before the bind and was replayed.
      const endedEarly = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-B",
          transportClosed: true,
          forgetOnExit: true,
          batchWithOpenReply: true,
        }),
      );
      await expect(endedEarly.wait()).resolves.toEqual({ exitCode: null, transportClosed: true });
      await endedEarly.close();
      await sleep(300);
      expect(exit).not.toHaveBeenCalled();
      expect(crashes).toEqual([]);
      expect(handle.status).toBe("running");
      expect(handle.diagnostics().pid).toBe(pid);
      const next = await handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-C" }));
      await next.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("accepts a route-only close acknowledgement when the exact pair's exit crosses the host's close", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const crashes = recordCrashes(handle);
    try {
      await handle.start();
      const pid = handle.diagnostics().pid;
      // The channel is live when the host closes it. The worker reports the
      // exact pair's exit only after the host's close went out (the pair is
      // tombstoned by then), forgets the channel, and acknowledges with the
      // host route id only.
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", closeMode: "exit-then-route-only-ack" }),
      );
      await session.close();
      expect(await exitsWithin(handle, 500)).toBe(false);
      expect(crashes).toEqual([]);
      expect(handle.status).toBe("running");
      expect(handle.diagnostics().pid).toBe(pid);
      const next = await handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-B" }));
      await next.close();
      expect(handle.status).toBe("running");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still retires on a route-only close acknowledgement when no exit was reported for the pair", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const crashes = recordCrashes(handle);
    try {
      await handle.start();
      const exited = nextExit(handle);
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", closeMode: "route-only-ack" }),
      );
      await session.close();
      await exited;
      expect(crashes).toEqual([
        expect.objectContaining({ willRestart: true, reason: CLOSE_NOT_ACKNOWLEDGED }),
      ]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still retires on a route-only close acknowledgement when only another route reported an exit", async () => {
    const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
    const crashes = recordCrashes(handle);
    try {
      await handle.start();
      // Route A ends on the worker side and reports its exact pair's exit.
      const ended = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", exitCode: 0, forgetOnExit: true }),
      );
      await expect(ended.wait()).resolves.toEqual({ exitCode: 0 });
      // Route B reported nothing; its route-only acknowledgement proves nothing.
      const exited = nextExit(handle);
      const silent = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-B", closeMode: "route-only-ack" }),
      );
      await silent.close();
      await exited;
      expect(crashes).toEqual([
        expect.objectContaining({ willRestart: true, reason: CLOSE_NOT_ACKNOWLEDGED }),
      ]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it.each([
    ["another session id", "ws-OTHER"],
    ["a number", 12345],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["null", null],
  ])(
    "still retires when the acknowledgement after an exact-pair exit carries %s as the session id",
    async (_label, closeAckWorkerSessionId) => {
      const handle = makeDuplexHandle({ duplexChannelLimits: { closeTimeoutMs: 200 } });
      const crashes = recordCrashes(handle);
      try {
        await handle.start();
        const session = await handle.openDuplexChannel(
          duplexOpenInput({ workerSessionId: "ws-A", exitCode: 0, closeAckWorkerSessionId }),
        );
        await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
        const exited = exitsWithin(handle, 2_000);
        await session.close();
        expect(await exited).toBe(true);
        expect(crashes).toEqual([
          expect.objectContaining({ willRestart: true, reason: CLOSE_NOT_ACKNOWLEDGED }),
        ]);
      } finally {
        await handle.stop().catch(() => undefined);
      }
    },
  );
});
