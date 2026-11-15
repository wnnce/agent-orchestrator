-- 004_notification_audit.sql
-- 重构通知表为纯异步审计与投递结果表：只保留 details JSONB，废除 error 和 attempts 以及 pending 索引
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS details JSONB;
ALTER TABLE notification_deliveries DROP COLUMN IF EXISTS error;
ALTER TABLE notification_deliveries DROP COLUMN IF EXISTS attempts;
DROP INDEX IF EXISTS idx_notification_pending;
