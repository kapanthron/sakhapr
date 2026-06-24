# Moggy — Claude Code Build Prompts

Paste the **master prompt once** at the start of each session, then paste **one phase prompt**.
Build one phase per session and start a fresh session (re-pasting the master prompt) between
phases — this keeps each phase on a clean context budget.

- App builds at the **repo root** (output directory `/`), matching `wrangler.toml` and `_headers`.
- Never read `data/kode_wilayah_flat.json` (1.18 MB, unused). The region transform is **already
  done** — `data/wilayah_nik.json` exists in the shape the validator expects.
- Deploy instructions live in `DEPLOY.md`.

---

## Master prompt (paste first, every session)

```
You are building "Moggy", a privacy-first, browser-only GenAI mortgage assistant for the Bank
Indonesia KPR, with an embedded eKTP integrity module called PARIKSA. I am the product owner
and I do not write code, so explain what each file does in plain language and never leave a
step half done.

== HARD RULES ==
- Plain HTML, CSS, and vanilla JavaScript in ES modules. No build step, no framework, no
  bundler, so I can open index.html directly AND deploy it to Cloudflare Pages with no compile.
- The app's index.html, styles.css, and app.js live at the REPO ROOT (output directory "/").
  modules/ and data/ are subfolders. Do not nest the app inside another folder.
- All personal data stays in memory only. Never use localStorage, sessionStorage, IndexedDB,
  Cache API, or cookies for any personal data. Provide a "Clear all data" button that wipes
  memory and revokes object URLs.
- A strict Content Security Policy already exists in the repo-root `_headers` file (served by
  Cloudflare Pages). Treat it as the source of truth. If a phase needs another origin or
  directive, tell me the EXACT origin/directive and why, and update `_headers` deliberately —
  never loosen it silently. The baseline already allows: 'wasm-unsafe-eval' and worker-src
  blob: (Tesseract), img-src blob: data: (eKTP preview), form-action mailto: (Path A draft).
- Bundle all third-party libraries locally under vendor/. Do not load personal data through
  any external network call.
- Customer language is Bahasa Indonesia. Code identifiers and comments in English.
- Every answer about money must append the matching disclaimer from data/knowledge_base.json.
  Always show the persistent PDPA notice (UU No. 27 Tahun 2022) and the NIK screening disclaimer.
- The NIK check is a deterministic screening aid for a human, never an automated credit decision.
- Ask me before introducing anything that sends data off the device.

== TOKEN / CONTEXT DISCIPLINE (important — follow exactly) ==
- NEVER open or read data/kode_wilayah_flat.json (it is 1.18 MB of raw source). It is NOT used
  at runtime and is not needed at all — see the next point.
- The region-table transform is ALREADY DONE. data/wilayah_nik.json exists, with the exact shape
  the validator expects: { provinsi: {2-digit:name}, kabupaten_kota: {4-digit:name},
  kecamatan: {6-digit:name} }. Do not regenerate it. Load it at runtime via fetch; if you need
  to confirm its shape, read only the first ~30 lines, never the whole file.
- Treat vendored libraries (Tesseract.js, jsPDF) as binaries: download them into vendor/ and
  reference them. Do not read their contents into context.
- We build ONE PHASE PER SESSION. After each phase I will start a fresh session and re-paste
  this master prompt, so make each phase self-contained and leave the repo in a clean, testable
  state. Do not try to build ahead.

== ASSETS in data/ (treat values as verified facts) ==
- knowledge_base.json  (Moggy master KB; quote figures exactly, use the calculators block for
  any number, use decision_routing for product choice, append the matching disclaimer)
- prescreen.json       (three prescreen sets: PRI, 2ND, TO)
- wilayah_nik.json     (already-transformed region table — see token rules above)
- reference/validate-nik_reference.js  (deterministic NIK validator to port to an ES module)
- reference/nik-test-fixtures.md       (known-good / known-bad NIKs for Phase 4 verification)

== BUILD PLAN (I will hand you one phase at a time; do not start until I give the phase) ==
  Phase 1  Shell: index.html, styles.css, app.js, modules/privacy.js — PDPA banner, in-memory
           store, Clear-all. Kapanfund look: deep teal #0E7C7B, cream bg, Inter + IBM Plex Mono.
  Phase 2  modules/intentRouter.js + modules/knowledgeAnswer.js over knowledge_base.json.
  Phase 3  modules/prescreen.js → file a (.txt transcript).
  Phase 4  Port reference/validate-nik_reference.js → modules/validateNik.js + modules/
           regionData.js (loads wilayah_nik.json). NO transform step. Verify the three fixtures
           in nik-test-fixtures.md (3175061708950001, 3203016503880002, 3402010102000003 all
           Consistent) via a temporary debug panel.
  Phase 5a modules/ocr.js (Tesseract.js vendored locally) + consent gate + editable OCR fields,
           then run validateNik.
  Phase 5b modules/pdfReport.js (jsPDF vendored locally) → file c (.pdf report).
  Phase 6  modules/bundle.js (3 files, canvas-downscale image to <5MB) + modules/sendDraft.js
           (Path A: download bundle + prefilled mailto draft to hendrik.panthron@thebank.co.id).
  Phase 7  (optional, ask me first) modules/semanticSearch.js with Transformers.js.
  Phase 8  (optional, ask me first) Path B relay.

After each phase, give me a short "How to test" checklist I can run in the browser with no
coding, and wait for my confirmation before the next phase. Confirm you understand these rules
and then STOP — do not write any code until I send "Phase 1".
```

