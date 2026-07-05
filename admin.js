/* ============================================================================
   admin.js  —  Super Admin client for Moggy
   Talks to the Worker admin API. Auth is server-checked: the session cookie is
   HttpOnly, so this script never sees the password after login. Download links
   are plain same-origin anchors; the cookie rides along automatically.
   ============================================================================ */

import { runOcr, cropFacePhoto } from "./modules/ocr.js";
import { geminiOcr, cropByBox } from "./modules/geminiOcr.js";
import { validateNik } from "./modules/validateNik.js";
import { loadRegionData } from "./modules/regionData.js";

const $ = (id) => document.getElementById(id);
const loginView = $("loginView");
const leadsView = $("leadsView");
const pariksaView = $("pariksaView");
const adminNav = $("adminNav");
const logoutBtn = $("logoutBtn");

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function showLogin(msg) {
  loginView.hidden = false;
  leadsView.hidden = true;
  pariksaView.hidden = true;
  adminNav.hidden = true;
  logoutBtn.hidden = true;
  if (msg) $("loginStatus").textContent = msg;
}

const cmsView = $("cmsView");
const biView = $("biView");

function showView(view, tabId) {
  loginView.hidden = true;
  leadsView.hidden = true;
  pariksaView.hidden = true;
  if (cmsView) cmsView.hidden = true;
  if (biView) biView.hidden = true;
  view.hidden = false;
  adminNav.hidden = false;
  logoutBtn.hidden = false;
  for (const id of ["tabLeads", "tabCms", "tabBi", "tabPariksa"]) {
    const b = $(id);
    if (b) b.classList.toggle("is-active", id === tabId);
  }
}
function showLeads() { showView(leadsView, "tabLeads"); }
function showPariksa() { showView(pariksaView, "tabPariksa"); }
function showCms() { showView(cmsView, "tabCms"); }
function showBi() { showView(biView, "tabBi"); }

const EMAIL_LABEL = {
  sent: "✓ terkirim",
  failed: "✗ gagal",
  not_configured: "• dicatat (email belum dikonfigurasi)",
  pending: "… tertunda",
};

function fmtTime(ts) {
  return new Date(ts).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}
/** Build a download URL with a unique filename (base_<ref>.ext). */
function fileUrl(prefix, id, name, ref) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const dl = ref ? `${base}_${ref}${ext}` : name;
  return `/api/admin/file?key=${encodeURIComponent(`${prefix}/${id}/${name}`)}&name=${encodeURIComponent(dl)}`;
}

