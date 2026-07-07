# Morby — Final End-to-End Review, PDP & Security Audit, and Investment Estimate

**Subject:** Morby (the Bank Mortgage Buddy) — browser KPR assistant + eKTP/NIK
prescreening (PARIKSA) + CMS (Phases 1–8).
**Status of the artefact:** working **prototype / POC**.
**Stated production target:** **on-premise servers + self-hosted ("own") AI**.
**Nature of this document:** internal engineering review. Legal/regulatory
conclusions must be signed off by the Bank's **DPO, Legal, and Compliance**.
This complements `COMPLIANCE_AUDIT.md`, `DPIA.md`, `PRIVACY.md`.

Legend: ✅ in place · ⚠️ partial / needs config · ❌ gap to close before go-live.

---

## 1. End-to-end functional review

**Architecture (today, on Cloudflare):** static SPA (vanilla HTML/CSS/ES
modules, no build) served by a Cloudflare Worker (`worker/index.js`) that also
exposes the API. Storage: **R2** (files) + **D1/SQLite** (CMS structured data).
AI: **Google Gemini** (chat answers + eKTP OCR). Email: **Resend**. Cron Trigger
drives the SLA sweep.

**Request surface (24 routes, all verified to parse):** public — `/api/submit`,
`/api/chat`, `/api/ocr`, `/api/session`; admin — `login/logout/set-password`,
`leads`, `diag`, `recap`, `file`, `delete`, and CMS `cms/{leads,delete,task,
run-sla,status,c360,bi,file-delete,audit}`. **Every admin data route is gated by
`requireAdmin` (HMAC session)** — verified; only `logout` is ungated (it only
clears the cookie). ✅

**Feature completeness (Phases 1–8), all syntax/JSON-validated and unit-checked:**
- P1 Lead ingest → D1 + R2, email fallback if D1 absent. ✅
- P2 Duplicate detection (phone/email) + qualification flags. ✅
- P3 Scoring (gaji/plafon/lokasi grades, weighted composite, sales owner) — exact
  thresholds from the brief; verified Surabaya/3M/60jt → A/A/A, owner HB. ✅
- P3.5 Prescreen now asks **plafon kredit diajukan** + **tenor (tahun)**. ✅
- P4 SLA tasks (call 30 min, WA 1 h after call done) + Cron reminders + Friday
  15:00 WIB weekly sweep; terminal statuses stop reminders. ✅
- P5 Pipeline (10 statuses, exact keys/labels) + `status_history`. ✅
- P6 Customer-360 multi-tab XLSX (Total + Primary/Second/Take Over) — validated
  as a real OOXML package with correct partitioning; pas-foto JPG export. ✅
- P7 Dashboard BI (big numbers + monthly Volume/Nasabah chart), numbers match D1;
  "sedang di analis" = `submitted` only, approval rate = approved/(approved+
  rejected). ✅
- P8 First-login password (hashed in D1, none in repo), per-document delete,
  download/delete audit log + viewer. ✅

**Engineering robustness notes (non-blocking):**
- ⚠️ Single 1,862-line `worker/index.js` — fine for a POC; modularize for
  maintainability before a production team owns it.
- ⚠️ In-memory `rateLimit()` is **per-isolate** — not a global limiter.
- ⚠️ XLSX/ZIP are hand-rolled (no deps) — neat for portability, but add a test
  fixture so format regressions are caught.
- ✅ Deterministic NIK validation + calculators are local (no AI dependency).
- ✅ Strong CSP and security headers in `_headers` (`default-src 'self'`,
  `object-src 'none'`, `frame-ancestors 'none'`, nosniff, no-referrer).

**Verdict:** functionally complete and internally consistent for a POC. No broken
routes or data-integrity issues found in review.

---

## 2. Data inventory & flow (updated for the CMS)

| Data | UU PDP class | Persisted where (today) | Retention |
|---|---|---|---|
| eKTP image + **full NIK** | **Data pribadi spesifik** | R2 (`leads/<id>/ektp.*`, `laporan_nik.pdf`) + emailed ZIP | ❌ indefinite |
| Name, phone, email, income, job, collateral, plafon, tenor | Personal | R2 `meta.json`/`prescreen.txt` + **D1 `leads`** + emailed ZIP | ❌ indefinite |
| **Masked** NIK (6+****+4) | Reduced | **D1 only** (full NIK never enters D1) ✅ | with lead |
| Chat transcript | May contain personal data | R2 `chatlog.txt`; sent to Gemini for answers | ❌ indefinite |
| Pipeline status, history, scores, audit log | Derived/operational | D1 | with lead |
| Admin password | Credential | **D1 `app_auth` as SHA-256 hash** ✅ | until changed |
| Language pref | Non-personal | `localStorage` (`sakhapr_lang`) only ✅ | client |

