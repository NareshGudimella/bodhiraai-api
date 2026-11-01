ALTER TABLE "schools" ADD COLUMN "is_direct" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "schools_is_direct_unique" ON "schools" USING btree ("is_direct") WHERE "schools"."is_direct";--> statement-breakpoint
-- organizations data: begin
-- not in legacy: Organizations (2026-11-01). Creates "Bodhira Direct" (the
-- Super Admin's organization for self sign-up students) and moves the
-- individual (B2C) students into it, then parents whose linked children are
-- all in it. Teachers with no school stay as they are. Idempotent: a database
-- with no users (before a data copy) is left empty, and `npm run
-- db:organizations` runs this section again after the copy.
INSERT INTO "schools" ("id", "name", "slug", "code", "country", "plan", "max_teachers", "max_students", "ai_daily_token_limit", "plan_expires_at", "status", "is_direct", "created_at", "updated_at")
SELECT (SELECT coalesce(max("id"), 0) + 1 FROM "schools"), 'Bodhira Direct', 'bodhira-direct', 'BODHIRA-DIRECT', 'India', 'free', 100000, 1000000, 0, NULL, 'active', true, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
WHERE EXISTS (SELECT 1 FROM "users") AND NOT EXISTS (SELECT 1 FROM "schools" WHERE "is_direct");
--> statement-breakpoint
-- The id was set explicitly (copied ids may be ahead of the identity sequence).
SELECT setval(pg_get_serial_sequence('"schools"', 'id'), (SELECT max("id") FROM "schools"))
WHERE EXISTS (SELECT 1 FROM "schools");
--> statement-breakpoint
UPDATE "users" SET "school_id" = "d"."id"
FROM (SELECT "id" FROM "schools" WHERE "is_direct") AS "d"
WHERE "users"."role" = 'student' AND "users"."school_id" IS NULL;
--> statement-breakpoint
UPDATE "users" AS "p" SET "school_id" = "d"."id"
FROM (SELECT "id" FROM "schools" WHERE "is_direct") AS "d"
WHERE "p"."role" = 'parent' AND "p"."school_id" IS NULL
  AND EXISTS (SELECT 1 FROM "parent_student" "ps" WHERE "ps"."parent_id" = "p"."id")
  AND NOT EXISTS (
    SELECT 1 FROM "parent_student" "ps"
      JOIN "users" "c" ON "c"."id" = "ps"."student_id"
     WHERE "ps"."parent_id" = "p"."id" AND "c"."school_id" IS DISTINCT FROM "d"."id"
  );
-- organizations data: end
