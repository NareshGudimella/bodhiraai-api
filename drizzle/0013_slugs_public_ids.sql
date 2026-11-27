-- Not in legacy (2026-11-27, docs/slug-contract.md): globally unique slugs and public ids for URLs.
-- Random 12-character base62 id (first character a letter, so it is never all digits).
CREATE OR REPLACE FUNCTION bodhira_public_id() RETURNS text AS $$
DECLARE
  chars constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  b bytea := decode(left(replace(gen_random_uuid()::text, '-', ''), 12) || left(replace(gen_random_uuid()::text, '-', ''), 12), 'hex');
  result text;
  i int;
BEGIN
  result := substr(chars, get_byte(b, 0) % 52 + 1, 1);
  FOR i IN 1..11 LOOP
    result := result || substr(chars, get_byte(b, i) % 62 + 1, 1);
  END LOOP;
  RETURN result;
END
$$ LANGUAGE plpgsql VOLATILE
--> statement-breakpoint
-- Same rules as src/common/slug.ts: lower-case, non-alphanumerics become '-', ~80 characters cut at a word boundary,
-- an all-digit slug gets the entity word in front, an empty one becomes the entity word.
CREATE OR REPLACE FUNCTION bodhira_slugify(src text, word text) RETURNS text AS $$
DECLARE
  b text := trim(both '-' from regexp_replace(lower(coalesce(src, '')), '[^[:alnum:]]+', '-', 'g'));
  cut text;
BEGIN
  IF length(b) > 80 THEN
    cut := left(b, 80);
    IF substr(b, 81, 1) <> '-' AND position('-' in cut) > 0 THEN
      cut := regexp_replace(cut, '-[^-]*$', '');
    END IF;
    b := trim(both '-' from cut);
  END IF;
  IF b = '' THEN RETURN word; END IF;
  IF b ~ '^[0-9]+$' THEN RETURN word || '-' || b; END IF;
  RETURN b;
END
$$ LANGUAGE plpgsql IMMUTABLE
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bodhira_unique_slug(tbl text, col text, src text, word text) RETURNS text AS $$
DECLARE
  base text := bodhira_slugify(src, word);
  cand text := base;
  n int := 1;
  taken boolean;
BEGIN
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I = $1::citext)', tbl, col) INTO taken USING cand;
    EXIT WHEN NOT taken;
    n := n + 1;
    cand := base || '-' || n;
  END LOOP;
  RETURN cand;
END
$$ LANGUAGE plpgsql
--> statement-breakpoint
-- Safety net for rows inserted without a slug (seeds, scripts, tests): the app sets it itself.
-- Trigger arguments: slug column, comma-separated source columns, entity word, source prefix.
CREATE OR REPLACE FUNCTION bodhira_slug_trigger() RETURNS trigger AS $$
DECLARE
  col text := TG_ARGV[0];
  j jsonb := to_jsonb(NEW);
  src text := coalesce(nullif(TG_ARGV[3], ''), '');
  c text;
BEGIN
  IF coalesce(j->>col, '') <> '' THEN RETURN NEW; END IF;
  FOREACH c IN ARRAY string_to_array(TG_ARGV[1], ',') LOOP
    src := src || ' ' || coalesce(j->>c, '');
  END LOOP;
  RETURN jsonb_populate_record(NEW, jsonb_build_object(col, bodhira_unique_slug(TG_TABLE_NAME, col, src, TG_ARGV[2])));
END
$$ LANGUAGE plpgsql
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bodhira_backfill_slugs(tbl text, col text, src_expr text, word text) RETURNS void AS $$
DECLARE r record;
BEGIN
  FOR r IN EXECUTE format('SELECT id, (%s)::text AS src FROM %I ORDER BY id', src_expr, tbl) LOOP
    EXECUTE format('UPDATE %I SET %I = bodhira_unique_slug($1, $2, $3, $4) WHERE id = $5', tbl, col)
      USING tbl, col, r.src, word, r.id;
  END LOOP;
