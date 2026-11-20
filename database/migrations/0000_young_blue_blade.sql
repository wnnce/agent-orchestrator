CREATE TABLE "action_executions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"execution_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"session_id" varchar(100),
	"turn_id" varchar(100),
	"task_key" varchar(255),
	"caller" varchar(50) DEFAULT 'unknown' NOT NULL,
	"action_name" varchar(100) NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) NOT NULL,
	"result" jsonb,
	"error_message" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"artifact_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"session_id" varchar(100) NOT NULL,
	"turn_id" varchar(100),
	"kind" varchar(100) NOT NULL,
	"path" text NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"session_id" varchar(100) NOT NULL,
	"turn_id" varchar(100),
	"sequence" integer NOT NULL,
	"type" varchar(100) NOT NULL,
	"runtime" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" varchar(100) NOT NULL,
	"channel" varchar(50) NOT NULL,
	"conversation_id" varchar(255) NOT NULL,
	"thread_id" varchar(255),
	"session_id" varchar(100),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"delivery_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"session_id" varchar(100),
	"configs" jsonb NOT NULL,
	"message" jsonb NOT NULL,
	"status" varchar(50) NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"session_id" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"delay_minutes" integer DEFAULT 0 NOT NULL,
	"trigger_at" timestamp with time zone NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_summary" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" varchar(100) NOT NULL,
	"title" varchar(255),
	"project_id" varchar(100) NOT NULL,
	"project_runtime_id" varchar(100) NOT NULL,
	"runtime_session_id" varchar(100),
	"config_revision" integer DEFAULT 1 NOT NULL,
	"status" varchar(50) NOT NULL,
	"source" varchar(50) DEFAULT 'unknown' NOT NULL,
	"runtime" varchar(50) DEFAULT 'unknown' NOT NULL,
	"workspace_path" text,
	"external_channel" varchar(50),
	"external_conversation_id" varchar(255),
	"external_thread_id" varchar(255),
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cursors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_executions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"execution_id" varchar(100) NOT NULL,
	"task_key" varchar(255) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"task_id" varchar(100) NOT NULL,
	"task_type" varchar(30) NOT NULL,
	"session_id" varchar(100),
	"turn_id" varchar(100),
	"status" varchar(30) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" bigint,
	"state_before" jsonb,
	"state_after" jsonb,
	"actions_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"turn_id" varchar(100) NOT NULL,
	"session_id" varchar(100) NOT NULL,
	"input" text NOT NULL,
	"status" varchar(50) NOT NULL,
	"runtime_turn_id" varchar(100),
	"output" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_action_executions_exec_id" ON "action_executions" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_action_executions_session" ON "action_executions" USING btree ("session_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_action_executions_project" ON "action_executions" USING btree ("project_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_action_executions_name" ON "action_executions" USING btree ("action_name","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_artifacts_artifact_id" ON "artifacts" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_session_created" ON "artifacts" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_events_event_id" ON "events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_events_session_sequence" ON "events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inbound_messages_message_id" ON "inbound_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_inbound_messages_conversation" ON "inbound_messages" USING btree ("channel","conversation_id","thread_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_deliveries_delivery_id" ON "notification_deliveries" USING btree ("delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scheduled_jobs_job_id" ON "scheduled_jobs" USING btree ("job_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_poll" ON "scheduled_jobs" USING btree ("status","trigger_at") WHERE status = 1 AND deleted_at = 0;--> statement-breakpoint
CREATE INDEX "idx_scheduled_jobs_session" ON "scheduled_jobs" USING btree ("session_id","status") WHERE deleted_at = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_session_id" ON "sessions" USING btree ("session_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_project" ON "sessions" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_external" ON "sessions" USING btree ("external_channel","external_conversation_id","external_thread_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_source" ON "sessions" USING btree ("source");--> statement-breakpoint
CREATE INDEX "idx_sessions_project_source" ON "sessions" USING btree ("project_id","source","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_executions_execution_id" ON "task_executions" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_task_executions_task_key" ON "task_executions" USING btree ("task_key","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_task_executions_project" ON "task_executions" USING btree ("project_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_task_executions_state_recovery" ON "task_executions" USING btree ("task_key","id" DESC NULLS LAST) WHERE status = 'success';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_turns_turn_id" ON "turns" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "idx_turns_session" ON "turns" USING btree ("session_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);