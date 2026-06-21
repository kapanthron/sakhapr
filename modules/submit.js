/* ============================================================================
   modules/submit.js  —  forward the lead package to the backend
   Sends the three files (prescreen .txt, eKTP image, NIK report .pdf) plus
   metadata to the Worker's /api/submit endpoint as multipart/form-data. The
   Worker stores them in R2 and emails them to the recipient.
   ============================================================================ */

/**
 * @param {{prescreen:Blob, ektp:Blob, report:Blob, meta:object}} parts
 * @returns {Promise<{ok:boolean, id:string, email:string}>}
 */
export async function submitLead({ prescreen, ektp, report, chatlog, pasfoto, meta }) {
  if (!prescreen || !ektp || !report) {
    throw new Error("Berkas tidak lengkap untuk dikirim.");
  }
  const form = new FormData();
  form.append("prescreen", prescreen, "prescreen.txt");
  form.append("ektp", ektp, ektp.name || "ektp");
  form.append("report", report, "laporan_nik.pdf");
  if (chatlog) form.append("chatlog", chatlog, "chatlog.txt");
  if (pasfoto) form.append("pasfoto", pasfoto, "pasfoto.jpg");
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
