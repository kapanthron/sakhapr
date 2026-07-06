/* ============================================================================
   sales.js — Moggy Sales portal (/sales)
   A scoped CMS for a single sales owner: their leads only, a mini BI dashboard,
   and pipeline status updates with a free-text note. Talks to /api/sales/*.
   ============================================================================ */

const $ = (id) => document.getElementById(id);
const loginView = $("loginView");
const salesView = $("salesView");
const logoutBtn = $("logoutBtn");

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(ts) {
  if (!ts) return "-";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(ts));
  } catch { return ts; }
}
function rupiah(n) { return n ? "Rp" + Number(n).toLocaleString("id-ID") : "-"; }
function rupiahShort(n) {
  n = Number(n) || 0;
  if (n >= 1e12) return "Rp" + (n / 1e12).toFixed(1).replace(/\.0$/, "") + "T";
  if (n >= 1e9) return "Rp" + (n / 1e9).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e6) return "Rp" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "jt";
  if (n >= 1e3) return "Rp" + Math.round(n / 1e3) + "rb";
  return "Rp" + n;
}
const JENIS_LABEL = { primary: "KPR PRI", second: "KPR SEC", take_over: "KPR TO" };
function gradeChip(g) {
  if (g === "A+" || g === "A") return "chip--ok";
  if (g === "B") return "chip--warn";
  return "chip--danger";
}

let CMS_STATUSES = [];
function statusLabel(key) {
  const s = CMS_STATUSES.find((x) => x.key === key);
  return s ? s.label : (key || "-");
}

function showLogin(msg) {
  loginView.hidden = false;
  salesView.hidden = true;
  logoutBtn.hidden = true;
  $("pwdChangeBtn").hidden = true;
  if (msg) $("loginStatus").textContent = msg;
}
function showSales() {
  loginView.hidden = true;
  salesView.hidden = false;
  logoutBtn.hidden = false;
  $("pwdChangeBtn").hidden = false;
}

async function login() {
  const user = $("loginUser").value.trim();
  const pass = $("loginPass").value;
  $("loginStatus").textContent = "Memeriksa…";
  const res = await fetch("/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, pass }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) { $("loginStatus").textContent = data.error || "ID atau kata sandi salah."; return; }
  if (data.role !== "sales") { $("loginStatus").textContent = "Akun ini bukan akun sales. Buka /super untuk admin."; return; }
  $("loginPass").value = "";
  if (data.firstLogin) $("loginStatus").textContent = "Login pertama berhasil — segera ganti kata sandi.";
  await loadAll();
}

async function loadAll() {
  showSales();
  await Promise.all([loadMe(), loadBi(), loadLeads()]);
}

async function loadMe() {
  try {
    const r = await fetch("/api/sales/me", { headers: { Accept: "application/json" } });
    if (r.status === 401) { showLogin("Silakan masuk."); return; }
    const d = await r.json().catch(() => ({}));
    if (d.ok) $("salesSub").textContent = `Sales ${d.owner} · ${d.user}`;
  } catch { /* ignore */ }
}

/* --- BI (scoped to this sales owner) --------------------------------------- */
let biSeries = [];
let biMetric = "volume";

async function loadBi() {
  $("biStatus").textContent = "Memuat…";
  let res;
  try { res = await fetch("/api/sales/bi", { headers: { Accept: "application/json" } }); }
  catch (e) { $("biStatus").textContent = "Gagal memuat: " + e.message; return; }
  if (res.status === 401) { showLogin("Sesi berakhir. Silakan masuk kembali."); return; }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) { $("biStatus").textContent = data.error || "Dashboard belum tersedia."; return; }
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
    bigNumCard("YTD jumlah leads", b.ytdLeads) +
    bigNumCard("Jumlah nasabah", b.nasabah, `${b.nasabahPct}% dari lead`) +
    bigNumCard("Total limit pengajuan", rupiah(b.totalLimit)) +
    bigNumCard("Sedang di analis", b.submitAnalis, `${b.submitAnalisPct}% dari lead`) +
    bigNumCard("Approval rate", `${b.approvalRate}%`, `${b.approved} approved / ${b.rejected} rejected`) +
    bigNumCard("Disbursed", b.disbursed, `${b.disbursedPct}% dari lead`) +
    bigNumCard("Take up rate", `${b.takeUpRate}%`, `${b.disbursed} disbursed / ${b.totalLeads} lead masuk`);
}
function renderBiChart() {
  const host = $("biChart");
  host.textContent = "";
  if (!biSeries.length) { host.innerHTML = `<p class="ektp__disclaimer">Belum ada data lead.</p>`; return; }
  const isVol = biMetric !== "nasabah";
  const vals = biSeries.map((s) => (isVol ? s.volume : s.nasabah));
  const label = (v) => (isVol ? rupiahShort(v) : String(v));
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
      `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle" class="bi-bar__val">${escapeHtml(label(v))}</text>` +
      `<text x="${(x + bw / 2).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" class="bi-axis">${escapeHtml(s.ym)}</text>`;
  });
  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="bi-svg" role="img" aria-label="Grafik lead per bulan">` +
    `<line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" class="bi-axisline"></line>` +
    bars + `</svg>`;
}

