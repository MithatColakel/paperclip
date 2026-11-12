CREATE TABLE "user_password_reset_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_password_reset_links" ADD CONSTRAINT "user_password_reset_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_password_reset_links" ADD CONSTRAINT "user_password_reset_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_password_reset_links_token_hash_unique_idx" ON "user_password_reset_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_password_reset_links_user_open_idx" ON "user_password_reset_links" USING btree ("user_id","used_at","revoked_at");--> statement-breakpoint
CREATE INDEX "user_password_reset_links_company_idx" ON "user_password_reset_links" USING btree ("company_id","created_at");