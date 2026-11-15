ALTER TABLE "ai_accounts" ADD COLUMN "provider_quota" jsonb;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "provider_quota_observed_at" timestamp with time zone;