END
$$ LANGUAGE plpgsql
--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "slug" "citext" DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "url_slug" "citext" DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "slug" "citext" DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "faqs" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "url_slug" "citext" DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "live_classes" ADD COLUMN "slug" "citext" DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "slug" "citext" DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN "slug" "citext" DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "social_links" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "url_slug" "citext" DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "testimonials" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "public_id" text DEFAULT bodhira_public_id() NOT NULL;
--> statement-breakpoint
SELECT bodhira_backfill_slugs('subjects', 'url_slug', $q$name$q$, 'subject')
--> statement-breakpoint
SELECT bodhira_backfill_slugs('chapters', 'url_slug', $q$title$q$, 'chapter')
--> statement-breakpoint
SELECT bodhira_backfill_slugs('lessons', 'url_slug', $q$title$q$, 'lesson')
--> statement-breakpoint
SELECT bodhira_backfill_slugs('quizzes', 'slug', $q$title$q$, 'quiz')
--> statement-breakpoint
SELECT bodhira_backfill_slugs('classes', 'slug', $q$'class ' || grade || ' ' || section$q$, 'class')
--> statement-breakpoint
SELECT bodhira_backfill_slugs('plans', 'slug', $q$name$q$, 'plan')
--> statement-breakpoint
SELECT bodhira_backfill_slugs('live_classes', 'slug', $q$title$q$, 'live-class')
--> statement-breakpoint
SELECT bodhira_backfill_slugs('assignments', 'slug', $q$title$q$, 'assignment')
--> statement-breakpoint
DROP FUNCTION bodhira_backfill_slugs(text, text, text, text)
--> statement-breakpoint
CREATE TRIGGER subjects_slug_fill BEFORE INSERT ON subjects FOR EACH ROW EXECUTE FUNCTION bodhira_slug_trigger('url_slug', 'name', 'subject', '')
--> statement-breakpoint
CREATE TRIGGER chapters_slug_fill BEFORE INSERT ON chapters FOR EACH ROW EXECUTE FUNCTION bodhira_slug_trigger('url_slug', 'title', 'chapter', '')
--> statement-breakpoint
CREATE TRIGGER lessons_slug_fill BEFORE INSERT ON lessons FOR EACH ROW EXECUTE FUNCTION bodhira_slug_trigger('url_slug', 'title', 'lesson', '')
--> statement-breakpoint
CREATE TRIGGER quizzes_slug_fill BEFORE INSERT ON quizzes FOR EACH ROW EXECUTE FUNCTION bodhira_slug_trigger('slug', 'title', 'quiz', '')
--> statement-breakpoint
CREATE TRIGGER classes_slug_fill BEFORE INSERT ON classes FOR EACH ROW EXECUTE FUNCTION bodhira_slug_trigger('slug', 'grade,section', 'class', 'class')
--> statement-breakpoint
CREATE TRIGGER plans_slug_fill BEFORE INSERT ON plans FOR EACH ROW EXECUTE FUNCTION bodhira_slug_trigger('slug', 'name', 'plan', '')
--> statement-breakpoint
CREATE TRIGGER live_classes_slug_fill BEFORE INSERT ON live_classes FOR EACH ROW EXECUTE FUNCTION bodhira_slug_trigger('slug', 'title', 'live-class', '')
--> statement-breakpoint
CREATE TRIGGER assignments_slug_fill BEFORE INSERT ON assignments FOR EACH ROW EXECUTE FUNCTION bodhira_slug_trigger('slug', 'title', 'assignment', '')
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_chat_sessions_public_id_unique" ON "ai_chat_sessions" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_slug_unique" ON "assignments" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "chapters_url_slug_unique" ON "chapters" USING btree ("url_slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "classes_slug_unique" ON "classes" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_public_id_unique" ON "conversations" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "faqs_public_id_unique" ON "faqs" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "features_public_id_unique" ON "features" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_public_id_unique" ON "invoices" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "lessons_url_slug_unique" ON "lessons" USING btree ("url_slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "live_classes_slug_unique" ON "live_classes" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "plans_slug_unique" ON "plans" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_attempts_public_id_unique" ON "quiz_attempts" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quizzes_slug_unique" ON "quizzes" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "social_links_public_id_unique" ON "social_links" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_url_slug_unique" ON "subjects" USING btree ("url_slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_public_id_unique" ON "subscriptions" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_public_id_unique" ON "team_members" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "testimonials_public_id_unique" ON "testimonials" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_public_id_unique" ON "users" USING btree ("public_id");
