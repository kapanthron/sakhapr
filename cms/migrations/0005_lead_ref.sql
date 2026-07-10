-- ============================================================================
-- Migration 0005 — add leads.ref (public application-status lookup)
-- Optional: the worker also adds this column automatically on the next lead
-- ingest, so running it by hand is not required.
-- ============================================================================
ALTER TABLE leads ADD COLUMN ref TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_ref ON leads (ref);
