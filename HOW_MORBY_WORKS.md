# How Morby Ver1.0 Works

Morby (the Bank Mortgage Buddy) is a browser-based GenAI KPR (mortgage) assistant
with eKTP/NIK screening and a built-in lead CMS. This document summarizes how it
works from two angles — **Business/Workflow** and **System/Architecture** — each
in a **high-level** and a **detailed** version.

Diagrams are Mermaid (render on GitHub/Notion or at <https://mermaid.live>).

---

## 1. Business / Workflow

### 1A. High-level

The whole funnel — from a customer question to a disbursed loan — runs in one
flow, mostly automated.

```mermaid
flowchart LR
    A([👤 Nasabah]) --> B["💬 Morby<br/>Tanya-jawab KPR · Kalkulator<br/>Prescreen · Skrining eKTP"]
    B --> C["🗂️ CMS otomatis<br/>Dedup · Skor & Grade<br/>Assign Sales · Buat tugas SLA"]
    C --> D["📞 Sales<br/>Pipeline 10 status<br/>Follow-up + keterangan"]
    D --> E["📊 Manajemen<br/>Dashboard BI · Export 360°<br/>Take-up & approval rate"]
    A -. "cek status (No. Ref)" .-> B
    classDef m fill:#0b4ea2,stroke:#083a78,color:#fff;
    class A,B,C,D,E m;
```

**In one line:** a customer chats → gets answers, a simulation, and completes a
prescreen + eKTP → the system automatically scores and routes the lead to the
right salesperson with SLA timers → sales work the pipeline → management sees
everything live. The customer can check their own status anytime with a reference
number.

### 1B. Detailed

Five actors, end to end. Everything a customer touches is on one chat screen; the
back office is the CMS and role-based portals.

```mermaid
flowchart TD
    subgraph N["👤 Nasabah"]
        N1[Buka chat Morby] --> N2{Maksud?}
        N2 -->|Tanya produk/promo/bunga| N3[Terima jawaban grounded<br/>+ link promo/checklist PDF]
        N2 -->|Hitung| N4[Kalkulator: angsuran + cashback<br/>Unduh PDF simulasi]
        N2 -->|Siap ajukan| N5[Prescreen: nama, HP, email,<br/>penghasilan, pekerjaan, plafon,<br/>tenor, kota, riwayat kredit]
        N5 --> N6[Consent eKTP + unggah]
        N6 --> N7[Kirim pengajuan → dapat No. Ref]
        N7 -. "simpan No. Ref" .-> N8[Ketik No. Ref di chat<br/>→ lihat status terkini]
    end
    subgraph M["🤖 Morby (AI + deterministik)"]
        M1[AI baca eKTP → NIK dan field] --> M2[Validator NIK deterministik]
        M3[Rakit paket lead: data teks eKTP,<br/>prescreen, laporan NIK, pas foto]
    end
    N6 --> M1
    N7 --> M3
    M3 --> C1
    subgraph C["🗂️ CMS otomatis"]
        C1[Dedup telepon/email] --> C2[Qualification flags]
        C2 --> C3[Skor: gaji/plafon/lokasi<br/>→ grade keseluruhan]
        C3 --> C4[Assign sales by kota<br/>AS · HB · RB · ER]
        C4 --> C5[Buat Task Call 30 mnt<br/>+ jam SLA]
    end
    subgraph S["📞 Portal Sales (per wilayah)"]
        S1[Lihat lead sendiri] --> S2[Update status pipeline<br/>+ keterangan]
        S2 --> S3[Tandai Call/WA selesai]
    end
    subgraph O["🛠️ Otomasi + Manajemen"]
        O1[Cron 5 mnt: reminder call/WA lewat] 
        O2[Jumat 15:00: sweep lead pasif]
        O3[Admin: Super Page — dokumen,<br/>audit log, export 360°/Excel]
        O4[Dashboard BI: volume Rp,<br/>take-up dan approval rate]
    end
    C5 --> S1
    S3 -. update .-> O4
    N8 -. baca status .-> S2
    C5 -.-> O1
```

**Key business rules (exact, from the brief):**
- **Scoring** = 40% income grade + 40% plafon grade + 20% location grade → overall A+…D.
- **Sales routing by city:** AS (Jabodetabek/Medan/Batam), HB (Surabaya/Gresik/Sidoarjo/Makassar/Bali), RB (Bandung/Yogya/Semarang), ER (others = escalation).
- **SLA:** Task Call due 30 min after a lead arrives; Task WA due 1 h after the call is done; overdue → email reminder; Friday 15:00 WIB weekly sweep.
- **Pipeline:** 10 statuses (uncontacted → slow_response → collect_data → submitted → approved → approved_not_disbursed → disbursed; plus drop_process / rejected / deal_other_bank).
- **Customer self-service:** a reference number returns first name + current status only (no other PII).

---

## 2. System / Architecture

### 2A. High-level

A single lightweight stack: a static browser app talking to one Cloudflare Worker
that fronts storage, AI, and email.

```mermaid
flowchart LR
    B["🌐 Browser (vanilla SPA)<br/>chat · calculator · super · sales"] -->|HTTPS| W["⚙️ Cloudflare Worker<br/>API + static assets + auth"]
    W --> R[("📦 R2<br/>documents")]
    W --> D[("🗃️ D1 / SQLite<br/>CMS data")]
    W --> G["🧠 Gemini<br/>chat + eKTP OCR"]
    W --> M["✉️ Resend<br/>email"]
    CR["⏰ Cron (5 min)"] --> W
    classDef a fill:#0b4ea2,stroke:#083a78,color:#fff;
    class B,W a;
```

**In one line:** everything runs on Cloudflare — one Worker serves the pages and
the API, stores files in R2 and structured data in D1, calls Gemini for AI and
Resend for email, and a Cron trigger drives the SLA reminders. Production target
is the same design **on-premise** with self-hosted AI.

### 2B. Detailed

```mermaid
flowchart TB
    subgraph FE["🌐 Frontend (static, no build)"]
        F1[index.html + app.js — chat/prescreen/eKTP]
        F2[calculator.html + calculator.js — simulasi + PDF]
        F3[admin.html + admin.js — Super Page]
        F4[sales.html + sales.js — Portal Sales]
        F5[modules/: i18n, calculator, prescreen,<br/>validateNik, ocr, pdfReport, privacy]
    end
    FE -->|fetch HTTPS| WK
    subgraph WK["⚙️ Cloudflare Worker (worker/index.js)"]
        direction TB
        P["Public: /api/chat (SSE), /api/ocr,<br/>/api/submit, /api/session, /api/status"]
        AD["Admin (HMAC + role=admin):<br/>/api/admin/* + /api/admin/cms/*"]
        SL["Sales (HMAC + role=sales):<br/>/api/sales/leads|status|bi|me"]
        AUTH["Auth: first-login hash, sessions,<br/>role gating, temp-password reset"]
        SCH["scheduled(): SLA sweep"]
    end
    WK --> R[("📦 R2 — leads/&lt;id&gt;/:<br/>ektp_data.txt, pasfoto.jpg,<br/>laporan_nik.pdf, prescreen.txt, chatlog")]
    WK --> D[("🗃️ D1: leads, lead_files,<br/>status_history, audit_log,<br/>sessions_metric, app_auth")]
    WK --> AI["🧠 Gemini v1beta<br/>chat (thinking off) + Vision OCR"]
    WK --> EM["✉️ Resend — ZIP lampiran,<br/>SLA reminder, reset password"]
    CR["⏰ Cron Trigger (*/5)"] --> SCH
    subgraph DET["🔒 Deterministic core (no AI)"]
        V1[NIK structure validator]
        V2[Annuity + cashback calculator]
        V3[Scoring + sales assignment]
    end
    WK --> DET
    classDef w fill:#0b4ea2,stroke:#083a78,color:#fff;
    class WK w;
```

**Component notes:**
- **Frontend:** plain HTML/CSS/ES modules, no build step, strict CSP, self-hosted fonts; four pages share `styles.css` and `modules/`.
- **Worker:** one file routes public/admin/sales APIs and serves static assets; streams chat via SSE; runs the Cron `scheduled()` sweep.
- **Data:** R2 holds the per-lead documents (eKTP stored as **text only** + cropped pas foto — the full card scan is never stored); D1 holds the queryable CMS (only a **masked NIK**). Schema self-heals missing columns.
- **AI:** Gemini for chat (grounded on the knowledge base, thinking disabled for fast first token) and eKTP Vision OCR (JSON fields) — always checked by the deterministic NIK validator.
- **Auth/roles:** first-login password hashed in D1 (nothing in the repo); HMAC HttpOnly sessions carry role (admin/sales) and sales owner; every sensitive action is written to `audit_log`.
- **Deterministic core:** all money and identity logic (installments, cashback, NIK validity, scoring, routing) is code + the knowledge base — AI never invents numbers.
- **Production path:** the same architecture on-prem — MinIO (R2), PostgreSQL (D1), vLLM self-hosted models (Gemini), internal SMTP (Resend) — see `ON_PREM_ARCHITECTURE.md`.

---

### Summary table

| View | High-level | Detailed |
|---|---|---|
| **Business** | Nasabah → Morby → CMS auto (skor/assign) → Sales pipeline → Manajemen BI; self-service status by ref | 5 actors, exact scoring/routing/SLA/pipeline rules + customer status loop |
| **Architecture** | Browser SPA → 1 Cloudflare Worker → R2 + D1 + Gemini + Resend + Cron | Frontend pages/modules, public/admin/sales routes, D1 tables + R2 layout, AI + deterministic core, auth/roles, on-prem path |

*Internal summary for Morby Ver1.0 (POC). Compliance conclusions require DPO/Legal sign-off.*