**Good:** D1 (the queryable CMS DB) holds **only masked NIK**; the full NIK is
confined to the eKTP image / NIK PDF in R2. Data minimization in the structured
store is correct.

---

## 3. UU PDP (UU 27/2022) compliance audit

| # | Area | Finding | Status |
|---|---|---|---|
| 3.1 | **Consent** (Psl 20–22) | eKTP consent is **never pre-ticked**, file picker disabled until ticked, submit re-checks it, links a privacy PDF, and consent (given/at/doc) is **recorded** and shown in the recap. | ✅ mechanism / ❌ replace POC PDF with official Privacy Notice |
| 3.2 | **Specific personal data safeguards** (Psl 4) | eKTP/NIK get strict handling; masked in DB. Full copies in R2/email still need encryption-in-use + access control. | ⚠️ |
| 3.3 | **Cross-border transfer** (Psl 56) | eKTP/NIK + chat go to **Google (Gemini)** and email to **Resend (US) → Gmail** — all **outside Indonesia**, on a **free-tier AI key that may train on / human-review** the data. | ❌ **critical** (resolved by on-prem AI — see §6) |
| 3.4 | **Retention / disposal** (Psl 5, 43–44) | R2 + mailbox keep data **forever**; no lifecycle rule. | ❌ |
| 3.5 | **Data-subject rights** (Psl 5–13) | Access/rectify/erase/withdraw not exposed to the subject; only admin delete (now per-document + per-lead, audited). | ❌ provide a channel/SLA |
| 3.6 | **Breach notification** (Psl 46, 3×24 h) | No documented/rehearsed procedure. | ❌ |
| 3.7 | **Accountability / DPIA / DPO** (Psl 34, 53–54) | DPIA exists as POC; large-scale sensitive processing needs DPO + formal sign-off. | ⚠️ |
| 3.8 | **Audit trail** | Download/delete/status/password/export now logged to `audit_log` with actor+time, viewable in-app. | ✅ (new in P8) |

**Net:** the biggest PDP exposures are **cross-border + free-tier AI training**
(3.3) and **no retention/erasure** (3.4/3.5). The on-prem target removes 3.3
almost entirely.

---

## 4. OJK / Bank Indonesia considerations

- **POJK 11/POJK.03/2022** (Layanan Perbankan Digital) — IT risk management +
  **third-party/cloud governance** (vendor due diligence, exit plan) for any AI/
  email/cloud dependency that remains.
- **POJK 6/POJK.07/2022** (Pelindungan Konsumen) — keep the "**bukan keputusan
  kredit**" disclaimers; ensure rate/promo disclosures are accurate.
- **PP 71/2019 (PSE) + SEOJK cloud guidance** — **electronic-system & data
  placement**: eKTP/NIK and credit data may require **onshore processing/storage
  + DR in Indonesia** (or an OJK-approved arrangement). **This is the primary
  driver for the on-premise decision.** Confirm scope with Compliance.
- **Material outsourcing / cloud use** may require **OJK notification**.

---

## 5. Security audit

| Domain | Finding | Status |
|---|---|---|
| **AuthN** | First-login password, stored only as SHA-256 in D1; **no password in repo** (`ADMIN_PASS` removed). Login user is constant-time compared. | ✅ much improved / ⚠️ add **MFA** + per-user accounts for a bank admin |
| **Password hashing** | Plain **SHA-256** (fast hash). Adequate vs repo-leak, but weak vs offline brute-force. | ⚠️ move to **bcrypt/scrypt/Argon2id** + per-user salt |
| **Session** | HttpOnly + Secure + SameSite=Strict cookie, HMAC-signed, 8 h TTL. | ✅ / ⚠️ `SESSION_SECRET` **must** be set (dev fallback exists) |
| **AuthZ** | All admin data routes behind `requireAdmin`; single admin role only. | ✅ / ⚠️ add roles (sales vs admin) + least privilege |
| **Transport** | TLS everywhere (browser↔Worker, Worker↔R2/Gemini/Resend). | ✅ |
| **Storage at rest** | R2 + D1 encrypted at rest (Cloudflare default). | ✅ |
| **Input validation** | IDs constrained to `[A-Za-z0-9-]`; R2 keys checked against `leads/<id>/`, no `..`; NIK digit-clamped. | ✅ |
| **XSS** | Admin uses `escapeHtml`; chat renders via XSS-safe markdown; strong CSP. | ✅ |
| **Rate limiting** | Present on submit/chat/ocr/login but **per-isolate in-memory** — not global, resettable. | ⚠️ Durable Object/KV |
| **Secrets** | API keys via env/secrets, not in repo. Email ZIP uses **legacy ZipCrypto + a static shared password** in code. | ⚠️ → AES-256 + per-lead/out-of-band, or stop emailing raw files |
| **Audit** | Security-relevant admin actions logged (P8). | ✅ / ⚠️ ship to a tamper-evident sink for production |
| **Brute force** | Login limited to 8/10 min per IP (in-isolate). | ⚠️ strengthen + lockout/alerting |

