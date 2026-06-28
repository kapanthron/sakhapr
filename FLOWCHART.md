# Moggy — Flowcharts

Two diagrams (Mermaid). Render on GitHub/Notion, or paste into
<https://mermaid.live> to export PNG/SVG for slides.

---

## 1. Versi detail (end-to-end)

```mermaid
flowchart TD
    subgraph CUST["👤 Sisi Nasabah (browser, data di memori)"]
        A([Nasabah buka Moggy]) --> B{Chat Bahasa Indonesia<br/>Intent router}
        B -->|Tanya produk/promo| C[RAG knowledge base<br/>→ AI jawab grounded<br/>+ disclaimer 'bukan keputusan kredit']
        B -->|Hitung angsuran/cashback| D[Kalkulator deterministik]
        B -->|Siap ajukan| E[Prescreen interview<br/>nama, HP, email, penghasilan,<br/>pekerjaan, plafon, tenor, kota, dll]
        C --> B
        D --> B
        E --> F[Konsmen eKTP<br/>checkbox TIDAK auto-tik + link PDF privasi]
        F -->|consent ditik| G[Upload eKTP]
        G --> H[AI OCR Vision<br/>Gemini → on-prem Qwen2.5-VL<br/>ekstrak NIK + field + kotak pas foto]
        H --> I[Validator NIK deterministik<br/>struktur/konsistensi + crop pas foto]
        I --> J[[Kirim paket:<br/>prescreen.txt + eKTP + laporan NIK.pdf<br/>+ chatlog + pas foto]]
    end

    J --> K[/POST /api/submit/]

    subgraph BE["⚙️ Backend (Worker → on-prem Node.js)"]
        K --> L[(R2/MinIO: simpan file)]
        K --> M{D1/PostgreSQL<br/>tersedia?}
        M -->|tidak| N[Fallback: email paket ZIP terproteksi]
        M -->|ya| O[CMS Ingest]
        O --> P[Dedup telepon/email<br/>→ flag DUPLICATE ×N]
        O --> Q[Qualification flags<br/>gaji<13jt, plafon<500jt,<br/>restruktur, TO sertifikat]
        O --> R[Scoring: grade gaji/plafon/lokasi<br/>→ skor komposit → grade keseluruhan]
        O --> S[Sales assignment by kota<br/>AS / HB / RB / ER]
        O --> T[SLA: buat Task Call jatuh tempo 30 mnt<br/>set last_activity]
    end

    subgraph AUTO["⏰ Otomasi (Cron tiap 5 menit)"]
        T --> U{Call/WA lewat & belum selesai?}
        U -->|ya| V[Reminder email ke sales owner]
        W[Jumat 15:00 WIB] --> X[Sweep mingguan lead tanpa update]
    end

    subgraph ADMIN["🔐 Super Page (login + MFA-ready + audit log)"]
        Y[Pipeline 10 status + status_history]
        Z[Kelola dokumen: unduh / hapus per file]
        AA[Export Customer-360 .xlsx 4 tab<br/>+ rekap bulanan + pas foto JPG]
        AB[Dashboard BI: big number + grafik volume/nasabah]
        AC[(Audit log: download/delete/status/auth/export)]
    end

    O --> Y
    L --> Z
    O --> AA
    O --> AB
    Z --> AC
    Y --> AC

    classDef cust fill:#E8F5F4,stroke:#0E7C7B,color:#063;
    classDef be fill:#FFF4E0,stroke:#C9871F,color:#5a3;
    classDef admin fill:#EEF1FF,stroke:#3b4cca,color:#223;
    class A,B,C,D,E,F,G,H,I,J cust;
    class K,L,M,N,O,P,Q,R,S,T be;
    class Y,Z,AA,AB,AC admin;
```

---

## 2. Versi ringkas (1 slide)

```mermaid
flowchart LR
    A([👤 Nasabah]) --> B["💬 Moggy<br/>Chat KPR + Skrining eKTP<br/>AI OCR + Validasi NIK"]
    B --> C["🗂️ CMS<br/>Skor & Grade<br/>+ Assign Sales"]
    C --> D["📞 Pipeline Sales<br/>Status + SLA Reminder"]
    D --> E["📊 Dashboard BI<br/>& Export Excel/360°"]

    F["🔐 Login + Audit Log"] -.-> C
    F -.-> D
    F -.-> E
    G["🇮🇩 Target on-prem:<br/>AI & data lokal (PDP/OJK)"] -.-> B

    classDef main fill:#0E7C7B,stroke:#0E7C7B,color:#fff,font-size:16px;
    classDef side fill:#EEF1FF,stroke:#3b4cca,color:#223;
    class A,B,C,D,E main;
    class F,G side;
```

---

### Catatan
- **Versi detail** = untuk dokumentasi teknis / review internal.
- **Versi ringkas** = 5 kotak alur utama + 2 catatan (auth/audit, target on-prem)
  agar muat 1 slide dan mudah dibaca audiens non-teknis.
