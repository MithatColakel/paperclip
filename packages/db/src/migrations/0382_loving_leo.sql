CREATE TABLE "device_login_limits" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"device_id" uuid,
	"exhausted_until" timestamp with time zone,
	"limit_reason" text,
	"limit_source" text,
	"limit_strikes" integer DEFAULT 0 NOT NULL,
	"limit_episode_started_at" timestamp with time zone,
	"limit_probe_run_id" uuid,
	"limit_run_id" uuid,
	"last_limited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_login_limits_reason_check" CHECK ("device_login_limits"."limit_reason" is null or "device_login_limits"."limit_reason" in ('provider_quota','credit_balance')),
	CONSTRAINT "device_login_limits_source_check" CHECK ("device_login_limits"."limit_source" is null or "device_login_limits"."limit_source" in ('provider','estimated'))
);
--> statement-breakpoint
ALTER TABLE "resource_wait_episodes" DROP CONSTRAINT "resource_wait_episodes_kind_check";--> statement-breakpoint
ALTER TABLE "device_login_limits" ADD CONSTRAINT "device_login_limits_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_login_limits" ADD CONSTRAINT "device_login_limits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_login_limits" ADD CONSTRAINT "device_login_limits_device_id_ai_account_hosts_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."ai_account_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_login_limits_company_idx" ON "device_login_limits" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "device_login_limits_device_idx" ON "device_login_limits" USING btree ("device_id");--> statement-breakpoint
ALTER TABLE "resource_wait_episodes" ADD CONSTRAINT "resource_wait_episodes_kind_check" CHECK ("resource_wait_episodes"."kind" in ('environment','ai_account','device_slots','device_login'));