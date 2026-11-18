-- ============================================================================
-- Table: scheduled_jobs
-- Purpose: Persist dynamic in-session scheduled reminders/delayed jobs.
--          Replaces unreliable sleep commands, supports session liveness guards,
--          user cancellation, and survives process restarts.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduled_jobs (
    -- Auto-incrementing primary key ID
    id BIGSERIAL PRIMARY KEY,

    -- Business unique Job ID: e.g. "job_18f2a9c3d4"
    job_id VARCHAR(100) NOT NULL,

    -- Owning project ID
    project_id VARCHAR(100) NOT NULL,

    -- Associated target session ID (the session that created this reminder)
    session_id VARCHAR(100) NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,

    -- Semantic task name (allows user to cancel by name, e.g. "check_ci_build")
    name VARCHAR(255) NOT NULL,

    -- Trigger timestamp (TIMESTAMPTZ)
    trigger_at TIMESTAMPTZ NOT NULL,

    -- Recurring schedule expression (non-null for recurring jobs, NULL for one-shot)
    cron VARCHAR(100),

    -- Job status:
    -- pending: waiting to trigger
    -- running: currently executing turn
    -- completed: successfully triggered and executed
    -- cancelled: cancelled by user in a subsequent turn
    -- abandoned: target session was closed/archived before trigger, abandoned safely
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    -- Task payload (JSONB):
    -- Contains prompt delivered to Agent upon trigger, target repo, metadata, etc.
    -- e.g.: { "prompt": "Check CI build status for current branch", "source": "timer", "caller_turn": 3 }
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Execution result summary or error text
    result_summary TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index on business job_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_jobs_job_id ON scheduled_jobs(job_id);

-- Composite index for fast scanning of pending jobs by project and trigger time
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_scan ON scheduled_jobs(project_id, status, trigger_at);

-- Query index by session
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_session ON scheduled_jobs(session_id, status);
