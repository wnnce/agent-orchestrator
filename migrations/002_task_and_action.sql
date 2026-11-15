-- ============================================================================
-- Migration: 002_task_and_action.sql
-- Purpose: 任务执行审计表 (task_executions) 与会话动态定时器表 (scheduled_jobs)
-- 架构方案 B (务实工业级设计):
--   1. 物理主键统一使用自增数字 (id BIGSERIAL PRIMARY KEY)
--   2. task_executions: 历史执行审计表，只增不改 (Append-Only)，无 deleted_at
--   3. scheduled_jobs: 具备生命周期的调度实体，保留 created_at, updated_at, deleted_at
-- ============================================================================

-- 1. 任务执行审计表 (纯追加审计历史)
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

-- 2. 会话动态延时任务表 (核心实体: 状态可变与软删除)
CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id BIGSERIAL PRIMARY KEY,
    job_id VARCHAR(100) NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delay_minutes INT NOT NULL DEFAULT 0,
    trigger_at TIMESTAMPTZ NOT NULL,
    status SMALLINT NOT NULL DEFAULT 1,
    prompt TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_summary TEXT,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at BIGINT NOT NULL DEFAULT 0
);

-- 安全补齐 scheduled_jobs 历史表可能缺失的列
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS delay_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS deleted_at BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_jobs_job_id
    ON scheduled_jobs(job_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_poll
    ON scheduled_jobs(status, trigger_at)
    WHERE status = 1 AND deleted_at = 0;

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_session
    ON scheduled_jobs(session_id, status)
    WHERE deleted_at = 0;