function renderLeads(leads) {
  const list = $("leadsList");
  list.textContent = "";
  if (!leads.length) {
    $("leadsStatus").textContent = "Belum ada data tersimpan.";
    return;
  }
  const nLead = leads.filter((l) => l.type !== "session").length;
  const nSess = leads.length - nLead;
  $("leadsStatus").textContent = `${nLead} lead dikirim · ${nSess} sesi chat (tidak dikirim).`;

  for (const lead of leads) {
    const isSession = lead.type === "session";
    const prefix = isSession ? "sessions" : "leads";
    const card = document.createElement("div");
    card.className = "lead-card";

    const email = lead.email || {};
    const emailClass = email.status === "sent" ? "ok" : email.status === "failed" ? "fail" : "warn";

    const head = document.createElement("div");
    head.className = "lead-card__head";
    head.innerHTML =
      `<div><strong>${escapeHtml(lead.productName || lead.product || (isSession ? "Sesi chat" : "(produk?)"))}</strong>` +
      (isSession ? ` <span class="badge">sesi · tidak dikirim</span>` : "") +
      `<span class="lead-card__id mono">Ref: ${escapeHtml(lead.ref || lead.id)}</span></div>` +
      `<div class="lead-card__time mono">${escapeHtml(lead.ts_wib || fmtTime(lead.ts))} WIB</div>`;
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "lead-card__meta";
    let metaHtml =
      `<span>Prescreen: <strong>${escapeHtml(lead.prescreenLabel || "-")} ${escapeHtml(lead.prescreenStatus || "")}</strong></span>` +
      `<span>Verdict NIK: <strong>${escapeHtml(lead.nikVerdict || "-")}</strong></span>`;
    if (!isSession) {
      metaHtml +=
        `<span>Email ke ${escapeHtml(email.to || "-")}: <strong class="status--${emailClass}">${EMAIL_LABEL[email.status] || email.status || "-"}</strong>` +
        (email.error ? ` <span class="lead-card__err">(${escapeHtml(email.error)})</span>` : "") +
        `</span>`;
    }
    meta.innerHTML = metaHtml;
    card.appendChild(meta);

    const files = lead.files || {};
    const dl = document.createElement("div");
    dl.className = "chips";
    for (const [label, name] of [
      ["Prescreen (.txt)", files.prescreen],
      ["Log chat (.txt)", files.chatlog],
      ["eKTP", files.ektp],
      ["Pas foto (.jpg)", files.pasfoto],
      ["Laporan NIK (.pdf)", files.report],
      ["meta.json", "meta.json"],
    ]) {
      if (!name) continue;
      const a = document.createElement("a");
      a.className = "chip";
      a.textContent = label;
      a.href = fileUrl(prefix, lead.id, name, lead.ref);
      const dot = name.lastIndexOf(".");
      a.download = (lead.ref ? `${dot > 0 ? name.slice(0, dot) : name}_${lead.ref}${dot > 0 ? name.slice(dot) : ""}` : name);
      dl.appendChild(a);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chip chip--danger";
    del.textContent = "Hapus";
    del.addEventListener("click", () => deleteRecord(lead.id, card));
    dl.appendChild(del);

    card.appendChild(dl);
    list.appendChild(card);
  }
}

async function deleteRecord(id, card) {
  if (!confirm("Hapus log ini secara permanen?")) return;
  try {
    const r = await fetch("/api/admin/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (r.ok) card.remove();
    else alert("Gagal menghapus.");
  } catch (e) {
    alert("Gagal menghapus: " + e.message);
  }
}

let ALL_LEADS = [];
let DASH_PERIOD = "month";

async function loadLeads() {
  $("leadsStatus").textContent = "Memuat…";
  const res = await fetch("/api/admin/leads", { headers: { Accept: "application/json" } });
  if (res.status === 401) {
    showLogin("Sesi berakhir. Silakan masuk kembali.");
    return;
  }
  const data = await res.json();
  ALL_LEADS = data.leads || [];
  showLeads();
  renderDashboard();
  renderRecapMonths();
  renderLeads(ALL_LEADS);
}

/* --- Overview dashboard + monthly recap ------------------------------------ */

/** WIB date parts for an ISO timestamp. */
function wibParts(iso) {
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
    const g = (t) => (p.find((x) => x.type === t) || {}).value || "";
    const y = g("year"), m = g("month"), d = g("day");
    return { ymd: `${y}-${m}-${d}`, ym: `${y}-${m}`, y };
  } catch { return { ymd: "", ym: "", y: "" }; }
}

function inPeriod(iso, period) {
  if (period === "all") return true;
  const r = wibParts(iso), now = wibParts(new Date().toISOString());
  if (period === "day") return r.ymd === now.ymd;
  if (period === "month") return r.ym === now.ym;
  if (period === "year") return r.y === now.y;
  return true;
}

const VERDICT_BUCKET = { "Consistent": "green", "Consistent with warnings": "amber", "Inconsistent": "red" };

function renderDashboard() {
  const grid = $("dashGrid");
  if (!grid) return;
  const items = ALL_LEADS.filter((m) => inPeriod(m.ts, DASH_PERIOD));
  const leads = items.filter((m) => m.type !== "session");
  const calc = items.filter((m) => m.usedCalculator).length;
  const ktp = items.filter((m) => m.nikVerdict);
  let green = 0, amber = 0, red = 0;
  for (const m of ktp) {
    const b = VERDICT_BUCKET[m.nikVerdict];
    if (b === "green") green++; else if (b === "amber") amber++; else if (b === "red") red++;
  }
  const durs = items.map((m) => m.durationMs || 0).filter((d) => d > 0);
  const totalMin = durs.reduce((a, b) => a + b, 0) / 60000;
  const avgMin = durs.length ? totalMin / durs.length : 0;

  const card = (label, value, sub) =>
    `<div class="dash__card"><div class="dash__value">${value}</div><div class="dash__label">${label}</div>${sub ? `<div class="dash__sub">${sub}</div>` : ""}</div>`;

  grid.innerHTML =
    card("Total sesi", items.length) +
    card("Submit dokumen", leads.length) +
    card("Pakai kalkulator", calc) +
    card("Pengecekan KTP", ktp.length, `🟢 ${green} · 🟡 ${amber} · 🔴 ${red}`) +
    card("Total waktu sesi", `${totalMin.toFixed(0)} mnt`, `rata-rata ${avgMin.toFixed(1)} mnt`);
}

function renderRecapMonths() {
  const box = $("recapMonths");
  if (!box) return;
  const months = [...new Set(ALL_LEADS.map((m) => wibParts(m.ts).ym).filter(Boolean))].sort().reverse();
  if (!months.length) { box.textContent = "Belum ada data."; return; }
  box.innerHTML = months.map((ym) =>
    `<a class="chip" href="/api/admin/recap?month=${encodeURIComponent(ym)}" download>${ym} (.xlsx)</a>`
  ).join("");
}

async function login() {
  const user = $("loginUser").value.trim();
  const pass = $("loginPass").value;
  $("loginStatus").textContent = "Memeriksa…";
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, pass }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // First login: the password must be chosen now (min 8 chars).
    $("loginStatus").textContent = data.error || "ID atau kata sandi salah.";
    return;
  }
  $("loginPass").value = "";
  if (data.firstLogin) {
    $("loginStatus").textContent = "Kata sandi berhasil ditetapkan. Selamat datang.";
  }
  await loadLeads();
}

