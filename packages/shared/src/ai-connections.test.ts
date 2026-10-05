import { describe, expect, it } from "vitest";
import { createAiConnectionSchema } from "./ai-connections.js";

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
