/* ============================================================================
   modules/knowledgeAnswer.js  —  turns a classification into a KB-grounded reply
   Quotes facts from data/knowledge_base.json. Never invents figures. Always
   returns a matching disclaimer for money answers, and warns when a promo's
   program_period.end has passed.

   answer(kb, classification, todayISO) -> {
     text,         // the reply body, in Bahasa Indonesia
     disclaimer,   // the disclaimer line to append (or null)
     product,      // routed product id, when applicable (for later phases)
     program,      // routed program id(s), when applicable
   }
   ============================================================================ */

import { INTENTS } from "./intentRouter.js";

const SITUATION_TO_PRODUCT = {
  primary: "kpr_flexi_primary",
  secondary: "kpr_secondary",
  take_over: "kpr_take_over",
};

const SITUATION_LABEL = {
  primary: "pembelian properti baru di developer kerjasama UOB",
  secondary: "pembelian properti bekas / second",
  take_over: "take over KPR dari bank lain",
};

// Which disclaimer fits which faq topic. Defaults to "general".
const FAQ_DISCLAIMER = {
  suku_bunga: "rate_movement",
  cashback: "estimate_only",
  biaya_kredit: "estimate_only",
  risiko: "approval",
};

// faq topics whose promo period must be checked against today.
const FAQ_PROGRAMS = {
  cashback: ["primary_cashback", "take_over_cashback"],
  appraisal_gratis: ["free_appraisal"],
};

/* --- Small lookups --------------------------------------------------------- */

const findProduct = (kb, id) => (kb.products || []).find((p) => p.id === id) || null;
const findProgram = (kb, id) => (kb.programs || []).find((p) => p.id === id) || null;
const findFaq = (kb, intent) => (kb.faq || []).find((f) => f.intent === intent) || null;
const disclaimerText = (kb, key) => (kb.disclaimers && kb.disclaimers[key]) || kb.disclaimers?.general || null;

/** ISO yyyy-mm-dd string compare is safe for date ordering. */
function promoWarning(kb, programIds, todayISO) {
  for (const id of programIds || []) {
    const prog = findProgram(kb, id);
    const end = prog?.program_period?.end;
    if (end && todayISO > end) {
      return `Catatan: periode program "${prog.name}" tercatat berakhir pada ${end}. Mohon konfirmasi ketersediaannya ke Mortgage Relations Unit.`;
    }
  }
  return null;
}

function supportLine(kb) {
  const s = kb.support || {};
  return `Untuk kepastian, hubungi Mortgage Relations Unit (${s.mortgage_relations_email || "mortgagerelations@uob.co.id"}, ${s.mortgage_relations_unit || ""}) atau UOB Contact Centre ${s.uob_contact_centre || "14008"}.`;
}

/* --- Intent handlers ------------------------------------------------------- */

function routeProduct(kb, cls) {
  const situation = cls.situation;
  if (!situation) {
    return {
      text:
        "Boleh dibantu, propertinya termasuk yang mana: beli baru dari developer, " +
        "properti bekas / second, atau take over KPR dari bank lain?",
      disclaimer: disclaimerText(kb, "general"),
      product: null,
      program: null,
    };
  }

  const productId = SITUATION_TO_PRODUCT[situation];
  const product = findProduct(kb, productId);

  // Pull the eligible program(s) from decision_routing (source of truth).
  const rule = (kb.decision_routing?.which_product || []).find((r) => r.recommend === productId);
  const programIds = rule
    ? [].concat(rule.eligible_program)
    : [].concat(product?.eligible_programs || []);
  const programNames = programIds.map((id) => findProgram(kb, id)?.name).filter(Boolean);

  let text =
    `Untuk ${SITUATION_LABEL[situation]}, produk yang sesuai adalah ${product?.name || productId}. ` +
    `${product?.use_case || ""}`.trim();

  if (programNames.length) {
    text += `\n\nProgram yang bisa dimanfaatkan: ${programNames.join(", ")}.`;
    if (programIds.some((id) => id.includes("cashback"))) {
      text += ` ${kb.decision_routing?.cashback_requires_ssut || ""}`.trimEnd();
    }
  }
  text += `\n\nJika ingin, saya bisa menjalankan prescreen singkat untuk ${product?.name || "produk ini"}.`;

  const warn = promoWarning(kb, programIds, cls._todayISO);
  return {
    text: warn ? `${text}\n\n${warn}` : text,
    disclaimer: disclaimerText(kb, "general"),
    product: productId,
    program: programIds,
  };
}

