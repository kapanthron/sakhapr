-- ============================================================================
-- Migration 0002 — CMS Phase 4 (SLA tasks + cron reminders)
-- Run ONCE against the existing D1 database (dashboard D1 console or
-- `wrangler d1 execute`). Safe to skip if the database was (re)created from the
-- current schema.sql, which already has these columns.
-- ============================================================================
ALTER TABLE leads ADD COLUMN last_activity_at TEXT;
ALTER TABLE leads ADD COLUMN call_reminder_at TEXT;
ALTER TABLE leads ADD COLUMN wa_reminder_at TEXT;
ALTER TABLE leads ADD COLUMN weekly_reminder_at TEXT;
-- call_due_at, wa_due_at, call_done_at, wa_done_at already exist in schema.sql.