/* --- Leads (this owner's) -------------------------------------------------- */
async function loadLeads() {
  $("leadsStatus").textContent = "Memuat…";
  $("leadsList").textContent = "";
  let res;
  try { res = await fetch("/api/sales/leads", { headers: { Accept: "application/json" } }); }
  catch (e) { $("leadsStatus").textContent = "Gagal memuat: " + e.message; return; }
  if (res.status === 401) { showLogin("Sesi berakhir. Silakan masuk kembali."); return; }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) { $("leadsStatus").textContent = data.error || "Belum tersedia."; return; }
  if (Array.isArray(data.statuses)) CMS_STATUSES = data.statuses;
  renderLeads(data.leads || []);
}

function renderLeads(leads) {
  const list = $("leadsList");
  list.textContent = "";
  $("leadsStatus").textContent = `${leads.length} lead di wilayah Anda.`;
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
      `<span>Grade: <strong class="badge ${gradeChip(l.grade_keseluruhan)}">${escapeHtml(l.grade_keseluruhan || "-")}</strong> (skor ${escapeHtml(String(l.skor_komposit != null ? l.skor_komposit : "-"))})</span>`;
    card.appendChild(meta);

    // Status + keterangan editor.
    const pipe = document.createElement("div");
    pipe.className = "cms-pipe";
    const sel = document.createElement("select");
    sel.className = "cms-pipe__select";
    for (const s of CMS_STATUSES) {
      const o = document.createElement("option");
      o.value = s.key; o.textContent = s.label;
      if (s.key === l.status) o.selected = true;
      sel.appendChild(o);
    }
    const lbl = document.createElement("label");
    lbl.className = "cms-pipe__label";
    lbl.textContent = "Status pipeline";
    lbl.appendChild(sel);
    pipe.appendChild(lbl);

    const note = document.createElement("textarea");
    note.className = "sales-note";
    note.rows = 2;
    note.placeholder = "Keterangan (opsional): catatan follow-up, alasan status, dll.";
    pipe.appendChild(note);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn--primary btn--small";
    save.textContent = "Simpan status";
    save.addEventListener("click", () => saveStatus(l.id, sel.value, note.value, save));
    pipe.appendChild(save);

    const hist = (l.history || []).slice().reverse();
    if (hist.length) {
      const h = document.createElement("ul");
      h.className = "cms-history";
      for (const e of hist) {
        const li = document.createElement("li");
        li.innerHTML =
          `<span class="mono">${escapeHtml(fmtTime(e.changed_at))}</span> — ` +
          `${escapeHtml(statusLabel(e.status_lama) || "(awal)")} → <strong>${escapeHtml(statusLabel(e.status_baru))}</strong>` +
          (e.changed_by ? ` <span class="cms-history__by">oleh ${escapeHtml(e.changed_by)}</span>` : "") +
          (e.keterangan ? `<br><span class="cms-history__note">“${escapeHtml(e.keterangan)}”</span>` : "");
        h.appendChild(li);
      }
      pipe.appendChild(h);
    }
    card.appendChild(pipe);
    list.appendChild(card);
  }
}

async function saveStatus(id, status, keterangan, btn) {
  btn.disabled = true;
  try {
    const r = await fetch("/api/sales/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, keterangan }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) { await loadLeads(); await loadBi(); }
    else { alert("Gagal: " + (d.error || r.status)); btn.disabled = false; }
  } catch (e) { alert("Gagal: " + e.message); btn.disabled = false; }
}

async function changePassword() {
  const np = prompt("Kata sandi baru (minimal 8 karakter):");
  if (np == null) return;
  if (np.length < 8) { alert("Kata sandi minimal 8 karakter."); return; }
  try {
    const r = await fetch("/api/admin/set-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPass: np }),
    });
    const d = await r.json().catch(() => ({}));
    alert(r.ok && d.ok ? "Kata sandi berhasil diubah." : "Gagal: " + (d.error || r.status));
  } catch (e) { alert("Gagal: " + e.message); }
}

async function logout() {
  await fetch("/api/admin/logout", { method: "POST" });
  showLogin("Anda telah keluar.");
}

$("loginBtn").addEventListener("click", login);
$("loginForm").addEventListener("submit", (e) => { e.preventDefault(); login(); });
$("refreshBtn").addEventListener("click", loadAll);
$("logoutBtn").addEventListener("click", logout);
$("pwdChangeBtn").addEventListener("click", changePassword);
$("biChartToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metric]");
  if (!btn) return;
  biMetric = btn.dataset.metric;
  $("biChartToggle").querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b === btn));
  renderBiChart();
});

// On load: if there's a valid sales session, go straight in; else show login.
fetch("/api/sales/me")
  .then((r) => (r.ok ? loadAll() : showLogin()))
  .catch(() => showLogin());
