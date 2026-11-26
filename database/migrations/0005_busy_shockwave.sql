ALTER TABLE "pipeline_runs" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" DROP COLUMN "input";