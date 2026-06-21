/* ============================================================================
   admin.js  —  Super Admin client for SakhaPR
   Talks to the Worker admin API. Auth is server-checked: the session cookie is
   HttpOnly, so this script never sees the password after login. Download links
   are plain same-origin anchors; the cookie rides along automatically.
   ============================================================================ */

import { runOcr } from "./modules/ocr.js";
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
        ai: { cls: "ok", label: `AI · Gemini${detail ? ` (${detail})` : ""}` },
        device: { cls: "warn", label: "Offline · OCR perangkat (Tesseract)" },
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

    // Primary: Gemini Vision (accurate). Fallback: on-device Tesseract.
    els.status.textContent = "Membaca eKTP dengan AI (Gemini)…";
    try {
      const g = await geminiOcr(file);
      setFields(g.fields || {});
      let photo = null;
      try { photo = await cropByBox(file, g.photo_box); } catch { /* ignore */ }
      showPhoto(photo);
      setEngine("ai", g.model || "gemini");
      els.status.textContent = "OCR AI selesai. Koreksi bila perlu, lalu klik Periksa NIK.";
    } catch (errAi) {
      console.warn("[admin] Gemini OCR failed, falling back to Tesseract:", errAi);
      els.status.textContent = "AI tidak tersedia — memakai OCR perangkat…";
      try {
        const { fields, photo } = await runOcr(file, (m) => {
          els.status.textContent = `OCR perangkat: ${m.status} ${Math.round((m.progress || 0) * 100)}%`;
        });
        setFields(fields);
        showPhoto(photo);
        setEngine("device");
        els.status.textContent = "OCR perangkat selesai. Koreksi bila perlu, lalu klik Periksa NIK.";
      } catch (err) {
        console.error("[admin] OCR failed:", err);
        setEngine("none");
        els.status.textContent = "OCR gagal. Anda bisa mengisi field manual lalu Periksa NIK.";
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
      body: JSON.stringify({ message: "Tes singkat: sebutkan satu produk KPR UOB." }),
    });
    const j = await r.json();
    out.textContent = j.ok
      ? `AI OK ✓ [${j.model || "?"}] — ${String(j.answer).slice(0, 80)}`
      : `AI ERROR (${r.status}) — ${j.error || "tidak diketahui"}`;
  } catch (e) {
    out.textContent = "Gagal memanggil /api/chat: " + e.message;
  }
}

$("aiTestBtn").addEventListener("click", testAi);
$("loginBtn").addEventListener("click", login);
$("loginForm").addEventListener("submit", (e) => { e.preventDefault(); login(); });
$("refreshBtn").addEventListener("click", loadLeads);
$("tabLeads").addEventListener("click", showLeads);
$("tabPariksa").addEventListener("click", showPariksa);
logoutBtn.addEventListener("click", logout);
setupPariksa();

// On load, try to list leads; a 401 falls back to the login view.
loadLeads();
