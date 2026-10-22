import { randomUUID } from "node:crypto";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_PROVIDERS } from "@paperclipai/shared";
import { aiConnectionPoolMembers } from "./schema/ai_connection_pools.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Fork: PUT /companies/:id/ai-connections/pool validates its provider with
// aiProviderSchema, so the pool member CHECK must accept every AI_PROVIDERS
// entry. A narrower CHECK rejects the insert (23514) and the request fails with
// a 500 instead of being stored.

describe("ai_connection_pool_members provider check", () => {
  it("lists every AI provider the API accepts", () => {
    const check = getTableConfig(aiConnectionPoolMembers).checks
      .find((candidate) => candidate.name === "ai_connection_pool_members_provider_check");
    expect(check).toBeDefined();
    const expression = new PgDialect().sqlToQuery(check!.value).sql;
    expect([...expression.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()).toEqual([...AI_PROVIDERS].sort());
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("ai_connection_pool_members provider check on a migrated database", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-pool-provider-check-");
    sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await sql?.end();
    await database?.cleanup();
  });

  it("stores a member for every AI provider and still rejects an unknown one", async () => {
    // Replica mode skips the foreign-key triggers, so a member needs no company,
    // connection or grant here; CHECK constraints still apply.
    const insert = (provider: string) => sql!.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO ai_connection_pool_members (company_id, provider, connection_id, grant_id, priority)
        VALUES (${randomUUID()}, ${provider}, ${randomUUID()}, ${randomUUID()}, 0)`;
    });
    for (const provider of AI_PROVIDERS) await insert(provider);
    await expect(insert("unknown")).rejects.toMatchObject({
      code: "23514",
      constraint_name: "ai_connection_pool_members_provider_check",
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
