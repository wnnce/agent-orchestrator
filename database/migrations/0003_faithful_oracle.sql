CREATE TABLE "task_execution_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"execution_id" varchar(100) NOT NULL,
	"project_id" varchar(100) NOT NULL,
	"task_key" varchar(255) NOT NULL,
	"sequence" integer NOT NULL,
	"level" varchar(16) NOT NULL,
	"message" text NOT NULL,
	"fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_execution_logs_exec_seq" ON "task_execution_logs" USING btree ("execution_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_task_execution_logs_task_key" ON "task_execution_logs" USING btree ("task_key","id" DESC NULLS LAST);