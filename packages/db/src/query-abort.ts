import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";

/**
 * Fork: stops the database work of an operation that nobody waits for any
 * more, such as an HTTP read whose client disconnected.
 *
 * `runQueryAbortScope` runs `work` with its statements on one connection that
 * it reserves from a small private pool. Only statements that the owner pool
 * would run outside a transaction move there. A transaction keeps its own
 * connection from the owner pool, and this scope never cuts it. When `signal`
 * aborts:
 * - a statement that waits in the reserved connection's queue is dropped
 *   before it reaches PostgreSQL;
 * - a running statement gets a PostgreSQL cancel request and fails with
 *   SQLSTATE 57014;
 * - a new statement, or a new transaction, fails at once with
 *   `QueryAbortedError` and never reaches PostgreSQL.
 *
 * The reserved connection returns to its pool only after every statement it
 * carried has settled and every cancel request has been delivered. A cancel
 * request reaches the server some milliseconds after it is sent. By then a
 * shared pooled connection could run another caller's statement, and the
 * cancel would stop that statement instead. The reservation keeps a late
 * cancel inside the work that it was meant for.
 *
 * Outside a scope nothing changes. After `work` settles, statements that its
 * leftover asynchronous tasks start go to the owner pool again.
 */

type Sql = postgres.Sql;
type ReservedSql = postgres.ReservedSql;

/** The postgres.js query fields this module relies on (postgres@3.4.9). */
type DriverQuery = Promise<unknown> & {
  resolve: (value: unknown) => unknown;
  reject: (error: unknown) => unknown;
  canceller: ((query: DriverQuery) => Promise<void>) | null;
};

type Scope = {
  owner: Sql;
  signal: AbortSignal;
  reserved: ReservedSql;
  open: boolean;
  pending: Set<DriverQuery>;
  cancelling: number;
  released: boolean;
};

/** A cancel request that never settles must not hold the connection forever. */
const CANCEL_SETTLE_LIMIT_MS = 10_000;

const scopes = new AsyncLocalStorage<Scope>();
const routedClients = new WeakSet<object>();

export class QueryAbortedError extends Error {
  readonly code = "QUERY_ABORTED";

  constructor() {
    super("The database work was abandoned, so this statement was not run.");
    this.name = "AbortError";
  }
}

/**
 * True when `error`, or an error that it wraps, says that a statement was not
 * run or was cancelled: either `QueryAbortedError` or SQLSTATE 57014.
 */
export function isQueryAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current instanceof QueryAbortedError) return true;
    if ((current as { code?: unknown }).code === "57014") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function startsTransaction(args: unknown[]): boolean {
  // postgres.js `begin()` sends BEGIN through `unsafe` with an `onexecute`
  // hook that keeps the connection for the transaction.
  const options = args[2] as { onexecute?: unknown } | undefined;
  return typeof options?.onexecute === "function";
}

/** Installed once by `createDb` on each pool's client. */
export function installQueryAbortRouting(client: Sql): void {
  if (routedClients.has(client)) return;
  routedClients.add(client);
  const unsafe = client.unsafe;
  client.unsafe = function routedUnsafe(...args: unknown[]) {
    const scope = scopes.getStore();
    if (!scope || scope.owner !== client || !scope.open) {
      return (unsafe as (...values: unknown[]) => unknown).apply(client, args);
    }
    if (scope.signal.aborted) throw new QueryAbortedError();
    if (startsTransaction(args)) {
      return (unsafe as (...values: unknown[]) => unknown).apply(client, args);
    }
    const query = (scope.reserved.unsafe as (...values: unknown[]) => unknown)(...args) as DriverQuery;
    track(scope, query);
    return query;
  } as Sql["unsafe"];
}

function track(scope: Scope, query: DriverQuery): void {
  scope.pending.add(query);
  const { resolve, reject } = query;
  const settle = () => {
    if (!scope.pending.delete(query)) return;
    releaseSoon(scope);
  };
  // postgres.js settles every query through these two fields. Wrapping them
  // tells, synchronously, which queries are still unsettled when the signal
  // aborts, so a cancel is never sent for a query that has already finished.
  query.resolve = (value) => {
    settle();
    return resolve(value);
  };
  query.reject = (error) => {
    settle();
    return reject(error);
  };
}

/**
 * postgres.js settles a query while it still handles the server's reply.
 * Releasing the connection in that call would hand it back to the pool
 * twice, so the release waits for the current task to finish.
 */
function releaseSoon(scope: Scope): void {
  queueMicrotask(() => releaseWhenIdle(scope));
}

function releaseWhenIdle(scope: Scope): void {
  if (scope.released || scope.open || scope.pending.size > 0 || scope.cancelling > 0) return;
  scope.released = true;
  scope.reserved.release();
}

function settleWithin<T>(promise: Promise<T>, limitMs: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, limitMs);
    timer.unref?.();
  });
  return Promise.race([promise.catch(() => undefined), limit]).finally(() => clearTimeout(timer));
}

function cancelPending(scope: Scope): void {
  for (const query of [...scope.pending]) {
    const canceller = query.canceller;
    if (!canceller) continue;
    // Same as `query.cancel()`, which drops the promise that says when the
    // cancel request was delivered.
    query.canceller = null;
    scope.cancelling += 1;
    void settleWithin(canceller(query), CANCEL_SETTLE_LIMIT_MS).then(() => {
      scope.cancelling -= 1;
      releaseSoon(scope);
    });
  }
}

function reserveUnlessAborted(pool: Sql, signal: AbortSignal): Promise<ReservedSql> {
  const reservation = pool.reserve();
  return new Promise<ReservedSql>((resolve, reject) => {
    const onAbort = () => {
      reject(new QueryAbortedError());
      // The pool hands the connection out later; give it straight back.
      reservation.then((reserved) => reserved.release(), () => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reservation.then(
      (reserved) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return;
        resolve(reserved);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function runQueryAbortScope<T>(input: {
  owner: Sql;
  pool: Sql;
  signal: AbortSignal;
  work: () => Promise<T>;
}): Promise<T> {
  const { owner, pool, signal, work } = input;
  if (signal.aborted) throw new QueryAbortedError();
  const reserved = await reserveUnlessAborted(pool, signal);
  if (signal.aborted) {
    reserved.release();
    throw new QueryAbortedError();
  }
  const scope: Scope = {
    owner,
    signal,
    reserved,
    open: true,
    pending: new Set(),
    cancelling: 0,
    released: false,
  };
  const onAbort = () => cancelPending(scope);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // Await inside the scope: a drizzle query is a lazy thenable that runs
    // only when awaited, and it must start while the scope is active.
    return await scopes.run(scope, async () => await work());
  } finally {
    signal.removeEventListener("abort", onAbort);
    scope.open = false;
    releaseSoon(scope);
  }
}
