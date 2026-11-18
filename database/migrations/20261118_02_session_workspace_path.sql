-- The session's working directory is now stored when the session is created, so control
-- operations no longer re-sync git just to find it. Existing sessions keep NULL and have the
-- path computed from the project layout.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_path TEXT;
