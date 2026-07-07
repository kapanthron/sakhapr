# Morby (the Bank Mortgage Buddy) — Data-Protection & Safety Audit

Scope: UU No. 27/2022 (Pelindungan Data Pribadi / **UU PDP**), and relevant
**OJK** / **Bank Indonesia** expectations for a bank-operated digital service.
This is an **engineering compliance review**, not legal advice — the findings
must be signed off by the Bank's DPO / Legal / Compliance before any pilot with real
applicant data.

Status legend: ✅ done · ⚠️ partial / needs config · ❌ gap to close before go-live.

---

## 0. Data inventory (what the system handles)

| Data | Sensitivity (UU PDP) | Where it goes |
|---|---|---|
| eKTP image + **NIK** | **Specific personal data** (identity) | Browser → **Google Gemini** (OCR) → Worker → **R2** + **email (Resend → Gmail)** |
| Name, phone, email, income, occupation, collateral | Personal data | Browser → R2 + email |
| Chat transcript | May contain personal data | Browser → **Google Gemini** (answers) → R2 + email |
| NIK structural verdict, pas foto | Derived / personal | R2 + email |
| Language pref (`sakhapr_lang`) | Non-personal | localStorage only |

NIK + eKTP are **data pribadi spesifik** (UU PDP Pasal 4(2)): they attract the
strictest consent + safeguard obligations.

---

## 1. Consent (your concern #1) — ✅ implemented, ⚠️ document source

UU PDP requires consent that is **explicit, specific, informed, and freely
given** (Pasal 20–22), recorded and demonstrable.

What is now in place:
- The eKTP consent checkbox is **never pre-ticked** (`index.html` has no
  `checked`; `resetEktpUi()` forces `checked = false`). The customer must tick it
  themselves. ✅
- The eKTP file picker is **disabled until** consent is ticked, and **Kirim is
  hard-blocked** server-bound submit re-checks `consent.checked` (`submitEktp`). ✅
- The consent label is a **question** linking to a **PDF** the customer can read
  (`docs/pernyataan/persetujuan-nasabah.pdf`), per your request. ✅
- Consent is now **recorded** with the submission: `consent.given`,
  `consent.at` (ISO timestamp), `consent.document` are stored in `meta.json` and
  shown as a **"Persetujuan (waktu)"** column in the Excel recap — so consent is
  auditable. ✅

To close before go-live:
- ❌ The bundled PDF is a **POC transcription**. Replace it with the Bank's **official
  Pemberitahuan Privasi (Privacy Notice) + Persetujuan Nasabah** PDF, version-
  controlled, and put its version id into `consentDoc`.
- ⚠️ Consent for **chat → Gemini** is currently covered only by the banner
  (notice), not an explicit tick. If chat content can contain personal data,
  obtain a basis for it too (notice + legitimate interest, or a tick).
- ❌ Provide **withdrawal of consent** and **erasure** to the data subject
  (Pasal 8, 9). Today only the admin can delete (`/api/admin/delete`).

---

## 2. Gemini & Resend — no leakage / encryption / no training (your concern #2)

### Google Gemini — ❌ **most important finding**
The key in use looks like a **Google AI Studio (free-tier) key**. On the **free
tier, Google may use your prompts and responses to improve its products and they
can be human-reviewed** — they are **not excluded from model training**. Sending
an **eKTP/NIK** there is a serious UU PDP exposure (sensitive data + cross-border
+ possible training use).

Required before real data:
1. **Switch to a paid tier**: **Gemini API (paid)** or, preferably for a bank,
   **Vertex AI** on Google Cloud. On **paid** services Google's terms state your
   data is **not used to train** their models.
2. **Vertex AI** additionally gives you: a **region** you choose (e.g.
   `asia-southeast2` Jakarta / `asia-southeast1` Singapore), **encryption at rest
   (optionally CMEK)**, TLS in transit, a **DPA / Cloud Data Processing
   Addendum**, and configurable/zero data retention. This is the bank-grade path.
3. Sign Google's **Data Processing Addendum** and record Google as a
   **prosesor** in the DPIA (already noted there).
4. **Minimise**: only the eKTP image + the question go to the model; do not send
   more fields than needed. Consider redaction.

Encryption: requests already go over **HTTPS/TLS**; the gap is **training use +
retention** on the free tier, which only the paid/Vertex tier fixes.

### Resend (email) — ⚠️
- Transit is **TLS**; Resend states it **does not train** on customer content.
- Content rests on Resend's infrastructure (US) and is delivered to **Gmail**
  (Google) — both are **cross-border processors**.
- Actions: sign Resend's **DPA**, prefer an **EU/region** endpoint if offered,
  set a short mail-retention, and keep using the **password-protected ZIP** so
  attachments aren't readable in transit logs.
- ⚠️ Current ZIP uses legacy **ZipCrypto** + a **shared static password**
  (`thebank2026#`) embedded in code — fine as a POC transit safeguard, **not**
  adequate for production. Move to **AES-256 ZIP** with a **per-lead random
  password delivered out-of-band**, or stop emailing raw files and have staff
  pull them from the authenticated admin only.

