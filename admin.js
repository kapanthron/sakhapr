/* ============================================================================
   admin.js  —  Super Admin client for SakhaPR
   Talks to the Worker admin API. Auth is server-checked: the session cookie is
   HttpOnly, so this script never sees the password after login. Download links
   are plain same-origin anchors; the cookie rides along automatically.
   ============================================================================ */

const $ = (id) => document.getElementById(id);
const loginView = $("loginView");
const leadsView = $("leadsView");
const logoutBtn = $("logoutBtn");

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function showLogin(msg) {
  loginView.hidden = false;
  leadsView.hidden = true;
  logoutBtn.hidden = true;
  if (msg) $("loginStatus").textContent = msg;
}

function showLeads() {
  loginView.hidden = true;
  leadsView.hidden = false;
  logoutBtn.hidden = false;
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

$("loginBtn").addEventListener("click", login);
$("loginForm").addEventListener("submit", (e) => { e.preventDefault(); login(); });
$("refreshBtn").addEventListener("click", loadLeads);
logoutBtn.addEventListener("click", logout);

// On load, try to list leads; a 401 falls back to the login view.
loadLeads();
