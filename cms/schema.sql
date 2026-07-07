-- ============================================================================
-- Morby CMS — Cloudflare D1 schema (Phase 1 foundation)
-- Run this once against the D1 database (dashboard console or wrangler d1).
-- TODO SECURITY/PDPA: this stores personal data permanently. Retention policy
-- and the DPIA must be revised before real applicant data is processed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  nama TEXT NOT NULL,
  telepon TEXT NOT NULL,
  email TEXT,
  nik_masked TEXT,
  jenis_kpr TEXT,                 -- primary, second, take_over
  gaji_bulanan INTEGER,           -- rupiah
  plafon INTEGER,                 -- rupiah, jumlah plafon kredit yang diajukan
  tenor_tahun INTEGER,            -- tenor kredit yang diajukan (tahun)
  kota TEXT,
  pernah_restruktur INTEGER,      -- 0 atau 1
  to_sertifikat_siap INTEGER,     -- 0 atau 1, hanya untuk take_over
  is_duplicate INTEGER DEFAULT 0,
  submit_count INTEGER DEFAULT 1,
  last_submit_at TEXT,
  grade_gaji TEXT,
  grade_plafon TEXT,
  grade_lokasi TEXT,
  skor_komposit INTEGER,
  grade_keseluruhan TEXT,
  tier_lokasi INTEGER,
  sales_owner TEXT,               -- AS, HB, RB, ER
  status TEXT DEFAULT 'uncontacted',
  call_due_at TEXT,               -- Task Call jatuh tempo (30 menit sejak lead masuk)
  wa_due_at TEXT,                 -- Task WA follow up jatuh tempo (1 jam sejak call selesai)
  call_done_at TEXT,
  wa_done_at TEXT,
  last_activity_at TEXT,          -- update terakhir (untuk sweep mingguan)
  call_reminder_at TEXT,          -- kapan reminder SLA call dikirim (null = belum)
  wa_reminder_at TEXT,            -- kapan reminder SLA WA dikirim (null = belum)
  weekly_reminder_at TEXT         -- kapan reminder sweep mingguan terakhir dikirim
);

CREATE TABLE IF NOT EXISTS lead_files (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  jenis TEXT NOT NULL,            -- chatlog, prescreen_xls, pariksa_pdf, pasfoto
  r2_key TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS status_history (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  status_lama TEXT,
  status_baru TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT,
  keterangan TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT,
  aksi TEXT,                      -- view, download, delete
  target TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions_metric (
  id TEXT PRIMARY KEY,
  tipe TEXT NOT NULL,             -- chatbot, prescreen_submit
  created_at TEXT NOT NULL
);

-- Phase 8: admin password set on first login (no password lives in the repo).
-- id = username; pass_sha256 = SHA-256 hex of the chosen password.
CREATE TABLE IF NOT EXISTS app_auth (
  id TEXT PRIMARY KEY,
  pass_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_telepon ON leads (telepon);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (email);
CREATE INDEX IF NOT EXISTS idx_files_lead ON lead_files (lead_id);
