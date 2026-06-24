# PRIVACY.md — Moggy + PARIKSA (as built)

**Purpose.** Data-protection control mapping for the Moggy prototype **as actually
deployed** on Cloudflare. It supersedes the earlier "zero egress / in-memory only"
control note: that design was changed on the owner's instruction to a server-backed
flow. This document describes what the running system really does so a compliance or
risk reviewer can assess it under Indonesia's UU PDP.

**Status.** Internal proof of concept. Not legal advice and not a completed DPIA
(see DPIA.md). Several controls are **POC-grade and must be hardened before any pilot
with real applicant data** — these are listed explicitly in §5.

**What changed from the original design (read this first).** The earlier PARIKSA/Moggy
note claimed processing stayed on the device with a single, consented egress. The built
system instead:
- **stores** the lead package on a server (Cloudflare R2), and an admin can list/download it;
- sends **chat text to Google (Gemini)** to generate answers;
- optionally **emails** the package via Resend (a third party);
- forwards data automatically after consent (no manual "attach and send" step).

So the app is **no longer zero-egress or in-memory-only**. The controls below reflect that.

---

## 1. What the app does and what data it touches

A browser app (static site) plus a Cloudflare **Worker** backend. The browser answers
KPR questions, runs a prescreen interview, performs on-device OCR + a deterministic NIK
structure check, builds files, and **uploads** them to the Worker, which **stores** them
in R2 and **emails** them. An admin page (server-checked login) lists and downloads them.

**Data inventory (as built).**

| Data item | Category | Where it lives | Leaves device? |
|---|---|---|---|
| Chat messages | Possibly personal | Browser RAM; **sent to Google Gemini** to answer; included in `chatlog.txt` | **Yes** — to Google, and to the server |
| Prescreen answers (incl. **full name, phone, email**, employment, repayment history, price, collateral) | Personal data | Browser RAM → `prescreen.txt` → server | **Yes** — to the server (+ email) |
| Uploaded eKTP image | Personal data (identity) | Browser RAM; **image sent to Google Gemini** to read the NIK (on-device Tesseract is fallback only); image is **uploaded** to the server | **Yes** — to **Google**, the server (+ email) |
| Extracted NIK fields | Personal data | Browser RAM; produced by **Google Gemini** OCR (or on-device fallback) | Embedded in the NIK report |
| NIK validation result | Derived data | `laporan_nik.pdf` → server | **Yes** — to the server (+ email) |
| Stored lead package (`prescreen.txt`, `chatlog.txt`, eKTP image, `laporan_nik.pdf`, `meta.json`) | Personal data | **Cloudflare R2 bucket `sakhapr-leads`** | Stored server-side |
| Admin session token | Functional | HttpOnly cookie (HMAC-signed), 8h | — |
| `knowledge_base.json`, `wilayah_nik.json` | Reference data, not personal | Static assets | No |

No analytics or advertising trackers are used.

---

## 2. Legal frame

Governing law: **UU No. 27 Tahun 2022 (UU PDP)**. The eKTP plus the prescreen answers
are personal data identifying an individual directly. **PT the Bank Indonesia is the
controller** (pengendali). The processors engaged by the build are:

| Processor | Role | Location / transfer |
|---|---|---|
| **Cloudflare, Inc.** | Hosting, Worker compute, **R2 storage**, Workers AI (fallback) | Global edge; R2 region currently **"Automatic"** — must be pinned |
| **Google LLC** (Gemini / Generative Language API) | Generates chat answers from customer text **and reads the uploaded eKTP image (OCR) to extract the NIK + fields** | **Cross-border (outside Indonesia)** — now receives a **biometric/identity document** |
| **Resend** (if `RESEND_API_KEY` set) | Email delivery of the package | **Cross-border (outside Indonesia)** |

Cross-border transfers to Google and Resend engage **UU PDP Pasal 56** (transfer abroad)
and require an adequate-protection basis and processor agreements. These are **not yet in
place** (see §5).

---

## 3. Control mapping to UU PDP (Pasal 16(2)) — as built