No injection, traversal, or auth-bypass found in review. The headline hardening
items are **MFA + stronger password hashing + global rate limiting + AES email**.

---

## 6. How the on-premise + self-hosted AI target changes the risk profile

Moving to **on-prem servers + own AI** is not just an infra choice — it
**resolves most of the critical compliance findings**:

| Finding | On-prem + self-hosted AI effect |
|---|---|
| 3.3 Cross-border + free-tier AI **training/human-review** of eKTP/NIK | **Eliminated** — the eKTP image and chat never leave the Bank's network; a self-hosted LLM/VLM does OCR + answers locally. **This is the single biggest win.** |
| OJK/PP71 data-localization for eKTP/NIK | **Satisfied** — processing + storage + DR all onshore. |
| Resend/Gmail cross-border email of raw files | **Removed** — internal SMTP / object store; staff pull from the authenticated CMS. |
| Vendor DPAs (Google/Resend/Cloudflare) | **Mostly moot** for the data plane (still need DPAs for any residual SaaS). |
| Retention (3.4) | Now **fully in the Bank's control** (storage lifecycle on its own systems). |

**What still must be done regardless of where it runs:** retention/erasure
policy + data-subject-rights channel (3.4/3.5), breach procedure (3.6), DPIA
sign-off + DPO (3.7), MFA + stronger hashing + global rate limiting + AES email
(§5), and replacing the POC consent PDF (3.1).

**AI-quality caveat:** self-hosting must match today's Gemini quality for (a)
Indonesian KPR Q&A and (b) **eKTP OCR/vision**. Budget for model selection +
**evaluation/fine-tuning** (e.g., a 30–70B-class instruct LLM for chat and a
vision-language model such as a Qwen-VL-class model for eKTP reading), with a
human-in-the-loop check on NIK extraction (already deterministic-validated).

---

## 7. Remediation checklist (priority)

**Must-fix before real applicant data**
1. ❌ Replace third-party AI with **self-hosted LLM+VLM on-prem** (removes 3.3 &
   localization). Until then, if any cloud AI is used, it must be **paid/Vertex,
   onshore region, DPA, no-training**.
2. ❌ **Retention**: storage lifecycle + documented policy + scheduled deletion.
3. ❌ **Data-subject rights** channel (access/rectify/erase/withdraw) + SLA.
4. ❌ **Breach-notification** procedure (3×24 h) — documented + rehearsed.
5. ❌ Replace POC consent PDF with the **official Privacy Notice + Persetujuan**.
6. ⚠️ Security hardening: **MFA**, **Argon2id/bcrypt** password hashing,
   **global rate limiting**, set `SESSION_SECRET`, per-user roles.
7. ⚠️ Stop emailing raw files / move to **AES-256 + out-of-band** if email stays.

**Should-fix**
8. ⚠️ Formal **DPIA sign-off** + **DPO** appointment.
9. ⚠️ Modularize the Worker; add format/security regression tests; ship audit log
   to a tamper-evident store; pentest before go-live.

**Already in place:** ✅ un-ticked recorded consent; ✅ TLS + at-rest encryption;
✅ masked NIK in DB; ✅ HttpOnly/HMAC sessions, no password in repo; ✅ strong CSP;
✅ full admin-route auth gating; ✅ audit logging; ✅ "not a credit decision"
disclaimers.

---

## 8. Investment estimate — On-premise + own AI vs Vendor (cloud)

> **Planning-grade only (±30%).** Figures depend on volume, HA/DR depth, and
> procurement. Assumed reference scale: **~3,000 leads/month, ~20,000 chat
> sessions/month, peak ~20–50 concurrent chats**. FX ≈ **Rp 16,000 / USD 1**
> (2026). Hardware prices are list/street; bank procurement may differ.

### 8A. Option A — On-premise + self-hosted AI (the stated target)

The cost centre is GPU inference for a self-hosted LLM (Indonesian KPR chat) +
VLM (eKTP OCR). Two tiers:

