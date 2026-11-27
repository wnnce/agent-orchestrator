ALTER TABLE "artifacts" ADD COLUMN "origin_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "origin_id" varchar(100);--> statement-breakpoint
UPDATE "artifacts" SET "origin_id" = "session_id", "origin_kind" = CASE
  WHEN "session_id" LIKE 'ses\_%' THEN 'session'
  WHEN "session_id" LIKE 'pnr\_%' THEN 'pipeline'
  ELSE 'task'
END;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "origin_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "origin_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "idx_artifacts_session_created";--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "session_id";--> statement-breakpoint
CREATE INDEX "idx_artifacts_origin_created" ON "artifacts" USING btree ("origin_kind","origin_id","created_at");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "origin_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "origin_id" varchar(100);--> statement-breakpoint
UPDATE "notification_deliveries" SET "origin_id" = "session_id", "origin_kind" = CASE
  WHEN "session_id" LIKE 'ses\_%' THEN 'session'
  WHEN "session_id" LIKE 'pnr\_%' THEN 'pipeline'
  ELSE 'task'
END WHERE "session_id" IS NOT NULL AND "session_id" NOT LIKE 'prun\_%';--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP COLUMN "session_id";
