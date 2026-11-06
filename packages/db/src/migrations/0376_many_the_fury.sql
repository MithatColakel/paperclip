ALTER TABLE "companies" ADD COLUMN "default_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environments_company_idx" ON "environments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "projects_company_default_environment_idx" ON "projects" USING btree ("company_id","default_environment_id");--> statement-breakpoint
UPDATE "projects" AS p
SET "default_environment_id" = e."id"
FROM "environments" AS e
WHERE p."default_environment_id" IS NULL
  AND e."id" = CASE
    WHEN p."execution_workspace_policy" ->> 'environmentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (p."execution_workspace_policy" ->> 'environmentId')::uuid
  END;
