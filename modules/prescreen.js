/* ============================================================================
   modules/prescreen.js  —  early prescreen interview (produces "file a")
   Loads the three question sets from data/prescreen.json, runs one question at
   a time, honours 'conditional' (skips a question when its dependency is not
   met), keeps answers in memory, and builds a clean .txt transcript.

   This module is pure logic/state: it does NOT touch the DOM. app.js renders
   the questions and option chips and calls back into the session.
   ============================================================================ */

/** Map a routed product id (from Phase 2) to a prescreen set id. */
export function productToSet(productId) {
  switch (productId) {
    case "kpr_flexi_primary": return "primary";
    case "kpr_secondary": return "secondary";
    case "kpr_take_over": return "take_over";
    default: return null;
  }
}

/** A running interview over one question set. */
export class PrescreenSession {
  /**
   * @param {object} data   parsed prescreen.json
   * @param {string} setId  'primary' | 'secondary' | 'take_over'
   */
  constructor(data, setId) {
    this.setId = setId;
    this.set = data.sets[setId];
    this.disclaimer = data?._meta?.disclaimer || "";
    this.questions = (this.set && this.set.questions) || [];
    this.answers = {}; // questionId -> { no, text, value, type, flag_hint }
    this.index = -1;   // before the first question
  }

  /** Resolve a field with optional English override based on getLang(). */
  _loc(base, suffix) {
    let lang = "id";
    try { lang = (window.localStorage.getItem("sakhapr_lang") || "id"); } catch (_) {}
    if (lang === "en" && this.set && this.set[base + suffix]) return this.set[base + suffix];
    return (this.set && this.set[base]) || "";
  }

  get label() { return this._loc("label", "_en") || this.setId; }
  get productId() { return this.set?.product_id || null; }
  get intro() { return this._loc("intro", "_en"); }

  /** Should this question be asked given the answers so far? */
  _shouldAsk(q) {
    if (!q || !q.conditional) return true;
    const dep = this.answers[q.conditional.depends_on];
    return Boolean(dep) && dep.value === q.conditional.equals;
  }

  /** Advance to the next askable question; returns it, or null when finished. */
  next() {
    this.index++;
    while (this.index < this.questions.length && !this._shouldAsk(this.questions[this.index])) {
      this.index++;
    }
    return this.current();
  }

  /** The question currently awaiting an answer, or null. */
  current() {
    if (this.index < 0 || this.index >= this.questions.length) return null;
    return this.questions[this.index];
  }

  /** Record a validated value for the current question. */
  record(value) {
    const q = this.current();
    if (!q) return;
    this.answers[q.id] = {
      no: q.no,
      text: q.text,
      value,
      type: q.type,
      unit: q.unit || null,
      flag_hint: q.flag_hint || null,
    };
  }

  isComplete() {
    return this.index >= this.questions.length;
  }
}

/**
 * Validate a raw answer against a question's type/options.
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
export function validateAnswer(q, raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { ok: false, error: "Mohon isi jawaban terlebih dahulu." };

  if (q.type === "choice") {
    const exact = q.options.find((o) => o.toLowerCase() === s.toLowerCase());
    if (exact) return { ok: true, value: exact };
    const n = parseInt(s, 10); // allow picking by number "1" / "2"
    if (!Number.isNaN(n) && n >= 1 && n <= q.options.length) {
      return { ok: true, value: q.options[n - 1] };
    }
    return { ok: false, error: `Mohon pilih salah satu: ${q.options.join(" / ")}.` };
  }

  if (q.type === "number") {
    const digits = s.replace(/[^0-9]/g, "");
    if (!digits) return { ok: false, error: "Mohon masukkan angka, contoh: 1000000000." };
    return { ok: true, value: digits };
  }

  if (q.type === "email") {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { ok: true, value: s };
    return { ok: false, error: "Mohon masukkan email yang valid, contoh: nama@email.com." };
  }

  if (q.type === "tel") {
    const digits = s.replace(/[^0-9]/g, "");
    if (digits.length >= 9 && digits.length <= 15) return { ok: true, value: s };
    return { ok: false, error: "Mohon masukkan nomor handphone yang valid (9–15 digit)." };
  }

  return { ok: true, value: s }; // free text
}

/** Format a stored answer for display (numbers get Indonesian grouping). */
function formatValue(a) {
  if (a.type === "number" && /^[0-9]+$/.test(a.value)) {
    const n = Number(a.value).toLocaleString("id-ID");
    return a.unit ? `${n} ${a.unit}` : `Rp${n}`;
  }
  return a.value;
}

/**
 * Build "file a": a clean .txt transcript with a header (timestamp, product,
 * disclaimer), the answered Q&A, and the early flag signals for sales.
 * @param {PrescreenSession} session
 * @param {string} timestamp  human-readable local time string
 * @returns {{filename:string, text:string}}
 */
export function buildTranscript(session, timestamp) {
  const L = [];
  L.push("Moggy — Transkrip Prescreen Awal");
  L.push("=".repeat(44));
  L.push(`Tanggal : ${timestamp}`);
  L.push(`Produk  : ${session.label} (${session.productId})`);
  L.push("");
  L.push("Disclaimer:");
  L.push(session.disclaimer);
  L.push("");
  L.push("Pertanyaan & Jawaban");
  L.push("-".repeat(44));

  let idx = 0;
  for (const q of session.questions) {
    const a = session.answers[q.id];
    if (!a) continue; // skipped by a conditional
    idx++;
    L.push(`${idx}. ${q.text}`);
    L.push(`   Jawaban: ${formatValue(a)}`);
  }

  const flags = session.questions
    .map((q) => session.answers[q.id])
    .filter((a) => a && a.flag_hint);
  if (flags.length) {
    L.push("");
    L.push("Sinyal awal untuk tim sales (bukan keputusan kredit)");
    L.push("-".repeat(44));
    for (const a of flags) {
      L.push(`- [${a.flag_hint}] ${a.text} → ${formatValue(a)}`);
    }
  }

  L.push("");
  L.push(
    "Catatan: Interview awal ini hanya triase awal, bukan keputusan kredit. " +
      "Keputusan akhir mengikuti analisa kredit dan Perjanjian Kredit."
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return { filename: `prescreen_${session.setId}_${stamp}.txt`, text: L.join("\n") };
}
