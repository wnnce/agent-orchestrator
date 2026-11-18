-- Sessions created by dispatch_agent_task used to be stored with source 'task', which hid them
-- from session lists and lifecycle management. Only the scheduled task engine creates 'task'
-- sessions now; dispatched sessions use 'dispatch'.
UPDATE sessions
SET source = 'dispatch', updated_at = now()
WHERE source = 'task' AND metadata ? 'sourceSessionId';