| Principle | How the build addresses it | Gap |
|---|---|---|
| **Terbatas, spesifik, sah, transparan** | Persistent UU PDP banner; consent box before eKTP upload; purpose limited to KPR lead handling. | Banner/consent do not yet name Google/Resend/Cloudflare as recipients of data. |
| **Sesuai tujuan** (purpose limitation) | Data used only to answer, prescreen, screen NIK, and forward the lead to the Bank. | Chat text sent to Google is a secondary disclosure that should be disclosed. |
| **Hak subjek** (subject rights) | On-device "Hapus semua data" clears the browser session; OCR/NIK run before upload. | **No deletion of server-stored data**: once uploaded to R2 there is no subject-facing or admin delete function yet. |
| **Akurat & akuntabel** | NIK check is deterministic (rules + table lookup), labelled a screening aid, never a credit decision. | OCR is now automatic (no human edit before send on the customer path) — accuracy relies on the admin re-checking via the Pariksa tool. |
| **Keamanan** (security) | HTTPS everywhere; browser CSP `connect-src 'self'`; admin auth via HMAC-signed HttpOnly cookie; R2 encrypted at rest by Cloudflare. | Admin credentials are **POC values in config** (`pocuob`/`poc2026#`); no rate limiting; no per-record encryption. |
| **Pemberitahuan** (notice & breach) | Purpose shown in UI. | No implemented 3×24h breach procedure; processors’ breach terms not contracted. |
| **Pemusnahan** (storage limitation) | Browser holds nothing persistent (no localStorage/IndexedDB/cookies for personal data). | **R2 retains lead data indefinitely** — no retention period or auto-deletion implemented. |
| **Akuntabilitas** | This doc + DPIA + the admin log provide traceability. | Processor DPAs (Cloudflare/Google/Resend) and lawful-basis record outstanding. |

**Lawful basis (Pasal 20).** To be selected and documented by the controller (e.g. contract
performance in a credit application). Not established by this tool.

---

## 4. Verification checklist (what is true today)

1. **On-device parts.** With the network on, OCR, the NIK check, the rate table, and the
   simulation run in the browser. (The chat needs the network because it calls Gemini.)
2. **Browser storage.** DevTools → Application: Local/Session Storage, IndexedDB, Cache,
   Cookies hold no personal data (the only cookie is the admin session on `/admin`).
3. **CSP.** The document response carries a `content-security-policy` header with
   `connect-src 'self'`. The browser never calls Google/Resend directly — those happen
   server-side from the Worker.
4. **Consent gate.** The eKTP file input is disabled until the UU PDP consent box is ticked.
5. **Transport.** All requests are HTTPS (Cloudflare).
6. **Server storage exists.** `/admin` (login required) lists stored leads with downloadable
   files — confirm who can access this and that the data there is expected.
7. **Admin auth.** `/api/admin/*` returns 401 without a valid signed session cookie.

---

## 5. Must-fix before any real applicant data (POC gaps)

1. **Retention & deletion.** Define a retention period and implement deletion of R2 lead data
   (admin delete + scheduled purge). Today data persists until manually removed in the R2 dashboard.
2. **Admin credentials.** Move `ADMIN_PASS` out of `wrangler.toml [vars]` into a secret, use a
   strong unique password, and consider IP allow-listing / MFA. Set `SESSION_SECRET` (done if
   configured).
3. **Cross-border transfers (Pasal 56).** Put DPAs in place with **Cloudflare, Google, and Resend**;
   record the adequacy/safeguard basis for transfer outside Indonesia; or disable the LLM/email and
   keep processing within an approved region.
4. **R2 region.** Pin the bucket to an approved location instead of "Automatic".
5. **Chat-to-LLM disclosure & minimisation.** Tell users chat text is processed by Google; avoid
   sending eKTP fields or other identifiers into the chat; consider a toggle to disable the LLM.
6. **Rate limiting / abuse** on `/api/submit` and `/api/chat`.
7. **Breach response.** Implement the 3×24h notification procedure (subject + authority).
8. **eKTP necessity.** Re-assess whether the full image must be uploaded/stored at first touch, or
   whether selected fields suffice.
9. **Update consent + banner** to name the server storage and the Google/Resend processors.

---

## 6. Summary for sign-off

Moggy (as built) processes regulated personal data partly on-device (OCR, NIK check) and partly
server-side: it **stores** the lead package in Cloudflare R2, **sends chat text to Google**, and
**optionally emails** the package via Resend. This is a deliberate move away from the original
zero-egress design and raises the stakes on storage, retention, access control, and cross-border
transfer. The controls in §3 are partly built and partly outstanding; the items in §5 must be
closed before any pilot with real applicant data. Lawful basis, processor agreements, retention,
and admin hardening sit with the Bank and deployment, not with the application alone.
