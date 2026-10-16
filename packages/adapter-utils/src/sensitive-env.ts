// Env keys whose values are secret: run logs redact them, and the SSH
// transport keeps them off the ssh command line.
export const SENSITIVE_ENV_KEY =
  /(key|token|secret|password|passwd|authorization|cookie)/i;

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY.test(key);
}
