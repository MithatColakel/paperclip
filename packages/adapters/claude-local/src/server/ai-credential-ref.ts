import path from "node:path";
import { deviceWorkspaceRoot } from "@paperclipai/adapter-utils/device-workspace";
import { POOL_RUN_FORBIDDEN_ENV_MATCHERS, type PoolRunEnvMatcher } from "@paperclipai/shared";

// Fork: a run that uses a pool account carries this marker in its env. It is
// sha256("paperclip-ai-account:" + accountId) cut to 16 hex characters, so it
// names the account without being a secret. On sandbox and SSH targets it
// selects the account's own Claude config directory.
export const AI_CREDENTIAL_REF_ENV_KEY = "PAPERCLIP_AI_CREDENTIAL_REF";

const AI_CREDENTIAL_REF_PATTERN = /^[a-f0-9]{16}$/;

/** The run's pool-account marker, or null when it is absent or malformed. */
export function readAiCredentialRef(env: Record<string, unknown> | null | undefined): string | null {
  const value = env?.[AI_CREDENTIAL_REF_ENV_KEY];
  return typeof value === "string" && AI_CREDENTIAL_REF_PATTERN.test(value) ? value : null;
}

/** The managed config directory name under `.paperclip-runtime/claude`. */
export function managedClaudeConfigDirName(credentialRef: string | null): string {
  return credentialRef ? `config-${credentialRef}` : "config";
}

/**
 * Fork: a pool account's Claude config directory on an SSH host. The run's
 * runtime directory there is per-run scratch that is removed after the run,
 * so the account's directory lives in a stable place on the host instead,
 * outside every per-run directory and git worktree. Its sessions survive
 * for `--resume`, and each account keeps one directory (and keychain item)
 * per host. Every run still seeds it again from its own stripped settings.
 * - copy mode: `<remoteWorkspacePath>/.paperclip-runtime/claude/config-<ref>`;
 * - device mode: `<remoteWorkspacePath>/.paperclip-device/claude/config-<ref>`.
 */
export function sshPoolClaudeConfigDir(input: {
  remoteWorkspacePath: string;
  deviceMode: boolean;
  credentialRef: string;
}): string {
  const root = input.deviceMode
    ? path.posix.join(deviceWorkspaceRoot(input.remoteWorkspacePath), "claude")
    : path.posix.join(input.remoteWorkspacePath, ".paperclip-runtime", "claude");
  return path.posix.join(root, managedClaudeConfigDirName(input.credentialRef));
}

/**
 * Fork: keys a pool run on an SSH host unsets after the login profiles are
 * sourced, so a profile can neither route the run away from Anthropic nor
 * hand it another credential. The run's own env still wins over this list.
 */
export const POOL_RUN_SSH_UNSET_ENV_KEYS: readonly string[] = [
  // Provider routing.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  // Proxies and TLS trust.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // Credential carriers.
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "ANTHROPIC_UNIX_SOCKET",
];

/** `HTTP_PROXY` -> `[Hh][Tt][Tt][Pp]_[Pp][Rr][Oo][Xx][Yy]`. */
function anyCaseGlob(name: string): string {
  return name.replace(/[A-Za-z]/g, (letter) => `[${letter.toUpperCase()}${letter.toLowerCase()}]`);
}

/**
 * A shell glob that matches every name the matcher flags. A prefix and suffix
 * may overlap (`ANTHROPIC_` + `_BASE_URL` flags `ANTHROPIC_BASE_URL`), so the
 * suffix loses its longest overlap with the prefix: `ANTHROPIC_*BASE_URL`.
 * That glob also matches a few names the matcher does not flag, which only
 * unsets more profile exports.
 */
function poolRunMatcherGlob(matcher: PoolRunEnvMatcher): string {
  switch (matcher.kind) {
    case "exact":
      return matcher.key;
    case "exact_any_case":
      return anyCaseGlob(matcher.key);
    case "prefix":
      return `${matcher.prefix}*`;
    case "prefix_and_suffix": {
      let overlap = Math.min(matcher.prefix.length, matcher.suffix.length);
      while (overlap > 0 && !matcher.prefix.endsWith(matcher.suffix.slice(0, overlap))) overlap -= 1;
      return `${matcher.prefix}*${matcher.suffix.slice(overlap)}`;
    }
  }
}

/**
 * Fork: name families a pool run on an SSH host also unsets after the login
 * profiles, so a routing key or provider switch that the list above does not
 * name yet (a new `CLAUDE_CODE_USE_<X>`, say) cannot route the pool token away
 * from Anthropic either. Shell globs derived from the routing guard's rules
 * (`POOL_RUN_FORBIDDEN_ENV_MATCHERS`), so the two never drift apart.
 */
export const POOL_RUN_SSH_UNSET_ENV_PATTERNS: readonly string[] = [
  ...new Set(POOL_RUN_FORBIDDEN_ENV_MATCHERS.map(poolRunMatcherGlob)),
];