async function resetPassword() {
  const btn = $("resetBtn");
  btn.disabled = true;
  $("resetStatus").textContent = "Mengirim kata sandi sementara…";
  try {
    const r = await fetch("/api/admin/reset-password", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      $("resetStatus").textContent =
        `Kata sandi sementara sudah dikirim ke ${d.sentTo || "email admin"}. ` +
        `Cek email, login dengan kata sandi itu, lalu ganti di "Ubah kata sandi".`;
    } else {
      $("resetStatus").textContent = d.error || "Gagal reset.";
      btn.disabled = false;
    }
  } catch (e) {
    $("resetStatus").textContent = "Gagal reset: " + e.message;
    btn.disabled = false;
  }
}

/* --- CMS (Phase 1: lead list from D1) -------------------------------------- */

const JENIS_LABEL = { primary: "Primary", second: "Second", take_over: "Take Over" };
const CMS_FILE_LABEL = { chatlog: "Log chat", prescreen_xls: "Prescreen", pariksa_pdf: "Laporan NIK (.pdf)", ektp: "eKTP penuh", pasfoto: "Pas foto (.jpg)" };
const SALES_LABEL = { AS: "AS", HB: "HB", RB: "RB", ER: "ER (eskalasi)" };
function gradeChip(g) {
  if (g === "A+" || g === "A") return "chip--ok";
  if (g === "B") return "chip--warn";
  return "chip--danger";
}

function rupiah(n) { return n ? "Rp" + Number(n).toLocaleString("id-ID") : "-"; }

async function loadCms() {
  $("cmsStatus").textContent = "Memuat…";
  $("cmsList").textContent = "";
  let res;
  try { res = await fetch("/api/admin/cms/leads", { headers: { Accept: "application/json" } }); }
  catch (e) { $("cmsStatus").textContent = "Gagal memuat: " + e.message; return; }
  if (res.status === 401) { showLogin("Sesi berakhir. Silakan masuk kembali."); return; }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    $("cmsStatus").textContent = data.error || "CMS belum tersedia (Cloudflare D1 belum dikonfigurasi).";
    return;
  }
  if (Array.isArray(data.statuses)) CMS_STATUSES = data.statuses;
  renderCmsLeads(data.leads || []);
}

/* --- Phase 7: Dashboard BI (big numbers + monthly chart) ------------------- */
let biSeries = [];
let biMetric = "volume";

async function loadBi() {
  $("biStatus").textContent = "Memuat…";
  let res;
  try { res = await fetch("/api/admin/cms/bi", { headers: { Accept: "application/json" } }); }
  catch (e) { $("biStatus").textContent = "Gagal memuat: " + e.message; return; }
  if (res.status === 401) { showLogin("Sesi berakhir. Silakan masuk kembali."); return; }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    $("biStatus").textContent = data.error || "Dashboard belum tersedia (D1 belum dikonfigurasi).";
    $("biBigNums").textContent = "";
    $("biChart").textContent = "";
    return;
  }
  $("biStatus").textContent = "";
  biSeries = data.series || [];
  renderBigNumbers(data.bigNumbers || {});
  renderBiChart();
}

function bigNumCard(label, value, sub) {
  return `<div class="bi-card"><div class="bi-card__value">${escapeHtml(String(value))}</div>` +
    `<div class="bi-card__label">${escapeHtml(label)}</div>` +
    (sub ? `<div class="bi-card__sub">${escapeHtml(sub)}</div>` : "") + `</div>`;
}

function renderBigNumbers(b) {
  $("biBigNums").innerHTML =
    bigNumCard("Total sesi keseluruhan", b.sesiTotal) +
    bigNumCard("Sesi chatbot", b.sesiChatbot) +
    bigNumCard("Sesi prescreen & submit", b.sesiPrescreen) +
    bigNumCard("YTD jumlah leads", b.ytdLeads) +
    bigNumCard("Jumlah nasabah", b.nasabah, `${b.nasabahPct}% dari lead`) +
    bigNumCard("Total limit pengajuan", rupiah(b.totalLimit)) +
    bigNumCard("Sedang di analis", b.submitAnalis, `${b.submitAnalisPct}% dari lead`) +
    bigNumCard("Approval rate", `${b.approvalRate}%`, `${b.approved} approved / ${b.rejected} rejected`) +
    bigNumCard("Disbursed", b.disbursed, `${b.disbursedPct}% dari lead`);
}

