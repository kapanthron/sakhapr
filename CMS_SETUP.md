# Moggy CMS — setup (Phase 1)

The CMS stores leads in **Cloudflare D1** (a database) + **R2** (the files).
Like R2 earlier, **D1 must be created in your Cloudflare account before the
binding can go live**. The code is already deployed and safely guarded: until
D1 is connected, leads keep flowing the old way (email). Once D1 is connected,
Moggy switches to **CMS-only** ingestion automatically.

> **PDPA/Security TODO:** the CMS stores personal data permanently. The DPIA and
> a retention policy must be revised before real applicant data is processed.
> The full NIK is **not** stored in D1 (only a masked form); the full value
> stays inside the eKTP image / NIK report in R2.

## Steps (no terminal needed — all in the Cloudflare dashboard)

1. **Create the database**
   - Cloudflare dashboard → **Workers & Pages → D1 SQL Database → Create**.
   - Name it **`moggy-cms`** → Create.

2. **Create the tables**
   - Open the new `moggy-cms` database → **Console** tab.
   - Open the file **`cms/schema.sql`** from this repo, copy ALL of it, paste
     into the console, and **Run**. You should see the tables created.

3. **Give me two values** (so I can bind it and deploy):
   - On the database's page, copy the **Database ID** (a UUID).
   - The **Database name** is `moggy-cms`.
   - Send me both; I'll add the binding to `wrangler.toml` and deploy. After
     that, new submissions appear under **Super → CMS**.

## After it's connected — how to verify (Phase 1 test)

1. Open Moggy, run a full flow (chat → prescreen → upload eKTP → **Kirim**).
2. Open **`/super` → CMS** tab → click **Muat ulang**.
   - You should see **1 lead row** with name/phone/email/city, masked NIK, and
   - **the file links** (Log chat, Prescreen, Laporan NIK, Pas foto).
3. That confirms ingestion writes 1 lead + its files to D1/R2.

(Duplicate detection, qualification flags, scoring, sales assignment, SLA/Cron,
pipeline, Customer-360 and the BI dashboard are the next phases.)

## Migrations (run once when upgrading an already-created database)

If you created the database from an **older** `schema.sql`, run the new column
migrations in the D1 **Console** (paste the file contents and **Run**). They are
additive and safe; skip any that error with "duplicate column".

- `cms/migrations/0001_add_tenor.sql` — adds `tenor_tahun` (Phase 3.5: plafon +
  tenor questions).
- `cms/migrations/0002_phase4_sla.sql` — adds `last_activity_at`,
  `call_reminder_at`, `wa_reminder_at`, `weekly_reminder_at` (Phase 4 SLA).

A database freshly created from the current `schema.sql` already has every
column, so no migration is needed.

## Phase 4 — SLA tasks + cron reminders

When a lead is assigned, two tasks open automatically:

- **Task Call** — due **30 minutes** after the lead arrives (`call_due_at`).
- **Task WA follow up** — due **1 hour** after the call is marked done
  (`wa_due_at` is set when you click *Call selesai*).

A **Cron Trigger** runs the worker's `scheduled()` handler every 5 minutes
(`[triggers] crons` in `wrangler.toml`). It emails a reminder to the sales owner
for any overdue Task Call / Task WA that isn't done yet, and every **Friday
15:00 WIB** sweeps leads with no update that week.

> **Design note (POC):** reminders go to `MAIL_TO` (your one Resend mailbox).
> To route per sales owner later, set secrets `SALES_EMAIL_AS`, `SALES_EMAIL_HB`,
> `SALES_EMAIL_RB`, `SALES_EMAIL_ER`; the code uses them automatically.

Test without waiting for the timers: in **Super → CMS**, use **Paksa due call
(uji)** on a lead, then **Jalankan SLA sekarang**. The status line reports how
many reminders fired (and whether email is configured).

## Phase 5 — pipeline status + history

Each lead card has a **Status pipeline** dropdown with the exact stages from the
brief:

`uncontacted → slow_response → collect_data → submitted → approved →
approved_not_disbursed → disbursed`, plus the branch exits `drop_process`,
`rejected`, `deal_other_bank`.

Changing it writes a row to `status_history` (old → new, timestamp, who) and the
card shows the full change log underneath. Reaching a terminal stage
(`disbursed`, `drop_process`, `rejected`, `deal_other_bank`) stops the SLA
reminders. No migration is needed — `status_history` already exists from Phase 1.
