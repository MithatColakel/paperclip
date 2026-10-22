import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import { environmentService } from "../environments.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { instanceSettingsService } from "../instance-settings.js";
import { workspaceOperationService } from "../workspace-operations.js";
import { createHeartbeatWorkspaceResolver, isWorkspaceValidationFailure, resolveExecutionWorkspaceReuseRequestForIssue } from "./workspaces.js";
import { prepareHeartbeatWorkspace, type HeartbeatWorkspacePreparationInput } from "./workspace-preparation.js";

const execFile = promisify(execFileCallback);
const support = await getEmbeddedPostgresTestSupport();

// Fork: a failed `git worktree list` while reusing a retained git worktree is a
// retryable run error in every reuse gate. Upstream's original-source gate runs
// before ensurePersistedExecutionWorkspaceAvailable on this path, so it must not
// turn the failure into a board-owned workspace_validation recovery either.
describe.skipIf(!support.supported)("heartbeat reuse of a retained git worktree when `git worktree list` fails", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-reuse-git-inspection-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    database = await startEmbeddedPostgresTestDatabase("paperclip-reuse-git-inspection");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  });
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Workspace reuse", issuePrefix: "WRU" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Workspace agent", status: "running", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Source project" }).returning();
    const source = join(home, project.id);
    await mkdir(source);
    await execFile("git", ["init", "--initial-branch=main", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Workspace test"]);
    await writeFile(join(source, "README.md"), "source content\n");
    await execFile("git", ["-C", source, "add", "."]);
    await execFile("git", ["-C", source, "commit", "-m", "Source"]);
    const [projectWorkspace] = await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id, name: "Source", cwd: source, isPrimary: true }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Reuse this workspace", identifier: "WRU-1", projectId: project.id, projectWorkspaceId: projectWorkspace.id, assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    const localEnvironment = await environmentService(db).ensureLocalEnvironment(company.id);
    const input: HeartbeatWorkspacePreparationInput = {
      run, agent,
      task: { issueRef: issue, issueId: issue.id, context: { issueId: issue.id, projectId: project.id }, responsibleUserId: null, previousSessionParams: null },
      policy: {
        trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        requestedExecutionWorkspaceMode: "isolated_workspace",
        useIsolatedTaskDirectory: false, nativeChatWorkspaceScope: null,
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, environmentExecutionWorkspaceSettings: null,
        executionPolicy: { executionMode: "any" },
      },
      environment: { selectedEnvironmentId: localEnvironment.id, localEnvironment, selectedEnvironmentForConfig: localEnvironment, environmentResolution: { environmentId: localEnvironment.id, source: "default" }, resolvedInstanceSettings: await instanceSettingsService(db).get() },
      config: { mergedConfig: { workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "test-{{issue.identifier}}" } }, configSnapshot: null, secretManifest: [] },
      reuse: { requestedShouldReuseExisting: false, existingExecutionWorkspace: null, reusableExistingExecutionWorkspace: null, workspaceReuseRequest: resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: null, issueExecutionWorkspacePreference: null, existingExecutionWorkspaceStatus: null }), nativeRecoveryExecutionWorkspaceId: null, persistedNativeExecutionInput: null, isDotRun: false, runOptions: {} },
      services: { envOrchestrator: environmentRunOrchestrator(db), executionWorkspacesSvc: executionWorkspaceService(db), workspaceOperationsSvc: workspaceOperationService(db), ...createHeartbeatWorkspaceResolver(db), appendRunEvent: vi.fn() },
      controllerLease: { assertOwned: vi.fn(async () => {}) }, nativeRunnerPreparationSpans: [],
    };
    return { input };
  }

  async function reuse(input: HeartbeatWorkspacePreparationInput, workspace: NonNullable<Awaited<ReturnType<typeof prepareHeartbeatWorkspace>>["persistedExecutionWorkspace"]>) {
    input.reuse.requestedShouldReuseExisting = true;
    input.reuse.existingExecutionWorkspace = workspace;
    input.reuse.reusableExistingExecutionWorkspace = workspace;
    input.reuse.workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: workspace.id, issueExecutionWorkspacePreference: "reuse_existing", existingExecutionWorkspaceStatus: workspace.status });
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: input.run.companyId, agentId: input.agent.id, issueId: input.task.issueId, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    input.run = run;
  }

  // Puts a `git` first on PATH whose `worktree list` runs `body`; every other
  // command goes to the real git.
  async function replaceListProbe(body: string) {
    const realGit = (await execFile("/bin/sh", ["-c", "command -v git"])).stdout.trim();
    const bin = await mkdtemp(join(home, "git-shim-"));
    await writeFile(join(bin, "git"), `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[0]==="worktree"&&args[1]==="list"){${body}}else{const r=require("node:child_process").spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"});process.exitCode=r.status??1;}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  }

  it("fails the run retryably at original-source selection and keeps the retained work", async () => {
    const { input } = await fixture();
    const first = await prepareHeartbeatWorkspace(db, input);
    const worktree = first.executionWorkspace.cwd;
    await writeFile(join(worktree, "retained.txt"), "keep this work");
    await reuse(input, first.persistedExecutionWorkspace!);
    await replaceListProbe('process.stderr.write("private-provider-output");process.exitCode=128;');

    const failure = await prepareHeartbeatWorkspace(db, input).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    // failRunSetup records anything else as a retryable setup_failed run.
    expect(isWorkspaceValidationFailure(failure)).toBe(false);
    expect(failure.message).toBe("Could not verify the original repository's git worktree registration (worktree_list nonzero_exit exit 128).");
    expect(await readFile(join(worktree, "retained.txt"), "utf8")).toBe("keep this work");
  });
});