function renderBiChart() {
  const host = $("biChart");
  host.textContent = "";
  if (!biSeries.length) { host.innerHTML = `<p class="ektp__disclaimer">Belum ada data lead.</p>`; return; }
  const vals = biSeries.map((s) => (biMetric === "nasabah" ? s.nasabah : s.volume));
  const max = Math.max(1, ...vals);
  const W = 640, H = 220, padL = 32, padB = 28, padT = 10, padR = 10;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = biSeries.length;
  const bw = Math.max(6, Math.min(48, innerW / n - 10));
  let bars = "";
  biSeries.forEach((s, i) => {
    const v = vals[i];
    const x = padL + (innerW * (i + 0.5)) / n - bw / 2;
    const h = (v / max) * innerH;
    const y = padT + innerH - h;
    bars +=
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="bi-bar"></rect>` +
      `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle" class="bi-bar__val">${v}</text>` +
      `<text x="${(x + bw / 2).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" class="bi-axis">${escapeHtml(s.ym)}</text>`;
  });
  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="bi-svg" role="img" aria-label="Grafik lead per bulan">` +
    `<line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" class="bi-axisline"></line>` +
    bars + `</svg>`;
}

// Phase 5: pipeline statuses (populated from the server response).
let CMS_STATUSES = [];
function statusLabel(key) {
  const s = CMS_STATUSES.find((x) => x.key === key);
  return s ? s.label : (key || "-");
}

