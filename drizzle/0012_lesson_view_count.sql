ALTER TABLE "lesson_progress" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;
-- Existing rows were watched at least once.
UPDATE "lesson_progress" SET "view_count" = 1 WHERE "view_count" = 0;
