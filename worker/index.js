/* ============================================================================
   worker/index.js  —  Moggy backend (Cloudflare Worker)

   Responsibilities:
   - Serve the static site via the ASSETS binding (and /admin -> admin.html).
   - POST /api/submit : receive a lead package (prescreen.txt + eKTP image +
     NIK report.pdf + metadata) from the customer browser, store it in R2, and
     email it to MAIL_TO (Resend; logged as "not_configured" if no key).
   - Admin API (server-checked login, signed session cookie):
       POST /api/admin/login   { user, pass }
       POST /api/admin/logout
       GET  /api/admin/leads               -> list of submissions
       GET  /api/admin/file?key=leads/..   -> download one stored file

   Storage layout in R2 (bucket binding BUCKET):
     leads/<id>/meta.json        metadata + send log
     leads/<id>/prescreen.txt    file a
     leads/<id>/ektp.<ext>       file b (eKTP image)
     leads/<id>/laporan_nik.pdf  file c
   ============================================================================ */

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const COOKIE_NAME = "sakhapr_admin";

/** Human-readable timestamp in WIB (Asia/Jakarta). */
function wibNow() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

/** Short reference: YYYYMMDD-HHMM-NNNNN (WIB date/time + 5-digit code). */
function makeRef() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value || "";
  const code = String(Math.floor(Math.random() * 100000)).padStart(5, "0");
  return `${g("year")}${g("month")}${g("day")}-${g("hour")}${g("minute")}-${code}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/submit" && request.method === "POST") {
        return await handleSubmit(request, env);
      }
      if (pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }
      if (pathname === "/api/ocr" && request.method === "POST") {
        return await handleOcr(request, env);
      }
      if (pathname === "/api/session" && request.method === "POST") {
        return await handleSession(request, env);
      }
      if (pathname === "/api/admin/login" && request.method === "POST") {
        return await handleLogin(request, env);
      }
      if (pathname === "/api/admin/logout" && request.method === "POST") {
        return handleLogout();
      }
      if (pathname === "/api/admin/delete" && request.method === "POST") {
        return await requireAdmin(request, env, () => handleDelete(request, env));
      }
      if (pathname === "/api/admin/email-test" && request.method === "POST") {
        return await requireAdmin(request, env, () => handleEmailTest(env));
      }
      if (pathname === "/api/admin/leads" && request.method === "GET") {
        return await requireAdmin(request, env, () => handleListLeads(env));
      }
      if (pathname === "/api/admin/diag" && request.method === "GET") {
        return await requireAdmin(request, env, () => handleDiag(env));
      }
      if (pathname === "/api/admin/recap" && request.method === "GET") {
        return await requireAdmin(request, env, () => handleRecap(url, env));
      }
      if (pathname === "/api/admin/cms/leads" && request.method === "GET") {
        return await requireAdmin(request, env, () => handleCmsLeads(env));
      }
      if (pathname === "/api/admin/cms/delete" && request.method === "POST") {
        return await requireAdmin(request, env, (s) => handleCmsDelete(request, env, s));
      }
      if (pathname === "/api/admin/file" && request.method === "GET") {
        return await requireAdmin(request, env, () => handleFile(url, env));
      }
      if (pathname === "/admin" || pathname === "/super") {
        return env.ASSETS.fetch(new Request(new URL("/admin.html", url), request));
      }
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }

    // Everything else: static assets.
    return env.ASSETS.fetch(request);
  },
};

/* --- Submit ---------------------------------------------------------------- */

async function handleSubmit(request, env) {
  if (!rateLimit("submit:" + clientIp(request), 12, 60000)) {
    return json({ ok: false, error: "Terlalu banyak pengiriman. Coba lagi sebentar." }, 429);
  }
  const form = await request.formData();
  const prescreen = form.get("prescreen"); // File (.txt)
  const ektp = form.get("ektp"); // File (image)
  const report = form.get("report"); // File (.pdf)
  const chatlog = form.get("chatlog"); // File (.txt), optional
  const pasfoto = form.get("pasfoto"); // File (.jpg, auto-cropped face), optional

  if (!(prescreen && ektp && report)) {
    return json({ ok: false, error: "Paket tidak lengkap (prescreen, ektp, report wajib)." }, 400);
  }

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const prefix = `leads/${id}/`;
  const ektpName = `ektp${extFromType(ektp.type)}`;

  // Store the three files in R2.
  await env.BUCKET.put(prefix + "prescreen.txt", await prescreen.arrayBuffer(), {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await env.BUCKET.put(prefix + ektpName, await ektp.arrayBuffer(), {
    httpMetadata: { contentType: ektp.type || "application/octet-stream" },
  });
  await env.BUCKET.put(prefix + "laporan_nik.pdf", await report.arrayBuffer(), {
    httpMetadata: { contentType: "application/pdf" },
  });
  if (chatlog) {
    await env.BUCKET.put(prefix + "chatlog.txt", await chatlog.arrayBuffer(), {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
  const hasPasfoto = pasfoto && typeof pasfoto.arrayBuffer === "function";
  if (hasPasfoto) {
    await env.BUCKET.put(prefix + "pasfoto.jpg", await pasfoto.arrayBuffer(), {
      httpMetadata: { contentType: "image/jpeg" },
    });
  }

  const ref = makeRef();
  const meta = {
    id,
    ref,
    ts,
    ts_wib: wibNow(),
    type: "lead",
    product: form.get("product") || "",
    productName: form.get("productName") || "",
    prescreenLabel: form.get("prescreenLabel") || "",
    prescreenStatus: form.get("prescreenStatus") || "",
    nikVerdict: form.get("nikVerdict") || "",
    answers: parseJsonObj(form.get("answers")),
    usedCalculator: form.get("usedCalculator") === "true",
    durationMs: parseInt(form.get("durationMs"), 10) || 0,
    sessionStart: form.get("sessionStart") || "",
    sessionEnd: form.get("sessionEnd") || "",
    consent: {
      given: form.get("consentGiven") === "true",
      at: form.get("consentAt") || "",
      document: form.get("consentDoc") || "",
    },
    files: {
      prescreen: "prescreen.txt",
      ektp: ektpName,
      report: "laporan_nik.pdf",
      ...(chatlog ? { chatlog: "chatlog.txt" } : {}),
      ...(hasPasfoto ? { pasfoto: "pasfoto.jpg" } : {}),
    },
    email: { to: env.MAIL_TO || "", status: "pending", at: null, providerId: null, error: null },
  };

  // CMS ingestion replaces the email relay once D1 is bound. If D1 isn't
  // configured yet (or ingestion fails), fall back to email so leads are never
  // lost during the transition.
  let cmsIngested = false;
  if (env.DB) {
    try {
      await cmsIngestLead(env, id, ts, form, meta);
      cmsIngested = true;
    } catch (e) {
      console.error("[CMS] ingest failed, falling back to email:", e && e.message);
    }
  }
  meta.email = cmsIngested
    ? { to: "", status: "cms", at: ts, providerId: null, error: null }
    : await sendEmail(env, meta, { prescreen, ektp, report, chatlog, ektpName, pasfoto: hasPasfoto ? pasfoto : null });

  await env.BUCKET.put(prefix + "meta.json", JSON.stringify(meta, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  return json({ ok: true, id, ref, email: meta.email.status });
}

/* --- Session log (every conversation, even if not submitted) ---------------- */

async function handleSession(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = typeof b.sessionId === "string" && /^[a-f0-9-]{8,40}$/i.test(b.sessionId)
    ? b.sessionId
    : crypto.randomUUID();
  const prefix = `sessions/${id}/`;
  if (b.chatlog) {
    await env.BUCKET.put(prefix + "chatlog.txt", String(b.chatlog), {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
  const meta = {
    id,
    ref: makeRef(),
    ts: new Date().toISOString(),
    ts_wib: wibNow(),
    type: "session",
    product: b.product || "",
    productName: b.productName || "",
    prescreenLabel: b.prescreenLabel || "",
    prescreenStatus: b.prescreenStatus || "",
    nikVerdict: b.nikVerdict || "",
    answers: (b.answers && typeof b.answers === "object") ? b.answers : {},
    usedCalculator: !!b.usedCalculator,
    durationMs: parseInt(b.durationMs, 10) || 0,
    sessionStart: b.sessionStart || "",
    sessionEnd: b.sessionEnd || "",
    files: { chatlog: "chatlog.txt" },
    email: { status: "n/a" },
  };
  await env.BUCKET.put(prefix + "meta.json", JSON.stringify(meta, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return json({ ok: true, id });
}

/* --- Admin: delete a record (lead or session) ------------------------------ */

async function handleDelete(request, env) {
  const { id } = await request.json().catch(() => ({}));
  if (!id || /[^a-zA-Z0-9-]/.test(String(id))) return json({ ok: false, error: "ID tidak valid." }, 400);
  let deleted = 0;
  for (const prefix of [`leads/${id}/`, `sessions/${id}/`]) {
    const listed = await env.BUCKET.list({ prefix });
    for (const o of listed.objects) {
      await env.BUCKET.delete(o.key);
      deleted++;
    }
  }
  return json({ ok: true, deleted });
}

/* --- Chat (Workers AI, grounded on the knowledge base) --------------------- */

const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const SYSTEM_PROMPT =
  "Anda adalah Moggy (the Bank Mortgage Buddy), asisten KPR (Kredit Pemilikan Rumah) the Bank Indonesia. " +
  "Jawab HANYA berdasarkan FAKTA dari knowledge base di bawah. Gunakan Bahasa " +
  "Indonesia yang ramah, jelas, dan ringkas. JANGAN mengarang angka, suku bunga, " +
  "biaya, atau syarat yang tidak ada di FAKTA. Jika informasinya tidak tersedia, " +
  "katakan dengan jujur lalu ajak nasabah melanjutkan ke proses pengajuan agar tim " +
  "the Bank dapat membantu lebih lanjut (JANGAN menyuruh menghubungi email atau nomor " +
  "telepon the response team). Untuk pertanyaan soal " +
  "uang (bunga, biaya, cashback, denda), sertakan pengingat singkat bahwa angka " +
  "bersifat estimasi dan dapat berubah. Pemeriksaan ini bukan keputusan kredit. " +
  "Rapikan jawaban: gunakan poin-poin diawali '- ' bila menyebut beberapa hal, dan " +
  "**tebal** untuk istilah penting. Jawab langsung dan ringkas (maksimal sekitar 6 " +
  "kalimat atau 6 poin) dan selalu selesaikan kalimat terakhir. Jangan mengulang " +
  "salam pembuka di setiap jawaban.";

let KB_CONTEXT = null;

async function kbContext(env, url) {
  if (KB_CONTEXT) return KB_CONTEXT;
  const res = await env.ASSETS.fetch(new Request(new URL("/data/knowledge_base.json", url)));
  const kb = await res.json();
  KB_CONTEXT = buildContext(kb).slice(0, 120000);
  return KB_CONTEXT;
}

function buildContext(kb) {
  const L = [];
  L.push("DISCLAIMER:");
  for (const [k, v] of Object.entries(kb.disclaimers || {})) L.push(`- ${k}: ${v}`);
  L.push("\nPRODUK:");
  for (const p of kb.products || []) {
    const rate = p.interest ? p.interest.formula || `${p.interest.starting_rate_percent || ""}%` : "";
    L.push(`- ${p.name} (${p.id}): ${p.use_case} Bunga: ${rate}. Tenor ${p.tenor_years?.min}-${p.tenor_years?.max} th. Plafon Rp${p.credit_limit?.min}-${p.credit_limit?.max}.`);
  }
  L.push("\nSUKU BUNGA: " + JSON.stringify(kb.interest_rate_options || {}));
  L.push("\nPROGRAM/PROMO:");
  for (const pr of kb.programs || []) {
    L.push(`- ${pr.name}: ${pr.benefit} Periode ${pr.program_period?.start} s/d ${pr.program_period?.end}. Produk: ${(pr.applies_to_products || []).join(", ")}.`);
  }
  L.push("\nSYARAT UMUM:");
  for (const e of kb.eligibility?.general_requirements || []) L.push(`- ${e}`);
  L.push("\nFAQ:");
  for (const f of kb.faq || []) L.push(`T: ${(f.question_examples || [])[0] || f.intent}\nJ: ${f.answer}`);
  L.push("\nTANYA-JAWAB TAMBAHAN:");
  for (const q of kb.supplemental_qa || []) L.push(`[${q.category}] T: ${q.question}\nJ: ${q.answer}`);
  L.push("\nKONTAK: " + JSON.stringify(kb.support || {}));
  return L.join("\n");
}

async function handleChat(request, env) {
  const url = new URL(request.url);
  if (!rateLimit("chat:" + clientIp(request), 40, 60000)) {
    return json({ ok: false, error: "Terlalu banyak permintaan. Coba lagi sebentar." }, 429);
  }
  const { message, history, lang } = await request.json().catch(() => ({}));
  if (!message || typeof message !== "string") {
    return json({ ok: false, error: "Pesan kosong." }, 400);
  }

  const ctx = await kbContext(env, url);
  const langDir = lang === "en"
    ? "PENTING: Jawab HANYA dalam Bahasa Inggris (English)."
    : "PENTING: Jawab dalam Bahasa Indonesia.";
  const sys = `${SYSTEM_PROMPT}\n\n${langDir}\n\nFAKTA (knowledge base):\n${ctx}`;
  const hist = Array.isArray(history) ? history.slice(-6) : [];

  // Streamed response (customer chat) — only via Gemini.
  if (url.searchParams.get("stream") === "1" && env.GEMINI_API_KEY) {
    try {
      return await streamGemini(env, sys, hist, message);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 502);
    }
  }

  try {
    let answer = "";
    let model = "";
    if (env.GEMINI_API_KEY) {
      answer = await callGemini(env, sys, hist, message);
      model = CACHED_GEMINI_MODEL || env.GEMINI_MODEL || "gemini";
    } else if (env.AI) {
      answer = await callWorkersAi(env, sys, hist, message);
      model = CHAT_MODEL;
    } else {
      return json({ ok: false, error: "AI belum dikonfigurasi." }, 503);
    }
    if (!answer) return json({ ok: false, error: "Jawaban kosong." }, 502);
    return json({ ok: true, answer, model });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 502);
  }
}

/** Build Gemini `contents` from history + the new message (first turn must be user). */
function geminiContents(history, message) {
  const contents = [];
  for (const h of history) {
    if (h && h.content) contents.push({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: String(h.content).slice(0, 1200) }] });
  }
  while (contents.length && contents[0].role === "model") contents.shift();
  contents.push({ role: "user", parts: [{ text: String(message).slice(0, 1200) }] });
  return contents;
}

/** Stream Gemini tokens to the client as plain text (SSE -> text). */
async function streamGemini(env, sys, history, message) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: sys }] },
    contents: geminiContents(history, message),
    generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
  });
  const open = (model) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body }
  );
  let model = await pickGeminiModel(env);
  let upstream = await open(model);
  if (isRateLimited(upstream.status)) {
    const fb = await pickGeminiFallback(env);
    if (fb && fb !== model) { model = fb; upstream = await open(fb); }
  }
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Gemini stream HTTP ${upstream.status}: ${(await upstream.text().catch(() => "")).slice(0, 120)}`);
  }
  return new Response(sseToText(upstream.body), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Transform a Gemini SSE body stream into a stream of plain answer-text deltas. */
function sseToText(upstreamBody) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
          const t = parts ? parts.map((p) => p.text || "").join("") : "";
          if (t) controller.enqueue(encoder.encode(t));
        } catch { /* ignore partial/keepalive */ }
      }
    },
    cancel() { try { reader.cancel(); } catch { /* */ } },
  });
}

