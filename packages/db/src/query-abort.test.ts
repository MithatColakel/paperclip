import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runWithQueryAbort, type Db } from "./client.js";
import { isQueryAbortError, QueryAbortedError } from "./query-abort.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

describe("isQueryAbortError", () => {
  it("recognises the abort error, SQLSTATE 57014 and errors that wrap them", () => {
    expect(isQueryAbortError(new QueryAbortedError())).toBe(true);
    expect(isQueryAbortError(Object.assign(new Error("cancelled"), { code: "57014" }))).toBe(true);
    expect(isQueryAbortError(new Error("Failed query", { cause: new QueryAbortedError() }))).toBe(true);
    expect(isQueryAbortError(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(false);
    expect(isQueryAbortError(null)).toBe(false);
  });
});

describe("runWithQueryAbort without a createDb client", () => {
  it("runs the work as is", async () => {
    const controller = new AbortController();
    await expect(runWithQueryAbort({} as Db, controller.signal, async () => "done")).resolves.toBe("done");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("runWithQueryAbort on a real database", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let observer: ReturnType<typeof postgres> | undefined;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-query-abort-");
    observer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    db = createDb(database.connectionString, { maxConnections: 3 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await observer?.end();
    await database?.cleanup();
  });

  async function activeSleeps(): Promise<Array<{ application_name: string }>> {
    return observer!<Array<{ application_name: string }>>`
      select application_name from pg_stat_activity
       where state = 'active' and query like 'select pg_sleep(%' and pid <> pg_backend_pid()
    `;
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("condition not reached in time");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("runs scoped statements on its own pool with the same result types", async () => {
    const probe = sql`select current_setting('application_name') as app, now() as at, '{"a":1}'::jsonb as doc`;
    const outside = (await db.execute(probe))[0] as Record<string, unknown>;
    const inside = (await runWithQueryAbort(db, new AbortController().signal, () => db.execute(probe)))[0] as Record<string, unknown>;
    expect(outside.app).toBe("paperclip");
    expect(inside.app).toBe("paperclip-abandonable-read");
    expect(typeof inside.at).toBe(typeof outside.at);
    expect(inside.doc).toEqual(outside.doc);
  });

  it("cancels the running statement and the queued one when the signal aborts", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const work = runWithQueryAbort(db, controller.signal, () =>
      Promise.all([
        db.execute(sql`select pg_sleep(30)`),
        db.execute(sql`select pg_sleep(29)`),
      ]),
    );
    const outcome = work.then(() => null, (error: unknown) => error);
    await waitFor(async () => (await activeSleeps()).some((row) => row.application_name === "paperclip-abandonable-read"));

    controller.abort();
    const error = await outcome;
    expect(isQueryAbortError(error)).toBe(true);
    await waitFor(async () => (await activeSleeps()).length === 0);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 40_000);

  it("refuses a statement that starts after the abort, without reaching the database", async () => {
    const controller = new AbortController();
    const refused = runWithQueryAbort(db, controller.signal, async () => {
      await db.execute(sql`select 1`);
      controller.abort();
      return db.execute(sql`select pg_sleep(30)`);
    });
    await expect(refused).rejects.toSatisfy(isQueryAbortError);
    expect(await activeSleeps()).toEqual([]);
  });

  it("refuses to start when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(runWithQueryAbort(db, controller.signal, async () => { ran = true; })).rejects.toBeInstanceOf(QueryAbortedError);
    expect(ran).toBe(false);
  });

  it("never cuts a transaction that started before the abort", async () => {
    const controller = new AbortController();
    let transactionResult: string | undefined;
    const work = runWithQueryAbort(db, controller.signal, async () => {
      transactionResult = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_sleep(0.4)`);
        return "committed";
      });
      return transactionResult;
    });
    await waitFor(async () => (await activeSleeps()).some((row) => row.application_name === "paperclip"));
    controller.abort();
    await expect(work).resolves.toBe("committed");
    expect(transactionResult).toBe("committed");
  });

  it("returns every reserved connection, so later scopes and plain queries still run", async () => {
    // The private pool holds four connections. A scope that kept its
    // connection would make the fifth reservation wait forever.
    for (let index = 0; index < 6; index += 1) {
      const controller = new AbortController();
      const work = runWithQueryAbort(db, controller.signal, () => db.execute(sql`select pg_sleep(30)`));
      const outcome = work.then(() => null, (error: unknown) => error);
      await waitFor(async () => (await activeSleeps()).length === 1);
      controller.abort();
      expect(isQueryAbortError(await outcome)).toBe(true);
    }
    const ok = await runWithQueryAbort(db, new AbortController().signal, () => db.execute(sql`select 42 as answer`));
    expect((ok[0] as { answer: number }).answer).toBe(42);
    expect(((await db.execute(sql`select 7 as answer`))[0] as { answer: number }).answer).toBe(7);
  }, 60_000);

  it("leaves statements outside the scope alone", async () => {
    const controller = new AbortController();
    // A drizzle query starts only when awaited; Promise.resolve starts it here,
    // outside the scope.
    const outsideSleep = Promise.resolve(db.execute(sql`select pg_sleep(2)`));
    const work = runWithQueryAbort(db, controller.signal, () => db.execute(sql`select pg_sleep(30)`));
    const outcome = work.then(() => null, (error: unknown) => error);
    await waitFor(async () => (await activeSleeps()).length === 2);
    controller.abort();
    expect(isQueryAbortError(await outcome)).toBe(true);
    await expect(outsideSleep).resolves.toBeDefined();
  }, 40_000);
});
