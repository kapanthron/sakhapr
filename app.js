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

/** Offer a single action button (e.g. download, start prescreen). */
function addActionButton(label, onClick) {
  const row = document.createElement("div");
  row.className = "chips";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip chip--action";
  btn.textContent = label;
  btn.addEventListener("click", () => onClick(btn));
  row.appendChild(btn);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/** Trigger a download of a Blob via a tracked (revocable) object URL. */
function downloadBlob(blob, filename) {
  const url = trackedObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
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

function greet() {
  addMessage(
    "bot",
    "Halo! Saya SakhaPR, asisten KPR UOB Indonesia. " +
      "Saya bisa menjawab pertanyaan seputar KPR, membantu memilih produk yang tepat, " +
      "dan menjalankan prescreen awal. Silakan tanya apa saja.",
    { persist: false }
  );
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

  const prefix = `Pertanyaan ${q.no}. `;
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

async function handleKbMessage(text) {
  const kb = await loadKnowledgeBase();
  const classification = classifyIntent(text);
  const res = answer(kb, classification, TODAY_ISO);

  store.intent = classification.intent;
  if (res.product) store.product = res.product;

  renderAnswer(res);

  // Hand off to the prescreen when the customer is ready, or offer it after routing.
  if (classification.intent === INTENTS.READY_TO_APPLY) {
    await offerPrescreen(productToSet(res.product));
  } else if (classification.intent === INTENTS.WHICH_PRODUCT && res.product) {
    const setId = productToSet(res.product);
    addActionButton("Mulai prescreen", () => offerPrescreen(setId));
  }
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

const ektp = {};
function cacheEktpEls() {
  const $ = (id) => document.getElementById(id);
  Object.assign(ektp, {
    section: $("ektpSection"),
    consent: $("ektpConsent"), file: $("ektpFile"), hint: $("ektpHint"),
    status: $("ektpStatus"), preview: $("ektpPreview"),
  });
}

function resetEktpUi() {
  if (!ektp.consent) return;
  ektp.consent.checked = false;
  ektp.file.value = "";
  ektp.file.disabled = true;
  ektp.hint.textContent = "Centang persetujuan untuk mengaktifkan unggah eKTP.";
  ektp.status.textContent = "";
  ektp.preview.hidden = true;
  ektp.preview.removeAttribute("src");
  if (ektp.section) ektp.section.hidden = true;
}

function setupEktp() {
  cacheEktpEls();
  if (!ektp.consent) return;

  // Consent gate: the file picker stays disabled until consent is ticked.
  ektp.consent.addEventListener("change", () => {
    const ok = ektp.consent.checked;
    ektp.file.disabled = !ok;
    ektp.hint.textContent = ok
      ? "Unggah foto eKTP. Identifikasi berjalan otomatis."
      : "Centang persetujuan untuk mengaktifkan unggah eKTP.";
  });

  ektp.file.addEventListener("change", async () => {
    const file = ektp.file.files && ektp.file.files[0];
    if (!file) return;
    await processEktp(file);
  });
}

/**
 * The whole eKTP step, automatic and behind the scenes:
 * on-device ML OCR -> NIK structure check -> build report PDF ->
 * forward all three files to the backend (which stores + emails them).
 * The customer only sees progress and a final confirmation.
 */
async function processEktp(file) {
  // In-memory preview via a tracked (revocable) object URL.
  ektp.preview.src = trackedObjectURL(file);
  ektp.preview.hidden = false;
  ektp.file.disabled = true;
  store.ektp = store.ektp || {};
  store.ektp.image = file;
  updateDataStatus();

  if (!store.files.fileA) {
    ektp.status.textContent =
      "Mohon selesaikan prescreen di atas terlebih dahulu sebelum mengunggah eKTP.";
    ektp.file.disabled = false;
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

    // 3) Forward the three files to the backend (store + email).
    ektp.status.textContent = "Meneruskan berkas ke UOB…";
    const session = flow.session || store.prescreen;
    const result = await submitLead({
      prescreen: store.files.fileA,
      ektp: file,
      report: reportBlob,
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
  }
}

/* --- Boot ------------------------------------------------------------------ */

function init() {
  cspSelfCheck();
  assertNoPersistentStorage();
  updateDataStatus();
  greet();
  setupEktp();
  composerInput.focus();
}

init();
