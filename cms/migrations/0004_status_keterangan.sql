-- ============================================================================
-- Migration 0004 — free-text note on status changes (sales pipeline updates)
-- Run ONCE against the existing D1 database (dashboard D1 console or wrangler).
-- Safe to skip if the database was (re)created from the current schema.sql.
-- ============================================================================
ALTER TABLE status_history ADD COLUMN keterangan TEXT;
