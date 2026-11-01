CREATE INDEX "ai_chat_sessions_created_at_index" ON "ai_chat_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "lesson_progress_last_viewed_at_index" ON "lesson_progress" USING btree ("last_viewed_at");--> statement-breakpoint
CREATE INDEX "quiz_attempts_submitted_at_index" ON "quiz_attempts" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "users_created_at_index" ON "users" USING btree ("created_at");