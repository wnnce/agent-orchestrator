-- Agent Orchestrator database schema.
-- This file defines the final schema for a new database. It is not an upgrade migration.

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  title VARCHAR(255) DEFAULT '新会话',
  project_id VARCHAR(100) NOT NULL,
  repository_id VARCHAR(100),
  project_runtime_id VARCHAR(100) NOT NULL,
  runtime_session_id VARCHAR(100),
  config_revision INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(50) NOT NULL,
  source VARCHAR(50) NOT NULL DEFAULT 'unknown',
  runtime VARCHAR(50) NOT NULL DEFAULT 'unknown',
  workspace_path TEXT,
  external_channel VARCHAR(50),
  external_conversation_id VARCHAR(255),
  external_thread_id VARCHAR(255),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id
  ON sessions(session_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_sessions_project
  ON sessions(project_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_sessions_external
  ON sessions(external_channel, external_conversation_id, external_thread_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_sessions_source
  ON sessions(source);

CREATE INDEX IF NOT EXISTS idx_sessions_project_source
  ON sessions(project_id, source, deleted_at);

CREATE TABLE IF NOT EXISTS turns (
  id BIGSERIAL PRIMARY KEY,
  turn_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100) NOT NULL,
  input TEXT NOT NULL,
  status VARCHAR(50) NOT NULL,
  runtime_turn_id VARCHAR(100),
  output TEXT,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_turn_id
  ON turns(turn_id);

CREATE INDEX IF NOT EXISTS idx_turns_session
  ON turns(session_id);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id BIGSERIAL PRIMARY KEY,
  message_id VARCHAR(100) NOT NULL,
  channel VARCHAR(50) NOT NULL,
  conversation_id VARCHAR(255) NOT NULL,
  thread_id VARCHAR(255),
  session_id VARCHAR(100),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_messages_message_id
  ON inbound_messages(message_id);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_conversation
  ON inbound_messages(channel, conversation_id, thread_id, received_at);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  event_id VARCHAR(100) NOT NULL,
  project_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100) NOT NULL,
  turn_id VARCHAR(100),
  sequence INTEGER NOT NULL,
  type VARCHAR(100) NOT NULL,
  runtime VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id
  ON events(event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_sequence
  ON events(session_id, sequence);

CREATE TABLE IF NOT EXISTS artifacts (
  id BIGSERIAL PRIMARY KEY,
  artifact_id VARCHAR(100) NOT NULL,
  project_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100) NOT NULL,
  turn_id VARCHAR(100),
  kind VARCHAR(100) NOT NULL,
  path TEXT NOT NULL,
  content_type VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_artifact_id
  ON artifacts(artifact_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_session_created
  ON artifacts(session_id, created_at);

CREATE TABLE IF NOT EXISTS project_triggers (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(100) NOT NULL,
  trigger_id VARCHAR(100) NOT NULL,
  implementation_key VARCHAR(255) NOT NULL,
  config JSONB NOT NULL,
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_triggers_project_trigger
  ON project_triggers(project_id, trigger_id, deleted_at);

CREATE TABLE IF NOT EXISTS trigger_intents (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_intents_key
  ON trigger_intents(idempotency_key);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  delivery_id VARCHAR(100) NOT NULL,
  project_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100),
  configs JSONB NOT NULL,
  message JSONB NOT NULL,
  status VARCHAR(50) NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_delivery_id
  ON notification_deliveries(delivery_id);

CREATE TABLE IF NOT EXISTS task_executions (
  id BIGSERIAL PRIMARY KEY,
  execution_id VARCHAR(100) NOT NULL,
  task_key VARCHAR(255) NOT NULL,
  project_id VARCHAR(100) NOT NULL,
  task_id VARCHAR(100) NOT NULL,
  task_type VARCHAR(30) NOT NULL,
  session_id VARCHAR(100),
  turn_id VARCHAR(100),
  status VARCHAR(30) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms BIGINT,
  state_before JSONB,
  state_after JSONB,
  actions_summary JSONB DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_executions_execution_id
  ON task_executions(execution_id);

CREATE INDEX IF NOT EXISTS idx_task_executions_task_key
  ON task_executions(task_key, id DESC);

CREATE INDEX IF NOT EXISTS idx_task_executions_project
  ON task_executions(project_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_task_executions_state_recovery
  ON task_executions(task_key, id DESC)
  WHERE status = 'success';

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  project_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  delay_minutes INT NOT NULL DEFAULT 0,
  trigger_at TIMESTAMPTZ NOT NULL,
  status SMALLINT NOT NULL DEFAULT 1,
  prompt TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary TEXT,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_jobs_job_id
  ON scheduled_jobs(job_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_poll
  ON scheduled_jobs(status, trigger_at)
  WHERE status = 1 AND deleted_at = 0;

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_session
  ON scheduled_jobs(session_id, status)
  WHERE deleted_at = 0;

CREATE TABLE IF NOT EXISTS action_executions (
  id BIGSERIAL PRIMARY KEY,
  execution_id VARCHAR(100) NOT NULL,
  project_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100),
  turn_id VARCHAR(100),
  task_key VARCHAR(255),
  caller VARCHAR(50) NOT NULL DEFAULT 'unknown',
  action_name VARCHAR(100) NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL,
  result JSONB,
  error_message TEXT,
  duration_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_action_executions_exec_id
  ON action_executions(execution_id);

CREATE INDEX IF NOT EXISTS idx_action_executions_session
  ON action_executions(session_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_action_executions_project
  ON action_executions(project_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_action_executions_name
  ON action_executions(action_name, id DESC);