/** Google Gemini (free tier, no card). Set GEMINI_API_KEY as a secret. */
let CACHED_GEMINI_MODEL = null;
let CACHED_GEMINI_FALLBACK = null;
let CACHED_MODEL_LIST = null;

async function listGeminiModels(env) {
  if (CACHED_MODEL_LIST) return CACHED_MODEL_LIST;
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY },
  });
  if (!res.ok) throw new Error(`ListModels HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const NON_CHAT = /(tts|image|vision|embedding|robotics|imagen|lyria|nano|thinking|\bexp\b|preview)/i;
  const usable = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));
  const chat = usable.filter((m) => !NON_CHAT.test(m.name));
  CACHED_MODEL_LIST = chat.length ? chat : usable;
  return CACHED_MODEL_LIST;
}

function scoreModel(name, preferLite) {
  const n = name.toLowerCase();
  let s = 0;
  if (n.includes("gemini")) s += 50;
  if (n.includes("flash")) s += 30;
  if (n.includes("lite")) s += preferLite ? 20 : -12;
  const v = n.match(/(\d+(?:\.\d+)?)/);
  if (v) s += parseFloat(v[1]); // version number as tiebreaker
  return s;
}

/** PRI chat model: the newest non-lite "Flash" Gemini for THIS key. */
async function pickGeminiModel(env) {
  if (env.GEMINI_MODEL) return env.GEMINI_MODEL;
  if (CACHED_GEMINI_MODEL) return CACHED_GEMINI_MODEL;
  const pool = await listGeminiModels(env);
  const pick = pool.slice().sort((a, b) => scoreModel(b.name, false) - scoreModel(a.name, false))[0];
  if (!pick) throw new Error("Tidak ada model yang mendukung generateContent untuk API key ini.");
  CACHED_GEMINI_MODEL = pick.name.replace(/^models\//, "");
  return CACHED_GEMINI_MODEL;
}

/** Fallback model used when the primary is rate-limited (429): a "lite" Flash,
 *  which has a higher free-tier quota. Override with GEMINI_FALLBACK_MODEL. */
async function pickGeminiFallback(env) {
  if (env.GEMINI_FALLBACK_MODEL) return env.GEMINI_FALLBACK_MODEL;
  if (CACHED_GEMINI_FALLBACK) return CACHED_GEMINI_FALLBACK;
  const pool = await listGeminiModels(env);
  const primary = await pickGeminiModel(env);
  const sorted = pool.slice().sort((a, b) => scoreModel(b.name, true) - scoreModel(a.name, true));
  const name = (m) => m.name.replace(/^models\//, "");
  const pick =
    sorted.find((m) => name(m) !== primary && /lite/i.test(m.name)) ||
    sorted.find((m) => name(m) !== primary) ||
    sorted[0];
  CACHED_GEMINI_FALLBACK = pick ? name(pick) : primary;
  return CACHED_GEMINI_FALLBACK;
}

/** True for responses that mean "try the lighter fallback model". */
function isRateLimited(status) {
  return status === 429 || status === 503;
}

/** POST generateContent with primary model; on 404 re-discover, on 429/503 fall
 *  back to the lite model. Returns the parsed JSON response. */
async function geminiGenerate(env, body) {
  const call = (model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body,
    });
  let model = await pickGeminiModel(env);
  let res = await call(model);
  if (res.status === 404) {
    CACHED_GEMINI_MODEL = null; CACHED_MODEL_LIST = null;
    model = await pickGeminiModel(env);
    res = await call(model);
  }
  if (isRateLimited(res.status)) {
    const fb = await pickGeminiFallback(env);
    if (fb && fb !== model) { model = fb; res = await call(fb); }
  }
  if (!res.ok) throw new Error(`Gemini gagal — ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return { data: await res.json(), model };
}

