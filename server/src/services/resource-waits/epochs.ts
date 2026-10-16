import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { WakeEpochRefs, WakeEpochSnapshot } from "./types.js";

/**
 * Fork: the lost-wake guard's epochs (spec 7.3 step 5). Read them before an
 * attempt; a deferral re-reads them after its successor is inserted. A
 * report, check or wake bumps the environment's epoch; account, binding and
 * device changes move their rows' `updated_at`. Timestamps are compared as
 * exact database text, so microsecond writes are never lost to rounding.
 */

const EXACT_TIMESTAMP_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

function exactTimestampOf(table: string, idColumn: string, id: string | null | undefined) {
  if (!id) return sql`null::text`;
  return sql`(select to_char(updated_at at time zone 'UTC', ${sql.raw(EXACT_TIMESTAMP_FORMAT)}) from ${sql.raw(table)} where ${sql.raw(idColumn)} = ${id}::uuid)`;
}

export async function readWakeEpochs(db: Db, refs: WakeEpochRefs): Promise<WakeEpochSnapshot> {
  const environmentId = refs.environmentId ?? null;
  const [row] = await db.execute<{
    environment_epoch: string | null;
    binding_updated_at: string | null;
    account_updated_at: string | null;
    device_updated_at: string | null;
  }>(sql`
    select
      ${environmentId
        ? sql`coalesce((select wake_epoch::text from environment_availability where environment_id = ${environmentId}::uuid), '0')`
        : sql`null::text`} as environment_epoch,
      ${exactTimestampOf("ai_account_agent_bindings", "agent_id", refs.agentId)} as binding_updated_at,
      ${exactTimestampOf("ai_accounts", "id", refs.accountId)} as account_updated_at,
      ${exactTimestampOf("ai_account_hosts", "id", refs.deviceId)} as device_updated_at
  `);
  return {
    environmentId,
    environmentEpoch: environmentId ? Number(row?.environment_epoch ?? 0) : null,
    agentId: refs.agentId ?? null,
    bindingUpdatedAt: row?.binding_updated_at ?? null,
    accountId: refs.accountId ?? null,
    accountUpdatedAt: row?.account_updated_at ?? null,
    deviceId: refs.deviceId ?? null,
    deviceUpdatedAt: row?.device_updated_at ?? null,
  };
}

/** Re-reads the snapshot's rows; true when any of them moved since it was taken. */
export async function wakeEpochsMoved(db: Db, before: WakeEpochSnapshot): Promise<boolean> {
  const after = await readWakeEpochs(db, {
    environmentId: before.environmentId,
    agentId: before.agentId,
    accountId: before.accountId,
    deviceId: before.deviceId,
  });
  return (before.environmentId !== null && after.environmentEpoch !== before.environmentEpoch)
    || (before.agentId !== null && after.bindingUpdatedAt !== before.bindingUpdatedAt)
    || (before.accountId !== null && after.accountUpdatedAt !== before.accountUpdatedAt)
    || (before.deviceId !== null && after.deviceUpdatedAt !== before.deviceUpdatedAt);
}

/** Merges two snapshots, keeping the earlier read of each ref (the run path reads in stages). */
export function mergeWakeEpochs(first: WakeEpochSnapshot | null | undefined, second: WakeEpochSnapshot | null | undefined): WakeEpochSnapshot | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return {
    environmentId: first.environmentId ?? second.environmentId,
    environmentEpoch: first.environmentId !== null ? first.environmentEpoch : second.environmentEpoch,
    agentId: first.agentId ?? second.agentId,
    bindingUpdatedAt: first.agentId !== null ? first.bindingUpdatedAt : second.bindingUpdatedAt,
    accountId: first.accountId ?? second.accountId,
    accountUpdatedAt: first.accountId !== null ? first.accountUpdatedAt : second.accountUpdatedAt,
    deviceId: first.deviceId ?? second.deviceId,
    deviceUpdatedAt: first.deviceId !== null ? first.deviceUpdatedAt : second.deviceUpdatedAt,
  };
}
