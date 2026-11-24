ALTER TABLE "turns" ADD COLUMN "model" varchar(150);--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "cache_read_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "cache_write_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "reasoning_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "total_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "usage_details" jsonb;