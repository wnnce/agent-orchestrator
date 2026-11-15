-- ============================================================================
-- Migration: 005_session_metadata.sql
-- Purpose: 为 sessions 核心实体表追加 metadata 扩展字段 (JSONB)
-- ============================================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
