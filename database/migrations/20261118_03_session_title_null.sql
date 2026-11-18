-- "No title yet" is now NULL instead of a UI placeholder string; the web UI shows its own label.
ALTER TABLE sessions ALTER COLUMN title DROP DEFAULT;
UPDATE sessions SET title = NULL WHERE title IN ('新会话', 'New Chat', 'New Session');
