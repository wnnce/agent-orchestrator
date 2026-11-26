CREATE TABLE "pipeline_action_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"record_id" varchar(100) NOT NULL,
	"run_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"sequence" integer NOT NULL,
	"node_run_id" varchar(100),
	"node_id" varchar(100) NOT NULL,
	"attempt" integer NOT NULL,
	"action" varchar(50) NOT NULL,
	"actor_type" varchar(20) NOT NULL,
	"actor_id" varchar(100),
	"from_node_id" varchar(100) NOT NULL,
	"to_node_id" varchar(100),
	"from_status" varchar(40) NOT NULL,
	"to_status" varchar(40) NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_node_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_run_id" varchar(100) NOT NULL,
	"run_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"sequence" integer NOT NULL,
	"level" varchar(16) NOT NULL,
	"message" text NOT NULL,
	"fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_node_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_run_id" varchar(100) NOT NULL,
	"run_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"pipeline_id" varchar(100) NOT NULL,
	"node_id" varchar(100) NOT NULL,
	"attempt" integer NOT NULL,
	"sequence" integer NOT NULL,
	"executor_type" varchar(30) NOT NULL,
	"session_id" varchar(100),
	"triggered_by_record_id" varchar(100),
	"status" varchar(40) NOT NULL,
	"input_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"final_action" varchar(50),
	"output_summary" text,
	"error_message" text,
	"step_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_poll_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"agent_turn_id" varchar(100),
	"reminder_sent" boolean DEFAULT false NOT NULL,
	"pending_decision" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"pipeline_id" varchar(100) NOT NULL,
	"version" integer NOT NULL,
	"topology_hash" varchar(64) NOT NULL,
	"nodes_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"pipeline_id" varchar(100) NOT NULL,
	"pipeline_version" integer NOT NULL,
	"external_key" varchar(255),
	"external_url" text,
	"title" varchar(255) NOT NULL,
	"description" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_node_id" varchar(100) NOT NULL,
	"status" varchar(40) NOT NULL,
	"workspace_path" text,
	"branch_name" varchar(255),
	"workspace_status" varchar(30) DEFAULT 'none' NOT NULL,
	"loop_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status_summary" text,
	"active_node_run_id" varchar(100),
	"latest_node_outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar(100) DEFAULT 'system' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipeline_action_records_id" ON "pipeline_action_records" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipeline_action_records_run_seq" ON "pipeline_action_records" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_pipeline_action_records_node" ON "pipeline_action_records" USING btree ("run_id","node_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipeline_node_logs_run_seq" ON "pipeline_node_logs" USING btree ("node_run_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_pipeline_node_logs_run_id" ON "pipeline_node_logs" USING btree ("run_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipeline_node_runs_id" ON "pipeline_node_runs" USING btree ("node_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipeline_node_runs_run_seq" ON "pipeline_node_runs" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_pipeline_node_runs_session" ON "pipeline_node_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_node_runs_active" ON "pipeline_node_runs" USING btree ("project_id","status","id") WHERE status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "idx_pipeline_node_runs_poll" ON "pipeline_node_runs" USING btree ("project_id","next_poll_at") WHERE status = 'waiting' AND next_poll_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipeline_revisions_version" ON "pipeline_revisions" USING btree ("project_id","pipeline_id","version");--> statement-breakpoint
CREATE INDEX "idx_pipeline_revisions_lookup" ON "pipeline_revisions" USING btree ("project_id","pipeline_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipeline_runs_run_id" ON "pipeline_runs" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipeline_runs_external_key" ON "pipeline_runs" USING btree ("project_id","pipeline_id","external_key") WHERE external_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_pipeline_runs_board" ON "pipeline_runs" USING btree ("project_id","pipeline_id","pipeline_version","current_node_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_pipeline_runs_status" ON "pipeline_runs" USING btree ("project_id","status","id" DESC NULLS LAST);