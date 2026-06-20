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
      if (pathname === "/api/admin/login" && request.method === "POST") {
        return await handleLogin(request, env);
      }
      if (pathname === "/api/admin/logout" && request.method === "POST") {
        return handleLogout();
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

  const meta = {
    id,
    ts,
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

  return json({ ok: true, id, email: meta.email.status });
}

/* --- Chat (Workers AI, grounded on the knowledge base) --------------------- */

const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const SYSTEM_PROMPT =
  "Anda adalah SakhaPR, asisten KPR (Kredit Pemilikan Rumah) UOB Indonesia. " +
  "Jawab HANYA berdasarkan FAKTA dari knowledge base di bawah. Gunakan Bahasa " +
  "Indonesia yang ramah, jelas, dan ringkas. JANGAN mengarang angka, suku bunga, " +
  "biaya, atau syarat yang tidak ada di FAKTA. Jika informasinya tidak tersedia, " +
  "katakan dengan jujur bahwa Anda belum memiliki datanya dan arahkan nasabah ke " +
  "Mortgage Relations Unit (mortgagerelations@uob.co.id). Untuk pertanyaan soal " +
  "uang (bunga, biaya, cashback, denda), sertakan pengingat singkat bahwa angka " +
  "bersifat estimasi dan dapat berubah. Pemeriksaan ini bukan keputusan kredit.";

let KB_CONTEXT = null;

async function kbContext(env, url) {
  if (KB_CONTEXT) return KB_CONTEXT;
  const res = await env.ASSETS.fetch(new Request(new URL("/data/knowledge_base.json", url)));
  const kb = await res.json();
  KB_CONTEXT = buildContext(kb).slice(0, 14000);
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
  L.push("\nKONTAK: " + JSON.stringify(kb.support || {}));
  return L.join("\n");
}

async function handleChat(request, env) {
  const { message, history } = await request.json().catch(() => ({}));
  if (!message || typeof message !== "string") {
    return json({ ok: false, error: "Pesan kosong." }, 400);
  }

  const ctx = await kbContext(env, new URL(request.url));
  const sys = `${SYSTEM_PROMPT}\n\nFAKTA (knowledge base):\n${ctx}`;
  const hist = Array.isArray(history) ? history.slice(-6) : [];

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
    generationConfig: { maxOutputTokens: 600, temperature: 0.3 },
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

/** Cloudflare Workers AI (free daily allocation; the [ai] binding). */
async function callWorkersAi(env, sys, history, message) {
  const messages = [{ role: "system", content: sys }];
  for (const h of history) {
    if (h && h.content) messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content).slice(0, 1200) });
  }
  messages.push({ role: "user", content: message.slice(0, 1200) });
  const out = await env.AI.run(CHAT_MODEL, { messages, max_tokens: 512 });
  return (out && (out.response || out.result || "")).trim();
}

/* --- Email (Resend) -------------------------------------------------------- */

async function sendEmail(env, meta, files) {
  const to = env.MAIL_TO;
  const at = new Date().toISOString();
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    return { to: to || "", status: "not_configured", at, providerId: null,
      error: "RESEND_API_KEY / MAIL_FROM belum diset; pengiriman dicatat tetapi tidak dikirim." };
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
      from: env.MAIL_FROM,
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
  const { user, pass } = await request.json().catch(() => ({}));
  const okUser = String(user || "") === (env.ADMIN_USER || "");
  const okPass = timingSafeEqual(String(pass || ""), env.ADMIN_PASS || "");
  if (!okUser || !okPass) {
    return json({ ok: false, error: "Kredensial salah." }, 401);
  }
  const token = await makeSession(env, env.ADMIN_USER);
  return json({ ok: true }, 200, {
    "Set-Cookie": cookie(COOKIE_NAME, token, SESSION_TTL_MS),
  });
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
  const listed = await env.BUCKET.list({ prefix: "leads/" });
  const metaKeys = listed.objects.filter((o) => o.key.endsWith("/meta.json"));
  const leads = [];
  for (const obj of metaKeys) {
    const got = await env.BUCKET.get(obj.key);
    if (!got) continue;
    try {
      leads.push(JSON.parse(await got.text()));
    } catch {
      /* skip malformed */
    }
  }
  leads.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return json({ ok: true, leads });
}

async function handleFile(url, env) {
  const key = url.searchParams.get("key") || "";
  if (!key.startsWith("leads/") || key.includes("..")) {
    return json({ ok: false, error: "Key tidak valid." }, 400);
  }
  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ ok: false, error: "Tidak ditemukan." }, 404);
  const name = key.split("/").pop();
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
