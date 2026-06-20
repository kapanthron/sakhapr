/* ============================================================================
   app.js — SakhaPR orchestrator
   Phase 1: wires the shell together. It renders chat messages, handles the
   composer, drives the "Hapus semua data" (Clear all data) button, and keeps an
   on-screen indicator of whether any data is held in memory.

   The conversational brain (intent router, knowledge answers, prescreen, NIK
   check, bundling, send) is added in later phases. For now, the bot gives a
   greeting and a friendly placeholder reply.
   ============================================================================ */

import {
  store,
  clearAllData,
  hasStoredData,
  assertNoPersistentStorage,
  cspSelfCheck,
  trackedObjectURL,
} from "./modules/privacy.js";
import { classifyIntent, INTENTS } from "./modules/intentRouter.js";
import { answer } from "./modules/knowledgeAnswer.js";
import { askLlm } from "./modules/chat.js";
import {
  schemesForFacility,
  computeInstallment,
  computeCashback,
  cashbackProgramFor,
  provisiAdmin,
  formatRp,
} from "./modules/calculator.js";

const FACILITY_TO_PRODUCT = {
  primary: "kpr_flexi_primary",
  secondary: "kpr_secondary",
  take_over: "kpr_take_over",
};
import {
  PrescreenSession,
  productToSet,
  validateAnswer,
  buildTranscript,
} from "./modules/prescreen.js";
import { validateNik } from "./modules/validateNik.js";
import { loadRegionData } from "./modules/regionData.js";
import { runOcr, terminateOcr } from "./modules/ocr.js";
import { buildNikReportPdf } from "./modules/pdfReport.js";
import { submitLead } from "./modules/submit.js";

const PRODUCT_NAMES = {
  kpr_flexi_primary: "KPR Flexi Primary",
  kpr_secondary: "KPR Secondary",
  kpr_take_over: "KPR Take Over",
};

/* --- Reference data (loaded once, public, not personal) -------------------- */
let knowledgeBase = null;
let prescreenData = null;
const TODAY_ISO = new Date().toISOString().slice(0, 10);

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}
async function loadKnowledgeBase() {
  if (!knowledgeBase) knowledgeBase = await loadJson("data/knowledge_base.json");
  return knowledgeBase;
}
async function loadPrescreen() {
  if (!prescreenData) prescreenData = await loadJson("data/prescreen.json");
  return prescreenData;
}

/* --- Conversation flow state ----------------------------------------------- */
// mode: 'idle' (KB chat) | 'choose_set' (picking a prescreen set) | 'prescreen'
const flow = { mode: "idle", session: null };

/* --- DOM handles ----------------------------------------------------------- */
const chatLog = document.getElementById("chatLog");
const composer = document.getElementById("composer");
const composerInput = document.getElementById("composerInput");
const clearAllBtn = document.getElementById("clearAllBtn");
const dataStatus = document.getElementById("dataStatus");

/* --- Rendering ------------------------------------------------------------- */

/**
 * Append a message bubble and record it in the in-memory store.
 * @param {"user"|"bot"|"system"} role
 * @param {string} text
 * @param {{persist?: boolean}} [opts]  persist=false for ephemeral system notes
 */
