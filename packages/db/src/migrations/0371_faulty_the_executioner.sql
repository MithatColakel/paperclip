CREATE TABLE "ai_connection_pool_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_connection_pool_members_provider_check" CHECK ("ai_connection_pool_members"."provider" in ('anthropic','openai','openrouter','xai')),
	CONSTRAINT "ai_connection_pool_members_priority_check" CHECK ("ai_connection_pool_members"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_connection_quota_states" (
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"exhausted_until" timestamp with time zone,
	"reason" text,
	"source" text,
	"last_run_id" uuid,
	"usage_checked_at" timestamp with time zone,
	"usage_windows" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_connection_quota_states_pk" PRIMARY KEY("company_id","connection_id"),
	CONSTRAINT "ai_connection_quota_states_reason_check" CHECK ("ai_connection_quota_states"."reason" is null or "ai_connection_quota_states"."reason" in ('provider_quota','usage_threshold')),
	CONSTRAINT "ai_connection_quota_states_source_check" CHECK ("ai_connection_quota_states"."source" is null or "ai_connection_quota_states"."source" in ('run_failure','usage_probe','manual'))
);
--> statement-breakpoint
ALTER TABLE "ai_connection_pool_members" ADD CONSTRAINT "ai_connection_pool_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connection_pool_members" ADD CONSTRAINT "ai_connection_pool_members_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connection_pool_members" ADD CONSTRAINT "ai_connection_pool_members_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connection_quota_states" ADD CONSTRAINT "ai_connection_quota_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connection_quota_states" ADD CONSTRAINT "ai_connection_quota_states_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_connection_pool_members_connection_uq" ON "ai_connection_pool_members" USING btree ("company_id","provider","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_connection_pool_members_priority_uq" ON "ai_connection_pool_members" USING btree ("company_id","provider","priority");--> statement-breakpoint
CREATE INDEX "ai_connection_quota_states_exhausted_idx" ON "ai_connection_quota_states" USING btree ("company_id","exhausted_until");