CREATE TABLE "otp_attempts" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "otp_attempts" ADD CONSTRAINT "otp_attempts_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;