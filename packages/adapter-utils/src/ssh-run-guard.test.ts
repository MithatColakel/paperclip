import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  getSshEnvLabSupport,
  SSH_RUN_GUARD_STEP,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";

const execFileAsync = promisify(execFile);

// Three 5 s misses, up to 5 s to notice, then the term grace on top for the slow case.
const STOP_DEADLINE_MS = 30_000;
const KILL_DEADLINE_MS = 45_000;
const TEST_TIMEOUT_MS = 70_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
}

describe("SSH run guard", () => {
  let rootDir = "";
  let fixture: SshEnvLabFixtureState | null = null;
  let config: Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>> | null = null;
  const children = new Set<ChildProcess>();
  const pids = new Set<number>();

  beforeAll(async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(`Skipping SSH run guard tests: ${support.reason ?? "unsupported environment"}`);
      return;
    }
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-run-guard-"));
    fixture = await startSshEnvLabFixture({ statePath: path.join(rootDir, "state.json") });
    config = await buildSshEnvLabFixtureConfig(fixture);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (rootDir) {
      await stopSshEnvLabFixture(path.join(rootDir, "state.json")).catch(() => undefined);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is what most tests assert.
      }
    }
    pids.clear();
  });

  async function pidIn(dir: string, name: string) {
    const file = path.join(dir, name);
    await waitFor(
      async () => (await readFile(file, "utf8").catch(() => "")).endsWith("\n"),
      10_000,
      `${name} to be written`,
    );
    const pid = Number((await readFile(file, "utf8")).trim());
    pids.add(pid);
    return pid;
  }

  // Runs `script` the way an agent command runs over SSH, in a fresh directory.
  async function startRun(script: string) {
    const dir = await mkdtemp(path.join(rootDir, "run-"));
    const target = await buildSshSpawnTarget({
      spec: { ...config!, remoteCwd: dir },
      command: "/bin/sh",
      args: ["-c", script],
      env: {},
    });
    const child = spawn(target.command, target.args, { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    void closed.then(() => target.cleanup());
    const pidFrom = (name: string) => pidIn(dir, name);
    const drop = () => {
      child.kill("SIGKILL");
    };
    return { child, closed, pidFrom, drop, stdout: () => stdout };
  }

  it("stops the whole process tree when the connection drops", async (ctx) => {
    if (!config) return ctx.skip();
    // A plain child, a grandchild, a background child whose parent has exited (only
    // its process group still ties it to the run), and a child in its own session
    // (only the process tree ties it to the run).
    const detachedChild = `require("child_process").spawn("sleep",["300"],{detached:true,stdio:"ignore"}).pid`;
    const run = await startRun(
      [
        "echo $$ > root.pid",
        "sleep 300 &",
        "echo $! > child.pid",
        "(sleep 300 & echo $! > grandchild.pid; wait) &",
        "/bin/sh -c 'nohup sleep 300 >/dev/null 2>&1 & echo $! > orphan.pid'",
        `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync("detached.pid", ${detachedChild} + "\\n"); setInterval(() => {}, 1000)' &`,
        "wait",
      ].join("\n"),
    );
    const running = await Promise.all(
      ["root.pid", "child.pid", "grandchild.pid", "orphan.pid", "detached.pid"].map(run.pidFrom),
    );
    expect(running.every(isAlive)).toBe(true);

    run.drop();

    await waitFor(() => !running.some(isAlive), STOP_DEADLINE_MS, "the run's processes to stop");
  }, TEST_TIMEOUT_MS);

  it("force-kills a process that ignores SIGTERM", async (ctx) => {
    if (!config) return ctx.skip();
    const run = await startRun(
      [
        "echo $$ > root.pid",
        `/bin/sh -c 'trap "" TERM; echo $$ > stubborn.pid; while :; do sleep 1; done' &`,
        "wait",
      ].join("\n"),
    );
    const stubborn = await run.pidFrom("stubborn.pid");

    run.drop();

    // It must outlive the root's TERM and only go at the kill step.
    const root = await run.pidFrom("root.pid");
    await waitFor(() => !isAlive(root), STOP_DEADLINE_MS, "the root process to stop");
    expect(isAlive(stubborn)).toBe(true);
    await waitFor(() => !isAlive(stubborn), KILL_DEADLINE_MS, "the stubborn process to be killed");
  }, TEST_TIMEOUT_MS);

  it("leaves another run under the same user alone", async (ctx) => {
    if (!config) return ctx.skip();
    const script = ["echo $$ > root.pid", "sleep 300 &", "echo $! > child.pid", "wait"].join("\n");
    const dropped = await startRun(script);
    const other = await startRun(script);
    const droppedPids = await Promise.all(["root.pid", "child.pid"].map(dropped.pidFrom));
    const otherPids = await Promise.all(["root.pid", "child.pid"].map(other.pidFrom));

    dropped.drop();

    await waitFor(() => !droppedPids.some(isAlive), STOP_DEADLINE_MS, "the dropped run to stop");
    expect(otherPids.every(isAlive)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("works when the host hides the sshd session from the user it runs as", async (ctx) => {
    if (!config) return ctx.skip();
    // A /proc mounted with hidepid hides sshd's session process, which is not dumpable,
    // from its own user. A `ps` shim gives the same view here: the outer shell plays the
    // session, and killing it plays the drop.
    const dir = await mkdtemp(path.join(rootDir, "hidden-"));
    const { stdout: realPs } = await execFileAsync("sh", ["-c", "command -v ps"]);
    await writeFile(
      path.join(dir, "ps"),
      `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "$HIDDEN_PID" ] && exit 1; done\nexec ${realPs.trim()} "$@"\n`,
      { mode: 0o755 },
    );
    const session = spawn("/bin/sh", ["-c", 'export HIDDEN_PID=$$ PATH="$PWD:$PATH"; /bin/sh -c "$PC_RUN"; :'], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PC_RUN: [SSH_RUN_GUARD_STEP, "echo $$ > root.pid", "sleep 300 &", "echo $! > child.pid", "wait"].join("\n"),
      },
    });
    children.add(session);
    const running = await Promise.all(["root.pid", "child.pid"].map((name) => pidIn(dir, name)));

    // Three checks 5 s apart: by now a hidden session counted as gone would have stopped it.
    await new Promise((resolve) => setTimeout(resolve, 17_000));
    expect(running.every(isAlive)).toBe(true);

    session.kill("SIGKILL");

    await waitFor(() => !running.some(isAlive), STOP_DEADLINE_MS, "the run's processes to stop");
  }, TEST_TIMEOUT_MS);

  it("keeps a normal run's input, output and exit code, and does not hold the channel", async (ctx) => {
    if (!config) return ctx.skip();
    const run = await startRun("cat; exit 7");
    const startedAt = Date.now();
    run.child.stdin!.end("prompt over stdin");

    await expect(run.closed).resolves.toBe(7);

    expect(run.stdout()).toBe("prompt over stdin");
    // The guard sleeps 5 s between checks; the client must not wait for it.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, TEST_TIMEOUT_MS);

  it("stops without touching what a normally finished run left behind", async (ctx) => {
    if (!config) return ctx.skip();
    const run = await startRun("nohup sleep 120 >/dev/null 2>&1 & echo $! > background.pid; echo $$ > root.pid");
    await expect(run.closed).resolves.toBe(0);
    const background = await run.pidFrom("background.pid");
    const root = await run.pidFrom("root.pid");

    // Long enough for the guard's next check to find the root gone and exit.
    await new Promise((resolve) => setTimeout(resolve, 7_000));

    expect(isAlive(background)).toBe(true);
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "command="], { maxBuffer: 16 * 1024 * 1024 });
    expect(stdout.split("\n").filter((line) => line.includes(`paperclip-run-guard ${root} `))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("parses in the shells a target's /bin/sh can be", async () => {
    // macOS /bin/sh is bash 3.2 and Debian's is dash. A syntax error here would stop
    // every agent command on that host from starting.
    for (const shell of ["/bin/sh", "/bin/bash", "/bin/dash"]) {
      const available = await execFileAsync(shell, ["-c", "true"]).then(() => true, () => false);
      if (!available) continue;
      await expect(execFileAsync(shell, ["-n", "-c", SSH_RUN_GUARD_STEP])).resolves.toBeDefined();
    }
  });
});
