import type { Db } from "@paperclipai/db";

/**
 * Fork: query-plan checks for tests. `captureQueries` records every statement
 * a drizzle handle runs, with its parameters; `explainAnalyze` runs one again
 * under EXPLAIN ANALYZE; `rowsExamined` adds up the rows the plan read from a
 * table over all loops (the rows each scan returned plus the rows its filter
 * dropped). A query that rescans a table once per output row shows here
 * whatever its statement count.
 */

interface QueryLogger {
  logQuery(query: string, params: unknown[]): void;
}

export interface CapturedQuery {
  query: string;
  params: unknown[];
}

export function captureQueries(db: Db): { queries: CapturedQuery[]; restore: () => void } {
  const session = (db as unknown as { session: { logger: QueryLogger } }).session;
  const original = session.logger;
  const queries: CapturedQuery[] = [];
  session.logger = {
    logQuery(query, params) {
      queries.push({ query, params });
      original.logQuery(query, params);
    },
  };
  return { queries, restore: () => { session.logger = original; } };
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

/**
 * EXPLAIN (ANALYZE, FORMAT JSON) of a captured statement, in a transaction
 * that applies `settings` (for example `enable_seqscan = off`, so a plan on a
 * tiny test table shows the access path a large one would take).
 */
export async function explainAnalyze(db: Db, captured: CapturedQuery, settings: string[] = []): Promise<PlanNode> {
  const client = (db as unknown as {
    $client: {
      begin<T>(run: (tx: { unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> }) => Promise<T>): Promise<T>;
    };
  }).$client;
  const rows = await client.begin(async (tx) => {
    for (const setting of settings) await tx.unsafe(`set local ${setting}`);
    return tx.unsafe(`explain (analyze, format json) ${captured.query}`, captured.params);
  });
  const raw = rows[0]?.["QUERY PLAN"];
  const document = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  return document[0]!.Plan;
}

function* nodesOf(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* nodesOf(child);
}

/** Every plan node that reads `table`. */
export function scansOf(plan: PlanNode, table: string): PlanNode[] {
  return [...nodesOf(plan)].filter((node) => node["Relation Name"] === table);
}

/** Rows the plan read from `table` over all loops: returned plus dropped by a filter. */
export function rowsExamined(plan: PlanNode, table: string): number {
  return scansOf(plan, table).reduce((sum, node) => {
    const loops = Number(node["Actual Loops"] ?? 1);
    const perLoop = Number(node["Actual Rows"] ?? 0)
      + Number(node["Rows Removed by Filter"] ?? 0)
      + Number(node["Rows Removed by Index Recheck"] ?? 0);
    return sum + perLoop * loops;
  }, 0);
}
