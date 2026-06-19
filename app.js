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

  addMessage(
    "bot",
    `Terima kasih. Prescreen ${session.label} selesai. Anda dapat mengunduh transkrip (file a) di bawah ini.`
  );
  addActionButton("Unduh transkrip prescreen (.txt)", () => {
    const { filename, text } = buildTranscript(session, new Date().toLocaleString("id-ID"));
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    store.files.fileA = blob; // kept in memory for the Phase 6 bundle
    downloadBlob(blob, filename);
    updateDataStatus();
  });
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

/* --- Boot ------------------------------------------------------------------ */

function init() {
  cspSelfCheck();
  assertNoPersistentStorage();
  updateDataStatus();
  greet();
  composerInput.focus();
}

init();
