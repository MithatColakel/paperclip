import type { AdapterExecutionTarget } from "./execution-target.js";

const REMOTE_EXECUTION_ENV_IDENTITY_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "NVM_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (!REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(normalizedKey)) {
      sanitized[key] = value;
      continue;
    }
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue === "string" && inheritedValue === value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function stringEntries(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * The env for an adapter's command install, resolvability probe and logs.
 *
 * A local target gets the server environment merged under the run env, as
 * before. A remote target gets the run env only: a sandbox or SSH host must
 * never receive the server's own variables (database URL, auth secret,
 * master key and the like). When the run env has no PATH, the server PATH
 * fills in. It serves only local lookups such as the ssh client, and
 * `sanitizeRemoteExecutionEnv` drops it before anything reaches the target,
 * so the target keeps its own PATH.
 */
export function remoteSafeRuntimeEnv(
  env: NodeJS.ProcessEnv | Record<string, string>,
  target: Pick<AdapterExecutionTarget, "kind"> | null | undefined,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (target?.kind !== "remote") {
    const merged = stringEntries({ ...inheritedEnv, ...env });
    if (!merged.PATH && !merged.Path) merged.PATH = defaultPathForPlatform();
    return merged;
  }
  const runEnv = stringEntries(env);
  if (!runEnv.PATH && !runEnv.Path) {
    const inheritedPath = readEnvValueCaseInsensitive(inheritedEnv, "PATH");
    runEnv.PATH = inheritedPath && inheritedPath.length > 0 ? inheritedPath : defaultPathForPlatform();
  }
  return runEnv;
}
