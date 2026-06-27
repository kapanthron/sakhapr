# Moggy — On-Premise End-to-End Architecture & Self-Hosted Model Design

**Goal:** run Moggy entirely on the Bank's **own on-prem servers** — no customer
data (eKTP/NIK, chat, leads) ever leaves the internal network. This removes the
audit's two most serious findings (cross-border transfer + third-party AI
training) and satisfies PP71/OJK data-localization.

**Premise:** the company **already owns servers** locally. So this document
focuses on **design, the open-source software stack, model selection, and the
port from the Cloudflare stack** — not hardware procurement. Hardware guidance is
limited to **GPU sizing**, the one piece that depends on what you have.

Everything below is **100% open-source / self-hostable**. No SaaS in the data
plane.

---

## 1. Design principles

1. **Data stays onshore & in-network.** AI inference (chat + eKTP OCR) runs on
   local GPUs. Storage and DB are local. Email (if used) goes through the Bank's
   own mail gateway.
2. **Same app logic, swapped infrastructure.** Moggy's code is plain JS with very
   few Cloudflare-specific calls — only 5 seams change (assets, object store, DB,
   AI, email).
3. **Defense in depth + least privilege.** Network zoning (DMZ → app → AI →
   data), mTLS internally, MFA for admins, secrets in a vault.
4. **Operable by your team.** Containers + a small orchestrator; standard
   Prometheus/Grafana/Loki observability; documented backup/DR.

---

## 2. End-to-end logical architecture

```
                         INTERNET / Bank WAN
                                 │
                      ┌──────────┴───────────┐
                      │  Zone 0: EDGE / DMZ  │
                      │  - WAF + reverse      │   nginx/Traefik + ModSecurity
                      │    proxy (TLS term.)  │   (or F5/existing NGFW)
                      └──────────┬───────────┘
                                 │ mTLS
            ┌────────────────────┴─────────────────────┐
            │           Zone 1: APPLICATION             │
            │  - Moggy app (Node.js) — ports Worker     │   2+ replicas, stateless
            │    logic: /api/*, /super, static assets   │
            │  - Identity/MFA: Keycloak (OIDC) or AD    │
            │  - Scheduler: SLA cron (systemd/node-cron)│
            └───────┬───────────────────────┬──────────┘
                    │ OpenAI-compatible HTTP │ S3 / SQL / SMTP
        ┌───────────┴──────────┐   ┌─────────┴───────────────────────┐
        │  Zone 2: AI / GPU    │   │      Zone 3: DATA (no inbound    │
        │  - vLLM: chat LLM    │   │      internet)                   │
        │  - vLLM/SGLang: VLM  │   │  - PostgreSQL (CMS) + pgvector   │
        │    (eKTP OCR)        │   │  - MinIO (S3) object store       │
        │  - TEI: embeddings   │   │  - Vault/OpenBao (secrets)       │
        │  - (Qdrant optional) │   │  - Backups: pgBackRest + MinIO   │
        └──────────────────────┘   │    replication → DR site         │
                                    └──────────────────────────────────┘
        Observability (cross-cutting): Prometheus + Grafana + Loki + DCGM
```

**Zone rules:** only Zone 0 is internet-facing; Zone 2/3 have **no inbound
internet**; Zone 3 has **no outbound internet** (air-gapped data tier). Model
weights are loaded once from an internal artifact registry, not the public hub.

---

## 3. Software stack (open-source, recommended)

