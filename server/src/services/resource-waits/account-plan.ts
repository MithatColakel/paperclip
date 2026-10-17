import { and, eq, inArray } from "drizzle-orm";
import {
  aiAccountProjects,
  aiAccounts,
  companyMemberships,
  projects,
} from "@paperclipai/db";
import {
  sshExecutionDeviceKey,
  type AiAccountPlanWaitReason,
  type DeploymentMode,
} from "@paperclipai/shared";
import {
  acceptedCredentialTypes,
  acceptsCredentialType,
  deviceForEnvironment,
  type ExecutionDeviceRow,
} from "../execution-devices.js";
import type { RunEnvironmentRow } from "./run-environment.js";
import type { ResourceWaitDb } from "./types.js";

/**
 * Fork: planCredential rows 1–9 (spec 4.2) evaluated from the database only.
 * The hold re-checks account waits with it (spec 7.4), and the run path can
 * share it so both read the same predicate:
 *
 * 1. no account (`unassigned`); 2. the owner is not an active `user` member of
 * the company (`owner_not_member`; in `local_trusted` the local board user
 * counts); 3. reserved for projects the company does not own
 * (`reserved_elsewhere`); 4–5. withdrawn by an admin or the owner
 * (`withdrawn`); 6. `signed_out`; 7. the environment maps to no device
 * (`device_unknown`); 8. the device does not accept the credential type
 * (`credential_type_unsupported`); 9. a limit that has not reset
 * (`usage_limit` or `credit_balance`).
 *
 * No row compares the run's responsible user with the owner, and no row
 * checks who owns the device. Nothing is created: a Local or SSH device that
 * the run would create on first use counts as known.
 */

export type AccountRow = typeof aiAccounts.$inferSelect;

const LOCAL_BOARD_USER_ID = "local-board";

export interface AccountPlanEvaluation {
  /** The first failing row, or null when every row passes. */
  reason: AiAccountPlanWaitReason | null;
  account: AccountRow | null;
  /** The environment's device; null when unknown or not created yet. */
  device: ExecutionDeviceRow | null;
  /** The owner is an active member: only then may the account's label be shown in the company. */
  ownerIsMember: boolean;
}

export function effectiveAccountOwner(account: Pick<AccountRow, "ownerUserId" | "createdByUserId">): string | null {
  return account.ownerUserId ?? account.createdByUserId ?? null;
}

export async function isActiveUserMember(
  db: ResourceWaitDb,
  companyId: string,
  userId: string | null,
  deploymentMode?: DeploymentMode,
): Promise<boolean> {
  if (!userId) return false;
  if (deploymentMode === "local_trusted" && userId === LOCAL_BOARD_USER_ID) return true;
  const [row] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ))
    .limit(1);
  return Boolean(row);
}

/** Row 3: the account is reserved for projects and the company owns none of them. */
async function isReservedElsewhere(db: ResourceWaitDb, accountId: string, companyId: string): Promise<boolean> {
  const reserved = await db
    .select({ projectId: aiAccountProjects.projectId })
    .from(aiAccountProjects)
    .where(eq(aiAccountProjects.accountId, accountId));
  if (reserved.length === 0) return false;
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, reserved.map((row) => row.projectId))))
    .limit(1);
  return owned.length === 0;
}

/** Rows 7–8 for one environment. Null when both pass. */
async function placementFailure(
  db: ResourceWaitDb,
  environment: RunEnvironmentRow,
  account: AccountRow,
  now: Date,
  knownDevice: ExecutionDeviceRow | null | undefined,
): Promise<{ reason: "device_unknown" | "credential_type_unsupported" | null; device: ExecutionDeviceRow | null }> {
  if (knownDevice === null) return { reason: "device_unknown", device: null };
  const device = knownDevice ?? await deviceForEnvironment(db, environment, { create: false });
  if (!device) {
    // The run creates these on first use (spec 6.1); they accept any type.
    const creatable = environment.driver === "local"
      || (environment.driver === "ssh" && sshExecutionDeviceKey(environment.config?.host, environment.config?.port) !== null);
    return { reason: creatable ? null : "device_unknown", device: null };
  }
  const types = acceptedCredentialTypes(environment, device, now);
  return { reason: acceptsCredentialType(types, account.credentialType) ? null : "credential_type_unsupported", device };
}

/**
 * Rows 1–9 for an account in a company and, when known, the run's
 * environment (rows 7–8 are skipped without one). The run path passes the
 * device it resolved (created on first use) as `device`; null then means
 * `device_unknown`. Without it the device is looked up read-only.
 */
export async function evaluateAccountPlan(
  db: ResourceWaitDb,
  input: {
    companyId: string;
    accountId: string | null;
    environment: RunEnvironmentRow | null;
    now: Date;
    deploymentMode?: DeploymentMode;
    device?: ExecutionDeviceRow | null;
  },
): Promise<AccountPlanEvaluation> {
  const [account] = input.accountId
    ? await db.select().from(aiAccounts).where(eq(aiAccounts.id, input.accountId))
    : [];
  if (!account) return { reason: "unassigned", account: null, device: null, ownerIsMember: false };
  const ownerIsMember = await isActiveUserMember(db, input.companyId, effectiveAccountOwner(account), input.deploymentMode);
  const result = (reason: AiAccountPlanWaitReason | null, device: ExecutionDeviceRow | null = null): AccountPlanEvaluation =>
    ({ reason, account, device, ownerIsMember });
  if (!ownerIsMember) return result("owner_not_member");
  if (await isReservedElsewhere(db, account.id, input.companyId)) return result("reserved_elsewhere");
  if (account.adminDisabledAt || account.status === "disabled") return result("withdrawn");
  if (account.status === "auth_failed") return result("signed_out");
  let device: ExecutionDeviceRow | null = null;
  if (input.environment) {
    const placement = await placementFailure(db, input.environment, account, input.now, input.device);
    if (placement.reason) return result(placement.reason, placement.device);
    device = placement.device;
  }
  if (account.exhaustedUntil && account.exhaustedUntil.getTime() > input.now.getTime()) {
    return result(account.limitReason === "credit_balance" ? "credit_balance" : "usage_limit", device);
  }
  return result(null, device);
}
