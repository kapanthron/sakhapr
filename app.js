/* ============================================================================
   app.js — Moggy orchestrator
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
import { streamLlm } from "./modules/chat.js";
import { t, getLang, setLang, applyStatic } from "./modules/i18n.js";
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
import { runOcr, terminateOcr, cropFacePhoto } from "./modules/ocr.js";
import { geminiOcr, cropByBox } from "./modules/geminiOcr.js";
import { buildNikReportPdf } from "./modules/pdfReport.js";
import { submitLead } from "./modules/submit.js";

const PRODUCT_NAMES = {
  kpr_flexi_primary: "KPR FLX PRI",
  kpr_secondary: "KPR 2ND",
  kpr_take_over: "KPR TO",
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
/** WIB timestamp string for all generated artifacts. */
function nowWIB() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

/** Minimal, XSS-safe Markdown -> HTML (bold, inline code, bullet/numbered lists). */
function mdToHtml(src) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+?)`/g, "<code>$1</code>");
  const lines = String(src).replace(/\r/g, "").split("\n");
  let html = "";
  let list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    let m;
    if ((m = line.match(/^[-*•]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; continue; }
    close();
    html += `<p>${inline(line)}</p>`;
  }
  close();
  return html;
}

function addMessage(role, text, opts = {}) {
  const { persist = true } = opts;

  const el = document.createElement("div");
  el.className = `msg msg--${role}`;
  if (role === "bot") el.innerHTML = mdToHtml(text); // render Markdown tidily
  else el.textContent = text;
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
  dataStatus.textContent = active ? t("data_some", { n: store.messages.length }) : t("data_none");
  dataStatus.classList.toggle("is-active", active);
}

/* --- Greeting -------------------------------------------------------------- */

// Context-appropriate starter ("umpan") questions shown at the opening.
const SUGGESTION_KEYS = [
  ["sug_takeover_l", "sug_takeover_q"],
  ["sug_income_l", "sug_income_q"],
  ["sug_install_l", "sug_install_q"],
  ["sug_cashback_l", "sug_cashback_q"],
  ["sug_docs_l", "sug_docs_q"],
  ["sug_process_l", "sug_process_q"],
];

function addSuggestions() {
  const row = document.createElement("div");
  row.className = "chips";
  for (const [labelKey, qKey] of SUGGESTION_KEYS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = t(labelKey);
    btn.addEventListener("click", () => {
      const q = t(qKey);
      row.remove();
      addMessage("user", q);
      handleKbMessage(q).catch((e) => console.error("[Moggy] suggestion failed:", e));
    });
    row.appendChild(btn);
  }
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function greet() {
  addMessage("bot", t("greeting"), { persist: false });
  addSuggestions();
}

/* --- Composer handling ----------------------------------------------------- */

/** Render an answer object (body + disclaimer) as one bot bubble. */
function renderAnswer(res) {
  const body = res.disclaimer ? `${res.text}\n\n— ${res.disclaimer}` : res.text;
  addMessage("bot", body);
}

/* --- Prescreen flow -------------------------------------------------------- */

/** Render chips whose visible label may differ from the recorded value. */
function addChoiceChips(labels, values, onPick) {
  const row = document.createElement("div");
  row.className = "chips";
  labels.forEach((label, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      row.remove();
      addMessage("user", label);
      onPick(values[i]);
    });
    row.appendChild(btn);
  });
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/** Localised display for a question (text + choice option labels). */
function localizedQuestion(q) {
  const en = getLang() === "en";
  const text = en && q.text_en ? q.text_en : q.text;
  const options = en && q.options_en && q.options_en.length === (q.options || []).length ? q.options_en : q.options;
  return { text, options };
}

/** Begin choosing/starting a prescreen. If the set is known, jump straight in. */
async function offerPrescreen(setId) {
  try {
    await loadPrescreen();
  } catch (err) {
    console.error("[Moggy] prescreen load failed:", err);
    addMessage("bot", t("prescreen_load_fail"));
    return;
  }
  if (setId) {
    startPrescreen(setId);
    return;
  }
  flow.mode = "choose_set";
  addMessage("bot", t("choose_situation"));
  addChoiceChips(
    [t("set_primary"), t("set_secondary"), t("set_take_over")],
    ["primary", "secondary", "take_over"],
    (picked) => startPrescreen(picked)
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

  const prefix = t("q_prefix", { n: Object.keys(session.answers).length + 1 });
  const loc = localizedQuestion(q);
  if (q.type === "choice") {
    addMessage("bot", prefix + loc.text);
    addChoiceChips(loc.options, q.options, submitPrescreenAnswer);
  } else {
    const hint = q.type === "number" ? t("num_hint") : "";
    addMessage("bot", prefix + loc.text + hint);
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
    if (q.type === "choice") addChoiceChips(localizedQuestion(q).options, q.options, submitPrescreenAnswer);
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
  const { text } = buildTranscript(session, nowWIB());
  store.files.fileA = new Blob([text], { type: "text/plain;charset=utf-8" });
  updateDataStatus();

  addMessage("bot", t("finish_prescreen", { label: session.label }));

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

const SIM_RE = /simulasi|angsuran|cicilan|installment|simulat|hitung.*(bunga|angsuran|cashback)|calculat.*(installment|payment)|estimasi.*angsuran/i;
const RATE_RE = /\bbunga\b|suku bunga|floating|berjenjang|\brate\b|tingkat suku|fix \d|interest rate/i;

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
        const yr = t("rate_year");
        const lbl = m ? (m[2] ? `${yr} ${m[1]}-${m[2]}` : `${yr} ${m[1]}`) : k;
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
  [t("rate_h_jenis"), t("rate_h_fix"), t("rate_h_float"), t("rate_h_tenor")].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });
  table.appendChild(head);

  for (const [jenis, list] of [[t("rate_jenis_primary"), io.primary || []], [t("rate_jenis_secondary"), io.secondary || []]]) {
    list.forEach((s, idx) => {
      const tr = document.createElement("tr");
      if (idx === 0) {
        const td = document.createElement("td");
        td.textContent = jenis;
        td.rowSpan = list.length;
        td.className = "rate-jenis";
        tr.appendChild(td);
      }
      [fixText(s), s.floating_after || "-", `${s.min_tenor_years || "-"} ${t("rate_tenor_unit")}`].forEach((val) => {
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
    lines.push(t("rate_flexi", { pct: pid(flexi.interest.current_estimate_percent) }));
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
    addMessage("bot", t("sim_nudge"));
    const panel = document.getElementById("simPanel");
    if (panel) { panel.open = true; panel.scrollIntoView({ behavior: "smooth", block: "center" }); }
    showPromoLinksIfRelevant(text);
    addContinuationChips();
    return;
  }

  const kb = await loadKnowledgeBase();
  const classification = classifyIntent(text);

  // Rate questions render a neat deterministic table (more reliable than an LLM).
  if (RATE_RE.test(text) || classification.faqIntent === "suku_bunga") {
    store.intent = classification.intent;
    addMessage("bot", t("rate_intro"));
    renderRateTable(kb);
    showPromoLinksIfRelevant(text);
    addContinuationChips();
    return;
  }
  // "Apa itu KPR FLX?" -> deterministic explainer (generic product info from the
  // knowledge base). Product-summary PDFs were removed; the explainer stands alone.
  if (FLEXI_RE.test(text) && !RATE_RE.test(text)) {
    addMessage("bot", t("flexi_explain"));
    showPromoLinksIfRelevant(text);
    addContinuationChips();
    return;
  }

  const detRes = answer(kb, classification, TODAY_ISO); // deterministic: product routing + fallback

  store.intent = classification.intent;
  if (detRes.product) store.product = detRes.product;

  // Ready to apply -> go straight to the prescreen (deterministic, reliable).
  if (classification.intent === INTENTS.READY_TO_APPLY) {
    renderAnswer(detRes);
    showPromoLinksIfRelevant(text);
    await offerPrescreen(productToSet(detRes.product));
    return;
  }

  // Otherwise answer with the LLM (streamed), falling back to the KB answer.
  const bubble = addStreamingBubble();
  let full = "";
  try {
    full = await streamLlm(text, recentHistory(), (partial) => {
      full = partial;
      bubble.innerHTML = mdToHtml(partial);
      chatLog.scrollTop = chatLog.scrollHeight;
    }, getLang());
  } catch (err) {
    console.warn("[Moggy] LLM stream failed:", err.message);
  }
  if (full.trim()) {
    bubble.innerHTML = mdToHtml(full);
    store.messages.push({ role: "bot", text: full, ts: Date.now() });
    updateDataStatus();
  } else {
    bubble.remove();
    renderAnswer(detRes);
  }
  showPromoLinksIfRelevant(text);
  showDocChecklistIfRelevant(text);
  addContinuationChips();
}

/* --- Document requirements checklist PDF ----------------------------------- */
const DOC_CHECKLIST = {
  file: "docs/checklist/checklist-dokumen-kpr.pdf",
  labelId: "Checklist Dokumen Persyaratan KPR (PDF)",
  labelEn: "KPR Document Requirements Checklist (PDF)",
  download: true,
};
const DOC_TRIGGER = /dokumen|persyaratan|syarat|berkas|kelengkapan|checklist|document|requirement|apa saja yang (?:harus|perlu) disiapkan/i;

function showDocChecklistIfRelevant(userText) {
  if (!DOC_TRIGGER.test(String(userText || ""))) return;
  const en = getLang() === "en";
  renderDocLinks(
    en ? "Download the document checklist (PDF):" : "Unduh checklist dokumen persyaratan (PDF):",
    [DOC_CHECKLIST]
  );
}

/* --- Promo / program PDF links --------------------------------------------- */
// When a customer asks about a promo/program, surface the official T&C PDF(s).
// Bump DOC_VERSION whenever a bundled PDF is replaced, to bust browser/CDN cache.
const DOC_VERSION = "20260624";
const PROMO_DOCS = [
  {
    id: "take_over",
    file: "docs/promo/take-over-cashback.pdf",
    labelId: "Cashback TO — Syarat & Ketentuan",
    labelEn: "TO Cashback — Terms & Conditions",
    re: /take[\s-]*over|takeover|pindah(?:an)?\s*(?:kpr|bank|kredit)|alih\s*kredit/i,
  },
  {
    id: "primary",
    file: "docs/promo/primary-cashback.pdf",
    labelId: "Cashback PRI — Syarat & Ketentuan",
    labelEn: "PRI Cashback — Terms & Conditions",
    re: /primary|primer|developer|rumah\s*baru/i,
  },
  {
    id: "appraisal",
    file: "docs/promo/free-appraisal.pdf",
    labelId: "Gratis Biaya Appraisal — Syarat & Ketentuan",
    labelEn: "Free Appraisal Fee — Terms & Conditions",
    re: /appraisal|apprais|penilaian|taksasi/i,
  },
];
const PROMO_TRIGGER = /promo|program|cashback|cash\s*back|diskon|gratis|free|appraisal|hadiah|bonus|reward/i;

function showPromoLinksIfRelevant(userText) {
  const text = String(userText || "");
  if (!PROMO_TRIGGER.test(text)) return;
  let matches = PROMO_DOCS.filter((p) => p.re.test(text));
  if (!matches.length) matches = PROMO_DOCS; // generic "promo/program" -> show all
  renderPromoLinks(matches);
}

function renderPromoLinks(items) {
  const en = getLang() === "en";
  renderDocLinks(
    en ? "Official program terms & conditions (PDF):" : "Syarat & ketentuan resmi program (PDF):",
    items
  );
}

/** Render a bot bubble with an intro line and a list of PDF links. */
function renderDocLinks(introText, items) {
  const en = getLang() === "en";
  const el = document.createElement("div");
  el.className = "msg msg--bot promo-links";
  const intro = document.createElement("p");
  intro.className = "promo-links__intro";
  intro.textContent = introText;
  el.appendChild(intro);
  for (const p of items) {
    const a = document.createElement("a");
    a.className = "promo-links__item";
    a.href = p.file + "?v=" + DOC_VERSION; // cache-bust so updated PDFs are fetched fresh
    if (p.download) {
      a.download = p.file.split("/").pop(); // force download instead of navigating
    } else {
      a.target = "_blank";
      a.rel = "noopener";
    }
    a.textContent = "📄 " + (en ? p.labelEn : p.labelId);
    el.appendChild(a);
  }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* --- KPR FLX explainer (generic product info from the knowledge base) ------- */
const FLEXI_RE = /kpr\s*flexi|flexi/i;


/** An empty bot bubble showing "typing…" dots, to be filled as the reply streams. */
function addStreamingBubble() {
  const el = document.createElement("div");
  el.className = "msg msg--bot";
  el.innerHTML = '<span class="typing"><span class="typing__dot"></span><span class="typing__dot"></span><span class="typing__dot"></span></span>';
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

/** After an answer, offer to start the application or keep asking. */
function addContinuationChips() {
  const yes = t("cont_yes");
  addChips([yes, t("cont_no")], (label) => {
    if (label === yes) {
      offerPrescreen(productToSet(store.product));
    } else {
      addMessage("bot", t("cont_no_reply"));
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
      addMessage("bot", t("pick_option"));
    } else {
      await handleKbMessage(text);
    }
  } catch (err) {
    console.error("[Moggy] message handling failed:", err);
    addMessage("bot", t("data_load_fail"));
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

  addMessage("system", had ? t("cleared_all") : t("nothing_clear"), { persist: false });
  // Re-greet so the app is immediately usable again.
  greet();
});

/* --- eKTP upload: read the NIK (OCR), verify, then send -------------------- */

const MAX_EKTP_BYTES = 3 * 1024 * 1024; // 3 MB
let ektpDataset = null;

const ektp = {};
function cacheEktpEls() {
  const $ = (id) => document.getElementById(id);
  Object.assign(ektp, {
    section: $("ektpSection"),
    consent: $("ektpConsent"), file: $("ektpFile"), hint: $("ektpHint"),
    status: $("ektpStatus"), preview: $("ektpPreview"), send: $("ektpSend"),
    nikWrap: $("ektpNikWrap"), nik: $("ektpNik"), nikStatus: $("ektpNikStatus"),
  });
}

function resetEktpUi() {
  if (!ektp.consent) return;
  ektp.consent.checked = false;
  ektp.file.value = "";
  ektp.file.disabled = true;
  ektp.nik.disabled = false;
  ektp.hint.textContent = t("ektp_hint_off");
  ektp.status.textContent = "";
  ektp.preview.hidden = true;
  ektp.preview.removeAttribute("src");
  ektp.send.disabled = true;
  ektp.nikWrap.hidden = true;
  ektp.nik.value = "";
  ektp.nikStatus.textContent = "";
  if (ektp.section) ektp.section.hidden = true;
}

function setupEktp() {
  cacheEktpEls();
  if (!ektp.consent) return;

  ektp.consent.addEventListener("change", () => {
    const ok = ektp.consent.checked;
    ektp.file.disabled = !ok;
    if (!ok) ektp.send.disabled = true;
    ektp.hint.textContent = ok ? t("ektp_hint_on") : t("ektp_hint_off");
  });

  // Pick a file -> OCR the NIK only; show it for verification. Send stays
  // disabled until the NIK is valid.
  ektp.file.addEventListener("change", async () => {
    const file = ektp.file.files && ektp.file.files[0];
    if (!file) return;
    ektp.preview.src = trackedObjectURL(file);
    ektp.preview.hidden = false;
    ektp.send.disabled = true;
    ektp.nikWrap.hidden = true;

    if (file.size > MAX_EKTP_BYTES) {
      ektp.status.textContent = t("ektp_too_big", { mb: (file.size / (1024 * 1024)).toFixed(1) });
      return;
    }
    store.ektp = store.ektp || {};
    store.ektp.image = file;
    updateDataStatus();

    ektp.status.textContent = t("ektp_reading");
    ektp.nikWrap.hidden = false;
    try {
      // Read the NIK first so it appears fast; never block it on the pas foto.
      let nik = "";
      let geminiBox = null;
      store.ektp.pasfoto = null;
      try {
        const g = await geminiOcr(file);
        nik = (g.fields && g.fields.nik) || "";
        geminiBox = g.photo_box || null;
        store.ektp.fields = (g && g.fields) || {}; // keep all eKTP text fields
      } catch (errAi) {
        console.warn("[Moggy] Gemini OCR unavailable, using on-device OCR:", errAi);
        const { fields, photo } = await runOcr(file, (m) => {
          ektp.status.textContent = t("ektp_read_progress", { status: m.status, pct: Math.round((m.progress || 0) * 100) });
        });
        nik = fields.nik || "";
        store.ektp.fields = fields || {};
        store.ektp.pasfoto = photo || null;
      }
      ektp.nik.value = nik;
      ektp.status.textContent = nik ? t("ektp_read_ok") : t("ektp_read_manual");
      validateNikField();

      // Crop the pas foto in the BACKGROUND — must never stall the NIK read.
      cropFacePhoto(file).then(async (p) => {
        if (p) { store.ektp.pasfoto = p; return; }
        if (!store.ektp.pasfoto && geminiBox) {
          try { store.ektp.pasfoto = await cropByBox(file, geminiBox); } catch { /* best effort */ }
        }
      }).catch(() => {});
    } catch (err) {
      console.error("[Moggy] NIK OCR failed:", err);
      ektp.nik.value = "";
      ektp.status.textContent = t("ektp_ocr_fail");
      validateNikField();
    }
  });

  ektp.nik.addEventListener("input", validateNikField);
  ektp.send.addEventListener("click", () => { submitEktp().catch((e) => console.error(e)); });
}

/** Read & tidy the NIK field; enable Kirim once it has 16 digits. No structural
 *  verdict is shown to the customer — validation happens behind the scenes on send. */
function validateNikField() {
  const nik = (ektp.nik.value || "").replace(/\D/g, "").slice(0, 16);
  if (ektp.nik.value !== nik) ektp.nik.value = nik;
  store.ektp = store.ektp || {};
  store.ektp.nik = nik;
  ektp.nikStatus.textContent = nik.length === 16 ? t("nik_ready") : t("nik_count", { n: nik.length });
  ektp.nikStatus.className = "ektp__nikstatus";
  ektp.send.disabled = nik.length !== 16;
}

/** Build the chat conversation log text from the in-memory messages. */
function buildChatLogText() {
  const L = ["Moggy — Log Chat", "=".repeat(40), `Tanggal: ${nowWIB()}`, ""];
  for (const m of store.messages) {
    L.push(`[${m.role === "user" ? "Nasabah" : "Moggy"}] ${m.text}`);
  }
  return L.join("\n");
}
function buildChatLogBlob() {
  return new Blob([buildChatLogText()], { type: "text/plain;charset=utf-8" });
}

/**
 * After the NIK is verified, build the NIK structure report and forward the
 * package (prescreen + eKTP image + report + chat log) to the backend.
 */
async function submitEktp() {
  const file = ektp.file.files && ektp.file.files[0];
  if (!file || ektp.send.disabled) return;
  if (!store.files.fileA) {
    ektp.status.textContent = t("ektp_need_prescreen");
    return;
  }
  // Hard PDP gate: explicit, freely-given consent is mandatory and must be the
  // customer's own action (the checkbox is never pre-ticked).
  if (!ektp.consent || !ektp.consent.checked) {
    ektp.status.textContent = t("ektp_need_consent");
    ektp.send.disabled = true;
    return;
  }
  const consentAt = new Date().toISOString();
  ektp.send.disabled = true;
  ektp.file.disabled = true;
  ektp.nik.disabled = true;

  try {
    // Validate the NIK behind the scenes (not shown to the customer).
    let dataset = { provinsi: {}, kabupaten_kota: {}, kecamatan: {} };
    try { ektpDataset = ektpDataset || (await loadRegionData()); dataset = ektpDataset; } catch { /* allow */ }
    const verdict = validateNik(store.ektp.nik || "", {}, dataset);
    store.ektp.verdict = verdict;

    ektp.status.textContent = t("ektp_building");
    const { blob: reportBlob } = buildNikReportPdf(verdict, { timestamp: nowWIB(), printed: {} });
    store.files.fileC = reportBlob;

    ektp.status.textContent = t("ektp_forwarding");
    const session = flow.session || store.prescreen;
    // Privacy: do NOT upload the full eKTP scan. Send the extracted eKTP text
    // fields instead. The pas foto (cropped face) is kept for identification.
    const ektpFields = Object.assign({}, store.ektp.fields || {}, { nik: store.ektp.nik || (store.ektp.fields && store.ektp.fields.nik) || "" });
    const result = await submitLead({
      prescreen: store.files.fileA,
      report: reportBlob,
      chatlog: buildChatLogBlob(),
      ektpData: JSON.stringify(ektpFields),
      pasfoto: store.ektp.pasfoto || null,
      meta: {
        // Fall back to the prescreen set's product_id so jenis_kpr is never blank.
        product: store.product || (session && session.productId) || "",
        productName: PRODUCT_NAMES[store.product] || store.product || (session && session.label) || "",
        prescreenLabel: session ? session.label : "",
        prescreenStatus: session && session.isComplete() ? "selesai" : "",
        nikVerdict: (verdict && verdict.verdict) || "",
        answers: JSON.stringify(collectAnswers()),
        usedCalculator: !!store.usedCalculator,
        durationMs: Date.now() - SESSION_START,
        sessionStart: SESSION_START_ISO,
        sessionEnd: new Date().toISOString(),
        consentGiven: true,
        consentAt,
        consentDoc: "persetujuan-nasabah.pdf",
        nik: store.ektp.nik || "", // server stores only a masked form in the CMS
      },
    });

    store.ektp.submitted = result.id;
    ektp.status.textContent = t("ektp_done", { ref: result.ref || result.id.slice(0, 8) });
    addMessage(
      "bot",
      t("ektp_done_chat"),
      { persist: false }
    );
  } catch (err) {
    console.error("[Moggy] submit failed:", err);
    ektp.status.textContent = t("ektp_fail");
    ektp.send.disabled = false;
    ektp.file.disabled = false;
    ektp.nik.disabled = false;
  }
}

/* --- Simulation (deterministic installment + cashback) --------------------- */

let simSchemes = [];
let simPopulate = null;

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
  simPopulate = populate;

  el.facility.addEventListener("change", () => { populate().catch(() => {}); });
  el.run.addEventListener("click", () => runSimulation(el).catch((e) => {
    console.error("[Moggy] sim failed:", e);
    el.result.textContent = t("sim_fail");
  }));
  populate().catch(() => { el.result.textContent = t("sim_load_fail"); });
}

function repopulateSimSchemes() { if (simPopulate) simPopulate().catch(() => {}); }

async function runSimulation(el) {
  const kb = await loadKnowledgeBase();
  const facility = el.facility.value;
  const scheme = simSchemes[parseInt(el.scheme.value, 10)];
  const plafon = parseInt(String(el.plafon.value).replace(/[^0-9]/g, ""), 10);
  const tenor = parseInt(el.tenor.value, 10);

  const product = (kb.products || []).find((p) => p.id === FACILITY_TO_PRODUCT[facility]);
  const errs = [];
  if (!plafon) errs.push(t("sim_err_plafon"));
  if (!tenor) errs.push(t("sim_err_tenor"));
  if (plafon && product && (plafon < product.credit_limit.min || plafon > product.credit_limit.max))
    errs.push(t("sim_err_plafon_range", { name: product.name, min: formatRp(product.credit_limit.min), max: formatRp(product.credit_limit.max) }));
  if (tenor && product && (tenor < product.tenor_years.min || tenor > product.tenor_years.max))
    errs.push(t("sim_err_tenor_range", { name: product.name, min: product.tenor_years.min, max: product.tenor_years.max }));
  if (scheme && scheme.minTenor && tenor && tenor < scheme.minTenor)
    errs.push(t("sim_err_scheme_min", { label: scheme.label, n: scheme.minTenor }));
  if (errs.length) { el.result.textContent = errs.join(" "); return; }

  const sched = computeInstallment(plafon, tenor, scheme);
  const provisi = provisiAdmin(plafon);
  const progId = cashbackProgramFor(facility);
  const cb = progId ? computeCashback(kb, plafon, el.segment.value) : null;
  const prog = progId ? (kb.programs || []).find((p) => p.id === progId) : null;

  renderSimulation(el.result, { product, scheme, plafon, tenor, sched, provisi, cb, prog });
  store.usedCalculator = true; // for the admin dashboard
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
  add("", `${formatRp(r.plafon)} · ${r.tenor} ${t("rate_tenor_unit")}`);

  add("sim__h", t("sim_h_install"));
  r.sched.forEach((p, i) => {
    const span = i === 0
      ? (r.sched.length > 1 ? t("sim_phase_first", { m: p.months }) : t("sim_phase_all"))
      : t("sim_phase_next", { m: p.months });
    add("sim__row", t("sim_phase_row", { rate: p.rate, span, amount: formatRp(p.installment) }));
  });
  add("sim__note", t("sim_provisi", { amount: formatRp(r.provisi) }));

  if (r.cb) {
    add("sim__h", t("sim_cashback_h"));
    add("sim__row", t("sim_cashback_row", { cat: r.cb.category, amount: formatRp(r.cb.received) }));
    add("sim__note", t("sim_cashback_detail", { gross: formatRp(r.cb.gross), cap: formatRp(r.cb.cap), capped: formatRp(r.cb.capped), pph: formatRp(r.cb.pph) }));
    add("sim__note", t("sim_ssut"));
    if (r.prog && r.prog.program_period && TODAY_ISO > r.prog.program_period.end) {
      add("sim__warn", t("sim_program_ended", { name: r.prog.name, end: r.prog.program_period.end }));
    }
  } else if (r.prog != null) {
    add("sim__note", t("sim_cashback_low"));
  }

  const disc = document.createElement("div");
  disc.className = "sim__disc";
  disc.textContent = t("sim_disc");
  container.appendChild(disc);

  // CTA: a fuller, personalised schedule comes from applying (starts the chat
  // interview flow).
  const cta = document.createElement("div");
  cta.className = "sim__cta";
  const ctaText = document.createElement("p");
  ctaText.className = "sim__cta-text";
  ctaText.textContent = t("sim_cta_text");
  const ctaBtn = document.createElement("button");
  ctaBtn.type = "button";
  ctaBtn.className = "btn btn--primary";
  ctaBtn.textContent = t("sim_cta_btn");
  ctaBtn.addEventListener("click", () => startApplyFlow());
  cta.append(ctaText, ctaBtn);
  container.appendChild(cta);
}

/** Begin the application interview from anywhere (header CTA or sim CTA). */
function startApplyFlow() {
  addMessage("user", t("apply_user_msg"));
  const simPanel = document.getElementById("simPanel");
  if (simPanel) simPanel.open = false;
  document.getElementById("chatLog").scrollIntoView({ behavior: "smooth", block: "end" });
  offerPrescreen(productToSet(store.product)).catch((e) => console.error(e));
}

function cashbackProgramForLabel(r) {
  return r.prog != null; // program exists but plafon too low -> cb null
}

/* --- Session logging (every conversation, even if not submitted) ----------- */

const SESSION_ID = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
const SESSION_START = Date.now();
const SESSION_START_ISO = new Date(SESSION_START).toISOString();

/** Flatten the prescreen answers to {id: value} for the columnar admin recap. */
function collectAnswers() {
  const session = flow.session || store.prescreen;
  const out = {};
  if (session && session.answers) {
    for (const [id, a] of Object.entries(session.answers)) out[id] = a && a.value != null ? a.value : "";
  }
  return out;
}

/** Send the chat session to the admin log (best-effort, via sendBeacon). */
function sendSessionLog() {
  // Submitted sessions are already stored as full leads; skip those.
  if (store.ektp && store.ektp.submitted) return;
  if (!store.messages.length) return;
  const session = flow.session || store.prescreen;
  const payload = {
    sessionId: SESSION_ID,
    chatlog: buildChatLogText(),
    product: store.product || "",
    productName: PRODUCT_NAMES[store.product] || store.product || "",
    prescreenLabel: session ? session.label : "",
    prescreenStatus: session ? (session.isComplete() ? "selesai" : "belum selesai") : "",
    nikVerdict: (store.ektp && store.ektp.verdict && store.ektp.verdict.verdict) || "",
    answers: collectAnswers(),
    usedCalculator: !!store.usedCalculator,
    durationMs: Date.now() - SESSION_START,
    sessionStart: SESSION_START_ISO,
    sessionEnd: new Date().toISOString(),
  };
  try {
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    navigator.sendBeacon("/api/session", blob);
  } catch (e) {
    /* best-effort */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") sendSessionLog();
});

/* --- Boot ------------------------------------------------------------------ */

function init() {
  cspSelfCheck();
  assertNoPersistentStorage();
  applyStatic();
  updateDataStatus();
  greet();
  setupEktp();
  setupSimulation();
  const applyBtn = document.getElementById("applyNowBtn");
  if (applyBtn) {
    applyBtn.addEventListener("click", () => startApplyFlow());
  }
  const langBtn = document.getElementById("langToggle");
  if (langBtn) {
    langBtn.addEventListener("click", () => {
      setLang(getLang() === "en" ? "id" : "en");
      applyStatic();
      updateDataStatus();
      repopulateSimSchemes();
    });
  }
  composerInput.focus();
}

init();
