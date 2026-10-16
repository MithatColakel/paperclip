CREATE TABLE "ai_account_agent_bindings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"account_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"migration_note" text,
	"reviewed_at" timestamp with time zone,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_account_agent_bindings_mode_check" CHECK ("ai_account_agent_bindings"."mode" in ('pool_account','device_login')),
	CONSTRAINT "ai_account_agent_bindings_source_check" CHECK ("ai_account_agent_bindings"."source" in ('manual','migrated_host_pool','migrated_company_pool')),
	CONSTRAINT "ai_account_agent_bindings_account_check" CHECK ("ai_account_agent_bindings"."mode" = 'pool_account' or "ai_account_agent_bindings"."account_id" is null)
);
--> statement-breakpoint
CREATE TABLE "ai_account_run_slots" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deferred_data_migrations" (
	"key" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"summary" jsonb,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "environment_availability" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"label" text,
	"message" text,
	"target_key" text,
	"accepted_credential_types" text[],
	"unavailable_since" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"check_failures" integer DEFAULT 0 NOT NULL,
	"wake_epoch" bigint DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_availability_state_check" CHECK ("environment_availability"."state" in ('available','unavailable','retired')),
	CONSTRAINT "environment_availability_source_check" CHECK ("environment_availability"."source" in ('lease_error','probe','check','plugin_report'))
);
--> statement-breakpoint
CREATE TABLE "execution_wait_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"notify_after_hours" integer,
	"notify_pm_on_device_wait" boolean DEFAULT false NOT NULL,
	"notify_pm_on_account_wait" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_wait_settings_notify_after_hours_check" CHECK ("execution_wait_settings"."notify_after_hours" is null or "execution_wait_settings"."notify_after_hours" between 0 and 168)
);
--> statement-breakpoint
CREATE TABLE "resource_wait_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"scope" text NOT NULL,
	"resource_key" text NOT NULL,
	"environment_id" uuid,
	"device_id" uuid,
	"account_id" uuid,
	"since" timestamp with time zone NOT NULL,
	"current_run_id" uuid,
	"resume_at" timestamp with time zone,
	"resume_at_source" text,
	"next_check_at" timestamp with time zone,
	"checks" integer DEFAULT 0 NOT NULL,
	"gate_checked_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"long_notified_at" timestamp with time zone,
	"resolved_notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_wait_episodes_kind_check" CHECK ("resource_wait_episodes"."kind" in ('environment','ai_account','device_slots')),
	CONSTRAINT "resource_wait_episodes_scope_check" CHECK ("resource_wait_episodes"."scope" in ('target','admission','account','device')),
	CONSTRAINT "resource_wait_episodes_resume_at_source_check" CHECK ("resource_wait_episodes"."resume_at_source" is null or "resource_wait_episodes"."resume_at_source" in ('provider','estimated','check')),
	CONSTRAINT "resource_wait_episodes_resolution_check" CHECK ("resource_wait_episodes"."resolution" is null or "resource_wait_episodes"."resolution" in ('resolved','superseded','abandoned','refused'))
);
--> statement-breakpoint
CREATE TABLE "resource_wait_notices" (
	"company_id" uuid NOT NULL,
	"notice_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_wait_notices_pk" PRIMARY KEY("company_id","notice_key")
);
--> statement-breakpoint
ALTER TABLE "ai_account_hosts" DROP CONSTRAINT "ai_account_hosts_kind_check";--> statement-breakpoint
ALTER TABLE "ai_accounts" DROP CONSTRAINT "ai_accounts_host_id_ai_account_hosts_id_fk";
--> statement-breakpoint
DROP INDEX "ai_accounts_email_hint_uq";--> statement-breakpoint
ALTER TABLE "ai_accounts" ALTER COLUMN "host_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "target_key" text;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "target_provider" text;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "target_match" jsonb;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "target_state" jsonb;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "target_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "managed_by_plugin_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "owner_source" text;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD COLUMN "over_limit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "limit_source" text;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "limit_strikes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "limit_episode_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "limit_probe_run_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "auth_suspect_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "auth_suspect_run_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "origin" text DEFAULT 'pool' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "admin_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "admin_disabled_by_user_id" text;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD COLUMN "admin_disabled_reason" text;--> statement-breakpoint
ALTER TABLE "ai_account_agent_bindings" ADD CONSTRAINT "ai_account_agent_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account_agent_bindings" ADD CONSTRAINT "ai_account_agent_bindings_account_id_ai_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ai_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account_agent_bindings" ADD CONSTRAINT "ai_account_agent_bindings_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account_run_slots" ADD CONSTRAINT "ai_account_run_slots_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account_run_slots" ADD CONSTRAINT "ai_account_run_slots_device_id_ai_account_hosts_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."ai_account_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account_run_slots" ADD CONSTRAINT "ai_account_run_slots_account_id_ai_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ai_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_availability" ADD CONSTRAINT "environment_availability_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_wait_settings" ADD CONSTRAINT "execution_wait_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_wait_episodes" ADD CONSTRAINT "resource_wait_episodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_wait_episodes" ADD CONSTRAINT "resource_wait_episodes_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_wait_episodes" ADD CONSTRAINT "resource_wait_episodes_company_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_wait_notices" ADD CONSTRAINT "resource_wait_notices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_account_agent_bindings_account_idx" ON "ai_account_agent_bindings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ai_account_agent_bindings_company_account_idx" ON "ai_account_agent_bindings" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE INDEX "ai_account_run_slots_device_idx" ON "ai_account_run_slots" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "environment_availability_state_next_check_idx" ON "environment_availability" USING btree ("state","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_wait_episodes_open_uq" ON "resource_wait_episodes" USING btree ("company_id",coalesce("issue_id"::text, 'agent:' || "agent_id"::text)) WHERE "resource_wait_episodes"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "resource_wait_episodes_company_open_idx" ON "resource_wait_episodes" USING btree ("company_id") WHERE "resource_wait_episodes"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "resource_wait_episodes_current_run_idx" ON "resource_wait_episodes" USING btree ("current_run_id");--> statement-breakpoint
CREATE INDEX "resource_wait_episodes_company_issue_idx" ON "resource_wait_episodes" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "resource_wait_episodes_company_agent_idx" ON "resource_wait_episodes" USING btree ("company_id","agent_id");--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_host_id_ai_account_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."ai_account_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_account_hosts_external_key_uq" ON "ai_account_hosts" USING btree ("external_key") WHERE "ai_account_hosts"."external_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_account_hosts_target_key_uq" ON "ai_account_hosts" USING btree ("target_key") WHERE "ai_account_hosts"."target_key" is not null;--> statement-breakpoint
CREATE INDEX "ai_accounts_owner_idx" ON "ai_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_accounts_owner_email_hint_uq" ON "ai_accounts" USING btree (coalesce("owner_user_id", "created_by_user_id"),lower("email_hint")) WHERE "ai_accounts"."email_hint" is not null;--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD CONSTRAINT "ai_account_hosts_owner_source_check" CHECK ("ai_account_hosts"."owner_source" is null or "ai_account_hosts"."owner_source" in ('plugin'));--> statement-breakpoint
ALTER TABLE "ai_account_hosts" ADD CONSTRAINT "ai_account_hosts_kind_check" CHECK ("ai_account_hosts"."kind" in ('server','ssh_host','mac','external'));--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_limit_source_check" CHECK ("ai_accounts"."limit_source" is null or "ai_accounts"."limit_source" in ('provider','estimated'));--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_origin_check" CHECK ("ai_accounts"."origin" in ('pool','legacy_host_pool'));