**CapEx (one-time)**

| Item | Lean (single-site) | Resilient (HA + DR) |
|---|---|---|
| GPU inference node(s) — e.g. 2× L40S 48GB / node, 512GB–1TB RAM, NVMe | 1 node ~ **$35–45k** | 2 nodes ~ **$80–100k** |
| App / web servers (no GPU) | 1× ~ **$8–12k** | 2× ~ **$20k** |
| Database + encrypted storage array (RAID, 10–20 TB usable) | ~ **$15–20k** | ~ **$30–45k** |
| Network: NGFW pair, switches, load balancer | ~ **$15–25k** | ~ **$35–55k** |
| Rack, UPS, PDU, cooling (if extending existing DC) | ~ **$10–20k** | ~ **$20–35k** |
| DR site (secondary; warm/cold) | (deferred) | ~ **$40–70k** |
| Software/licenses (RHEL, backup, monitoring, vector DB, MLOps) | ~ **$10–20k** | ~ **$20–35k** |
| Implementation: SI labor, security hardening, **model eval/fine-tune**, pentest | ~ **$30–50k** | ~ **$50–90k** |
| **CapEx total** | **≈ $125–230k** (Rp 2.0–3.7 bn) | **≈ $295–470k** (Rp 4.7–7.5 bn) |

**OpEx (per year)**

| Item | Range / year |
|---|---|
| Power + cooling (GPU servers run continuously) | $15–30k |
| Hardware/OS/support contracts | $20–40k |
| Staff allocation (DevOps/MLOps + security share, ~1–2 FTE) | $50–90k |
| Annual model re-eval, pentest, audits | $15–30k |
| **OpEx total** | **≈ $100–190k / yr** (Rp 1.6–3.0 bn) |

**3-year TCO (resilient):** ≈ CapEx $350k + 3×$140k ≈ **$770k (~Rp 12.3 bn)**.
**3-year TCO (lean):** ≈ $175k + 3×$120k ≈ **$535k (~Rp 8.5 bn)**.

### 8B. Option B — Vendor / cloud (managed)

Keep Cloudflare-style compute + a **paid, onshore, no-training** AI (e.g. Vertex
AI in Jakarta region) + managed email; little/no CapEx.

| Item | Range |
|---|---|
| Edge compute + storage + DB (Workers/R2/D1-class) | $100–300 / mo |
| **AI** — chat (~100M tokens/mo, Flash-class) + eKTP vision (~3k img/mo), paid/onshore tier | $150–800 / mo |
| Email (managed, with DPA) | $20–100 / mo |
| Compliance/region premium (onshore region, dedicated where needed) | +20–50% |
| One-time integration + DPAs + pentest | $20–50k once |
| **OpEx total** | **≈ $400–1,500 / mo ≈ $5–18k / yr** (Rp 80–290 m) |

**3-year TCO:** ≈ one-time $35k + 3×$11k ≈ **$70k (~Rp 1.1 bn)** at this scale.

### 8C. Comparison & recommendation

| | On-prem + own AI | Vendor / cloud |
|---|---|---|
| 3-yr TCO (this scale) | **~$535–770k** (Rp 8.5–12 bn) | **~$70k** (Rp 1.1 bn) |
| Data localization / sovereignty | ✅ fully onshore | ⚠️ needs OJK-approved onshore region + DPA |
| Cross-border / AI-training risk | ✅ eliminated | ⚠️ mitigated only on paid no-training tier |
| Up-front capital | High | ~none |
| Scales with volume | Fixed-ish (until capacity hit) | Linear with usage |
| Ops burden | High (own DC + MLOps) | Low (managed) |
| **Break-even** | Cloud is **far cheaper at prototype/early scale**; on-prem wins on **compliance/sovereignty** and at **very high sustained volume**. | |

**Recommendation:** the **compliance driver (PP71/OJK localization + no third-
party AI on eKTP/NIK)**, not raw cost, justifies **on-prem + self-hosted AI** —
it is materially more expensive but removes the audit's most serious findings. A
pragmatic path: **start lean on-prem for the AI/data plane** (single GPU node +
spare, onshore storage), defer the full DR tier until volume/criticality demand
it, and **keep cloud only for non-sensitive edge delivery** if desired. Final
numbers should be firmed up with a sizing test of the chosen models against the
target concurrency and an eKTP-OCR accuracy benchmark.

---

*Internal engineering review for the Morby POC. Final compliance and procurement
decisions rest with the Bank's Legal, Compliance, DPO, and IT/Procurement.*
