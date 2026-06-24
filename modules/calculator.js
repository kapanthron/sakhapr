/* ============================================================================
   modules/calculator.js  —  deterministic KPR simulation
   Monthly installment (annuity, per interest phase) + potential cashback, using
   the formulas and rates from data/knowledge_base.json. No guessing: every rate
   comes from the KB (interest_rate_options + reference_rates.floating_tiers).

   Installment uses the KB annuity formula. For fixed-then-floating schemes the
   installment is re-amortised over the REMAINING tenor at each rate change
   (standard bank practice), matching the KB simulation_example shape.
   ============================================================================ */

/** Annuity monthly payment for principal P at annualPct over n months. */
export function annuity(P, annualPct, nMonths) {
  const i = annualPct / 100 / 12;
  if (nMonths <= 0) return 0;
  if (i === 0) return P / nMonths;
  return (P * (i * Math.pow(1 + i, nMonths))) / (Math.pow(1 + i, nMonths) - 1);
}

/** Outstanding balance after paying `installment` for `months` at annualPct. */
function balanceAfter(P, annualPct, months, installment) {
  const i = annualPct / 100 / 12;
  let bal = P;
  for (let m = 0; m < months; m++) bal = bal * (1 + i) - installment;
  return Math.max(0, bal);
}

/**
 * Walk the interest phases over the total tenor. Each phase re-amortises the
 * remaining balance over the remaining tenor at that phase's rate.
 * @param {number} P principal (plafon)
 * @param {number} totalMonths
 * @param {Array<{rate:number, months:?number}>} phases  last phase months=null -> rest
 * @returns {Array<{rate:number, months:number, installment:number}>}
 */
export function simulateSchedule(P, totalMonths, phases) {
  let bal = P;
  let paid = 0;
  const out = [];
  for (const ph of phases) {
    if (paid >= totalMonths) break;
    const months = ph.months == null ? totalMonths - paid : Math.min(ph.months, totalMonths - paid);
    const inst = annuity(bal, ph.rate, totalMonths - paid);
    out.push({ rate: ph.rate, months, installment: Math.round(inst) });
    bal = balanceAfter(bal, ph.rate, months, inst);
    paid += months;
  }
  return out;
}

/** Resolve a floating tier name (e.g. "Preferred Floating + 0.5%") to a percent. */
function floatingPercent(name, kb) {
  const tiers = (kb.reference_rates && kb.reference_rates.floating_tiers_percent) || {};
  let base = name || "";
  let add = 0;
  const m = base.match(/\+\s*([\d.]+)\s*%/);
  if (m) { add = parseFloat(m[1]); base = base.replace(/\s*\+.*/, "").trim(); }
  const pct = tiers[base];
  return pct != null ? pct + add : null;
}

function parseTiers(obj) {
  const out = [];
  for (const [k, rate] of Object.entries(obj)) {
    const m = k.match(/year_(\d+)(?:_to_(\d+))?/);
    if (!m) continue;
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    out.push({ years: b - a + 1, rate });
  }
  return out;
}

/**
 * The interest schemes available for a facility, drawn from the KB.
 * @returns {Array<object>} scheme descriptors
 */
export function schemesForFacility(kb, facility) {
  const schemes = [];

  // KPR FLX PRI is floating from the start.
  if (facility === "primary") {
    const flexi = (kb.products || []).find((p) => p.id === "kpr_flexi_primary");
    const rate = flexi && flexi.interest && flexi.interest.current_estimate_percent;
    if (rate) {
      schemes.push({ label: `FLX Floating (SRBI + 2.50% ≈ ${rate}%)`, single: true, floatingRate: rate, minTenor: flexi.tenor_years.min });
    }
  }

  const key = facility === "secondary" || facility === "take_over" ? "secondary" : "primary";
  for (const s of (kb.interest_rate_options && kb.interest_rate_options[key]) || []) {
    if (s.tiered_fixed_rate_percent) {
      schemes.push({
        label: s.scheme,
        tiers: parseTiers(s.tiered_fixed_rate_percent),
        floatingRate: floatingPercent(s.floating_after, kb),
        floatingLabel: s.floating_after,
        minTenor: s.min_tenor_years,
      });
    } else {
      const fixedYears = parseInt((s.scheme.match(/Fix\s*(\d+)/) || [])[1] || "0", 10);
      schemes.push({
        label: s.scheme,
        fixedYears,
        fixedRate: s.fixed_rate_percent,
        floatingRate: floatingPercent(s.floating_after, kb),
        floatingLabel: s.floating_after,
        minTenor: s.min_tenor_years,
      });
    }
  }
  return schemes;
}

function buildPhases(scheme) {
  if (scheme.single) return [{ rate: scheme.floatingRate, months: null }];
  if (scheme.tiers) {
    const ph = scheme.tiers.map((t) => ({ rate: t.rate, months: t.years * 12 }));
    if (scheme.floatingRate != null) ph.push({ rate: scheme.floatingRate, months: null });
    return ph;
  }
  const ph = [{ rate: scheme.fixedRate, months: scheme.fixedYears * 12 }];
  if (scheme.floatingRate != null) ph.push({ rate: scheme.floatingRate, months: null });
  return ph;
}

/** Compute the installment schedule for a scheme over a tenor in years. */
export function computeInstallment(plafon, tenorYears, scheme) {
  const totalMonths = Math.round(tenorYears * 12);
  return simulateSchedule(plafon, totalMonths, buildPhases(scheme));
}

/** Provisi & administrasi = 1.1% of plafon. */
export function provisiAdmin(plafon) {
  return Math.round(0.011 * plafon);
}

/** The cashback program id for a facility, or null. */
export function cashbackProgramFor(facility) {
  if (facility === "primary") return "primary_cashback";
  if (facility === "take_over") return "take_over_cashback";
  return null;
}

/**
 * Potential cashback for a plafon + segment, per calculators.cashback.
 * segment: "PV" | "WB" | "" (New to Bank / lainnya -> resolve by plafon)
 */
export function computeCashback(kb, plafon, segment) {
  const caps = (kb.calculators && kb.calculators.cashback && kb.calculators.cashback.category_caps) || { A: 25000000, B: 15000000, C: 7500000 };
  let cat = null;
  if (segment === "PV") cat = "A";
  else if (segment === "WB") cat = "B";
  else if (plafon >= 2500000000) cat = "A";
  else if (plafon >= 1100000000) cat = "B";
  else if (plafon >= 500000000) cat = "C";
  if (!cat) return null;

  const cap = caps[cat];
  const gross = 0.01 * plafon;
  const capped = Math.min(gross, cap);
  const pph = 0.05 * capped;
  return {
    category: cat,
    cap,
    gross: Math.round(gross),
    capped: Math.round(capped),
    pph: Math.round(pph),
    received: Math.round(capped - pph),
  };
}

export function formatRp(n) {
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}
