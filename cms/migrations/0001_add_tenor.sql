-- ============================================================================
-- Migration 0001 — add tenor_tahun to leads
-- Run ONCE against the existing D1 database that was already provisioned with
-- schema.sql (dashboard D1 console or `wrangler d1 execute`). Safe to skip if
-- the database was (re)created from the current schema.sql, which already has
-- this column.
-- ============================================================================
ALTER TABLE leads ADD COLUMN tenor_tahun INTEGER;
