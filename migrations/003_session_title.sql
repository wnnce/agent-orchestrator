-- ============================================================================
-- Migration: 003_session_title.sql
-- Purpose: 为会话核心实体表增加标题字段 (title)
-- ============================================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title VARCHAR(255) DEFAULT '新会话';
