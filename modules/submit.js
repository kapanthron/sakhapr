/* ============================================================================
   modules/submit.js  —  forward the lead package to the backend
   Sends prescreen (.txt), the NIK report (.pdf), the eKTP data as TEXT
   (extracted fields, NOT the full scanned card), and the pas foto (cropped face)
   plus metadata to /api/submit as multipart/form-data. The full eKTP scan is
   never uploaded or stored (privacy); the pas foto is kept for identification.
   ============================================================================ */

/**
 * @param {{prescreen:Blob, report:Blob, ektpData:string, pasfoto:Blob, meta:object}} parts
 * @returns {Promise<{ok:boolean, id:string, email:string}>}
 */
export async function submitLead({ prescreen, report, chatlog, ektpData, pasfoto, meta }) {
  if (!prescreen || !report) {
    throw new Error("Berkas tidak lengkap untuk dikirim.");
  }
  const form = new FormData();
  form.append("prescreen", prescreen, "prescreen.txt");
  form.append("report", report, "laporan_nik.pdf");
  if (chatlog) form.append("chatlog", chatlog, "chatlog.txt");
  if (ektpData) form.append("ektpData", ektpData); // extracted eKTP fields as text
  if (pasfoto) form.append("pasfoto", pasfoto, "pasfoto.jpg"); // cropped face only
  for (const [k, v] of Object.entries(meta || {})) {
    form.append(k, v == null ? "" : String(v));
  }

  const res = await fetch("/api/submit", { method: "POST", body: form });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) detail = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}
