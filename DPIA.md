# DPIA — SakhaPR + PARIKSA (as built, server-backed)

Penilaian Dampak Pelindungan Data Pribadi (UU 27/2022, Pasal 34). This revision reflects the
**system as actually deployed** (Cloudflare Worker + R2 storage + Google Gemini chat + optional
Resend email), which differs materially from the earlier in-memory/zero-egress design. Placeholders
`[ ... ]` need the owner and the responsible officer. POC-grade assessment; ratings are starting
points for review.

---

## 0. Document control

| Field | Value |
|---|---|
| Project | SakhaPR + PARIKSA — KPR assistant, eKTP screening, server-backed lead intake (POC) |
| Version | v0.3 (server-backed design: R2 storage + LLM chat + email) |
| Author | Hendrik Panthron Pangarso Mursid |
| DPO / reviewer | `[name]` |
| Date | 2026-06-20 |
| Status | Draft |
| Linked | PRIVACY.md, wrangler.toml, worker/index.js, knowledge_base.json |

---

## 1. Screening: is a DPIA required? — Yes

| High-risk trigger (Pasal 34(2)) | Applies? | Note |
|---|---|---|
| Automated decision with significant effect | No | NIK check + prescreen are screening aids; confirm no downstream auto-reject. |
| Sensitive / specific personal data | `[assess]` | eKTP + financial prescreen, linked, raises sensitivity. |
| Large-scale processing | Not yet | POC scale; revisit at pilot. |
| Data matching | `[assess]` | Does UOB match submissions downstream? |
| Systematic monitoring | No | — |
| New technology | **Yes** | Browser OCR (WASM), LLM (Gemini) over customer text, server storage. |
| **Cross-border transfer** | **Yes** | Chat text → Google; email → Resend; compute/storage → Cloudflare. |
| **Central storage of identity + financial data** | **Yes** | R2 retains the full lead package. |

**Conclusion.** A DPIA is required and the risk profile is **higher** than the original design because
data now leaves the device, is **stored centrally**, and is **transferred cross-border**.

---

## 2. Description of the processing (as built)

- **Purpose.** Answer KPR questions, route product, run prescreen, capture identity, screen NIK, and
  **intake the lead to UOB** (store + notify).
- **Lawful basis (Pasal 20).** `[Select and justify — controller decides.]`
- **Data categories.** Chat text; prescreen answers incl. **name, phone, email**, employment,
  repayment history, transaction price, collateral; eKTP image; extracted NIK fields; NIK result.
- **Data subjects.** Prospective KPR applicants.
- **Data flow (actual).**
  1. Browser: chat, prescreen, on-device OCR + NIK check, file build.
  2. Chat text → **Google Gemini** (Generative Language API) to generate answers.
  3. On "Kirim": `prescreen.txt` + `chatlog.txt` + eKTP image + `laporan_nik.pdf` → **Cloudflare
     Worker** → stored in **R2 (`sakhapr-leads`)** + `meta.json`.
  4. Worker emails the files via **Resend** (if configured) to `hendrik.panthron@gmail.com`.
  5. **Admin** (`/admin`, server-checked login) lists and downloads all stored leads.
- **Parties.** Controller: PT Bank UOB Indonesia. Processors: **Cloudflare** (compute/storage/Workers
  AI), **Google** (chat LLM), **Resend** (email). Recipient mailbox: `hendrik.panthron@gmail.com`.
- **Retention.** Browser: nothing persistent. **R2: indefinite — no retention/auto-delete
  implemented.** Email inbox: per recipient/UOB policy. Gemini/Resend: per their policies.
- **Technology.** Static site; Tesseract WASM OCR; deterministic NIK validator + bundled Kemendagri
  table; Cloudflare Worker; R2; Gemini 3.5 Flash; HMAC-signed admin cookie.

---

## 3. Necessity and proportionality

- **Each item necessary?** `[Per field. Name/phone/email = contactability; eKTP + NIK = identity
  screen; prescreen = qualification.]`
- **Less data possible?** `[Assess: is the full eKTP image required and must it be stored, or would
  extracted fields + an on-device-only check suffice?]`
