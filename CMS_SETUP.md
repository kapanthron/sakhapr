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
