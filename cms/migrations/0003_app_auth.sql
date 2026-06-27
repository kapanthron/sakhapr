-- ============================================================================
-- Migration 0003 — CMS Phase 8 (admin password set on first login)
-- Optional: the worker also creates this table automatically on first login,
-- so running it by hand is not required. Provided for completeness.
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_auth (
  id TEXT PRIMARY KEY,
  pass_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