function readyToApply(kb, cls) {
  const productId = cls.situation ? SITUATION_TO_PRODUCT[cls.situation] : null;
  const product = productId ? findProduct(kb, productId) : null;
  const tail = product
    ? `untuk ${product.name}`
    : "setelah Anda memilih situasi (Primary, Secondary, atau Take Over)";
  return {
    text:
      `Baik, kita bisa mulai prescreen singkat ${tail}. ` +
      `Prescreen ini hanya triase awal untuk tim marketing, bukan keputusan kredit. ` +
      `(Modul prescreen aktif pada tahap berikutnya.)`,
    disclaimer: disclaimerText(kb, "general"),
    product: productId,
    program: null,
  };
}

function smallTalk(kb) {
  return {
    text:
      "Halo! Saya SakhaPR, siap membantu soal KPR UOB. Anda bisa bertanya tentang " +
      "produk, suku bunga, biaya, dokumen, atau langsung menyebut rencana Anda " +
      "(beli rumah baru, second, atau take over).",
    disclaimer: null,
    product: null,
    program: null,
  };
}

function informationAnswer(kb, cls) {
  // "apa itu KPR Take Over" and similar explain questions -> product summary.
  if (cls.productTopic) {
    const product = findProduct(kb, SITUATION_TO_PRODUCT[cls.productTopic]);
    if (product) {
      const interest = product.interest?.formula ? ` Skema bunga: ${product.interest.formula}.` : "";
      return {
        text: `${product.name}: ${product.description}${interest}`,
        disclaimer: disclaimerText(kb, product.interest ? "rate_movement" : "general"),
        product: product.id,
        program: null,
      };
    }
  }

  // General "what promos/programs are available?"
  if (cls.faqIntent === "promo_umum") {
    const progs = kb.programs || [];
    const items = progs.map((p) => {
      const end = p.program_period && p.program_period.end;
      const expired = end && cls._todayISO > end;
      return (
        `• ${p.name}${p.tagline ? ` — ${p.tagline}` : ""}` +
        (end ? ` (berlaku s/d ${end}${expired ? ", mungkin sudah berakhir" : ""})` : "")
      );
    });
    const text = items.length
      ? `Promo/program KPR UOB yang tersedia:\n${items.join("\n")}\n\nIngin detail salah satunya, misalnya cashback atau bebas biaya appraisal?`
      : "Saat ini belum ada program yang tercatat. " + supportLine(kb);
    return { text, disclaimer: disclaimerText(kb, "general"), product: null, program: null };
  }

  // Matched a knowledge_base FAQ.
  if (cls.faqIntent) {
    const faq = findFaq(kb, cls.faqIntent);
    if (faq) {
      const warn = promoWarning(kb, FAQ_PROGRAMS[cls.faqIntent], cls._todayISO);
      const text = warn ? `${faq.answer}\n\n${warn}` : faq.answer;
      const key = FAQ_DISCLAIMER[cls.faqIntent] || "general";
      return { text, disclaimer: disclaimerText(kb, key), product: null, program: null };
    }
  }

  // Nothing matched: be honest and route to a human.
  return {
    text:
      "Maaf, saya belum menemukan jawaban pasti untuk pertanyaan itu di basis " +
      `pengetahuan saya. ${supportLine(kb)}`,
    disclaimer: disclaimerText(kb, "general"),
    product: null,
    program: null,
  };
}

/* --- Entry point ----------------------------------------------------------- */

/**
 * @param {object} kb            parsed knowledge_base.json
 * @param {object} classification  from classifyIntent()
 * @param {string} todayISO       yyyy-mm-dd (for promo expiry checks)
 */
export function answer(kb, classification, todayISO) {
  const cls = { ...classification, _todayISO: todayISO };
  switch (cls.intent) {
    case INTENTS.WHICH_PRODUCT:
      return routeProduct(kb, cls);
    case INTENTS.READY_TO_APPLY:
      return readyToApply(kb, cls);
    case INTENTS.SMALL_TALK:
      return smallTalk(kb);
    case INTENTS.INFORMATION:
    default:
      return informationAnswer(kb, cls);
  }
}