function renderCmsLeads(leads) {
  const list = $("cmsList");
  list.textContent = "";
  $("cmsStatus").textContent = `${leads.length} lead di CMS (D1).`;
  for (const l of leads) {
    const card = document.createElement("div");
    card.className = "lead-card";

    const head = document.createElement("div");
    head.className = "lead-card__head";
    head.innerHTML =
      `<div><strong>${escapeHtml(l.nama || "(tanpa nama)")}</strong> ` +
      `<span class="badge">${escapeHtml(JENIS_LABEL[l.jenis_kpr] || l.jenis_kpr || "-")}</span>` +
      (l.is_duplicate ? ` <span class="badge chip--danger">DUPLICATE ×${escapeHtml(String(l.submit_count || 1))}</span>` : "") +
      `<span class="lead-card__id mono">${escapeHtml(l.telepon || "")}${l.email ? " · " + escapeHtml(l.email) : ""}</span></div>` +
      `<div class="lead-card__time mono">${escapeHtml(fmtTime(l.created_at))} WIB</div>`;
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "lead-card__meta";
    meta.innerHTML =
      `<span>Kota: <strong>${escapeHtml(l.kota || "-")}</strong></span>` +
      `<span>Gaji/bln: <strong>${rupiah(l.gaji_bulanan)}</strong></span>` +
      `<span>Plafon: <strong>${rupiah(l.plafon)}</strong></span>` +
      `<span>Tenor: <strong>${l.tenor_tahun != null ? escapeHtml(String(l.tenor_tahun)) + " th" : "-"}</strong></span>` +
      `<span>NIK: <strong class="mono">${escapeHtml(l.nik_masked || "-")}</strong></span>` +
      `<span>Tier lokasi: <strong>${l.tier_lokasi === 1 ? "1" : l.tier_lokasi === 2 ? "2" : "Lain"}</strong></span>` +
      (l.is_duplicate && l.last_submit_at ? `<span>Submit terakhir: <strong>${escapeHtml(fmtTime(l.last_submit_at))}</strong></span>` : "");
    card.appendChild(meta);

    // Phase 3: scoring (grade per dimensi, komposit, grade keseluruhan, sales owner).
    if (l.grade_keseluruhan || l.skor_komposit != null || l.sales_owner) {
      const score = document.createElement("div");
      score.className = "lead-card__meta cms-score";
      score.innerHTML =
        `<span>Grade: <strong class="badge ${gradeChip(l.grade_keseluruhan)}">${escapeHtml(l.grade_keseluruhan || "-")}</strong></span>` +
        `<span>Skor: <strong>${l.skor_komposit != null ? escapeHtml(String(l.skor_komposit)) : "-"}</strong></span>` +
        `<span>Gaji: <strong>${escapeHtml(l.grade_gaji || "-")}</strong></span>` +
        `<span>Plafon: <strong>${escapeHtml(l.grade_plafon || "-")}</strong></span>` +
        `<span>Lokasi: <strong>${escapeHtml(l.grade_lokasi || "-")}</strong></span>` +
        `<span>Sales: <strong>${escapeHtml(SALES_LABEL[l.sales_owner] || l.sales_owner || "-")}</strong></span>`;
      card.appendChild(score);
    }

    // Phase 4: SLA tasks (call + WA) — status + actions.
    const tasks = document.createElement("div");
    tasks.className = "lead-card__meta cms-tasks";
    tasks.innerHTML =
      `<span>Task Call: <strong>${taskState(l.call_due_at, l.call_done_at, l.call_reminder_at)}</strong></span>` +
      `<span>Task WA: <strong>${taskState(l.wa_due_at, l.wa_done_at, l.wa_reminder_at)}</strong></span>`;
    card.appendChild(tasks);

    const taskBtns = document.createElement("div");
    taskBtns.className = "chips cms-task-actions";
    if (!l.call_done_at) {
      taskBtns.appendChild(taskButton("Call selesai", "chip--ok", l.id, "call_done"));
      taskBtns.appendChild(taskButton("Paksa due call (uji)", "", l.id, "force_call_due"));
    }
    if (l.call_done_at && !l.wa_done_at) {
      taskBtns.appendChild(taskButton("WA selesai", "chip--ok", l.id, "wa_done"));
      taskBtns.appendChild(taskButton("Paksa due WA (uji)", "", l.id, "force_wa_due"));
    }
    if (taskBtns.children.length) card.appendChild(taskBtns);

    // Phase 5: pipeline status selector + change history.
    const pipe = document.createElement("div");
    pipe.className = "cms-pipe";
    const lbl = document.createElement("label");
    lbl.className = "cms-pipe__label";
    lbl.textContent = "Status pipeline";
    const sel = document.createElement("select");
    sel.className = "cms-pipe__select";
    for (const s of CMS_STATUSES) {
      const o = document.createElement("option");
      o.value = s.key;
      o.textContent = s.label;
      if (s.key === l.status) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => updateCmsStatus(l.id, sel.value, sel));
    lbl.appendChild(sel);
    pipe.appendChild(lbl);

    const hist = (l.history || []).slice().reverse();
    if (hist.length) {
      const h = document.createElement("ul");
      h.className = "cms-history";
      for (const e of hist) {
        const li = document.createElement("li");
        li.innerHTML =
          `<span class="mono">${escapeHtml(fmtTime(e.changed_at))}</span> — ` +
          `${escapeHtml(statusLabel(e.status_lama) || "(awal)")} → <strong>${escapeHtml(statusLabel(e.status_baru))}</strong>` +
          (e.changed_by ? ` <span class="cms-history__by">oleh ${escapeHtml(e.changed_by)}</span>` : "");
        h.appendChild(li);
      }
      pipe.appendChild(h);
    }
    card.appendChild(pipe);

    // Phase 2: qualification flags (review markers, not auto-reject).
    const flags = [];
    if (l.gaji_bulanan != null && l.gaji_bulanan < 13000000) flags.push("Gaji &lt; Rp13jt");
    if (l.plafon != null && l.plafon < 500000000) flags.push("Plafon &lt; Rp500jt");
    if (l.pernah_restruktur) flags.push("Pernah restruktur");
    if (l.jenis_kpr === "take_over" && !l.to_sertifikat_siap) flags.push("TO: sertifikat belum siap");
    if (flags.length) {
      const fl = document.createElement("div");
      fl.className = "cms-flags";
      fl.innerHTML = flags.map((f) => `<span class="badge chip--danger">${f}</span>`).join(" ");
      card.appendChild(fl);
    }

    const dl = document.createElement("div");
    dl.className = "chips";
    // Show files in a stable order (eKTP penuh first so it's easy to find).
    const order = ["ektp", "pasfoto", "prescreen_xls", "pariksa_pdf", "chatlog"];
    const files = (l.files || []).slice().sort((a, b) => order.indexOf(a.jenis) - order.indexOf(b.jenis));
    for (const f of files) {
      const group = document.createElement("span");
      group.className = "doc-chip";
      const a = document.createElement("a");
      a.className = "chip";
      a.textContent = "⬇ " + (CMS_FILE_LABEL[f.jenis] || f.jenis);
      a.href = `/api/admin/file?key=${encodeURIComponent(f.r2_key)}`;
      const base = f.r2_key.split("/").pop();
      a.download = `${(l.nama || "lead").replace(/[^A-Za-z0-9]+/g, "_")}_${base}`;
      group.appendChild(a);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "chip chip--danger doc-chip__del";
      x.title = "Hapus dokumen ini";
      x.textContent = "✕";
      x.addEventListener("click", () => deleteCmsFile(l.id, f.r2_key, group));
      group.appendChild(x);
      dl.appendChild(group);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chip chip--danger";
    del.textContent = "Hapus lead";
    del.addEventListener("click", () => deleteCmsLead(l.id, card));
    dl.appendChild(del);

    card.appendChild(dl);
    list.appendChild(card);
  }
}

// Phase 8: delete a single document.
async function deleteCmsFile(leadId, r2Key, group) {
  if (!confirm("Hapus dokumen ini secara permanen? Tindakan ini tercatat di audit log.")) return;
  try {
    const r = await fetch("/api/admin/cms/file-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: leadId, r2_key: r2Key }),
    });
    if (r.ok) group.remove();
    else alert("Gagal menghapus dokumen.");
  } catch (e) {
    alert("Gagal menghapus dokumen: " + e.message);
  }
}

