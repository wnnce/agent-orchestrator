ALTER TABLE "action_executions" RENAME TO "tool_executions";--> statement-breakpoint
ALTER SEQUENCE "action_executions_id_seq" RENAME TO "tool_executions_id_seq";--> statement-breakpoint
ALTER INDEX "action_executions_pkey" RENAME TO "tool_executions_pkey";--> statement-breakpoint
ALTER TABLE "tool_executions" RENAME COLUMN "action_name" TO "tool_name";--> statement-breakpoint
ALTER TABLE "tool_executions" ADD COLUMN "owner_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "tool_executions" ADD COLUMN "owner_id" varchar(100);--> statement-breakpoint
UPDATE "tool_executions" AS t SET "owner_kind" = 'pipeline', "owner_id" = s."metadata"->>'pipelineNodeRunId'
  FROM "sessions" AS s
  WHERE s."session_id" = t."session_id" AND s."metadata" ? 'pipelineNodeRunId';--> statement-breakpoint
UPDATE "tool_executions" SET "owner_kind" = 'task' WHERE "task_key" IS NOT NULL AND "owner_kind" IS NULL;--> statement-breakpoint
DELETE FROM "tool_executions" WHERE "session_id" IS NULL;--> statement-breakpoint
ALTER TABLE "tool_executions" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_executions" DROP COLUMN "task_key";--> statement-breakpoint
ALTER TABLE "tool_executions" DROP COLUMN "caller";--> statement-breakpoint
ALTER INDEX "idx_action_executions_exec_id" RENAME TO "idx_tool_executions_exec_id";--> statement-breakpoint
ALTER INDEX "idx_action_executions_session" RENAME TO "idx_tool_executions_session";--> statement-breakpoint
ALTER INDEX "idx_action_executions_project" RENAME TO "idx_tool_executions_project";--> statement-breakpoint
ALTER INDEX "idx_action_executions_name" RENAME TO "idx_tool_executions_name";--> statement-breakpoint
CREATE INDEX "idx_tool_executions_owner" ON "tool_executions" USING btree ("owner_kind","owner_id","id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "owner" jsonb;--> statement-breakpoint
UPDATE "sessions" SET "owner" = jsonb_build_object(
  'kind', 'pipeline',
  'pipelineId', "metadata"->>'pipelineId',
  'runId', "metadata"->>'pipelineRunId',
  'nodeId', "metadata"->>'pipelineNodeId',
  'nodeRunId', "metadata"->>'pipelineNodeRunId'
) WHERE "metadata" ? 'pipelineNodeRunId';