async function callGemini(env, sys, history, message) {
  const contents = [];
  for (const h of history) {
    if (h && h.content) contents.push({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: String(h.content).slice(0, 1200) }] });
  }
  while (contents.length && contents[0].role === "model") contents.shift(); // Gemini must start with 'user'
  contents.push({ role: "user", parts: [{ text: message.slice(0, 1200) }] });

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: sys }] },
    contents,
    generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
  });

  const { data } = await geminiGenerate(env, body);
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return (parts ? parts.map((p) => p.text || "").join("") : "").trim();
}

/* --- eKTP OCR via Gemini Vision -------------------------------------------- */

const OCR_PROMPT =
  "Anda pembaca KTP-el (eKTP) Indonesia yang teliti. Dari gambar KTP berikut, " +
  "baca dan kembalikan HANYA satu objek JSON valid (tanpa teks lain), dengan kunci:\n" +
  '{"nik":"","nama":"","tempat_lahir":"","tanggal_lahir":"","jenis_kelamin":"",' +
  '"provinsi":"","kabupaten_kota":"","kecamatan":"","photo_box":[]}\n' +
  "Aturan: nik = TEPAT 16 digit angka (baca cermat, jangan menambah/menghilangkan digit). " +
  "tanggal_lahir format dd-mm-yyyy. jenis_kelamin = \"LAKI-LAKI\" atau \"PEREMPUAN\". " +
  "provinsi/kabupaten_kota/kecamatan sesuai teks pada kartu (HURUF KAPITAL). " +
  "photo_box = kotak pas foto wajah pada kartu sebagai [ymin,xmin,ymax,xmax] " +
  "ternormalisasi 0-1000 (relatif terhadap seluruh gambar). " +
  "Jika sebuah nilai tidak terbaca, isi string kosong (untuk photo_box: array kosong).";

