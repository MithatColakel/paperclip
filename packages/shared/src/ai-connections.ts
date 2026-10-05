import { z } from "zod";

/** Runtime authentication is a separate transport, never a tool or channel. */
export const connectionPurposeTransportSchema = z.discriminatedUnion(
  "connectionPurpose",
  [
    z.object({
      connectionPurpose: z.literal("tool"),
      transport: z.enum(["mcp_remote", "rest_api", "local_stdio"]),
    }),
    z.object({
      connectionPurpose: z.literal("channel"),
      transport: z.enum(["chat_sdk", "rest_api"]),
      config: z.object({ provider: z.string().optional() }).passthrough().optional(),
    }).refine(
      (connection) => connection.transport === "chat_sdk" || connection.config?.provider === "agentmail",
      { message: "REST channel connections require the AgentMail provider", path: ["config", "provider"] },
    ),
    z.object({
      connectionPurpose: z.literal("ai"),
      transport: z.literal("runtime_auth"),
    }),
  ],
);
export type ConnectionPurposeTransport = z.infer<
  typeof connectionPurposeTransportSchema
>;

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "xai",
] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export const aiAuthMethodSchema = z.enum(["subscription", "api_key"]);
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiAuthMethod = z.infer<typeof aiAuthMethodSchema>;
const requirement = { provider: aiProviderSchema, method: aiAuthMethodSchema };
export const aiConnectionBindingSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: aiProviderSchema,
    // Retained on the wire for older servers during rolling upgrades. The
    // responsible user's provider default determines the actual run method.
    method: aiAuthMethodSchema,
    mode: z.literal("responsible_user"),
  }).strict(),
  z
    .object({
      ...requirement,
      mode: z.literal("shared"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
  z.object({
    provider: aiProviderSchema,
    // Any method in the company pool may serve the run; kept for wire parity.
    method: aiAuthMethodSchema,
    // Ordered company-shared accounts; a usage-limited account hands the run to the next one.
    mode: z.literal("company_pool"),
  }).strict(),
  z
    .object({
      ...requirement,
      // Legacy wire format only; human access still applies. New UI never creates it.
      mode: z.literal("delegated"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
]);
export type AiConnectionBinding = z.infer<typeof aiConnectionBindingSchema>;
export const aiConnectionMetadataSchema = z.object(requirement).strict();
export type AiConnectionMetadata = z.infer<typeof aiConnectionMetadataSchema>;

/** Existing integrations only. This table describes compatibility, never routing. */
export const AI_CONNECTION_CAPABILITIES: Record<
  AiProvider,
  {
    name: string;
    methods: Partial<
      Record<AiAuthMethod, { adapters: readonly string[]; envKey: string }>
    >;
  }
> = {
  anthropic: {
    name: "Claude",
    methods: {
      subscription: {
        adapters: ["claude_local"],
        envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      api_key: { adapters: ["claude_local"], envKey: "ANTHROPIC_API_KEY" },
    },
  },
  openai: {
    name: "OpenAI",
    methods: {
      subscription: { adapters: ["codex_local"], envKey: "CODEX_HOME" },
      api_key: { adapters: ["codex_local"], envKey: "OPENAI_API_KEY" },
    },
  },
  openrouter: {
    name: "OpenRouter",
    methods: {
      api_key: { adapters: ["opencode_local"], envKey: "OPENROUTER_API_KEY" },
    },
  },
  xai: {
    name: "Grok",
    methods: {
      subscription: { adapters: ["grok_local"], envKey: "GROK_HOME" },
      api_key: { adapters: ["grok_local"], envKey: "XAI_API_KEY" },
    },
  },
};
export function isAiConnectionCompatible(
  requirement: AiConnectionMetadata | AiConnectionBinding,
  adapterType: string,
  model?: unknown,
  runnerProvider?: unknown,
  acpxAgent?: unknown,
): boolean {
  if (adapterType === "paperclip_runner")
    adapterType =
      runnerProvider === "claude" ||
      (runnerProvider === "acpx" && acpxAgent === "claude")
        ? "claude_local"
        : runnerProvider === "acpx" && acpxAgent === "grok"
          ? "grok_local"
        : runnerProvider === "codex"
          ? "codex_local"
          : runnerProvider === "opencode"
            ? "opencode_local"
            : "unsupported";
  const methods = AI_CONNECTION_CAPABILITIES[requirement.provider].methods;
  const candidates = "mode" in requirement && (requirement.mode === "responsible_user" || requirement.mode === "company_pool")
    ? Object.values(methods)
    : requirement.method ? [methods[requirement.method]] : [];
  return (
    candidates.some((method) => method?.adapters.includes(adapterType)) &&
    (requirement.provider !== "openrouter" ||
      (typeof model === "string" && model.startsWith("openrouter/")))
  );
}
export type AiConnectionUnavailableReason =
  | "responsible_user_missing"
  | "membership_missing"
  | "default_missing"
  | "connection_missing"
  | "connection_unavailable"
  | "incompatible"
  | "access_denied"
  | "credential_missing"
  | "pool_exhausted";
export interface AiConnectionAttribution {
  connectionId: string;
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  mode: AiConnectionBinding["mode"];
  responsibleUserId: string | null;
  /** Position of the selected account in the company pool (company_pool only). */
  poolPriority?: number;
}
export type AiConnectionResolution =
  | { ok: true; attribution: AiConnectionAttribution }
  | { ok: false; reason: AiConnectionUnavailableReason; message: string };

export interface AiManagedConnectionSummary {
  id: string;
  grantId: string;
  companyId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  name: string;
  accountLabel?: string;
  ownership: "personal" | "shared";
  ownerUserId?: string;
  ownerName?: string;
  isDefault: boolean;
  status: "connected" | "needs_attention" | "expired" | "revoked";
  unavailableReason?: string;
}
/** A long-lived Claude subscription token printed by `claude setup-token`. */
export const CLAUDE_SETUP_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{80,}$/;

export const createAiConnectionSchema = z
  .object({
    ...requirement,
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    apiKey: z.string().trim().min(1).max(32768).optional(),
    loginSessionId: z.string().max(128).optional(),
    // Lets a Claude subscription connect where no environment can run the
    // browser sign-in (SSH hosts, hosted instances): the user runs
    // `claude setup-token` anywhere and pastes the result.
    setupToken: z.string().trim().min(1).max(4096).optional(),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!AI_CONNECTION_CAPABILITIES[v.provider].methods[v.method])
      ctx.addIssue({ code: "custom", message: "Unsupported sign-in method" });
    const credentials = [v.apiKey, v.loginSessionId, v.setupToken].filter(Boolean).length;
    if (
      credentials !== 1 ||
      (v.method === "api_key" ? !v.apiKey : Boolean(v.apiKey))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide exactly the credential for the selected sign-in method",
      });
    }
    if (v.setupToken) {
      if (v.provider !== "anthropic" || v.method !== "subscription")
        ctx.addIssue({ code: "custom", message: "A setup token only connects a Claude subscription" });
      else if (!CLAUDE_SETUP_TOKEN_PATTERN.test(v.setupToken))
        ctx.addIssue({ code: "custom", message: "This is not a Claude setup token. Run `claude setup-token` and paste the whole token." });
    }
  });
export type CreateAiConnection = z.infer<typeof createAiConnectionSchema>;

export const aiConnectionLoginIntentSchema = z
  .object({
    provider: aiProviderSchema,
    method: z.literal("subscription"),
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
  })
  .strict();
export type AiConnectionLoginIntent = z.infer<
  typeof aiConnectionLoginIntentSchema
>;

export const localAiConnectionSchema = aiConnectionLoginIntentSchema.extend({
  localSessionId: z.string().uuid().optional(),
});
export const localAiLoginStartSchema = aiConnectionLoginIntentSchema.extend({ restart: z.boolean().optional() });
export interface LocalAiLoginStatus {
  status: "ready" | "sign_in_required" | "expired";
}
export interface LocalAiLoginAttempt {
  sessionId: string;
  command: string;
  expiresAt: string;
}

/** Preview-era copies of rotating local credentials must be reconnected. */
export function aiSubscriptionNeedsIsolatedLogin(config: Record<string, unknown> | undefined): boolean {
  const metadata = aiConnectionMetadataSchema.safeParse(config?.ai);
  return metadata.success && metadata.data.method === "subscription" &&
    (metadata.data.provider === "openai" || metadata.data.provider === "xai") &&
    config?.aiIsolatedSubscription !== true;
}

/** Without a provider reset time, a usage-limited account is skipped for this long. */
export const AI_CONNECTION_POOL_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
/** A subscription whose usage window reaches this percentage is skipped before it fails a run. */
export const AI_CONNECTION_POOL_USAGE_THRESHOLD_PERCENT = 95;
/** Usage is re-read from the provider at most this often per account. */
export const AI_CONNECTION_POOL_USAGE_PROBE_TTL_MS = 5 * 60 * 1000;
export const AI_CONNECTION_POOL_MAX_MEMBERS = 20;

export type AiConnectionQuotaReason = "provider_quota" | "usage_threshold";
export type AiConnectionQuotaSource = "run_failure" | "usage_probe" | "manual";
export const AI_CONNECTION_POOL_USAGE_WINDOW_KEYS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;
export type AiConnectionPoolUsageWindowKey = (typeof AI_CONNECTION_POOL_USAGE_WINDOW_KEYS)[number];
export interface AiConnectionPoolUsageWindow {
  key: AiConnectionPoolUsageWindowKey;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface AiConnectionPoolMemberSummary {
  connectionId: string;
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  priority: number;
  name: string;
  accountLabel?: string;
  status: AiManagedConnectionSummary["status"];
  exhaustedUntil: string | null;
  quotaReason: AiConnectionQuotaReason | null;
  quotaSource: AiConnectionQuotaSource | null;
  usageCheckedAt: string | null;
  usageWindows: AiConnectionPoolUsageWindow[];
}
export interface AiConnectionPoolSummary {
  companyId: string;
  provider: AiProvider;
  members: AiConnectionPoolMemberSummary[];
  /** Company-shared accounts of this provider that are not in the pool yet. */
  candidates: Array<Pick<AiConnectionPoolMemberSummary, "connectionId" | "grantId" | "method" | "name" | "accountLabel" | "status">>;
}

export const replaceAiConnectionPoolSchema = z
  .object({
    provider: aiProviderSchema,
    members: z
      .array(z.object({ connectionId: z.string().uuid(), grantId: z.string().uuid() }).strict())
      .max(AI_CONNECTION_POOL_MAX_MEMBERS),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.members.map((m) => m.connectionId)).size !== v.members.length)
      ctx.addIssue({ code: "custom", message: "Each account can appear in the pool only once", path: ["members"] });
  });
export type ReplaceAiConnectionPool = z.infer<typeof replaceAiConnectionPoolSchema>;