| Layer | Recommended | Why / alternatives |
|---|---|---|
| OS | RHEL / Rocky / Ubuntu LTS | Standard, GPU driver support |
| Runtime | Podman or Docker + **k3s** (light K8s) | k3s = HA + rolling deploys without OpenShift weight; or plain docker-compose + systemd for simplicity |
| Edge / WAF | **nginx** + ModSecurity (or Traefik) | TLS termination, rate limit, OWASP CRS; or reuse existing NGFW/F5 |
| App server | **Node.js 20+** (port of `worker/index.js`) | Code is plain JS; webcrypto/fetch built-in |
| Object storage | **MinIO** (S3-compatible) | Drop-in for R2; encryption, versioning, **lifecycle = retention** |
| Database | **PostgreSQL 16** | Drop-in for D1/SQLite; `ON CONFLICT` already used; TDE via LUKS |
| Vector store (RAG) | **pgvector** (in Postgres) | Fewest moving parts; **Qdrant**/Milvus if scale grows |
| LLM serving | **vLLM** (OpenAI-compatible) | High throughput, paged-attn, tensor-parallel; alts: SGLang, TGI |
| VLM serving (OCR) | **vLLM** or **SGLang** | Both serve Qwen2.5-VL; SGLang strong for structured/JSON output |
| Embeddings | **TEI** (text-embeddings-inference) | Fast BGE-M3 serving |
| Secrets | **HashiCorp Vault** / **OpenBao** | API keys, DB creds, session secret, model tokens |
| Identity + MFA | **Keycloak** (OIDC) or Bank AD/LDAP + TOTP/WebAuthn | Replaces the single-admin login with real MFA + roles |
| Email (optional) | Bank SMTP relay / **Postfix** | Internal only; or drop email and pull from CMS |
| Scheduler | systemd timer / **node-cron** | Replaces Cloudflare Cron Trigger |
| Observability | **Prometheus + Grafana + Loki**, **DCGM-exporter** (GPU) | Metrics/logs/GPU utilization |
| Backup / DR | **pgBackRest**, MinIO site replication, Velero (k3s) | RPO/RTO per policy |

---

## 4. Self-hosted model selection (detailed)

Three model roles: **(A) chat LLM** (Indonesian KPR Q&A over the knowledge base),
**(B) vision model** (eKTP OCR → structured fields), **(C) embeddings** (RAG
retrieval). The existing **deterministic NIK validator + calculators stay** as
the trustworthy, non-AI core.

### A. Chat LLM (Bahasa Indonesia, RAG)

| Model | Params | Indonesian | VRAM (AWQ/INT4) | Notes |
|---|---|---|---|---|
| **Sahabat-AI** (Llama3/Gemma2 ID-tuned, GoTo/Indosat+AISG) | 8–9B / 70B | ★★★ native-tuned | 8B ≈ 6–8 GB; 70B ≈ 40–48 GB | **Best Bahasa Indonesia alignment**; strong default |
| **SEA-LION v3** (AI Singapore; Gemma2/Llama3.1 base) | 9B / 27B / 70B | ★★★ SEA-tuned | 27B ≈ 18–22 GB | SEA-region tuned, good ID + formal register |
| **Qwen2.5-Instruct** | 7B / 14B / 32B / 72B | ★★ strong multiling. | 32B ≈ 20–24 GB; 72B ≈ 44–48 GB | Excellent reasoning/instruction following |
| **Llama 3.3-Instruct** | 70B | ★★ good | ≈ 40–48 GB | Strong general, large community |
| **Gemma 2** | 9B / 27B | ★★ good | 27B ≈ 18–22 GB | Efficient, permissive |

**Recommendation:**
- **Primary:** **Sahabat-AI / SEA-LION (Indonesian-tuned)** at the largest size
  your GPU allows — best Bahasa Indonesia for a customer-facing bank assistant.
- If you prefer one model family with top reasoning: **Qwen2.5-32B-Instruct**
  (sweet spot on a single 48 GB GPU) or **72B** if you have 80 GB / 2×48 GB.
- **Smaller/cheaper tier:** Sahabat-AI 9B / Qwen2.5-14B on a single 24 GB GPU.

Serve quantized (**AWQ or GPTQ INT4**, or FP8 on Hopper) to cut VRAM ~3–4× with
minimal quality loss. Keep `temperature` low for factual KPR answers; ground every
answer with RAG (next section) and the "bukan keputusan kredit" guardrail.

### B. Vision model for eKTP OCR (image → structured JSON)

| Model | Params | Doc/ID OCR | VRAM (FP16) | Notes |
|---|---|---|---|---|
| **Qwen2.5-VL-Instruct** | 7B / 32B / 72B | ★★★ SOTA open, strong ID/KTP, JSON output | 7B ≈ 18–22 GB; 32B ≈ 40–48 GB | **Recommended** — robust structured extraction |
| **InternVL2.5** | 8B / 26B / 38B | ★★★ strong docs | 8B ≈ 20 GB | Good alternative |
| **MiniCPM-V 2.6** | 8B | ★★ efficient | ≈ 16–18 GB | Lightest VLM option |
| **GOT-OCR2.0** | 0.5B | ★★ pure OCR (text, not reasoning) | ≈ 4 GB | Tiny, fast text dump |
| **PaddleOCR** (classical, non-LLM) | — | ★★ detector+recognizer, fast | CPU/GPU small | Great for fixed eKTP layout; pair with rules |