/** Base64-encode an ArrayBuffer in chunks (avoids call-stack limits on big images). */
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Read an eKTP image with Gemini (multimodal); returns structured fields. */
async function handleOcr(request, env) {
  if (!rateLimit("ocr:" + clientIp(request), 20, 60000)) {
    return json({ ok: false, error: "Terlalu banyak permintaan. Coba lagi sebentar." }, 429);
  }
  if (!env.GEMINI_API_KEY) {
    return json({ ok: false, error: "Gemini belum dikonfigurasi (GEMINI_API_KEY)." }, 503);
  }
  const form = await request.formData().catch(() => null);
  const file = form && form.get("ektp");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ ok: false, error: "Gambar eKTP wajib." }, 400);
  }
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) {
    return json({ ok: false, error: "Gambar terlalu besar (maks 8 MB)." }, 400);
  }
  try {
    const out = await geminiVisionOcr(env, abToBase64(buf), file.type || "image/jpeg");
    return json({ ok: true, ...out });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 502);
  }
}

async function geminiVisionOcr(env, b64, mime) {
  const body = JSON.stringify({
    contents: [{
      role: "user",
      parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: OCR_PROMPT }],
    }],
    // Flash models spend tokens "thinking"; give plenty of headroom so the JSON
    // answer is never truncated (truncation = empty fields = looks inaccurate).
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 4096 },
  });
  // Reuses the primary→lite fallback on 404 / 429 / 503.
  const { data } = await geminiGenerate(env, body);
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = parts ? parts.map((p) => p.text || "").join("") : "";
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* leave empty */ } }
  }

  const sex = String(parsed.jenis_kelamin || "");
  const fields = {
    nik: String(parsed.nik || "").replace(/\D/g, "").slice(0, 16),
    nama: String(parsed.nama || "").trim(),
    tempat_lahir: String(parsed.tempat_lahir || "").trim(),
    tanggal_lahir: String(parsed.tanggal_lahir || "").trim(),
    jenis_kelamin: /perempuan/i.test(sex) ? "PEREMPUAN" : /laki/i.test(sex) ? "LAKI-LAKI" : "",
    provinsi: String(parsed.provinsi || "").trim(),
    kabupaten_kota: String(parsed.kabupaten_kota || "").trim(),
    kecamatan: String(parsed.kecamatan || "").trim(),
  };
  const pb = Array.isArray(parsed.photo_box) && parsed.photo_box.length === 4
    ? parsed.photo_box.map((n) => Number(n))
    : null;
  return { fields, photo_box: pb && pb.every((n) => Number.isFinite(n)) ? pb : null, model };
}

/** Cloudflare Workers AI (free daily allocation; the [ai] binding). */
async function callWorkersAi(env, sys, history, message) {
  const messages = [{ role: "system", content: sys.slice(0, 9000) }]; // llama context is small
  for (const h of history) {
    if (h && h.content) messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content).slice(0, 1200) });
  }
  messages.push({ role: "user", content: message.slice(0, 1200) });
  const out = await env.AI.run(CHAT_MODEL, { messages, max_tokens: 1024 });
  return (out && (out.response || out.result || "")).trim();
}

