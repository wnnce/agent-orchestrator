-- ============================================================================
-- Migration: 006_action_executions.sql
-- Purpose: Action 统一执行审计记录表 (action_executions)
-- 架构方案:
--   1. 物理主键使用自增数字 (id BIGSERIAL PRIMARY KEY)
--   2. execution_id 业务唯一标识 (act_xxx)
--   3. Append-Only 只写日志，高并发插入轻量无状态
-- ============================================================================

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
