CREATE TABLE "ai_account_host_environments" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_account_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"max_accounts" integer DEFAULT 3 NOT NULL,
	"overflow_to_other_accounts" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_account_hosts_kind_check" CHECK ("ai_account_hosts"."kind" in ('server','ssh_host','mac')),
	CONSTRAINT "ai_account_hosts_max_accounts_check" CHECK ("ai_account_hosts"."max_accounts" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "ai_account_projects" (
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_account_projects_pk" PRIMARY KEY("account_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "ai_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"provider" text DEFAULT 'anthropic' NOT NULL,
	"credential_type" text NOT NULL,
	"label" text NOT NULL,
	"email_hint" text,
	"plan" text,
	"pool_enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"credential_material" jsonb NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"credential_hint" text,
	"exhausted_until" timestamp with time zone,
	"limit_reason" text,
	"limit_run_id" uuid,
	"last_limited_at" timestamp with time zone,
	"last_selected_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_accounts_provider_check" CHECK ("ai_accounts"."provider" in ('anthropic')),
	CONSTRAINT "ai_accounts_credential_type_check" CHECK ("ai_accounts"."credential_type" in ('subscription','api_key')),
	CONSTRAINT "ai_accounts_status_check" CHECK ("ai_accounts"."status" in ('active','auth_failed','disabled')),
	CONSTRAINT "ai_accounts_limit_reason_check" CHECK ("ai_accounts"."limit_reason" is null or "ai_accounts"."limit_reason" in ('provider_quota','credit_balance','manual'))
);
--> statement-breakpoint
ALTER TABLE "ai_account_host_environments" ADD CONSTRAINT "ai_account_host_environments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account_host_environments" ADD CONSTRAINT "ai_account_host_environments_host_id_ai_account_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."ai_account_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account_projects" ADD CONSTRAINT "ai_account_projects_account_id_ai_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ai_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account_projects" ADD CONSTRAINT "ai_account_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_host_id_ai_account_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."ai_account_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_account_host_environments_host_idx" ON "ai_account_host_environments" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_account_hosts_name_uq" ON "ai_account_hosts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ai_account_projects_project_idx" ON "ai_account_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ai_accounts_host_idx" ON "ai_accounts" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_accounts_fingerprint_uq" ON "ai_accounts" USING btree ("credential_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_accounts_email_hint_uq" ON "ai_accounts" USING btree (lower("email_hint")) WHERE "ai_accounts"."email_hint" is not null;