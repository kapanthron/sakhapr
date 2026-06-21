/* ============================================================================
   worker/index.js  —  SakhaPR backend (Cloudflare Worker)

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
      if (pathname === "/api/admin/leads" && request.method === "GET") {
        return await requireAdmin(request, env, () => handleListLeads(env));
      }
      if (pathname === "/api/admin/file" && request.method === "GET") {
        return await requireAdmin(request, env, () => handleFile(url, env));
      }
      if (pathname === "/admin") {
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
    files: {
      prescreen: "prescreen.txt",
      ektp: ektpName,
      report: "laporan_nik.pdf",
      ...(chatlog ? { chatlog: "chatlog.txt" } : {}),
    },
    email: { to: env.MAIL_TO || "", status: "pending", at: null, providerId: null, error: null },
  };

  // Email the package (best-effort; never blocks storage).
  meta.email = await sendEmail(env, meta, { prescreen, ektp, report, chatlog, ektpName });

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
  "Anda adalah SakhaPR, asisten KPR (Kredit Pemilikan Rumah) UOB Indonesia. " +
  "Jawab HANYA berdasarkan FAKTA dari knowledge base di bawah. Gunakan Bahasa " +
  "Indonesia yang ramah, jelas, dan ringkas. JANGAN mengarang angka, suku bunga, " +
  "biaya, atau syarat yang tidak ada di FAKTA. Jika informasinya tidak tersedia, " +
  "katakan dengan jujur lalu ajak nasabah melanjutkan ke proses pengajuan agar tim " +
  "UOB dapat membantu lebih lanjut (JANGAN menyuruh menghubungi email atau nomor " +
  "telepon Mortgage Relations). Untuk pertanyaan soal " +
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
  const model = await pickGeminiModel(env);
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body }
  );
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

/** Discover a chat-capable model for THIS key (model names change over time). */
async function pickGeminiModel(env) {
  if (env.GEMINI_MODEL) return env.GEMINI_MODEL;
  if (CACHED_GEMINI_MODEL) return CACHED_GEMINI_MODEL;

  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY },
  });
  if (!res.ok) throw new Error(`ListModels HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();

  const NON_CHAT = /(tts|image|vision|embedding|robotics|imagen|lyria|nano|thinking|\bexp\b|preview)/i;
  const usable = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));
  const chat = usable.filter((m) => !NON_CHAT.test(m.name));

  // Prefer the newest "Flash" Gemini (fast + cheap), penalise "lite".
  const score = (name) => {
    const n = name.toLowerCase();
    let s = 0;
    if (n.includes("gemini")) s += 50;
    if (n.includes("flash")) s += 30;
    if (n.includes("lite")) s -= 12;
    const v = n.match(/(\d+(?:\.\d+)?)/);
    if (v) s += parseFloat(v[1]); // version number as tiebreaker
    return s;
  };
  const pool = chat.length ? chat : usable;
  const pick = pool.slice().sort((a, b) => score(b.name) - score(a.name))[0];
  if (!pick) throw new Error("Tidak ada model yang mendukung generateContent untuk API key ini.");
  CACHED_GEMINI_MODEL = pick.name.replace(/^models\//, "");
  return CACHED_GEMINI_MODEL;
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

  const call = async (model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body,
    });

  let model = await pickGeminiModel(env);
  let res = await call(model);
  if (res.status === 404) {
    CACHED_GEMINI_MODEL = null; // cached model went stale -> re-discover once
    model = await pickGeminiModel(env);
    res = await call(model);
  }
  if (!res.ok) throw new Error(`Gemini gagal — ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const data = await res.json();
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
      parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: OCR_PROMPT }],
    }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 1024 },
  });
  const call = (model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body,
    });

  let model = await pickGeminiModel(env);
  let res = await call(model);
  if (res.status === 404) {
    CACHED_GEMINI_MODEL = null;
    model = await pickGeminiModel(env);
    res = await call(model);
  }
  if (!res.ok) throw new Error(`Gemini OCR HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const data = await res.json();
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

/* --- Email (Resend) -------------------------------------------------------- */

async function sendEmail(env, meta, files) {
  // Defaults make the "Resend → your own Gmail" shortcut work with only one
  // secret (RESEND_API_KEY): the test sender onboarding@resend.dev can deliver
  // to the email that owns the Resend account, with no domain verification.
  const to = env.MAIL_TO || "hendrik.panthron@gmail.com";
  const from = env.MAIL_FROM || "SakhaPR <onboarding@resend.dev>";
  const at = new Date().toISOString();
  if (!env.RESEND_API_KEY) {
    return { to, status: "not_configured", at, providerId: null,
      error: "RESEND_API_KEY belum diset; pengiriman dicatat tetapi tidak dikirim." };
  }

  try {
    const attachments = [
      { filename: "prescreen.txt", content: await abToBase64(await files.prescreen.arrayBuffer()) },
      { filename: files.ektpName, content: await abToBase64(await files.ektp.arrayBuffer()) },
      { filename: "laporan_nik.pdf", content: await abToBase64(await files.report.arrayBuffer()) },
    ];
    if (files.chatlog) {
      attachments.push({ filename: "chatlog.txt", content: await abToBase64(await files.chatlog.arrayBuffer()) });
    }
    const body = {
      from,
      to: [to],
      subject: "SakhaPR lead + eKTP screening",
      text:
        `Lead KPR dari SakhaPR.\n\n` +
        `Produk      : ${meta.productName || meta.product || "-"}\n` +
        `Prescreen   : ${meta.prescreenLabel || "-"} ${meta.prescreenStatus || ""}\n` +
        `Verdict NIK : ${meta.nikVerdict || "-"}\n` +
        `Lead ID     : ${meta.id}\n\n` +
        `Lampiran: transkrip prescreen, gambar eKTP, laporan skrining NIK.\n` +
        `Catatan: skrining NIK hanya alat bantu struktur/konsistensi, bukan keputusan kredit.`,
      attachments,
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
  return handler();
}

/* --- Admin: data ----------------------------------------------------------- */

async function handleListLeads(env) {
  const leads = [];
  for (const prefix of ["leads/", "sessions/"]) {
    const listed = await env.BUCKET.list({ prefix });
    for (const obj of listed.objects.filter((o) => o.key.endsWith("/meta.json"))) {
      const got = await env.BUCKET.get(obj.key);
      if (!got) continue;
      try {
        leads.push(JSON.parse(await got.text()));
      } catch {
        /* skip malformed */
      }
    }
  }
  leads.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return json({ ok: true, leads });
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
async function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function extFromType(type) {
  if (/png/i.test(type)) return ".png";
  if (/jpe?g/i.test(type)) return ".jpg";
  if (/webp/i.test(type)) return ".webp";
  return ".img";
}
