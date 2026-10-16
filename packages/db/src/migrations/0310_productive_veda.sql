-- Data only; the DDL is in the previous migration. No agent bindings are
-- inserted here: a boot job applies the full binding checks after migrations.
-- 0. The creator owns each existing account.
UPDATE "public"."ai_accounts"
SET "owner_user_id" = "created_by_user_id"
WHERE "owner_user_id" IS NULL
  AND "created_by_user_id" IS NOT NULL;--> statement-breakpoint
-- 1. Every existing account came from a host pool.
UPDATE "public"."ai_accounts"
SET "origin" = 'legacy_host_pool'
WHERE "origin" = 'pool';--> statement-breakpoint
-- 2. An account switched out of its host pool becomes disabled, which its
-- owner can resume.
UPDATE "public"."ai_accounts"
SET "status" = 'disabled'
WHERE "pool_enabled" = false
  AND "status" = 'active';--> statement-breakpoint
-- 3a. An ssh_host or mac device whose mapped SSH environments all share one
-- host and port gets the key `ssh:<lower(host)>:<port>` (port 22 when unset).
-- A device whose environments disagree, or whose key another device also
-- claims, is skipped; the pre-deploy report lists it.
UPDATE "public"."ai_account_hosts" AS h
SET "external_key" = k."key"
FROM (
  SELECT c."host_id", c."key", count(*) OVER (PARTITION BY c."key") AS "claims"
  FROM (
    SELECT s."host_id", min(s."key") AS "key"
    FROM (
      SELECT m."host_id",
        CASE
          WHEN btrim(coalesce(e."config" ->> 'host', '')) <> ''
            AND coalesce(nullif(btrim(e."config" ->> 'port'), ''), '22') ~ '^[0-9]{1,5}$'
          THEN 'ssh:' || lower(btrim(e."config" ->> 'host')) || ':'
            || coalesce(nullif(btrim(e."config" ->> 'port'), ''), '22')::integer::text
        END AS "key"
      FROM "public"."ai_account_host_environments" AS m
      INNER JOIN "public"."environments" AS e ON e."id" = m."environment_id"
      INNER JOIN "public"."ai_account_hosts" AS d ON d."id" = m."host_id"
      WHERE e."driver" = 'ssh'
        AND d."kind" IN ('ssh_host', 'mac')
    ) AS s
    GROUP BY s."host_id"
    HAVING count(*) = count(s."key")
      AND count(DISTINCT s."key") = 1
  ) AS c
) AS k
WHERE h."id" = k."host_id"
  AND k."claims" = 1
  AND h."external_key" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "public"."ai_account_hosts" AS other
    WHERE other."external_key" = k."key"
  );--> statement-breakpoint
-- 3b. The server device mapped to the local environment gets the key `local`.
UPDATE "public"."ai_account_hosts" AS h
SET "external_key" = 'local'
FROM "public"."ai_account_host_environments" AS m
INNER JOIN "public"."environments" AS e ON e."id" = m."environment_id"
WHERE m."host_id" = h."id"
  AND e."driver" = 'local'
  AND h."kind" = 'server'
  AND h."external_key" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "public"."ai_account_hosts" AS other
    WHERE other."external_key" = 'local'
  );