**Recommendation:** **Qwen2.5-VL-7B** as primary eKTP reader (prompt it to return
the exact JSON Moggy already expects: NIK, nama, TTL, jenis kelamin, alamat,
provinsi/kab/kec, plus the face-photo bounding box). Then **always run the
existing deterministic NIK validator** (`validateNik.js`) on the output — the AI
proposes, the validator disposes. If accuracy on hard scans needs more, step up
to **Qwen2.5-VL-32B**, or add **PaddleOCR** as a cheap second opinion the worker
cross-checks. This mirrors today's "Gemini + local validator" design, fully local.

### C. Embeddings + retrieval (RAG)

| Model | Use | Notes |
|---|---|---|
| **BGE-M3** (BAAI) | Dense+sparse multilingual embeddings incl. Indonesian | **Recommended**; served via TEI; store vectors in pgvector |
| **multilingual-e5-large** | Alternative dense embeddings | Solid multilingual |
| **bge-reranker-v2-m3** | Optional reranker for top-k precision | Adds quality on ambiguous queries |

**RAG flow:** chunk `knowledge_base.json` (programs, rates, RIPLAY, promo terms)
→ embed with BGE-M3 → store in **pgvector** → at query time retrieve top-k →
feed as grounded context to the chat LLM. This keeps answers anchored to the
Bank's approved product facts (and is trivial to update when programs change).

### Model summary (what to deploy)

- **Chat:** Sahabat-AI / SEA-LION (ID-tuned) **or** Qwen2.5-32B-Instruct (AWQ).
- **eKTP OCR:** Qwen2.5-VL-7B (FP16) + deterministic NIK validator.
- **Embeddings:** BGE-M3 via TEI + pgvector.
- All behind **vLLM/SGLang/TEI OpenAI-compatible endpoints** the app calls.

---

## 5. GPU sizing — map to your existing servers

The deciding factor is **GPU VRAM**. Rough budget (quantized serving):

| You have | Can comfortably serve | Suggested config |
|---|---|---|
| **1× 24 GB** (e.g. RTX 4090 / A5000 / L4) | Chat ≤14B AWQ **or** VLM-7B (not both large at once) | Sahabat-AI 9B / Qwen2.5-14B for chat **+** Qwen2.5-VL-7B time-shared; OCR is bursty so co-residence is fine |
| **1× 48 GB** (L40S / A6000 / A40) | Chat 32B AWQ **+** VLM-7B | Qwen2.5-32B (chat) + Qwen2.5-VL-7B (OCR) on one card or split |
| **2× 48 GB** or **1× 80 GB** (A100/H100) | Chat 70–72B **+** VLM-7B/32B + embeddings | Production-grade quality, headroom for concurrency |
| **No GPU today** | Small models on CPU (slow) — POC only | Qwen2.5-7B GGUF via llama.cpp for demos; **add 1 GPU** before production |

For the reference load (~20–50 concurrent chats, ~3k eKTP/month), **a single
48 GB GPU** runs the recommended stack with vLLM batching; **2 GPUs** give HA +
headroom. Embeddings (BGE-M3) and OCR (bursty) can share a card with the chat LLM
or sit on a smaller one.

> To finalize the exact model sizes I need three facts about your servers:
> **(1)** GPU model + count + VRAM (or "none yet"); **(2)** CPU RAM per node;
> **(3)** do you want k3s/OpenShift or plain docker-compose. Tell me these and I'll
> pin a concrete deployment manifest.

---

## 6. Data flow, end-to-end (all local)

1. **Customer chat** → app → **RAG** (BGE-M3 + pgvector retrieve) → **chat LLM
   (vLLM)** streams the grounded answer. Nothing leaves the network.
2. **eKTP upload** → app → **VLM (Qwen2.5-VL)** returns structured JSON + face box
   → **deterministic NIK validator** verifies structure → app crops pas-foto.
3. **Prescreen submit** → app writes files to **MinIO** (`leads/<id>/…`) and the
   lead row to **PostgreSQL**; scoring/SLA/pipeline exactly as today.
4. **Super page (admin)** → behind **Keycloak MFA** → CMS, Customer-360 export,
   BI dashboard, audit log — all reading local Postgres/MinIO.
