-- A project now has a single repository, so sessions no longer record which one they use.
-- Existing sessions keep working: their stored workspace_path (or, for sessions without one,
-- the worktree found under the session directory) still points at the right checkout.
ALTER TABLE sessions DROP COLUMN IF EXISTS repository_id;