function addMessage(role, text, opts = {}) {
  const { persist = true } = opts;

  const el = document.createElement("div");
  el.className = `msg msg--${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;

  if (persist && role !== "system") {
    store.messages.push({ role, text, ts: Date.now() });
  }
  updateDataStatus();
}

/**
 * Render a row of clickable option chips under the transcript. Each click
 * echoes the choice as a user message, removes the chips, then runs onPick.
 * @param {string[]} options
 * @param {(value:string)=>void} onPick
 */
function addChips(options, onPick) {
  const row = document.createElement("div");
  row.className = "chips";
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      row.remove();
      addMessage("user", opt);
      onPick(opt);
    });
    row.appendChild(btn);
  }
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/** Reflect whether memory currently holds any data, in the footer pill. */
function updateDataStatus() {
  const active = hasStoredData();
  dataStatus.textContent = active
    ? `Data tersimpan di memori (${store.messages.length} pesan).`
    : "Tidak ada data tersimpan.";
  dataStatus.classList.toggle("is-active", active);
}

/* --- Greeting -------------------------------------------------------------- */

// Context-appropriate starter ("umpan") questions shown at the opening.
const SUGGESTIONS = [
  { label: "Take over KPR", q: "Saya mau take over KPR dari bank lain ke UOB. Bagaimana caranya dan apa syaratnya?" },
  { label: "Syarat penghasilan", q: "Berapa minimum gaji untuk mengajukan KPR UOB?" },
  { label: "Hitung cicilan", q: "Tolong hitung cicilan KPR. Harga rumah Rp800 juta, DP 20%, tenor 20 tahun." },
  { label: "Cashback promo", q: "Berapa cashback maksimal Kategori A dan apa syaratnya?" },
  { label: "Dokumen", q: "Saya karyawan swasta. Dokumen apa saja yang perlu disiapkan untuk KPR?" },
  { label: "Proses KPR", q: "Berapa lama proses KPR UOB dari pengajuan sampai akad?" },
];

function addSuggestions() {
  const row = document.createElement("div");
  row.className = "chips";
  for (const s of SUGGESTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = s.label;
    btn.addEventListener("click", () => {
      row.remove();
      addMessage("user", s.q);
      handleKbMessage(s.q).catch((e) => console.error("[SakhaPR] suggestion failed:", e));
    });
    row.appendChild(btn);
  }
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function greet() {
  addMessage(
    "bot",
    "Halo! Saya SakhaPR, asisten KPR UOB Indonesia. " +
      "Saya bisa menjawab pertanyaan seputar KPR, membantu memilih produk yang tepat, " +
      "dan menjalankan prescreen awal. Silakan tanya apa saja, atau pilih salah satu di bawah.",
    { persist: false }
  );
  addSuggestions();
}

/* --- Composer handling ----------------------------------------------------- */

/** Render an answer object (body + disclaimer) as one bot bubble. */
function renderAnswer(res) {
  const body = res.disclaimer ? `${res.text}\n\n— ${res.disclaimer}` : res.text;
  addMessage("bot", body);
}

/* --- Prescreen flow -------------------------------------------------------- */

const SET_PROMPTS = {
  primary: "KPR Primary (beli baru di developer)",
  secondary: "KPR Secondary (beli properti bekas)",
  take_over: "KPR Take Over (pindah dari bank lain)",
};

/** Begin choosing/starting a prescreen. If the set is known, jump straight in. */
async function offerPrescreen(setId) {
  try {
    await loadPrescreen();
  } catch (err) {
    console.error("[SakhaPR] prescreen load failed:", err);
    addMessage("bot", "Maaf, set pertanyaan prescreen belum bisa dimuat. Jalankan lewat server lokal atau versi ter-deploy.");
    return;
  }
  if (setId) {
    startPrescreen(setId);
    return;
  }
  flow.mode = "choose_set";
  addMessage("bot", "Untuk prescreen awal, situasi Anda yang mana?");
  addChips(
    [SET_PROMPTS.primary, SET_PROMPTS.secondary, SET_PROMPTS.take_over],
    (label) => {
      const picked = Object.keys(SET_PROMPTS).find((k) => SET_PROMPTS[k] === label);
      startPrescreen(picked);
    }
  );
}

function startPrescreen(setId) {
  const session = new PrescreenSession(prescreenData, setId);
  flow.mode = "prescreen";
  flow.session = session;
  store.prescreen = session; // in-memory only

  if (session.intro) addMessage("bot", session.intro);
  askNextQuestion();
}

/** Present the current question (with option chips for choices). */
function askNextQuestion() {
  const session = flow.session;
  const q = session.next();
  if (!q) return finishPrescreen();

  // Number questions by position asked (the static "no" is ignored), so adding
  // questions to a set never requires renumbering.
  const prefix = `Pertanyaan ${Object.keys(session.answers).length + 1}. `;
  if (q.type === "choice") {
    addMessage("bot", prefix + q.text);
    addChips(q.options, submitPrescreenAnswer);
  } else {
    const hint = q.type === "number" ? " (masukkan angka)" : "";
    addMessage("bot", prefix + q.text + hint);
  }
}

/** Handle one answer (typed or chip), validate, advance. */
function submitPrescreenAnswer(raw) {
  const session = flow.session;
  const q = session.current();
  if (!q) return;

  const result = validateAnswer(q, raw);
  if (!result.ok) {
    addMessage("bot", result.error);
    if (q.type === "choice") addChips(q.options, submitPrescreenAnswer);
    return;
  }
  session.record(result.value);
  askNextQuestion();
}

function finishPrescreen() {
  const session = flow.session;
  flow.mode = "idle";

  // Build the prescreen transcript (file a) silently and keep it in memory.
  // The customer never sees or downloads it; it is forwarded behind the scenes.
  const { text } = buildTranscript(session, new Date().toLocaleString("id-ID"));
  store.files.fileA = new Blob([text], { type: "text/plain;charset=utf-8" });
  updateDataStatus();

  addMessage(
    "bot",
    `Terima kasih, prescreen ${session.label} selesai. Langkah terakhir: unggah foto eKTP Anda ` +
      `dan setujui pemrosesan data. Identifikasi dilakukan otomatis — Anda tidak perlu mengisi apa pun.`
  );

  // Reveal the eKTP upload step.
  if (ektp.section) {
    ektp.section.hidden = false;
    ektp.section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/* --- Input dispatch -------------------------------------------------------- */

/** Recent conversation for the LLM (mapped to chat roles), excluding the current msg. */
function recentHistory() {
  return store.messages
    .slice(-7, -1)
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
}

const SIM_RE = /simulasi|angsuran|cicilan|hitung.*(bunga|angsuran|cashback)|estimasi.*angsuran/i;
const RATE_RE = /\bbunga\b|suku bunga|floating|berjenjang|\brate\b|tingkat suku|fix \d/i;

/** Indonesian percent format (comma decimal). */
const pid = (n) => String(n).replace(".", ",");

/** Render the KPR interest-rate table (deterministic, from the KB). */
function renderRateTable(kb) {
  const io = kb.interest_rate_options || {};
  const rr = kb.reference_rates || {};

  const fixText = (s) => {
    if (s.tiered_fixed_rate_percent) {
      const parts = Object.entries(s.tiered_fixed_rate_percent).map(([k, v]) => {
        const m = k.match(/year_(\d+)(?:_to_(\d+))?/);
        const lbl = m ? (m[2] ? `Th ${m[1]}-${m[2]}` : `Th ${m[1]}`) : k;
        return `${lbl}: ${pid(v)}%`;
      });
      return `${s.scheme} — ${parts.join("; ")}`;
    }
    return `${pid(s.fixed_rate_percent)}% ${s.scheme}`;
  };

  const card = document.createElement("div");
  card.className = "rate-card";
  const scroll = document.createElement("div");
  scroll.className = "rate-scroll";
  const table = document.createElement("table");
  table.className = "rate";

  const head = document.createElement("tr");
  ["Jenis", "Suku Bunga Fix (eff. p.a)", "Floating setelah fix", "Min. Tenor"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });
  table.appendChild(head);

  for (const [jenis, list] of [["Primary", io.primary || []], ["Secondary / Take Over", io.secondary || []]]) {
    list.forEach((s, idx) => {
      const tr = document.createElement("tr");
      if (idx === 0) {
        const td = document.createElement("td");
        td.textContent = jenis;
        td.rowSpan = list.length;
        td.className = "rate-jenis";
        tr.appendChild(td);
      }
      [fixText(s), s.floating_after || "-", `${s.min_tenor_years || "-"} Tahun`].forEach((val) => {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  }
  scroll.appendChild(table);
  card.appendChild(scroll);

  const foot = document.createElement("div");
  foot.className = "rate-foot";
  const lines = [];
  if (rr.benchmark) lines.push(`${rr.benchmark.name}: ${pid(rr.benchmark.current_value_percent)}% (per ${rr.benchmark.value_as_of}).`);
  for (const [k, v] of Object.entries(rr.floating_tiers_percent || {})) lines.push(`${k}: ${pid(v)}%`);
  const flexi = (kb.products || []).find((p) => p.id === "kpr_flexi_primary");
  if (flexi && flexi.interest && flexi.interest.current_estimate_percent) {
    lines.push(`KPR Flexi Primary: SRBI + 2,50% (≈ ${pid(flexi.interest.current_estimate_percent)}%), floating sejak awal.`);
  }
  lines.push(kb.disclaimers && kb.disclaimers.rate_movement);
  for (const l of lines) {
    if (!l) continue;
    const d = document.createElement("div");
    d.textContent = "• " + l;
    foot.appendChild(d);
  }
  card.appendChild(foot);

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function handleKbMessage(text) {
  // Numeric questions go to the deterministic simulator, not the LLM.
  if (SIM_RE.test(text)) {
    addMessage(
      "bot",
      "Untuk menghitung angsuran bulanan dan potensi cashback secara akurat, silakan isi panel " +
        "\"Simulasi Angsuran & Cashback\" di bawah (pilih fasilitas, skema bunga, plafon, dan tenor)."
    );
    const panel = document.getElementById("simPanel");
    if (panel) { panel.open = true; panel.scrollIntoView({ behavior: "smooth", block: "center" }); }
    addContinuationChips();
    return;
  }

  const kb = await loadKnowledgeBase();
  const classification = classifyIntent(text);

  // Rate questions render a neat deterministic table (more reliable than an LLM).
  if (RATE_RE.test(text) || classification.faqIntent === "suku_bunga") {
    store.intent = classification.intent;
    addMessage("bot", "Berikut tabel suku bunga KPR UOB:");
    renderRateTable(kb);
    addContinuationChips();
    return;
  }
  const detRes = answer(kb, classification, TODAY_ISO); // deterministic: product routing + fallback

  store.intent = classification.intent;
  if (detRes.product) store.product = detRes.product;

  // Ready to apply -> go straight to the prescreen (deterministic, reliable).
  if (classification.intent === INTENTS.READY_TO_APPLY) {
    renderAnswer(detRes);
    await offerPrescreen(productToSet(detRes.product));
    return;
  }

  // Otherwise answer with Workers AI (grounded), falling back to the KB answer.
  try {
    const reply = await askLlm(text, recentHistory());
    addMessage("bot", reply);
  } catch (err) {
    console.warn("[SakhaPR] LLM unavailable, using offline answer:", err.message);
    renderAnswer(detRes);
  }
  addContinuationChips();
}

/** After an answer, offer to start the application or keep asking. */
function addContinuationChips() {
  addChips(["Ya, lanjut ke pengajuan", "Tidak, ada pertanyaan lain"], (label) => {
    if (label.startsWith("Ya")) {
      offerPrescreen(productToSet(store.product));
    } else {
      addMessage("bot", "Baik. Silakan ajukan pertanyaan lain yang ingin Anda ketahui.");
    }
  });
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = composerInput.value.trim();
  if (!text) return;

  addMessage("user", text);
  composerInput.value = "";

  try {
    if (flow.mode === "prescreen") {
      submitPrescreenAnswer(text);
    } else if (flow.mode === "choose_set") {
      addMessage("bot", "Silakan pilih salah satu opsi di atas.");
    } else {
      await handleKbMessage(text);
    }
  } catch (err) {
    console.error("[SakhaPR] message handling failed:", err);
    addMessage(
      "bot",
      "Maaf, data belum bisa dimuat. Jika Anda membuka file ini langsung " +
        "(file://), jalankan lewat server lokal (mis. `npx serve`) atau buka " +
        "versi yang sudah ter-deploy."
    );
  }
});

/* --- Clear all data -------------------------------------------------------- */

clearAllBtn.addEventListener("click", () => {
  const had = hasStoredData();
  clearAllData();
  flow.mode = "idle";
  flow.session = null;
  resetEktpUi();
  terminateOcr(); // free the OCR worker
  chatLog.innerHTML = "";
  updateDataStatus();

  addMessage(
    "system",
    had ? "Seluruh data telah dihapus dari memori." : "Tidak ada data untuk dihapus.",
    { persist: false }
  );
  // Re-greet so the app is immediately usable again.
  greet();
});

/* --- eKTP upload + automatic identification (ML OCR) + forward -------------- */

const MAX_EKTP_BYTES = 3 * 1024 * 1024; // 3 MB

const ektp = {};
function cacheEktpEls() {
  const $ = (id) => document.getElementById(id);
  Object.assign(ektp, {
    section: $("ektpSection"),
    consent: $("ektpConsent"), file: $("ektpFile"), hint: $("ektpHint"),
    status: $("ektpStatus"), preview: $("ektpPreview"), send: $("ektpSend"),
  });
}

function resetEktpUi() {
  if (!ektp.consent) return;
  ektp.consent.checked = false;
  ektp.file.value = "";
  ektp.file.disabled = true;
  ektp.hint.textContent = "Centang persetujuan untuk memilih foto eKTP.";
  ektp.status.textContent = "";
  ektp.preview.hidden = true;
  ektp.preview.removeAttribute("src");
  ektp.send.disabled = true;
  if (ektp.section) ektp.section.hidden = true;
}

function setupEktp() {
  cacheEktpEls();
  if (!ektp.consent) return;

  // Consent gate: the file picker stays disabled until consent is ticked.
  ektp.consent.addEventListener("change", () => {
    const ok = ektp.consent.checked;
    ektp.file.disabled = !ok;
    if (!ok) ektp.send.disabled = true;
    ektp.hint.textContent = ok
      ? "Pilih foto eKTP (jelas, < 3 MB), lalu klik Kirim."
      : "Centang persetujuan untuk memilih foto eKTP.";
  });

  // Pick a file -> preview + size check. Sending happens on the Kirim button.
  ektp.file.addEventListener("change", () => {
    const file = ektp.file.files && ektp.file.files[0];
    if (!file) return;
    ektp.preview.src = trackedObjectURL(file);
    ektp.preview.hidden = false;

    if (file.size > MAX_EKTP_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      ektp.status.textContent = `Ukuran foto ${mb} MB melebihi 3 MB. Mohon gunakan foto yang lebih kecil.`;
      ektp.send.disabled = true;
      return;
    }
    ektp.status.textContent = "Foto siap. Klik Kirim untuk memproses dan mengirim.";
    ektp.send.disabled = false;
  });

  ektp.send.addEventListener("click", () => {
    const file = ektp.file.files && ektp.file.files[0];
    if (file) processEktp(file);
  });
}

/** Build the chat conversation log (.txt) from the in-memory messages. */
function buildChatLogBlob() {
  const L = ["SakhaPR — Log Chat", "=".repeat(40), `Tanggal: ${new Date().toLocaleString("id-ID")}`, ""];
  for (const m of store.messages) {
    L.push(`[${m.role === "user" ? "Nasabah" : "SakhaPR"}] ${m.text}`);
  }
  return new Blob([L.join("\n")], { type: "text/plain;charset=utf-8" });
}

/**
 * The whole eKTP step, automatic and behind the scenes:
 * on-device ML OCR -> NIK structure check -> build report PDF ->
 * forward all three files to the backend (which stores + emails them).
 * The customer only sees progress and a final confirmation.
 */
async function processEktp(file) {
  ektp.send.disabled = true;
  ektp.file.disabled = true;
  store.ektp = store.ektp || {};
  store.ektp.image = file;
  updateDataStatus();

  if (!store.files.fileA) {
    ektp.status.textContent =
      "Mohon selesaikan prescreen di atas terlebih dahulu sebelum mengirim eKTP.";
    ektp.file.disabled = false;
    ektp.send.disabled = false;
    return;
  }

  try {
    // 1) On-device OCR (machine learning) + deterministic NIK check.
    ektp.status.textContent = "Mengidentifikasi eKTP di perangkat Anda (OCR mesin learning)…";
    const [{ fields }, dataset] = await Promise.all([
      runOcr(file, (m) => {
        ektp.status.textContent = `Identifikasi eKTP: ${m.status} ${Math.round((m.progress || 0) * 100)}%`;
      }),
      loadRegionData(),
    ]);
    const printed = {
      jenis_kelamin: fields.jenis_kelamin || "",
      tanggal_lahir: fields.tanggal_lahir || "",
      provinsi: fields.provinsi || "",
      kabupaten_kota: fields.kabupaten_kota || "",
      kecamatan: fields.kecamatan || "",
    };
    const verdict = validateNik(fields.nik || "", printed, dataset);
    store.ektp.fields = printed;
    store.ektp.verdict = verdict;

    // 2) Build the NIK report PDF (file c) behind the scenes.
    ektp.status.textContent = "Menyusun laporan skrining…";
    const { blob: reportBlob } = buildNikReportPdf(verdict, {
      timestamp: new Date().toLocaleString("id-ID"),
      printed,
    });
    store.files.fileC = reportBlob;

    // 3) Forward the files to the backend (store + email).
    ektp.status.textContent = "Meneruskan berkas ke UOB…";
    const session = flow.session || store.prescreen;
    const result = await submitLead({
      prescreen: store.files.fileA,
      ektp: file,
      report: reportBlob,
      chatlog: buildChatLogBlob(),
      meta: {
        product: store.product || "",
        productName: PRODUCT_NAMES[store.product] || store.product || "",
        prescreenLabel: session ? session.label : "",
        prescreenStatus: session && session.isComplete() ? "selesai" : "",
        nikVerdict: verdict.verdict || "",
      },
    });

    store.ektp.submitted = result.id;
    ektp.status.textContent =
      "Terima kasih. Data Anda telah diteruskan ke tim UOB Mortgage Relations untuk " +
      `ditindaklanjuti. (Ref: ${result.id.slice(0, 8)}). Anda dapat menutup halaman ini.`;
    addMessage(
      "bot",
      "Pengajuan Anda sudah kami terima dan teruskan ke tim UOB. Tim akan menghubungi Anda. Terima kasih!",
      { persist: false }
    );
  } catch (err) {
    console.error("[SakhaPR] eKTP processing/forward failed:", err);
    ektp.status.textContent =
      "Maaf, terjadi kendala saat memproses atau meneruskan data. Mohon coba lagi atau hubungi UOB.";
    ektp.file.disabled = false;
    ektp.send.disabled = false;
  }
}

/* --- Simulation (deterministic installment + cashback) --------------------- */

let simSchemes = [];

function setupSimulation() {
  const el = {
    facility: document.getElementById("simFacility"),
    scheme: document.getElementById("simScheme"),
    plafon: document.getElementById("simPlafon"),
    tenor: document.getElementById("simTenor"),
    segment: document.getElementById("simSegment"),
    run: document.getElementById("simRun"),
    result: document.getElementById("simResult"),
  };
  if (!el.run) return;

  async function populate() {
    const kb = await loadKnowledgeBase();
    simSchemes = schemesForFacility(kb, el.facility.value);
    el.scheme.textContent = "";
    simSchemes.forEach((s, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = s.label;
      el.scheme.appendChild(o);
    });
  }

  el.facility.addEventListener("change", () => { populate().catch(() => {}); });
  el.run.addEventListener("click", () => runSimulation(el).catch((e) => {
    console.error("[SakhaPR] sim failed:", e);
    el.result.textContent = "Gagal menghitung. Pastikan halaman termuat penuh.";
  }));
  populate().catch(() => { el.result.textContent = "Gagal memuat data. Jalankan lewat server/deploy."; });
}

async function runSimulation(el) {
  const kb = await loadKnowledgeBase();
  const facility = el.facility.value;
  const scheme = simSchemes[parseInt(el.scheme.value, 10)];
  const plafon = parseInt(String(el.plafon.value).replace(/[^0-9]/g, ""), 10);
  const tenor = parseInt(el.tenor.value, 10);

  const product = (kb.products || []).find((p) => p.id === FACILITY_TO_PRODUCT[facility]);
  const errs = [];
  if (!plafon) errs.push("Isi plafon kredit (angka).");
  if (!tenor) errs.push("Isi tenor (tahun).");
  if (plafon && product && (plafon < product.credit_limit.min || plafon > product.credit_limit.max))
    errs.push(`Plafon untuk ${product.name} antara ${formatRp(product.credit_limit.min)} dan ${formatRp(product.credit_limit.max)}.`);
  if (tenor && product && (tenor < product.tenor_years.min || tenor > product.tenor_years.max))
    errs.push(`Tenor untuk ${product.name} antara ${product.tenor_years.min}–${product.tenor_years.max} tahun.`);
  if (scheme && scheme.minTenor && tenor && tenor < scheme.minTenor)
    errs.push(`Skema "${scheme.label}" minimal tenor ${scheme.minTenor} tahun.`);
  if (errs.length) { el.result.textContent = errs.join(" "); return; }

  const sched = computeInstallment(plafon, tenor, scheme);
  const provisi = provisiAdmin(plafon);
  const progId = cashbackProgramFor(facility);
  const cb = progId ? computeCashback(kb, plafon, el.segment.value) : null;
  const prog = progId ? (kb.programs || []).find((p) => p.id === progId) : null;

  renderSimulation(el.result, { product, scheme, plafon, tenor, sched, provisi, cb, prog });
}

function renderSimulation(container, r) {
  container.textContent = "";
  const add = (cls, text) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    container.appendChild(d);
    return d;
  };

  add("sim__h", `${r.product ? r.product.name : ""} · ${r.scheme.label}`);
  add("", `Plafon ${formatRp(r.plafon)} · Tenor ${r.tenor} tahun`);

  add("sim__h", "Estimasi angsuran per bulan");
  r.sched.forEach((p, i) => {
    const span = i === 0 ? `${r.sched.length > 1 ? p.months + " bln pertama" : "seluruh tenor"}` : `${p.months} bln berikutnya`;
    add("sim__row", `• Bunga ${p.rate}% (${span}): ${formatRp(p.installment)} / bln`);
  });
  add("sim__note", "Provisi & administrasi (1.1%): " + formatRp(r.provisi));

  if (r.cb) {
    add("sim__h", "Potensi cashback");
    add("sim__row", `Kategori ${r.cb.category} · cashback diterima: ${formatRp(r.cb.received)}`);
    add("sim__note", `(1% = ${formatRp(r.cb.gross)}, maksimum ${formatRp(r.cb.cap)} → ${formatRp(r.cb.capped)}, dipotong PPh 5% ${formatRp(r.cb.pph)})`);
    add("sim__note", "Syarat: wajib membeli unit trust/reksa dana via SSUT di UOB TMRW.");
    if (r.prog && r.prog.program_period && TODAY_ISO > r.prog.program_period.end) {
      add("sim__warn", `Catatan: periode program "${r.prog.name}" tercatat berakhir ${r.prog.program_period.end}.`);
    }
  } else if (cashbackProgramForLabel(r)) {
    add("sim__note", "Plafon di bawah Rp500 juta belum memenuhi kategori cashback.");
  }

  const disc = document.createElement("div");
  disc.className = "sim__disc";
  disc.textContent = "— Semua perhitungan bersifat estimasi. Angka final mengikuti analisa kredit dan Perjanjian Kredit.";
  container.appendChild(disc);
}

function cashbackProgramForLabel(r) {
  return r.prog != null; // program exists but plafon too low -> cb null
}

/* --- Boot ------------------------------------------------------------------ */

function init() {
  cspSelfCheck();
  assertNoPersistentStorage();
  updateDataStatus();
  greet();
  setupEktp();
  setupSimulation();
  composerInput.focus();
}

init();
