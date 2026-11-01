CREATE TABLE "mail_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"mailer" "citext" NOT NULL,
	"host" "citext",
	"port" integer,
	"encryption" "citext",
	"username" "citext",
	"password_enc" text,
	"from_address" "citext" NOT NULL,
	"from_name" "citext",
	"updated_by" bigint,
	"updated_at" timestamp (3) NOT NULL
);
