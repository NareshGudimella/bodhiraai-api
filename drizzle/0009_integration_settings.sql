CREATE TABLE "integration_settings" (
	"provider" "citext" PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"secrets" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp (3) NOT NULL
);
