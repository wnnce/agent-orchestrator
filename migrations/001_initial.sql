-- ============================================================================
-- Migration: 001_initial.sql
-- Purpose: 项目配置、会话路由、Turn轮次、事件流水、审计与通知表
-- 架构方案 B (务实工业级设计):
--   1. 物理主键统一使用自增数字 (id BIGSERIAL PRIMARY KEY)，严禁使用字符串做物理主键
--   2. 核心实体资源表 (projects, sessions, project_triggers) 具备完整生命周期:
--      - created_at TIMESTAMPTZ NOT NULL DEFAULT now()
--      - updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
--      - deleted_at BIGINT NOT NULL DEFAULT 0 (0为未删除，删除时记录毫秒时间戳数字)
--   3. 从属流水与日志表 (turns, events, artifacts) 为只增不改 (Append-Only):
--      - 仅保留 created_at，不加 updated_at 与 deleted_at，极大降低存储开销与查询负担
--   4. 瞬时排重与投递表 (inbound_messages, trigger_intents, notification_deliveries):
--      - 物理生命周期管理，不加 deleted_at
-- ============================================================================

-- 1. 项目表 (核心实体: 支持软删除与更新)
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(100) NOT NULL,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_id
  ON projects(project_id, deleted_at);

-- 2. 会话表 (核心实体: 支持软删除与更新)
CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  project_id VARCHAR(100) NOT NULL,
  repository_id VARCHAR(100),
  project_runtime_id VARCHAR(100) NOT NULL,
  runtime_session_id VARCHAR(100),
  config_revision INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(50) NOT NULL,
  external_channel VARCHAR(50),
  external_conversation_id VARCHAR(255),
  external_thread_id VARCHAR(255),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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

-- 3. 对话轮次表 (从属流水: 属于 Session 的历史对话)
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

-- 4. 入站消息去重表 (瞬时排重)
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

-- 5. 会话事件表 (纯 Append-Only 流式事件流水)
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

-- 6. 会话产物表 (从属文件元数据)
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

-- 7. 项目触发器配置表 (核心配置实体: 支持软删除与更新)
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

-- 8. 触发意图去重表 (瞬时排重)
CREATE TABLE IF NOT EXISTS trigger_intents (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_intents_key
  ON trigger_intents(idempotency_key);

-- 9. 通知投递表 (出站队列)
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  delivery_id VARCHAR(100) NOT NULL,
  project_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100),
  configs JSONB NOT NULL,
  message JSONB NOT NULL,
  status VARCHAR(50) NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_delivery_id
  ON notification_deliveries(delivery_id);

CREATE INDEX IF NOT EXISTS idx_notification_pending
  ON notification_deliveries(status, created_at);
