import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { type Db, connectionGrants, toolConnections } from "@paperclipai/db";
import {
  AI_ACCOUNT_CREDENTIAL_PREFIXES,
  AI_ACCOUNT_ENV_KEY,
  type AiAccountCredentialType,
  type CreateMyAiAccount,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import { aiConnectionService } from "./ai-connections.js";

/**
 * Fork: credential handling for Claude pool accounts. A pool account stores
 * one credential (a subscription setup token or an API key) as
 * local_encrypted material under the instance master key. The value appears
 * nowhere else: not in responses, activity, run events, logs or plugin
 * messages. Only the run environment delivered to a target carries it.
 */

/** sha256 hex of the raw value. One credential has one owner (`ai_accounts_fingerprint_uq`). */
export function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The last characters of a credential, for recognition only; null for a short value. */
export function credentialHint(value: string): string | null {
  return value.length > 8 ? `…${value.slice(-4)}` : null;
}

/**
 * The non-secret marker a pool run carries (`PAPERCLIP_AI_CREDENTIAL_REF`):
 * the first 16 hex characters of sha256("paperclip-ai-account:" + accountId).
 */
export function credentialRefForAccount(accountId: string): string {
  return createHash("sha256").update(`paperclip-ai-account:${accountId}`).digest("hex").slice(0, 16);
}

/** 422 unless the value has the prefix of its credential type. */
export function assertCredentialShape(type: AiAccountCredentialType, value: string): void {
  if (!value.startsWith(AI_ACCOUNT_CREDENTIAL_PREFIXES[type])) {
    throw unprocessable(type === "subscription"
      ? "This credential is not a Claude subscription token from `claude setup-token`"
      : "This credential is not a Claude Console API key");
  }
}

/** Encrypts a credential with the existing local_encrypted secret machinery. */
export async function encryptCredential(value: string): Promise<Record<string, unknown>> {
  const prepared = await localEncryptedProvider.createSecret({ value });
  return prepared.material as unknown as Record<string, unknown>;
}

/** Decrypts an account's stored credential. Callers deliver it only in a run environment. */
export async function decryptCredential(material: Record<string, unknown>): Promise<string> {
  return localEncryptedProvider.resolveVersion({
    material: material as unknown as StoredSecretVersionMaterial,
    externalRef: null,
  });
}

/** Whether an error (or one of its causes) is a Postgres unique violation, optionally of one constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === "23505") {
      if (!constraint) return true;
      return record.constraint_name === constraint || record.constraint === constraint;
    }
    current = record.cause;
  }
  return false;
}

/**
 * Maps a unique violation on `ai_accounts` to a generic 409
 * `ai_account_duplicate`: the message never names another owner. Returns the
 * error unchanged otherwise.
 */
export function aiAccountDuplicateError(error: unknown, emailMessage = "You already have a Claude account with this e-mail."): unknown {
  if (isUniqueViolation(error, "ai_accounts_fingerprint_uq")) {
    return conflict("This Claude credential is already in Paperclip.", { code: "ai_account_duplicate" });
  }
  if (isUniqueViolation(error, "ai_accounts_owner_email_hint_uq")) {
    return conflict(emailMessage, { code: "ai_account_duplicate" });
  }
  return error;
}

export interface CredentialImportActor {
  userId: string | null;
  /** `local_implicit` or an instance admin. */
  isInstanceAdmin: boolean;
}

export type CredentialSource = "pasted" | "ai_connection" | "server_env";

/**
 * The credential a new pool account stores, adapted from the legacy
 * `resolveNewCredential`:
 * - a pasted value;
 * - `server_env`: the server's own environment token for the type
 *   (`AI_ACCOUNT_ENV_KEY`), for instance admins only (403 otherwise);
 * - `ai_connection`: the caller's own personal grant of a saved Claude
 *   connection, never another member's or a shared one (403).
 * The actor owns the new account in every case. The value is checked against
 * the type's prefix and never leaves the server.
 */
export async function resolveImportedCredential(
  db: Db,
  input: Pick<CreateMyAiAccount, "credentialType" | "value" | "importFrom">,
  actor: CredentialImportActor,
): Promise<{ value: string; source: CredentialSource }> {
  let value: string;
  let source: CredentialSource;
  if (input.value !== undefined) {
    value = input.value.trim();
    source = "pasted";
  } else if (input.importFrom?.kind === "server_env") {
    if (!actor.isInstanceAdmin) throw forbidden("Only instance admins can import the server's Claude token");
    const envKey = AI_ACCOUNT_ENV_KEY[input.credentialType];
    const fromEnv = process.env[envKey]?.trim();
    if (!fromEnv) throw unprocessable(`The server has no ${envKey} to import`);
    value = fromEnv;
    source = "server_env";
  } else if (input.importFrom?.kind === "ai_connection") {
    if (!actor.userId) throw forbidden("Only a signed-in user can import their own Claude connection");
    const { companyId, connectionId } = input.importFrom;
    const [connection] = await db.select().from(toolConnections).where(and(
      eq(toolConnections.id, connectionId),
      eq(toolConnections.companyId, companyId),
      eq(toolConnections.connectionPurpose, "ai"),
    ));
    if (!connection) throw notFound("Claude connection not found");
    const [grant] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, companyId),
      eq(connectionGrants.connectionId, connectionId),
      eq(connectionGrants.kind, "user"),
      eq(connectionGrants.subjectUserId, actor.userId),
      eq(connectionGrants.status, "active"),
      isNull(connectionGrants.revokedAt),
    ));
    if (!grant) throw forbidden("Only the owner of a personal Claude connection can import it");
    value = String(await aiConnectionService(db).credential({ connection, grant })).trim();
    source = "ai_connection";
  } else {
    throw unprocessable("Give either a value or an import source");
  }
  assertCredentialShape(input.credentialType, value);
  return { value, source };
}