- **Minimisation gaps (as built):** chat text goes to a third-party LLM; the **raw eKTP image is
  stored** (not just derived fields); data is retained indefinitely.
- **Transparency.** Banner + consent box present, but do **not** yet name Google/Resend/Cloudflare or
  the server storage.
- **Proportionality conclusion.** `[To be completed — likely "proportionate only after the §5 PRIVACY
  gaps are closed".]`

---

## 4. Risk assessment

L and I on 1–5; Rating = L×I. Suggested for review; **higher than the prior design** due to storage
and cross-border transfer.

| # | Risk to the data subject | L | I | Rating | Notes |
|---|---|---|---|---|---|
| R1 | Intercept in transit | 1 | 5 | 5 | HTTPS throughout (Cloudflare). |
| R2 | **Breach of R2-stored lead data** | 3 | 5 | **15** | Central store of identity + financial data; no retention limit; main exposure. |
| R3 | **Unauthorised admin access** | 3 | 5 | **15** | Admin password is a POC value in config; no MFA/rate-limit. |
| R4 | **Cross-border transfer without safeguards** (Google/Resend/Cloudflare) | 3 | 4 | **12** | No DPAs / Pasal 56 basis yet. |
| R5 | **Chat text with personal data sent to Google** | 3 | 3 | 9 | Customer may type identifiers; processed abroad. |
| R6 | Inaccurate OCR misleads (no human edit on customer path) | 3 | 3 | 9 | Mitigate: admin Pariksa re-check; NIK labelled screening only. |
| R7 | Indefinite retention (no deletion) | 4 | 3 | 12 | No purge/delete implemented. |
| R8 | Data exposed on user device | 2 | 4 | 8 | Browser holds nothing persistent; depends on device. |
| R9 | Stale region table false-warning | 1 | 2 | 2 | Unmatched code is a warning, not a fail. |

---

## 5. Mitigation and protection measures

| Risk | Control | Owner | Status |
|---|---|---|---|
| R2 | R2 encryption at rest (Cloudflare default); retention period + scheduled deletion; pin bucket region; minimise stored fields | Engineering / `[owner]` | **To build** |
| R3 | Move `ADMIN_PASS` to a secret; strong password; `SESSION_SECRET` set; add rate-limit + IP allow-list / MFA | Engineering | **Partly built** (HMAC cookie) |
| R4 | DPAs with Cloudflare, Google, Resend; document Pasal 56 transfer basis; or disable LLM/email and keep data in-region | `[owner]` / Legal | **To do** |
| R5 | Disclose LLM processing; instruct users not to enter eKTP/identifiers in chat; optional LLM toggle; consider Workers AI (stays in Cloudflare) | Engineering | **To do** |
| R6 | Human review; admin Pariksa OCR re-check; deterministic NIK; outputs labelled screening only | `[owner]` | Built / policy |
| R7 | Implement retention + delete (admin + auto-purge) | Engineering | **To build** |
| R8 | Managed devices; screen lock; on-device "Hapus semua data" | IT / `[owner]` | Partly |
| Breach | 3×24h notification procedure (subject + authority) | DPO | **To do** |
| Consent | Update banner/consent to name server storage + processors | Engineering | **To do** |

---

## 6. Residual risk and decision

- **Residual risk after current build:** **Medium-High.** Moving from in-memory to **central storage +
  cross-border LLM/email** raises R2, R3, R4, and R7. These carry real weight until the §5 items and
  PRIVACY.md §5 gaps are closed.
- **DPO opinion.** `[Proceed with conditions / Do not proceed with real data until gaps closed.]`
- **Conditions (suggested):** retention + deletion implemented; admin hardened (secret password, MFA/
  rate-limit); processor DPAs + Pasal 56 basis signed; R2 region pinned; consent/banner updated; no
  auto-decisioning; managed devices only.
- **Decision and owner.** `[name, role, date.]`
- **Review trigger.** Re-assess before any scale-up, before adding a recipient/processor, before
  enabling email to external recipients, or at `[date]`.

---

*Supports accountability under UU PDP; does not replace legal review. The build is a prototype: do
not process real applicant data until the conditions above are met and signed off.*
