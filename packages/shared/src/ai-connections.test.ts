import { describe, expect, it } from "vitest";
import {
  AI_CONNECTION_POOL_MAX_MEMBERS,
  aiConnectionBindingSchema,
  createAiConnectionSchema,
  isAiConnectionCompatible,
  replaceAiConnectionPoolSchema,
} from "./ai-connections.js";

const token = `sk-ant-oat01-${"Ab3_-".repeat(19)}`;
const base = { name: "Claude account", ownership: "personal" as const };

describe("createAiConnectionSchema credentials", () => {
  it("accepts a Claude subscription with a setup token", () => {
    const parsed = createAiConnectionSchema.parse({ ...base, provider: "anthropic", method: "subscription", setupToken: token });
    expect(parsed.setupToken).toBe(token);
  });

  it("keeps the browser sign-in and API key paths", () => {
    expect(createAiConnectionSchema.safeParse({ ...base, provider: "anthropic", method: "subscription", loginSessionId: "session-1" }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({ ...base, provider: "anthropic", method: "api_key", apiKey: "sk-ant-api03-key" }).success).toBe(true);
  });

  it.each([
    ["a malformed token", { provider: "anthropic", method: "subscription", setupToken: "sk-ant-api03-not-a-setup-token" }],
    ["a token for another provider", { provider: "openai", method: "subscription", setupToken: token }],
    ["a token on the API key method", { provider: "anthropic", method: "api_key", setupToken: token }],
    ["a token together with a login session", { provider: "anthropic", method: "subscription", setupToken: token, loginSessionId: "session-1" }],
    ["an API key on the subscription method", { provider: "anthropic", method: "subscription", apiKey: "sk-ant-api03-key" }],
    ["no credential", { provider: "anthropic", method: "subscription" }],
  ])("rejects %s", (_label, input) => {
    expect(createAiConnectionSchema.safeParse({ ...base, ...input }).success).toBe(false);
  });
});

describe("company account pool contract", () => {
  const member = (n: number) => ({ connectionId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, grantId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
  it("binds an agent to the pool without naming an account", () => {
    const binding = { provider: "anthropic", method: "subscription", mode: "company_pool" } as const;
    expect(aiConnectionBindingSchema.parse(binding)).toEqual(binding);
    expect(aiConnectionBindingSchema.safeParse({ ...binding, connectionId: member(1).connectionId }).success).toBe(false);
    expect(isAiConnectionCompatible({ ...binding, method: "api_key" }, "claude_local")).toBe(true);
  });
  it("accepts an ordered list of distinct accounts up to the limit", () => {
    expect(replaceAiConnectionPoolSchema.safeParse({ provider: "anthropic", members: [member(1), member(2)] }).success).toBe(true);
    expect(replaceAiConnectionPoolSchema.safeParse({ provider: "anthropic", members: [member(1), member(1)] }).success).toBe(false);
    const tooMany = Array.from({ length: AI_CONNECTION_POOL_MAX_MEMBERS + 1 }, (_, i) => member(i));
    expect(replaceAiConnectionPoolSchema.safeParse({ provider: "anthropic", members: tooMany }).success).toBe(false);
  });
});
