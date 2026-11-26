CREATE TABLE "video_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"lesson_id" bigint NOT NULL,
	"ip" text,
	"user_agent" text NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"key_deadline" timestamp (3) NOT NULL,
	"segments_until" timestamp (3) NOT NULL,
	"key_fetches" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp (3)
);
--> statement-breakpoint
CREATE INDEX "video_sessions_user_id_created_at_index" ON "video_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "video_sessions_lesson_id_index" ON "video_sessions" USING btree ("lesson_id");