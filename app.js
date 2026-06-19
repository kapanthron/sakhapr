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
} from "./modules/privacy.js";
import { classifyIntent } from "./modules/intentRouter.js";
import { answer } from "./modules/knowledgeAnswer.js";

/* --- Knowledge base (loaded once, public reference data, not personal) ----- */
let knowledgeBase = null;
const TODAY_ISO = new Date().toISOString().slice(0, 10);

async function loadKnowledgeBase() {
  if (knowledgeBase) return knowledgeBase;
  const res = await fetch("data/knowledge_base.json");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  knowledgeBase = await res.json();
  return knowledgeBase;
}

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

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = composerInput.value.trim();
  if (!text) return;

  addMessage("user", text);
  composerInput.value = "";

  try {
    const kb = await loadKnowledgeBase();
    const classification = classifyIntent(text);
    const res = answer(kb, classification, TODAY_ISO);

    // Remember the running context (in memory only) for later phases.
    store.intent = classification.intent;
    if (res.product) store.product = res.product;

    renderAnswer(res);
  } catch (err) {
    console.error("[SakhaPR] answer failed:", err);
    addMessage(
      "bot",
      "Maaf, basis pengetahuan belum bisa dimuat. Jika Anda membuka file ini " +
        "langsung (file://), jalankan lewat server lokal (mis. `npx serve`) atau " +
        "buka versi yang sudah ter-deploy."
    );
  }
});

/* --- Clear all data -------------------------------------------------------- */

clearAllBtn.addEventListener("click", () => {
  const had = hasStoredData();
  clearAllData();
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
