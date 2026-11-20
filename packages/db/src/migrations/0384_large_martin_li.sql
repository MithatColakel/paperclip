ALTER TABLE "device_login_limits" ADD COLUMN "codex_fallback_blocked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_login_limits" ADD COLUMN "codex_fallback_block_reason" text;--> statement-breakpoint
ALTER TABLE "device_login_limits" ADD COLUMN "codex_fallback_block_run_id" uuid;--> statement-breakpoint
ALTER TABLE "device_login_limits" ADD CONSTRAINT "device_login_limits_codex_block_reason_check" CHECK ("device_login_limits"."codex_fallback_block_reason" is null or "device_login_limits"."codex_fallback_block_reason" in ('codex_limit','codex_failed'));