// Phase 8: audit log viewer.
async function loadAudit() {
  $("auditStatus").textContent = "Memuat…";
  $("auditList").textContent = "";
  let res;
  try { res = await fetch("/api/admin/cms/audit", { headers: { Accept: "application/json" } }); }
  catch (e) { $("auditStatus").textContent = "Gagal memuat: " + e.message; return; }
  if (res.status === 401) { showLogin("Sesi berakhir. Silakan masuk kembali."); return; }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) { $("auditStatus").textContent = data.error || "Audit log belum tersedia."; return; }
  const rows = data.rows || [];
  $("auditStatus").textContent = `${rows.length} entri terbaru.`;
  const list = $("auditList");
  list.textContent = "";
  for (const e of rows) {
    const row = document.createElement("div");
    row.className = "audit-row";
    row.innerHTML =
      `<span class="mono audit-row__time">${escapeHtml(fmtTime(e.at))}</span>` +
      `<span class="badge">${escapeHtml(e.aksi || "-")}</span>` +
      `<span class="audit-row__actor">${escapeHtml(e.actor || "-")}</span>` +
      `<span class="audit-row__target mono">${escapeHtml(e.target || "")}</span>`;
    list.appendChild(row);
  }
}

// Phase 8: change the admin password.
async function changePassword() {
  const np = prompt("Kata sandi baru (minimal 8 karakter):");
  if (np == null) return;
  if (np.length < 8) { alert("Kata sandi minimal 8 karakter."); return; }
  try {
    const r = await fetch("/api/admin/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPass: np }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) alert("Kata sandi berhasil diubah.");
    else alert("Gagal: " + (d.error || r.status));
  } catch (e) {
    alert("Gagal: " + e.message);
  }
}

// Phase 4: human-readable state of an SLA task.
function taskState(dueAt, doneAt, reminderAt) {
  if (doneAt) return "Selesai " + escapeHtml(fmtTime(doneAt));
  if (!dueAt) return "—";
  const overdue = new Date(dueAt).getTime() <= Date.now();
  const due = "jatuh tempo " + escapeHtml(fmtTime(dueAt));
  if (overdue) return `LEWAT (${due})${reminderAt ? " · reminder terkirim" : ""}`;
  return "Terjadwal (" + due + ")";
}

function taskButton(label, cls, id, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip" + (cls ? " " + cls : "");
  b.textContent = label;
  b.addEventListener("click", () => callCmsTask(id, action));
  return b;
}

async function callCmsTask(id, action) {
  try {
    const r = await fetch("/api/admin/cms/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    if (r.ok) loadCms();
    else alert("Gagal: " + ((await r.json().catch(() => ({}))).error || r.status));
  } catch (e) {
    alert("Gagal: " + e.message);
  }
}

async function updateCmsStatus(id, status, sel) {
  if (sel) sel.disabled = true;
  try {
    const r = await fetch("/api/admin/cms/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (r.ok) { loadCms(); return; }
    alert("Gagal ubah status: " + ((await r.json().catch(() => ({}))).error || r.status));
  } catch (e) {
    alert("Gagal ubah status: " + e.message);
  }
  if (sel) sel.disabled = false;
}

async function runSla() {
  const s = $("cmsStatus");
  s.textContent = "Menjalankan sweep SLA…";
  try {
    const r = await fetch("/api/admin/cms/run-sla?weekly=1", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      s.textContent =
        `Sweep selesai — reminder call: ${d.call}, WA: ${d.wa}, mingguan: ${d.weekly}, email terkirim: ${d.sent}.` +
        (d.notConfigured ? " (RESEND_API_KEY belum diset; reminder dicatat tapi email tidak terkirim.)" : "");
      loadCms();
    } else {
      s.textContent = "Gagal sweep: " + (d.error || r.status);
    }
  } catch (e) {
    s.textContent = "Gagal sweep: " + e.message;
  }
}

async function deleteCmsLead(id, card) {
  if (!confirm("Hapus lead ini beserta semua dokumennya secara permanen? Tindakan ini tercatat di audit log.")) return;
  try {
    const r = await fetch("/api/admin/cms/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (r.ok) card.remove();
    else alert("Gagal menghapus.");
  } catch (e) {
    alert("Gagal menghapus: " + e.message);
  }
}

async function logout() {
  await fetch("/api/admin/logout", { method: "POST" });
  showLogin("Anda telah keluar.");
}

/* --- Pariksa tool: OCR + NIK structure test (runs on-device) --------------- */

const VERDICT_CLASS = {
  "Consistent": "ok",
  "Consistent with warnings": "warn",
  "Inconsistent": "fail",
};

function renderNikResult(container, res) {
  container.textContent = "";
  const verdict = document.createElement("div");
  verdict.className = `verdict verdict--${VERDICT_CLASS[res.verdict] || "warn"}`;
  verdict.textContent = `Verdict: ${res.verdict}`;
  container.appendChild(verdict);

  const table = document.createElement("table");
  table.className = "checks";
  const head = document.createElement("tr");
  ["Check", "Status", "Reason"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });
  table.appendChild(head);
  for (const c of res.checks) {
    const tr = document.createElement("tr");
    const label = document.createElement("td"); label.textContent = c.label;
    const status = document.createElement("td"); status.textContent = c.status; status.className = `status status--${c.status}`;
    const reason = document.createElement("td"); reason.textContent = c.reason;
    tr.append(label, status, reason);
    table.appendChild(tr);
  }
  container.appendChild(table);
}

function setupPariksa() {
  const f = (id) => $(id);
  const els = {
    file: f("pkFile"), status: f("pkStatus"), preview: f("pkPreview"),
    fields: f("pkFields"), check: f("pkCheck"), result: f("pkResult"),
    nik: f("pkNik"), sex: f("pkSex"), dob: f("pkDob"),
    prov: f("pkProv"), kab: f("pkKab"), kec: f("pkKec"),
    photoWrap: f("pkPhotoWrap"), photo: f("pkPhoto"), photoDl: f("pkPhotoDl"),
    engine: f("pkEngine"),
  };
  if (!els.file) return;
  let photoUrl = null; // revoked between runs to avoid leaks

  els.file.addEventListener("change", async () => {
    const file = els.file.files && els.file.files[0];
    if (!file) return;
    els.preview.src = URL.createObjectURL(file);
    els.preview.hidden = false;
    els.fields.hidden = false;
    els.check.hidden = false;
    els.result.textContent = "";
    els.photoWrap.hidden = true;

    const setEngine = (kind, detail) => {
      if (!els.engine) return;
      const map = {
        ai: { cls: "ok", label: "Dibaca oleh sistem" },
        device: { cls: "warn", label: "Dibaca oleh sistem (cadangan)" },
        none: { cls: "fail", label: "Gagal membaca" },
      };
      const e = map[kind] || map.none;
      els.engine.textContent = e.label;
      els.engine.className = `pk-engine status--${e.cls}`;
      els.engine.hidden = false;
    };
    if (els.engine) els.engine.hidden = true;

    const setFields = (f) => {
      els.nik.value = f.nik || "";
      els.dob.value = f.tanggal_lahir || "";
      els.sex.value = f.jenis_kelamin || "";
      els.prov.value = f.provinsi || "";
      els.kab.value = f.kabupaten_kota || "";
      els.kec.value = f.kecamatan || "";
    };
    const showPhoto = (blob) => {
      if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; }
      if (!blob) return;
      photoUrl = URL.createObjectURL(blob);
      els.photo.src = photoUrl;
      els.photoDl.href = photoUrl;
      els.photoDl.download = `pasfoto_ektp_${new Date().toISOString().slice(0, 10)}.jpg`;
      els.photoWrap.hidden = false;
    };

    // Primary: server reader (accurate). Fallback: on-device reader.
    els.status.textContent = "Sedang membaca eKTP oleh sistem…";
    // Deterministic pas foto crop, independent of the OCR model.
    let detPhoto = null;
    try { detPhoto = await cropFacePhoto(file); } catch { /* ignore */ }
    try {
      const g = await geminiOcr(file);
      setFields(g.fields || {});
      let photo = detPhoto;
      if (!photo) { try { photo = await cropByBox(file, g.photo_box); } catch { /* ignore */ } }
      showPhoto(photo);
      setEngine("ai");
      els.status.textContent = "Pembacaan selesai. Koreksi bila perlu, lalu klik Periksa NIK.";
    } catch (errAi) {
      console.warn("[admin] primary reader failed, using fallback:", errAi);
      els.status.textContent = "Mencoba pembacaan cadangan…";
      try {
        const { fields, photo } = await runOcr(file, (m) => {
          els.status.textContent = `Membaca: ${m.status} ${Math.round((m.progress || 0) * 100)}%`;
        });
        setFields(fields);
        showPhoto(detPhoto || photo);
        setEngine("device");
        els.status.textContent = "Pembacaan selesai. Koreksi bila perlu, lalu klik Periksa NIK.";
      } catch (err) {
        console.error("[admin] read failed:", err);
        setEngine("none");
        els.status.textContent = "Gagal membaca. Anda bisa mengisi field manual lalu Periksa NIK.";
      }
    }
  });

  els.check.addEventListener("click", async () => {
    let dataset;
    try {
      dataset = await loadRegionData();
    } catch {
      els.result.textContent = "Gagal memuat data wilayah.";
      return;
    }
    const printed = {
      jenis_kelamin: els.sex.value,
      tanggal_lahir: els.dob.value.trim(),
      provinsi: els.prov.value.trim(),
      kabupaten_kota: els.kab.value.trim(),
      kecamatan: els.kec.value.trim(),
    };
    renderNikResult(els.result, validateNik(els.nik.value.trim(), printed, dataset));
  });
}

async function testAi() {
  const out = $("aiTestResult");
  out.textContent = "Menguji…";
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Tes singkat: sebutkan satu produk KPR the Bank." }),
    });
    const j = await r.json();
    out.textContent = j.ok
      ? `AI OK ✓ [${j.model || "?"}] — ${String(j.answer).slice(0, 80)}`
      : `AI ERROR (${r.status}) — ${j.error || "tidak diketahui"}`;
  } catch (e) {
    out.textContent = "Gagal memanggil /api/chat: " + e.message;
  }
}