/* --- Password-protected ZIP (traditional PKWARE/ZipCrypto) ----------------- */
// Bundles the lead files into one encrypted ZIP. ZipCrypto is widely supported
// (Windows Explorer, 7-Zip, WinRAR, macOS Archive Utility with a password). It
// is legacy encryption — adequate for transit on top of TLS email, not a
// substitute for proper key management.
const ZIP_PASSWORD = "thebank2026#";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function crc32Update(crc, b) {
  return (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
}
function makeKeys(password) {
  let k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
  const upd = (b) => {
    k0 = crc32Update(k0, b);
    k1 = (k1 + (k0 & 0xff)) >>> 0;
    k1 = (Math.imul(k1, 134775813) + 1) >>> 0;
    k2 = crc32Update(k2, (k1 >>> 24) & 0xff);
  };
  for (let i = 0; i < password.length; i++) upd(password.charCodeAt(i) & 0xff);
  return {
    encrypt(b) {
      const t = (k2 | 2) & 0xffff;
      const c = b ^ (((t * (t ^ 1)) >>> 8) & 0xff);
      upd(b);
      return c;
    },
  };
}

function makeEncryptedZip(entries, password) {
  const enc = new TextEncoder();
  const prepared = entries.map((e) => {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const keys = makeKeys(password);
    const header = new Uint8Array(12);
    crypto.getRandomValues(header.subarray(0, 11));
    header[11] = (crc >>> 24) & 0xff; // password check byte (CRC high byte)
    const encHeader = new Uint8Array(12);
    for (let i = 0; i < 12; i++) encHeader[i] = keys.encrypt(header[i]);
    const encData = new Uint8Array(e.data.length);
    for (let i = 0; i < e.data.length; i++) encData[i] = keys.encrypt(e.data[i]);
    return { name, crc, encHeader, encData, compSize: 12 + e.data.length, size: e.data.length };
  });

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const p of prepared) {
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);     // version needed
    lh.setUint16(6, 0x0001, true); // flag: bit 0 = encrypted
    lh.setUint16(8, 0, true);      // method: store
    lh.setUint16(10, 0, true);     // mod time
    lh.setUint16(12, 0x21, true);  // mod date (1980-01-01)
    lh.setUint32(14, p.crc, true);
    lh.setUint32(18, p.compSize, true);
    lh.setUint32(22, p.size, true);
    lh.setUint16(26, p.name.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), p.name, p.encHeader, p.encData);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0001, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, p.crc, true);
    cd.setUint32(20, p.compSize, true);
    cd.setUint32(24, p.size, true);
    cd.setUint16(28, p.name.length, true);
    cd.setUint32(42, offset, true); // local header offset
    central.push(new Uint8Array(cd.buffer), p.name);

    offset += 30 + p.name.length + p.compSize;
  }
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, prepared.length, true);
  eocd.setUint16(10, prepared.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true); // central dir start
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];

  let total = 0;
  for (const a of all) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

/* --- Email (Resend) -------------------------------------------------------- */

async function sendEmail(env, meta, files) {
  // Defaults make the "Resend → your own Gmail" shortcut work with only one
  // secret (RESEND_API_KEY): the test sender onboarding@resend.dev can deliver
  // to the email that owns the Resend account, with no domain verification.
  const to = env.MAIL_TO || "hendrik.panthron@gmail.com";
  const from = env.MAIL_FROM || "Moggy <onboarding@resend.dev>";
  const at = new Date().toISOString();
  if (!env.RESEND_API_KEY) {
    return { to, status: "not_configured", at, providerId: null,
      error: "RESEND_API_KEY belum diset; pengiriman dicatat tetapi tidak dikirim." };
  }

  try {
    const attachments = [
      { name: "prescreen.txt", data: new Uint8Array(await files.prescreen.arrayBuffer()) },
      { name: files.ektpName, data: new Uint8Array(await files.ektp.arrayBuffer()) },
      { name: "laporan_nik.pdf", data: new Uint8Array(await files.report.arrayBuffer()) },
    ];
    if (files.chatlog) {
      attachments.push({ name: "chatlog.txt", data: new Uint8Array(await files.chatlog.arrayBuffer()) });
    }
    if (files.pasfoto) {
      attachments.push({ name: "pasfoto.jpg", data: new Uint8Array(await files.pasfoto.arrayBuffer()) });
    }
    // Bundle every file into one password-protected ZIP for safer transit.
    const zip = makeEncryptedZip(attachments, ZIP_PASSWORD);
    const zipName = `Moggy_${meta.ref || meta.id}.zip`;
    const body = {
      from,
      to: [to],
      subject: "Moggy lead + eKTP screening",
      text:
        `Lead KPR dari Moggy.\n\n` +
        `Produk      : ${meta.productName || meta.product || "-"}\n` +
        `Prescreen   : ${meta.prescreenLabel || "-"} ${meta.prescreenStatus || ""}\n` +
        `Verdict NIK : ${meta.nikVerdict || "-"}\n` +
        `Lead ID     : ${meta.id}\n\n` +
        `Lampiran: ${zipName} (ZIP terproteksi kata sandi) berisi transkrip prescreen, ` +
        `gambar eKTP, laporan skrining NIK${files.pasfoto ? ", pas foto" : ""}.\n` +
        `Kata sandi ZIP sesuai kebijakan internal the Bank.\n` +
        `Catatan: skrining NIK hanya alat bantu struktur/konsistensi, bukan keputusan kredit.`,
      attachments: [{ filename: zipName, content: abToBase64(zip) }],
    };
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { to, status: "failed", at, providerId: null, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { to, status: "sent", at, providerId: data.id || null, error: null };
  } catch (err) {
    return { to, status: "failed", at, providerId: null, error: String(err && err.message || err) };
  }
}

/** Admin diagnostic: what does the LIVE worker actually see at runtime? */
async function handleDiag(env) {
  let geminiModel = null, geminiFallback = null, geminiErr = null;
  if (env.GEMINI_API_KEY) {
    try {
      geminiModel = await pickGeminiModel(env);
      geminiFallback = await pickGeminiFallback(env);
    } catch (e) { geminiErr = String((e && e.message) || e).slice(0, 160); }
  }
  return json({
    ok: true,
    hasGeminiKey: !!env.GEMINI_API_KEY,
    hasResendKey: !!env.RESEND_API_KEY,
    hasSessionSecret: !!env.SESSION_SECRET,
    hasBucket: !!env.BUCKET,
    mailTo: env.MAIL_TO || "(default) hendrik.panthron@gmail.com",
    mailFrom: env.MAIL_FROM || "(default) onboarding@resend.dev",
    geminiModel,
    geminiFallback,
    geminiErr,
  });
}

/** Admin diagnostic: verify the Resend key by sending a real test email. */
async function handleEmailTest(env) {
  const to = env.MAIL_TO || "hendrik.panthron@gmail.com";
  const from = env.MAIL_FROM || "Moggy <onboarding@resend.dev>";
  if (!env.RESEND_API_KEY) {
    return json({ ok: false, configured: false, to, from, error: "RESEND_API_KEY belum diset." });
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Moggy — tes konfigurasi email",
        text: "Ini email tes dari Moggy. Jika Anda menerima pesan ini, RESEND_API_KEY sudah benar dan pengiriman lead akan bekerja.",
      }),
    });
    const txt = await res.text();
    let data = {};
    try { data = JSON.parse(txt); } catch { /* keep raw */ }
    if (!res.ok) {
      return json({ ok: false, configured: true, to, from, status: res.status, error: String(data.message || txt).slice(0, 220) });
    }
    return json({ ok: true, configured: true, to, from, providerId: data.id || null });
  } catch (err) {
    return json({ ok: false, configured: true, to, from, error: String((err && err.message) || err) });
  }
}

