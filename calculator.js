/* ============================================================================
   calculator.js — standalone Installment & Cashback simulator (calculator.html)
   Reuses the deterministic calculator + knowledge base. Every figure is a
   simulation and non-binding; a PDF with that disclaimer can be downloaded.
   ============================================================================ */

import { t, getLang, setLang, applyStatic } from "./modules/i18n.js";
import {
  schemesForFacility, computeInstallment, computeCashback,
  cashbackProgramFor, provisiAdmin, formatRp,
} from "./modules/calculator.js";

const FACILITY_TO_PRODUCT = {
  primary: "kpr_flexi_primary",
  secondary: "kpr_secondary",
  take_over: "kpr_take_over",
};
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const $ = (id) => document.getElementById(id);

let kb = null;
let simSchemes = [];
let lastResult = null; // for the PDF

async function loadKb() {
  if (!kb) {
    const res = await fetch("data/knowledge_base.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    kb = await res.json();
  }
  return kb;
}

async function populate() {
  await loadKb();
  const el = $("simFacility");
  simSchemes = schemesForFacility(kb, el.value);
  const sel = $("simScheme");
  sel.textContent = "";
  simSchemes.forEach((s, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = s.label;
    sel.appendChild(o);
  });
}

function run() {
  const facility = $("simFacility").value;
  const scheme = simSchemes[parseInt($("simScheme").value, 10)];
  const plafon = parseInt(String($("simPlafon").value).replace(/[^0-9]/g, ""), 10);
  const tenor = parseInt($("simTenor").value, 10);
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
  if (errs.length) { $("simResult").textContent = errs.join(" "); $("pdfBtn").hidden = true; lastResult = null; return; }

  const sched = computeInstallment(plafon, tenor, scheme);
  const provisi = provisiAdmin(plafon);
  const progId = cashbackProgramFor(facility);
  const cb = progId ? computeCashback(kb, plafon, $("simSegment").value) : null;
  const prog = progId ? (kb.programs || []).find((p) => p.id === progId) : null;

  lastResult = { product, scheme, plafon, tenor, sched, provisi, cb, prog };
  renderResult($("simResult"), lastResult);
  $("pdfBtn").hidden = false;
}

function renderResult(container, r) {
  container.textContent = "";
  const add = (cls, text) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    container.appendChild(d);
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
    if (r.prog && r.prog.program_period && TODAY_ISO > r.prog.program_period.end)
      add("sim__warn", t("sim_program_ended", { name: r.prog.name, end: r.prog.program_period.end }));
  } else if (r.prog != null) {
    add("sim__note", t("sim_cashback_low"));
  }
  const disc = document.createElement("div");
  disc.className = "sim__disc";
  disc.textContent = t("sim_disc");
  container.appendChild(disc);
}

/* --- PDF download ---------------------------------------------------------- */
function downloadPdf() {
  if (!lastResult || !(window.jspdf && window.jspdf.jsPDF)) return;
  const r = lastResult;
  const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
  const M = 48;
  let y = 56;
  const W = doc.internal.pageSize.getWidth();
  const line = (txt, opts = {}) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.size || 11);
    doc.setTextColor(opts.color || "#1d2733");
    const wrapped = doc.splitTextToSize(txt, W - M * 2);
    doc.text(wrapped, M, y);
    y += wrapped.length * (opts.lh || 15) + (opts.after || 0);
  };

  doc.setFillColor("#0b4ea2");
  doc.rect(0, 0, W, 8, "F");
  line("Morby Ver1.0 — the Bank Mortgage Buddy", { bold: true, size: 15, color: "#0b4ea2", after: 2 });
  line(t("calc_pdf_title"), { bold: true, size: 13, after: 8 });
  line(`${r.product ? r.product.name : ""} · ${r.scheme.label}`, { bold: true, after: 2 });
  line(`${t("sim_plafon")}: ${formatRp(r.plafon)} · ${t("sim_tenor")}: ${r.tenor} ${t("rate_tenor_unit")}`, { after: 10 });

  line(t("sim_h_install"), { bold: true, size: 12, after: 4 });
  r.sched.forEach((p, i) => {
    const span = i === 0
      ? (r.sched.length > 1 ? t("sim_phase_first", { m: p.months }) : t("sim_phase_all"))
      : t("sim_phase_next", { m: p.months });
    line("• " + t("sim_phase_row", { rate: p.rate, span, amount: formatRp(p.installment) }));
  });
  line(t("sim_provisi", { amount: formatRp(r.provisi) }), { size: 10, color: "#5a6573", after: 8 });

  if (r.cb) {
    line(t("sim_cashback_h"), { bold: true, size: 12, after: 4 });
    line("• " + t("sim_cashback_row", { cat: r.cb.category, amount: formatRp(r.cb.received) }));
    line(t("sim_cashback_detail", { gross: formatRp(r.cb.gross), cap: formatRp(r.cb.cap), capped: formatRp(r.cb.capped), pph: formatRp(r.cb.pph) }), { size: 10, color: "#5a6573", after: 8 });
  }

  y += 8;
  doc.setDrawColor("#e8c98a"); doc.setFillColor("#fff8e6");
  const discTxt = doc.splitTextToSize(t("calc_pdf_disclaimer"), W - M * 2 - 16);
  const boxH = discTxt.length * 13 + 18;
  doc.rect(M, y, W - M * 2, boxH, "FD");
  doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor("#9a6700");
  doc.text(discTxt, M + 8, y + 15);
  y += boxH + 16;

  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor("#8a94a3");
  doc.text(`${t("calc_pdf_generated")}: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`, M, y);

  doc.save(`Morby_simulasi_${r.product ? r.product.id : "kpr"}.pdf`);
}

/* --- Wire up --------------------------------------------------------------- */
function refreshLang() {
  applyStatic(document);
  $("langToggle").textContent = getLang() === "en" ? "ID" : "EN";
}

$("simFacility").addEventListener("change", () => { populate().catch(() => {}); $("pdfBtn").hidden = true; });
$("simRun").addEventListener("click", () => {
  try { run(); } catch (e) { console.error(e); $("simResult").textContent = t("sim_fail"); }
});
$("pdfBtn").addEventListener("click", downloadPdf);
$("langToggle").addEventListener("click", () => {
  setLang(getLang() === "en" ? "id" : "en");
  refreshLang();
  populate().catch(() => {});
});

refreshLang();
populate().catch(() => { $("simResult").textContent = t("sim_load_fail"); });