5. **SLA cron** (systemd/node-cron) → reminder emails via **internal SMTP** (or
   just in-CMS tasks, no email).
6. **Retention** → MinIO lifecycle + a Postgres purge job delete data after the
   policy window (closes the audit's retention gap).

---

## 7. Porting from the Cloudflare stack (the 5 seams)

The app is portable; only these change (each is a small adapter):

| Today (Cloudflare) | On-prem replacement | Code touch |
|---|---|---|
| `env.ASSETS` (static) | nginx serves `/` static dir | none (nginx config) |
| `env.BUCKET` (R2) — `put/get/list/delete` | **MinIO** via S3 SDK | one storage adapter module |
| `env.DB` (D1/SQLite) — `prepare().bind().run/all/first` | **PostgreSQL** via `pg` | one DB adapter; SQL is ~portable (`ON CONFLICT` ok) |
| Gemini (`generativelanguage…`) | **vLLM** `/v1/chat/completions` (+ VLM for OCR) | swap base URL + payload to OpenAI schema |
| Resend (`api.resend.com`) | **SMTP** via nodemailer (or remove email) | one email adapter |
| Cron Trigger `scheduled()` | systemd timer hitting an internal endpoint | trivial |
| `crypto.subtle`, `fetch` | Node webcrypto + global fetch (Node 20+) | none |

Estimated porting effort: **~1–2 engineer-weeks** for a working internal build,
plus model bring-up/eval. The CMS schema, scoring, SLA, pipeline, exports, BI, and
auth logic are reused unchanged.

---

## 8. Security & compliance controls (on-prem)

- **Network:** 4-zone segmentation, mTLS east-west, no inbound to AI/data zones,
  outbound-deny on the data zone.
- **AuthN/Z:** Keycloak OIDC + **MFA (TOTP/WebAuthn)**, **per-user roles** (sales
  vs admin), replace the single SHA-256 admin login; if kept, upgrade hashing to
  **Argon2id**.
- **Secrets:** Vault/OpenBao; set a strong `SESSION_SECRET`; no creds in repo.
- **At rest:** LUKS full-disk + Postgres + MinIO SSE; **per-lead** sensitive
  fields confined as today (masked NIK in DB; full NIK only in the image/PDF).
- **Retention/erasure:** MinIO lifecycle + Postgres purge job + a data-subject
  erasure endpoint (closes PDP 3.4/3.5).
- **Audit:** existing `audit_log` shipped to a **tamper-evident** sink (Loki/WORM)
  for download/delete/status/auth/export events.
- **Backup/DR:** pgBackRest + MinIO replication to a **DR site in Indonesia**;
  test RPO/RTO; rehearse the **3×24-hour breach** procedure.
- **Supply chain:** pull model weights + container images into an **internal
  registry** (Harbor) and scan; no runtime calls to public hubs.

---

## 9. Deployment tiers (using your existing servers)

| | **Lean (pilot)** | **Resilient (production)** |
|---|---|---|
| App | 1–2 Node replicas | 2+ replicas, k3s, autoscale |
| GPU | 1× 48 GB (chat 32B + VLM-7B) | 2× 48 GB or 1–2× 80 GB (70B + VLM) |
| DB | 1× Postgres | Postgres primary + standby (HA) |
| Object | 1× MinIO | MinIO distributed (erasure-coded) + DR replica |
| Identity | Keycloak single | Keycloak HA / Bank AD |
| DR | nightly backup offsite | warm DR site, replication |

Both reuse **the same images and config** — start Lean on the servers you have,
grow to Resilient as volume/criticality rise.

---

## 10. Recommended next steps

1. Tell me your **GPU/RAM/orchestrator** (the 3 facts in §5) → I pin exact model
   sizes + a `docker-compose`/k3s manifest and the vLLM launch commands.
2. Stand up **vLLM + Qwen2.5-VL** and benchmark **eKTP OCR accuracy** vs the
   current Gemini output on a sample set (NIK extraction is already validated).
3. Build the **storage + DB adapters** (MinIO, Postgres) and run the existing CMS
   against them.
4. Add **RAG** (BGE-M3 + pgvector) over `knowledge_base.json`.
5. Wire **Keycloak MFA**, retention jobs, backups, and the breach runbook.

---

*Internal engineering design for the Moggy on-prem deployment. All components are
open-source and run inside the Bank's network. Final model choice should be
confirmed by an accuracy/concurrency benchmark on your hardware.*
