/* ============================================================================
   modules/intentRouter.js  —  Layer 1 deterministic intent router
   Classifies a Bahasa Indonesia message into one of four intents using a
   keyword + synonym map. No network, no LLM, fully deterministic.

     INFORMATION    a factual question  -> answered from the knowledge base
     WHICH_PRODUCT  buying intent       -> routed via decision_routing
     READY_TO_APPLY wants to apply      -> hands off to the prescreen (Phase 3)
     SMALL_TALK     greeting / thanks   -> a short friendly reply

   It also extracts light "hints" the answerer uses:
     situation     'primary' | 'secondary' | 'take_over' | null
     productTopic  same set, for "apa itu ..." explain questions
     faqIntent     a knowledge_base faq.intent key, when one clearly matches
   ============================================================================ */

export const INTENTS = {
  INFORMATION: "INFORMATION",
  WHICH_PRODUCT: "WHICH_PRODUCT",
  READY_TO_APPLY: "READY_TO_APPLY",
  SMALL_TALK: "SMALL_TALK",
};

/* --- Text helpers ---------------------------------------------------------- */

/** Lowercase, replace punctuation with spaces, collapse whitespace. */
function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const includesAny = (text, terms) => terms.some((t) => text.includes(t));

/* --- Keyword maps ----------------------------------------------------------
   All terms are pre-normalized (lowercase, single-spaced). */

// Explicit "I want to start the application" phrasing.
const APPLY_TERMS = [
  "mau ajukan", "mau mengajukan", "ingin mengajukan", "ajukan kpr", "ajukan sekarang",
  "daftar kpr", "mau daftar", "mendaftar", "mulai pengajuan", "lanjut pengajuan",
  "proses pengajuan", "mau apply", "saya mau apply", "apply kpr", "saya siap ajukan",
  "lanjut ke pengajuan", "saya mau mengajukan",
];

// Buying / "which product fits" intent.
const BUYING_TERMS = [
  "mau beli", "ingin beli", "mau membeli", "rencana beli", "berencana beli",
  "beli rumah", "beli properti", "beli apartemen", "mau take over", "mau takeover",
  "mau pindah kpr", "pindah kpr", "oper kredit", "produk apa yang cocok",
  "produk yang cocok", "produk cocok", "rekomendasi produk", "produk mana",
  "pilih produk", "bingung pilih", "cocok yang mana", "mau kpr",
];

// "Explain this term" triggers -> keep it INFORMATION, not WHICH_PRODUCT.
const EXPLAIN_TRIGGERS = [
  "apa itu", "apa sih", "apakah itu", "jelaskan", "pengertian", "maksud",
  "arti dari", "tentang", "apa bedanya", "bedanya", "beda antara", "perbedaan",
];

// Situation -> product (also used for productTopic in explain questions).
const SITUATION_TERMS = {
  take_over: ["take over", "takeover", "oper kredit", "pindah kpr", "pindah dari bank", "alih kredit", "pindahkan kpr"],
  secondary: ["second", "seken", "bekas", "rumah lama", "properti bekas"],
  primary: ["developer", "rumah baru", "properti baru", "primary", "indent", "pre project", "beli baru", "unit baru"],
};

// knowledge_base faq.intent -> trigger terms.
const FAQ_TERMS = {
  produk_apa_saja: ["produk apa saja", "jenis kpr", "kpr apa saja", "ada apa saja", "macam kpr", "pilihan kpr", "kpr apa aja"],
  syarat_umum: ["syarat", "persyaratan", "kualifikasi", "umur minimal", "usia minimal", "penghasilan minimal", "gaji minimal", "wni", "eligibilitas", "kriteria"],
  dokumen: ["dokumen", "berkas", "lampiran", "slip gaji", "kartu keluarga", "persyaratan dokumen", "berkas yang"],
  biaya_kredit: ["biaya", "provisi", "administrasi", "notaris", "biaya kpr", "biaya apa saja", "ada biaya"],
  appraisal_gratis: ["appraisal", "taksasi", "penilaian agunan", "gratis appraisal", "bebas biaya appraisal", "bebas appraisal"],
  cashback: ["cashback", "cash back", "promo cashback", "dapat cashback", "reward"],
  suku_bunga: ["bunga", "suku bunga", "interest", "rate", "fixed", "floating", "berjenjang", "fix berapa"],
  pelunasan: ["pelunasan", "lunas", "pelunasan dipercepat", "penalti", "pinalti", "early settlement", "percepat"],
  risiko: ["risiko", "resiko", "bahaya", "konsekuensi", "kerugian"],
  tenor: ["tenor", "jangka waktu", "lama cicilan", "berapa tahun", "30 tahun", "20 tahun"],
  cara_pengajuan: ["cara ajukan", "cara pengajuan", "langkah pengajuan", "bagaimana mengajukan", "gimana ajukan", "cara mengajukan"],
  // General "what promos are there" — kept LAST so specific promo terms (cashback,
  // appraisal) win on ties.
  promo_umum: ["promo", "promosi", "penawaran", "ada promo", "program apa", "lagi ada apa", "benefit apa"],
};

const GREET_WORDS = new Set([
  "halo", "hai", "hi", "hello", "helo", "hey", "hei", "pagi", "siang", "sore",
  "malam", "oke", "ok", "sip", "mantap", "makasih", "thanks", "thx", "terimakasih",
]);
const GREET_PHRASES = [
  "terima kasih", "apa kabar", "selamat pagi", "selamat siang", "selamat sore",
  "selamat malam", "selamat datang",
];

/* --- Detection ------------------------------------------------------------- */

function detectSituation(text) {
  for (const [situation, terms] of Object.entries(SITUATION_TERMS)) {
    if (includesAny(text, terms)) return situation;
  }
  return null;
}

/** Highest-scoring faq.intent for this text, or null. */
function detectFaqIntent(text) {
  let best = null;
  let bestScore = 0;
  for (const [intent, terms] of Object.entries(FAQ_TERMS)) {
    const score = terms.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  return best;
}

function isGreeting(text, words) {
  if (GREET_PHRASES.some((p) => text.includes(p))) return true;
  return words.some((w) => GREET_WORDS.has(w));
}

/**
 * Classify a raw message.
 * @param {string} rawMessage
 * @returns {{intent:string, situation:?string, productTopic:?string, faqIntent:?string}}
 */
export function classifyIntent(rawMessage) {
  const text = normalize(rawMessage);
  const words = text.split(" ").filter(Boolean);

  const situation = detectSituation(text);
  const faqIntent = detectFaqIntent(text);
  const isExplain = includesAny(text, EXPLAIN_TRIGGERS);

  // 1) Explicit intent to apply.
  if (includesAny(text, APPLY_TERMS)) {
    return { intent: INTENTS.READY_TO_APPLY, situation, productTopic: null, faqIntent: null };
  }

  // 2) Buying intent (but an "apa itu ..." question stays INFORMATION).
  if (!isExplain && includesAny(text, BUYING_TERMS)) {
    return { intent: INTENTS.WHICH_PRODUCT, situation, productTopic: null, faqIntent: null };
  }

  // 3) Pure greeting / thanks (nothing else to answer).
  if (isGreeting(text, words) && !faqIntent && !situation) {
    return { intent: INTENTS.SMALL_TALK, situation: null, productTopic: null, faqIntent: null };
  }

  // 4) Everything else is an information question.
  const productTopic = isExplain ? situation : null;
  return { intent: INTENTS.INFORMATION, situation, productTopic, faqIntent };
}