### Cloudflare (R2 + Worker) — ⚠️
- R2 is **encrypted at rest** by default; Worker↔R2 and browser↔Worker are TLS.
- ⚠️ R2 bucket region is **"Automatic"** — **pin a jurisdiction** and confirm it
  meets BI/OJK **data-localization** expectations (see §4).

---

## 3. Retention & PDP-violation hotspots (your concern #3)

UU PDP Pasal 5 / 43–44: keep data **only as long as necessary**, then delete or
anonymise. Audit of every store:

| Location | Retention today | Risk | Fix |
|---|---|---|---|
| **R2** `leads/*`, `sessions/*` | **Indefinite — no auto-delete** | ❌ High (sensitive data kept forever) | Add **R2 Object Lifecycle** rule (e.g. delete after N days) + documented retention policy; admin delete already exists |
| **Email inbox** (Gmail) | Indefinite | ❌ High | Define mailbox retention + auto-archive/delete; restrict access |
| **Gemini (free tier)** | Per Google free-tier (training/review) | ❌ Critical | Paid/Vertex tier (zero/limited retention, no training) — see §2 |
| **Resend** | Per Resend default | ⚠️ | DPA + short retention |
| **Browser memory** | Cleared on tab close / "Hapus data" | ✅ Low | — |
| **localStorage** | Only `sakhapr_lang` (non-personal) | ✅ | enforced by `assertNoPersistentStorage()` |
| **Admin session cookie** | HttpOnly, 8h, HMAC-signed | ✅ | — |

Other PDP/security gaps found in code:
- ❌ **Admin password in plaintext** `wrangler.toml [vars]` (`pocadmin`/`poc2026#`).
  Move to `ADMIN_PASS_SHA256` secret (already supported), use a strong password,
  add **MFA** and **access logging** for production (this is a **bank admin**
  console over real ID data).
- ⚠️ **Rate limiting** is **in-memory per-isolate** (`rateLimit()`), so it resets
  and isn't global. For production use a **Durable Object / KV** counter.
- ⚠️ **Chatlog** stores the **full** conversation (incl. anything the user typed,
  e.g. they might paste an NIK). Consider redaction/minimisation before storage.
- ❌ **No breach-notification procedure** (UU PDP Pasal 46: **3×24 hours** to the
  agency + data subjects). Document and rehearse it.
- ❌ **Data-subject rights** (access/rectify/erase/withdraw, Pasal 5–13): provide
  a channel + SLA; today only manual admin delete.
- ⚠️ **DPIA** exists (`DPIA.md`) but as POC — needs formal DPO sign-off; appoint a
  **DPO** (Pasal 53–54) since this is large-scale sensitive-data processing.

---

## 4. OJK / Bank Indonesia angle

As a **bank**-operated service, beyond UU PDP:
- **POJK 11/POJK.03/2022** (Penyelenggaraan Layanan Perbankan Digital) — risk
  management, security, and **third-party/cloud** governance for the Gemini /
  Resend / Cloudflare dependencies (vendor due diligence + exit plan).
- **POJK 6/POJK.07/2022** (Pelindungan Konsumen) — clear, non-misleading
  disclosures; the "bukan keputusan kredit" disclaimers help, keep them.
- **SEOJK / OJK cloud & data guidance** + **PP 71/2019** (PSE) — **electronic
  system & data placement**: certain financial data may need to be **processed/
  stored and have DR in Indonesia**, or have OJK-approved offshore arrangements.
  → **Pin Cloudflare R2 region** and **use Vertex AI in an approved region**, and
  get Compliance to confirm whether onshore placement is mandated for eKTP/NIK.
- **BI** (for payment-adjacent data, if any) — data-localization rules may apply.
- **Outsourcing/cloud notification** to OJK may be required for material vendors.

---

## 5. Remediation checklist (priority order)

**Must-fix before any real applicant data:**
1. ❌ Move Gemini to **paid Gemini API / Vertex AI** (no training, region, DPA, CMEK).
2. ❌ Replace POC consent PDF with **official the Bank Privacy Notice + Persetujuan**.
3. ❌ Add **R2 lifecycle retention** + mailbox retention; document the policy.
4. ❌ Harden admin: hashed password secret, strong creds, **MFA**, access logs.
5. ❌ Sign **DPAs** (Google, Resend, Cloudflare); record cross-border basis (Pasal 56).
6. ❌ Define **breach-notification (3×24h)** + **data-subject-rights** procedures.
7. ⚠️ **Pin R2 region** and confirm onshore-placement requirements with Compliance.

**Should-fix:**
8. ⚠️ AES-256 ZIP + out-of-band/per-lead password (or stop emailing raw files).
9. ⚠️ Durable-Object rate limiting; minimise/redact chatlog & fields sent to Gemini.
10. ⚠️ Formal **DPIA** sign-off and **DPO** appointment.

**Already in place:** ✅ explicit un-ticked consent + hard gate + **recorded
consent (timestamp/doc)**; ✅ TLS everywhere + R2 at-rest encryption; ✅ no
persistent personal data in the browser; ✅ HttpOnly/HMAC admin session; ✅
password-ZIP email; ✅ on-device-only language pref; ✅ "not a credit decision"
disclaimers.

---

*Generated as an internal engineering review for the Morby POC. Final compliance
determinations rest with the Bank Legal, Compliance, and the DPO.*
