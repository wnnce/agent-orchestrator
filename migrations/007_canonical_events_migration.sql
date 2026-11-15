-- Migration 007: Canonical Domain Event Protocol Alignment
-- 1. Migrate reasoning item.completed to agent.reasoning.completed
UPDATE events
SET
  type = 'agent.reasoning.completed',
  payload = jsonb_build_object(
    'itemId', COALESCE(payload->'item'->>'id', 'reas_' || id::text),
    'text', COALESCE(payload->'item'->'content'->>0, payload->'item'->>'text', ''),
    'metadata', jsonb_build_object('migratedFromLegacy', true)
  )
WHERE type = 'item.completed' AND payload->'item'->>'type' = 'reasoning';

-- 2. Delete non-canonical obsolete raw events
DELETE FROM events
WHERE type IN (
  'item.started',
  'item.completed',
  'thread.tokenUsage.updated',
  'thread.status.changed',
  'thread.readState.changed',
  'mcpServer.startupStatus.updated',
  'thread.goal.cleared',
  'turn.diff.updated',
  'warning'
);
