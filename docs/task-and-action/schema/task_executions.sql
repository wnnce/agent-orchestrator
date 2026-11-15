-- ============================================================================
-- Table: task_executions
-- Purpose: Audit log recording execution history of static Tasks and dynamic Jobs.
--          Used to track latency, output summaries, state transitions, history,
--          and cold-start state hydration.
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_executions (
    -- Auto-incrementing primary key ID
    id BIGSERIAL PRIMARY KEY,

    -- Business execution ID: e.g. "exec_8a2b3c4d"
    execution_id VARCHAR(100) NOT NULL,

    -- Business unique Task Key: formatted as "${project_id}:${task_id}" (or "${project_id}:job:${job_id}")
    -- Used for fast history lookup, metrics, and cold-start state recovery
    task_key VARCHAR(255) NOT NULL,

    -- Owning project ID
    project_id VARCHAR(100) NOT NULL,

    -- Task identifier: e.g. "sync-github-issues" or dynamic job ID "job_18f2a9c3d4"
    task_id VARCHAR(100) NOT NULL,

    -- Association type: "project_task" (static) or "scheduled_job" (dynamic session job)
    task_type VARCHAR(30) NOT NULL,

    -- Session ID allocated/woken for executing this task
    session_id VARCHAR(100),

    -- Turn ID associated with this execution
    turn_id VARCHAR(100),

    -- Execution status: success | failed | skipped_overlapping | timeout
    status VARCHAR(30) NOT NULL,

    -- Execution timestamps
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,

    -- Execution duration (milliseconds)
    duration_ms BIGINT,

    -- Initial state before execution (JSONB)
    state_before JSONB,

    -- Final state after execution (JSONB)
    state_after JSONB,

    -- Action invocation audit summary (JSONB)
    -- e.g.: { "dispatched_tasks": 2, "notified_channels": ["feishu"], "state_updated": true }
    actions_summary JSONB,

    -- Error details if execution failed
    error_message TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index on execution_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_executions_exec_id ON task_executions(execution_id);

-- Composite index for fast lookup of task history ordered by time (descending)
CREATE INDEX IF NOT EXISTS idx_task_executions_task_key_desc ON task_executions(task_key, id DESC);

-- Project-level execution query index
CREATE INDEX IF NOT EXISTS idx_task_executions_project ON task_executions(project_id, started_at DESC);
