/* ============================================================================
   admin.js  —  Super Admin client for SakhaPR
   Talks to the Worker admin API. Auth is server-checked: the session cookie is
   HttpOnly, so this script never sees the password after login. Download links
   are plain same-origin anchors; the cookie rides along automatically.
   ============================================================================ */

import { runOcr } from "./modules/ocr.js";
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

function showLeads() {
  loginView.hidden = true;
  pariksaView.hidden = true;
  leadsView.hidden = false;
  adminNav.hidden = false;
  logoutBtn.hidden = false;
  $("tabLeads").classList.add("is-active");
  $("tabPariksa").classList.remove("is-active");
}

function showPariksa() {
  loginView.hidden = true;
  leadsView.hidden = true;
  pariksaView.hidden = false;
  adminNav.hidden = false;
  logoutBtn.hidden = false;
  $("tabPariksa").classList.add("is-active");
  $("tabLeads").classList.remove("is-active");
}

const EMAIL_LABEL = {
  sent: "✓ terkirim",
  failed: "✗ gagal",
  not_configured: "• dicatat (email belum dikonfigurasi)",
  pending: "… tertunda",
};

function fileUrl(id, name) {
  return `/api/admin/file?key=${encodeURIComponent(`leads/${id}/${name}`)}`;
}

function renderLeads(leads) {
  const list = $("leadsList");
  list.textContent = "";
  if (!leads.length) {
    $("leadsStatus").textContent = "Belum ada lead tersimpan.";
    return;
  }
  $("leadsStatus").textContent = `${leads.length} lead tersimpan.`;

  for (const lead of leads) {
    const card = document.createElement("div");
    card.className = "lead-card";

    const email = lead.email || {};
    const emailClass = email.status === "sent" ? "ok" : email.status === "failed" ? "fail" : "warn";

    const head = document.createElement("div");
    head.className = "lead-card__head";
    head.innerHTML =
      `<div><strong>${escapeHtml(lead.productName || lead.product || "(produk?)")}</strong>` +
      `<span class="lead-card__id mono">${escapeHtml(lead.id)}</span></div>` +
      `<div class="lead-card__time mono">${escapeHtml(new Date(lead.ts).toLocaleString("id-ID"))}</div>`;
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "lead-card__meta";
    meta.innerHTML =
      `<span>Prescreen: <strong>${escapeHtml(lead.prescreenLabel || "-")} ${escapeHtml(lead.prescreenStatus || "")}</strong></span>` +
      `<span>Verdict NIK: <strong>${escapeHtml(lead.nikVerdict || "-")}</strong></span>` +
      `<span>Email ke ${escapeHtml(email.to || "-")}: <strong class="status--${emailClass}">${EMAIL_LABEL[email.status] || email.status || "-"}</strong>` +
      (email.error ? ` <span class="lead-card__err">(${escapeHtml(email.error)})</span>` : "") +
      `</span>`;
    card.appendChild(meta);

    const files = lead.files || {};
    const dl = document.createElement("div");
    dl.className = "chips";
    const links = [
      ["Prescreen (.txt)", files.prescreen],
      ["Log chat (.txt)", files.chatlog],
      ["eKTP", files.ektp],
      ["Laporan NIK (.pdf)", files.report],
      ["meta.json", "meta.json"],
    ];
    for (const [label, name] of links) {
      if (!name) continue;
      const a = document.createElement("a");
      a.className = "chip";
      a.textContent = label;
      a.href = fileUrl(lead.id, name);
      dl.appendChild(a);
    }
    card.appendChild(dl);
    list.appendChild(card);
  }
}

async function loadLeads() {
  $("leadsStatus").textContent = "Memuat…";
  const res = await fetch("/api/admin/leads", { headers: { Accept: "application/json" } });
  if (res.status === 401) {
    showLogin("Sesi berakhir. Silakan masuk kembali.");
    return;
  }
  const data = await res.json();
  showLeads();
  renderLeads(data.leads || []);
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
  if (!res.ok) {
    $("loginStatus").textContent = "ID atau kata sandi salah.";
    return;
  }
  $("loginPass").value = "";
  await loadLeads();
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
  };
  if (!els.file) return;

  els.file.addEventListener("change", async () => {
    const file = els.file.files && els.file.files[0];
    if (!file) return;
    els.preview.src = URL.createObjectURL(file);
    els.preview.hidden = false;
    els.fields.hidden = false;
    els.check.hidden = false;
    els.result.textContent = "";
    els.status.textContent = "Memuat mesin OCR lalu membaca eKTP…";
    try {
      const { fields } = await runOcr(file, (m) => {
        els.status.textContent = `OCR: ${m.status} ${Math.round((m.progress || 0) * 100)}%`;
      });
      els.nik.value = fields.nik || "";
      els.dob.value = fields.tanggal_lahir || "";
      els.sex.value = fields.jenis_kelamin || "";
      els.prov.value = fields.provinsi || "";
      els.kab.value = fields.kabupaten_kota || "";
      els.kec.value = fields.kecamatan || "";
      els.status.textContent = "OCR selesai. Koreksi bila perlu, lalu klik Periksa NIK.";
    } catch (err) {
      console.error("[admin] OCR failed:", err);
      els.status.textContent = "OCR gagal. Anda bisa mengisi field manual lalu Periksa NIK.";
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

$("loginBtn").addEventListener("click", login);
$("loginForm").addEventListener("submit", (e) => { e.preventDefault(); login(); });
$("refreshBtn").addEventListener("click", loadLeads);
$("tabLeads").addEventListener("click", showLeads);
$("tabPariksa").addEventListener("click", showPariksa);
logoutBtn.addEventListener("click", logout);
setupPariksa();

// On load, try to list leads; a 401 falls back to the login view.
loadLeads();