/* --- Admin: auth ----------------------------------------------------------- */

async function handleLogin(request, env) {
  const ip = clientIp(request);
  if (!rateLimit("login:" + ip, 8, 10 * 60 * 1000)) {
    return json({ ok: false, error: "Terlalu banyak percobaan masuk. Coba lagi nanti." }, 429);
  }
  const { user, pass } = await request.json().catch(() => ({}));
  const okUser = timingSafeEqual(String(user || ""), env.ADMIN_USER || "");
  const okPass = await checkPassword(env, String(pass || ""));
  if (!okUser || !okPass) {
    return json({ ok: false, error: "Kredensial salah." }, 401);
  }
  const token = await makeSession(env, env.ADMIN_USER);
  return json({ ok: true }, 200, {
    "Set-Cookie": cookie(COOKIE_NAME, token, SESSION_TTL_MS),
  });
}

/** Verify the admin password against ADMIN_PASS_SHA256 (preferred) or ADMIN_PASS. */
async function checkPassword(env, pass) {
  if (env.ADMIN_PASS_SHA256) {
    const h = await sha256hex(pass);
    return timingSafeEqual(h.toLowerCase(), String(env.ADMIN_PASS_SHA256).toLowerCase());
  }
  if (env.ADMIN_PASS) return timingSafeEqual(pass, env.ADMIN_PASS);
  return false;
}
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", strToBytes(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function handleLogout() {
  return json({ ok: true }, 200, { "Set-Cookie": cookie(COOKIE_NAME, "", -1) });
}

async function requireAdmin(request, env, handler) {
  const token = readCookie(request, COOKIE_NAME);
  const session = await verifySession(env, token);
  if (!session) return json({ ok: false, error: "Tidak terautentikasi." }, 401);
  return handler(session); // existing handlers ignore the arg; CMS uses it for audit actor
}

/* --- Admin: data ----------------------------------------------------------- */

async function allMetas(env) {
  const metas = [];
  for (const prefix of ["leads/", "sessions/"]) {
    const listed = await env.BUCKET.list({ prefix });
    for (const obj of listed.objects.filter((o) => o.key.endsWith("/meta.json"))) {
      const got = await env.BUCKET.get(obj.key);
      if (!got) continue;
      try { metas.push(JSON.parse(await got.text())); } catch { /* skip malformed */ }
    }
  }
  metas.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return metas;
}

async function handleListLeads(env) {
  return json({ ok: true, leads: await allMetas(env) });
}

/* --- Monthly recap as a real .xlsx ----------------------------------------- */

function parseJsonObj(s) {
  if (!s) return {};
  try { const o = JSON.parse(s); return (o && typeof o === "object") ? o : {}; } catch { return {}; }
}

/** WIB year-month ("YYYY-MM") for an ISO timestamp. */
function wibYearMonth(iso) {
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).formatToParts(new Date(iso));
    const g = (t) => (p.find((x) => x.type === t) || {}).value || "";
    return `${g("year")}-${g("month")}`;
  } catch { return ""; }
}

function xmlEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
function colLetter(n) {
  let s = ""; n++;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Build a minimal but valid .xlsx (inline strings) from a header + rows. */
function buildXlsx(headers, rows, sheetName) {
  const enc = new TextEncoder();
  const all = [headers, ...rows];
  let sd = "";
  all.forEach((row, ri) => {
    sd += `<row r="${ri + 1}">`;
    row.forEach((val, ci) => {
      sd += `<c r="${colLetter(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
    });
    sd += `</row>`;
  });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sd}</sheetData></worksheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc((sheetName || "Rekap").slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  return makePlainZip([
    { name: "[Content_Types].xml", data: enc.encode(ct) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "xl/workbook.xml", data: enc.encode(wb) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
  ]);
}

function wibFmt(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }); } catch { return ""; }
}

const RECAP_HEADERS = [
  "Timestamp (WIB)", "Sesi Mulai (WIB)", "Sesi Berakhir (WIB)", "Ref", "Tipe", "Produk",
  "Status Prescreen", "Nama Lengkap", "Nomor HP", "Email", "Penghasilan Bersih/bln",
  "Pekerjaan", "Profesi & Lama Kerja", "Kota Jaminan", "Alamat Jaminan", "Kode Pos",
  "Restruktur 12bln Terakhir", "Kondisi Jaminan", "TO dari Bank",
  "Verdict NIK", "Persetujuan (waktu)", "Pakai Kalkulator", "Durasi (menit)", "Status Email",
];
function recapRow(m) {
  const a = m.answers || {};
  return [
    m.ts_wib || m.ts || "",
    wibFmt(m.sessionStart),
    wibFmt(m.sessionEnd),
    m.ref || m.id || "",
    m.type === "session" ? "Sesi" : "Lead",
    m.productName || m.product || "",
    m.prescreenStatus || "",
    a.nama_lengkap || "",
    a.nomor_handphone || "",
    a.email_aktif || "",
    a.penghasilan_bersih_bulanan || "",
    a.pekerjaan_saat_ini || "",
    a.profesi_dan_lama_kerja || "",
    a.kota_jaminan || "",
    a.alamat_jaminan || "",
    a.kode_pos || "",
    a.history_telat_restruktur_12bln || "",
    a.kondisi_jaminan || a.rencana_huni || "",
    a.bank_asal || "",
    m.nikVerdict || "",
    (m.consent && m.consent.given) ? wibFmt(m.consent.at) : "",
    m.usedCalculator ? "Ya" : "Tidak",
    m.durationMs ? (m.durationMs / 60000).toFixed(1) : "",
    (m.email && m.email.status) || "",
  ];
}

async function handleRecap(url, env) {
  const month = url.searchParams.get("month") || "all";
  const metas = await allMetas(env);
  const rows = metas.filter((m) => month === "all" || wibYearMonth(m.ts) === month).map(recapRow);
  const xlsx = buildXlsx(RECAP_HEADERS, rows, month === "all" ? "Semua" : month);
  const fname = `Moggy_rekap_${month === "all" ? "semua" : month}.xlsx`;
  return new Response(xlsx, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fname}"`,
      "Cache-Control": "no-store",
    },
  });
}

/* --- CMS (Cloudflare D1) — Phase 1: ingestion + list ----------------------- */
// TODO SECURITY/PDPA: D1 now stores personal data permanently. Retention +
// DPIA must be revised before real applicant data; full NIK is NOT stored here
// (only masked) — the full value remains inside the eKTP image / NIK report.

function digitsOnly(s) { return String(s == null ? "" : s).replace(/\D/g, ""); }

function maskNik(nik) {
  const d = digitsOnly(nik);
  return d.length === 16 ? d.slice(0, 6) + "******" + d.slice(12) : "";
}

function jenisKprFromProduct(product) {
  if (product === "kpr_flexi_primary") return "primary";
  if (product === "kpr_secondary") return "second";
  if (product === "kpr_take_over") return "take_over";
  return product || "";
}

/** Insert a lead row + its 4 file rows + a session metric into D1. */
// Phase 2: location tier (1 = Jabodetabek/Bandung/Surabaya/Gresik/Sidoarjo,
// 2 = Yogyakarta/Semarang/Makassar/Medan/Batam/Bali, 0 = lain).
const TIER1 = new Set(["jabodetabek", "bandung", "surabaya", "gresik", "sidoarjo"]);
const TIER2 = new Set(["yogyakarta", "jogja", "semarang", "makassar", "medan", "batam", "bali"]);
function tierLokasi(kota) {
  const k = String(kota || "").trim().toLowerCase();
  if (TIER1.has(k)) return 1;
  if (TIER2.has(k)) return 2;
  return 0;
}

/* --- Phase 3: scoring + sales assignment (exact tables from the brief) ------ */
function gradeGaji(g) {
  g = g || 0;
  if (g < 13000000) return "C";
  if (g <= 50000000) return "B";
  if (g <= 100000000) return "A";
  return "A+";
}
function gradePlafon(p) {
  p = p || 0;
  if (p < 750000000) return "D";
  if (p < 1100000000) return "C";
  if (p < 2500000000) return "B";
  if (p <= 5000000000) return "A";
  return "A+";
}
const LOKASI_A = new Set(["jabodetabek", "bandung", "surabaya", "gresik", "sidoarjo"]);
const LOKASI_B = new Set(["yogyakarta", "jogja", "semarang", "makassar", "medan", "batam", "bali"]);
function gradeLokasi(kota) {
  const k = String(kota || "").trim().toLowerCase();
  if (LOKASI_A.has(k)) return "A";
  if (LOKASI_B.has(k)) return "B";
  return "C";
}
const GRADE_POINTS = { "A+": 100, "A": 85, "B": 70, "C": 50, "D": 30 };
function compositeScore(gg, gp, gl) {
  return Math.round(0.40 * (GRADE_POINTS[gg] || 0) + 0.40 * (GRADE_POINTS[gp] || 0) + 0.20 * (GRADE_POINTS[gl] || 0));
}
function bandGrade(s) {
  if (s >= 90) return "A+";
  if (s >= 80) return "A";
  if (s >= 65) return "B";
  if (s >= 50) return "C";
  return "D";
}
const SALES_AS = new Set(["jabodetabek", "medan", "batam"]);
const SALES_HB = new Set(["surabaya", "gresik", "sidoarjo", "makassar", "bali"]);
const SALES_RB = new Set(["bandung", "yogyakarta", "jogja", "semarang"]);
function salesOwner(kota) {
  const k = String(kota || "").trim().toLowerCase();
  if (SALES_AS.has(k)) return "AS";
  if (SALES_HB.has(k)) return "HB";
  if (SALES_RB.has(k)) return "RB";
  return "ER";
}

async function cmsIngestLead(env, id, ts, form, meta) {
  const a = parseJsonObj(form.get("answers"));
  const restruktur = /^pernah$/i.test(String(a.history_telat_restruktur_12bln || "").trim()) ? 1 : 0;
  const sertifikat = /sudah sertifikat/i.test(String(a.jaminan_sertifikat_atau_ppjb || "")) ? 1 : 0;
  const tel = digitsOnly(a.nomor_handphone);
  const em = String(a.email_aktif || "").toLowerCase().trim();
  const nama = String(a.nama_lengkap || "").replace(/\s+/g, " ").trim();
  const kota = a.kota_jaminan || "";
  const gaji = parseInt(digitsOnly(a.penghasilan_bersih_bulanan), 10) || null;
  const plafon = parseInt(digitsOnly(a.harga_transaksi), 10) || null; // proxy: price, not loan amount

  // Phase 2: duplicate check on normalised telepon OR email (prior submissions).
  const prior = (await env.DB.prepare(
    "SELECT created_at FROM leads WHERE (telepon != '' AND telepon = ?) OR (email != '' AND email = ?) ORDER BY created_at DESC"
  ).bind(tel, em).all()).results || [];
  const isDuplicate = prior.length > 0 ? 1 : 0;
  const submitCount = prior.length + 1;
  const lastSubmitAt = prior.length ? prior[0].created_at : null;

  // Phase 3: grades, composite, overall band, sales owner.
  const gGaji = gradeGaji(gaji), gPlafon = gradePlafon(plafon), gLokasi = gradeLokasi(kota);
  const skor = compositeScore(gGaji, gPlafon, gLokasi);
  const gradeAll = bandGrade(skor);
  const owner = salesOwner(kota);

  await env.DB.prepare(
    "INSERT INTO leads (id,created_at,nama,telepon,email,nik_masked,jenis_kpr,gaji_bulanan,plafon,kota,pernah_restruktur,to_sertifikat_siap,tier_lokasi,is_duplicate,submit_count,last_submit_at," +
    "grade_gaji,grade_plafon,grade_lokasi,skor_komposit,grade_keseluruhan,sales_owner,status) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'uncontacted')"
  ).bind(
    id, ts,
    nama,
    tel,
    em,
    maskNik(form.get("nik")),
    jenisKprFromProduct(meta.product),
    gaji,
    plafon,
    kota,
    restruktur,
    sertifikat,
    tierLokasi(kota),
    isDuplicate,
    submitCount,
    lastSubmitAt,
    gGaji,
    gPlafon,
    gLokasi,
    skor,
    gradeAll,
    owner
  ).run();

  const f = meta.files || {};
  const fileRows = [
    ["chatlog", f.chatlog],
    ["prescreen_xls", f.prescreen],
    ["pariksa_pdf", f.report],
    ["ektp", f.ektp],            // full eKTP image (uncropped), as requested by owner
    ["pasfoto", f.pasfoto],
  ];
  for (const [jenis, name] of fileRows) {
    if (!name) continue;
    await env.DB.prepare(
      "INSERT INTO lead_files (id,lead_id,jenis,r2_key,uploaded_at) VALUES (?,?,?,?,?)"
    ).bind(crypto.randomUUID(), id, jenis, `leads/${id}/${name}`, ts).run();
  }
  await env.DB.prepare(
    "INSERT INTO sessions_metric (id,tipe,created_at) VALUES (?,?,?)"
  ).bind(crypto.randomUUID(), "prescreen_submit", ts).run();
}

async function handleCmsLeads(env) {
  if (!env.DB) return json({ ok: false, error: "CMS (Cloudflare D1) belum dikonfigurasi." }, 503);
  const leads = (await env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT 500").all()).results || [];
  const files = (await env.DB.prepare("SELECT lead_id,jenis,r2_key FROM lead_files").all()).results || [];
  const byLead = {};
  for (const fl of files) (byLead[fl.lead_id] = byLead[fl.lead_id] || []).push(fl);
  return json({ ok: true, leads: leads.map((l) => ({ ...l, files: byLead[l.id] || [] })) });
}

/** Write an audit-log row (best-effort). */
async function cmsAudit(env, actor, aksi, target) {
  try {
    await env.DB.prepare("INSERT INTO audit_log (id,actor,aksi,target,at) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), actor || "admin", aksi, target, new Date().toISOString()).run();
  } catch { /* never block on audit */ }
}

/** Delete a CMS lead: its R2 files + D1 rows, logged to audit_log. */
async function handleCmsDelete(request, env, session) {
  if (!env.DB) return json({ ok: false, error: "CMS belum dikonfigurasi." }, 503);
  const { id } = await request.json().catch(() => ({}));
  if (!id || /[^a-zA-Z0-9-]/.test(String(id))) return json({ ok: false, error: "ID tidak valid." }, 400);

  // Remove every stored object under leads/<id>/ (eKTP, pas foto, pdf, txt, meta).
  let deleted = 0;
  const listed = await env.BUCKET.list({ prefix: `leads/${id}/` });
  for (const o of listed.objects) { await env.BUCKET.delete(o.key); deleted++; }

  await env.DB.prepare("DELETE FROM lead_files WHERE lead_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM status_history WHERE lead_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(id).run();
  await cmsAudit(env, session && session.u, "delete", `lead:${id}`);
  return json({ ok: true, deleted });
}

/** Plain (unencrypted, STORE) ZIP — used to assemble the .xlsx package. */
function makePlainZip(entries) {
  const enc = new TextEncoder();
  const prepared = entries.map((e) => ({ name: enc.encode(e.name), data: e.data, crc: crc32(e.data) }));
  const chunks = [], central = [];
  let offset = 0;
  for (const p of prepared) {
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, 0, true);     // store
    lh.setUint16(12, 0x21, true);
    lh.setUint32(14, p.crc, true);
    lh.setUint32(18, p.data.length, true);
    lh.setUint32(22, p.data.length, true);
    lh.setUint16(26, p.name.length, true);
    chunks.push(new Uint8Array(lh.buffer), p.name, p.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, p.crc, true);
    cd.setUint32(20, p.data.length, true);
    cd.setUint32(24, p.data.length, true);
    cd.setUint16(28, p.name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), p.name);
    offset += 30 + p.name.length + p.data.length;
  }
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, prepared.length, true);
  eocd.setUint16(10, prepared.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  let total = 0;
  for (const a of all) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

async function handleFile(url, env) {
  const key = url.searchParams.get("key") || "";
  if (!(key.startsWith("leads/") || key.startsWith("sessions/")) || key.includes("..")) {
    return json({ ok: false, error: "Key tidak valid." }, 400);
  }
  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ ok: false, error: "Tidak ditemukan." }, 404);
  // Allow the admin to request a unique download filename (so files with the
  // same base name don't overwrite each other).
  const requested = url.searchParams.get("name") || "";
  const safe = requested.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const name = safe || key.split("/").pop();
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

/* --- Session helpers (HMAC-signed cookie) ---------------------------------- */

function sessionSecret(env) {
  return env.SESSION_SECRET || "sakhapr-dev-secret-change-me";
}

async function makeSession(env, user) {
  const payload = b64url(strToBytes(JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL_MS })));
  const sig = b64url(await hmac(sessionSecret(env), payload));
  return `${payload}.${sig}`;
}

async function verifySession(env, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [payload, sig] = token.split(".");
  const expected = b64url(await hmac(sessionSecret(env), payload));
  if (!timingSafeEqual(sig, expected)) return null;
  let data;
  try {
    data = JSON.parse(bytesToStr(unb64url(payload)));
  } catch {
    return null;
  }
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", strToBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, strToBytes(msg));
  return new Uint8Array(sig);
}

/* --- Small utilities ------------------------------------------------------- */

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function cookie(name, value, maxAgeMs) {
  const maxAge = Math.floor(maxAgeMs / 1000);
  return `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}

// Best-effort, in-memory rate limit (per Worker isolate). For stronger limits,
// use a Cloudflare Rate Limiting rule or a Durable Object.
const RL = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (RL.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  RL.set(key, arr);
  if (RL.size > 5000) RL.clear(); // crude cap
  return arr.length <= max;
}

function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const strToBytes = (s) => new TextEncoder().encode(s);
const bytesToStr = (b) => new TextDecoder().decode(b);

function b64url(bytes) {
  let bin = "";
  bytes.forEach((x) => (bin += String.fromCharCode(x)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function extFromType(type) {
  if (/png/i.test(type)) return ".png";
  if (/jpe?g/i.test(type)) return ".jpg";
  if (/webp/i.test(type)) return ".webp";
  return ".img";
}