---

## Phase prompts (paste one per session, after the master prompt)

### Phase 1
```
Phase 1. Create index.html, styles.css, app.js, and modules/privacy.js at the repo root. The
shell shows a chat area, a persistent PDPA notice in Bahasa Indonesia at the top, and a Clear
all data button. Use the Kapanfund look: deep teal #0E7C7B primary, cream background, Inter for
text and IBM Plex Mono for any code or numbers (self-host the fonts under vendor/, do not use an
external font CDN). The CSP is already in the repo-root _headers file — do not add a conflicting
<meta> CSP. Implement an in-memory store object and the Clear all data action (wipe memory,
revoke object URLs). Give me the How to test checklist.
```

### Phase 2
```
Phase 2. Build modules/intentRouter.js and modules/knowledgeAnswer.js reading
data/knowledge_base.json. intentRouter classifies a message into INFORMATION, WHICH_PRODUCT,
READY_TO_APPLY, or SMALL_TALK using a keyword and synonym map in Bahasa Indonesia. For
WHICH_PRODUCT use the decision_routing block to name the product and eligible program.
knowledgeAnswer returns the KB fact and always appends the matching disclaimer; check promos
against program_period.end and warn if past. Wire both into the chat. How to test included.
```

### Phase 3
```
Phase 3. Build modules/prescreen.js. Load data/prescreen.json with three sets (PRI,
2ND, TO). After the router detects READY_TO_APPLY, ask which situation applies, run
that set one question at a time, honour any 'conditional' (skip questions whose dependency is not
met), store answers in memory, and produce file a: a clean .txt transcript with a header
(timestamp, product, disclaimer) that downloads on demand. How to test included.
```

### Phase 4
```
Phase 4. Do NOT write any transform and do NOT open data/kode_wilayah_flat.json. The region
table data/wilayah_nik.json already exists with keys provinsi (2-digit), kabupaten_kota
(4-digit), kecamatan (6-digit). Port reference/validate-nik_reference.js to modules/validateNik.js
as an ES export, and load the table via modules/regionData.js (fetch wilayah_nik.json). Add a
temporary debug panel where I type a NIK and see the full per-check result. Verify against the
fixtures in reference/nik-test-fixtures.md: 3175061708950001 Consistent, 3203016503880002
Consistent, 3402010102000003 Consistent. The verdicts must match exactly. How to test included.
```

### Phase 5a
```
Phase 5a. Build modules/ocr.js using Tesseract.js bundled locally under vendor/tesseract (the
_headers CSP already allows its WASM and Web Worker). Add a consent gate: the eKTP file input
stays disabled until the customer ticks an explicit consent box naming the purpose and the
recipient mailbox (hendrik.panthron@thebank.co.id). On upload, OCR reads the NIK and printed fields
and shows them in editable boxes so I can correct OCR mistakes, then runs validateNik and shows
the verdict. No PDF yet. How to test included.
```

### Phase 5b
```
Phase 5b. Build modules/pdfReport.js with jsPDF bundled locally under vendor/ to render file c:
a NIK validation report PDF listing every check, status, reason, the final verdict, and the
screening disclaimer. Wire a button that generates and downloads it after the Phase 5a verdict.
How to test included.
```

### Phase 6
```
Phase 6. Build modules/bundle.js and modules/sendDraft.js for Path A. bundle.js collects file a
(.txt), the eKTP image (file b), and file c (.pdf). If the total exceeds 5MB, downscale the eKTP
image with a canvas until the bundle fits, and tell me the final size. sendDraft.js downloads the
bundle and opens a prefilled mailto draft to hendrik.panthron@thebank.co.id with subject
"Moggy lead + eKTP screening" and a body summarising product, prescreen status, and NIK
verdict, plus a line reminding the sender to attach the downloaded bundle. After send, prompt
Clear all data. How to test included.
```

### Phase 7 (optional — ask first)
```
Phase 7. Add modules/semanticSearch.js using @huggingface/transformers with
Xenova/multilingual-e5-small to embed the knowledge base once and answer fuzzy questions the
keyword router misses. BEFORE wiring it, tell me the exact model origin to add to connect-src and
script-src in _headers, and the first-load download size. Keep Layer 1 as default and fall back
to it if the model fails to load. Remind me to refresh the DPIA.
```

### Phase 8 (optional — ask first)
```
Phase 8. Add Path B: a thin relay I own (Cloudflare Worker or Google Apps Script Web App) that
receives the bundle over HTTPS and emails it, retaining nothing. Tell me the exact relay origin
to add to connect-src in _headers before wiring it, document the relay as a processor, and remind
me to refresh the DPIA. Keep Path A as a fallback.
```