async function testEmail() {
  const out = $("emailTestResult");
  out.textContent = "Mengirim email tes…";
  try {
    const r = await fetch("/api/admin/email-test", { method: "POST" });
    if (r.status === 401) { showLogin("Sesi berakhir. Silakan masuk kembali."); return; }
    const j = await r.json();
    if (j.ok) {
      out.textContent = `Email tes terkirim ✓ ke ${j.to} (dari ${j.from}). Cek inbox/spam.`;
    } else if (j.configured === false) {
      out.textContent = "✗ RESEND_API_KEY belum diset. Tambahkan secret di Cloudflare lalu deploy ulang.";
    } else {
      out.textContent = `✗ Gagal${j.status ? ` (HTTP ${j.status})` : ""}: ${j.error || "tidak diketahui"}`;
    }
  } catch (e) {
    out.textContent = "Gagal memanggil tes email: " + e.message;
  }
}

async function checkConfig() {
  const out = $("diagResult");
  out.textContent = "Memeriksa…";
  try {
    const r = await fetch("/api/admin/diag", { headers: { Accept: "application/json" } });
    if (r.status === 401) { showLogin("Sesi berakhir. Silakan masuk kembali."); return; }
    const j = await r.json();
    const yn = (b) => (b ? "✓" : "✗");
    out.textContent =
      `GEMINI_API_KEY ${yn(j.hasGeminiKey)} · RESEND_API_KEY ${yn(j.hasResendKey)} · ` +
      `SESSION_SECRET ${yn(j.hasSessionSecret)} · R2 ${yn(j.hasBucket)} | ` +
      `model: ${j.geminiModel || j.geminiErr || "-"}` +
      `${j.geminiFallback ? ` (cadangan: ${j.geminiFallback})` : ""} | dari ${j.mailFrom} → ${j.mailTo}`;
  } catch (e) {
    out.textContent = "Gagal memeriksa konfigurasi: " + e.message;
  }
}

$("dashFilter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-period]");
  if (!btn) return;
  DASH_PERIOD = btn.dataset.period;
  $("dashFilter").querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b === btn));
  renderDashboard();
});
$("diagBtn").addEventListener("click", checkConfig);
$("emailTestBtn").addEventListener("click", testEmail);
$("aiTestBtn").addEventListener("click", testAi);
$("loginBtn").addEventListener("click", login);
$("loginForm").addEventListener("submit", (e) => { e.preventDefault(); login(); });
$("forgotBtn").addEventListener("click", () => { $("resetBox").hidden = !$("resetBox").hidden; });
$("resetBtn").addEventListener("click", resetPassword);
$("refreshBtn").addEventListener("click", loadLeads);
$("tabLeads").addEventListener("click", showLeads);
$("tabPariksa").addEventListener("click", showPariksa);
$("tabCms").addEventListener("click", () => { showCms(); loadCms(); loadAudit(); });
$("tabBi").addEventListener("click", () => { showBi(); loadBi(); });
$("cmsRefreshBtn").addEventListener("click", loadCms);
$("cmsSlaBtn").addEventListener("click", runSla);
$("auditRefreshBtn").addEventListener("click", loadAudit);
$("pwdChangeBtn").addEventListener("click", changePassword);
$("biRefreshBtn").addEventListener("click", loadBi);
$("biChartToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metric]");
  if (!btn) return;
  biMetric = btn.dataset.metric;
  $("biChartToggle").querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b === btn));
  renderBiChart();
});
logoutBtn.addEventListener("click", logout);
setupPariksa();

// On load, try to list leads; a 401 falls back to the login view.
loadLeads();
