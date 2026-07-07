/* ============================================================================
   modules/pdfReport.js  —  renders "file c": the NIK screening report PDF
   Uses jsPDF (vendored locally at vendor/jspdf/jspdf.umd.min.js, loaded as a
   classic script that exposes window.jspdf). Pure client-side; the PDF is built
   in memory and returned as a Blob.

   The report lists every structural check (status + reason), the overall
   verdict, the decoded NIK fields, and the screening disclaimer.
   ============================================================================ */

const TEAL = [14, 124, 123];
const INK = [29, 35, 33];
const SOFT = [90, 96, 94];
const STATUS_COLOR = {
  PASS: [29, 107, 52],
  WARN: [154, 103, 0],
  FAIL: [179, 38, 30],
  NA: [120, 120, 120],
};
const VERDICT_COLOR = {
  Consistent: [29, 107, 52],
  "Consistent with warnings": [154, 103, 0],
  Inconsistent: [179, 38, 30],
};

const SCREENING_DISCLAIMER =
  "Pemeriksaan NIK ini hanya alat bantu skrining struktur dan konsistensi. " +
  "Ini bukan bukti keaslian dokumen dan bukan keputusan kredit. Verifikasi akhir " +
  "dilakukan oleh petugas.";

/**
 * Build the NIK screening report PDF.
 * @param {{nik:string, verdict:string, decoded:?object, checks:Array}} result
 * @param {{timestamp?:string, printed?:object}} [opts]
 * @returns {{filename:string, blob:Blob}}
 */
export function buildNikReportPdf(result, opts = {}) {
  const JsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!JsPDF) throw new Error("jsPDF belum dimuat (window.jspdf tidak tersedia).");

  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 40;
  const contentW = pageW - M * 2;
  let y = M;

  const ensureSpace = (h) => {
    if (y + h > pageH - M) {
      doc.addPage();
      y = M;
    }
  };
  const setColor = (c) => doc.setTextColor(c[0], c[1], c[2]);

  // --- Header ---
  setColor(TEAL);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Morby — Laporan Skrining NIK (PARIKSA)", M, y);
  y += 20;

  setColor(SOFT);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Dibuat: ${opts.timestamp || new Date().toLocaleString("id-ID")}`, M, y);
  y += 18;

  // --- Verdict box ---
  const vColor = VERDICT_COLOR[result.verdict] || STATUS_COLOR.WARN;
  doc.setDrawColor(vColor[0], vColor[1], vColor[2]);
  doc.setFillColor(vColor[0], vColor[1], vColor[2]);
  doc.setLineWidth(1);
  doc.rect(M, y, contentW, 26, "S");
  setColor(vColor);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(`Verdict: ${result.verdict}`, M + 8, y + 17);
  y += 40;

  // --- Decoded summary ---
  setColor(INK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Ringkasan", M, y);
  y += 16;

  doc.setFont("courier", "normal");
  doc.setFontSize(10);
  setColor(INK);
  const nikShown = result.nik || "(kosong)";
  doc.text(`NIK : ${nikShown}`, M, y);
  y += 14;

  const d = result.decoded;
  if (d) {
    const dob = `${String(d.realDay).padStart(2, "0")}-${String(d.mm).padStart(2, "0")}-${d.year}`;
    doc.text(`Decoded : ${dob}, ${d.sex}`, M, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    if (d.code2 || d.kecName) {
      const region =
        `Wilayah : Prov ${d.code2 || "?"} (${d.provName || "?"}), ` +
        `Kab/Kota ${d.code4 || "?"} (${d.kabName || "?"}), ` +
        `Kec ${d.code6 || "?"} (${d.kecName || "?"})`;
      const lines = doc.splitTextToSize(region, contentW);
      doc.text(lines, M, y);
      y += lines.length * 13;
    }
  }
  y += 8;

  // --- Checks ---
  setColor(INK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Hasil pemeriksaan", M, y);
  y += 16;

  for (const c of result.checks || []) {
    ensureSpace(34);
    const sc = STATUS_COLOR[c.status] || STATUS_COLOR.NA;

    // status tag + label
    doc.setFont("courier", "bold");
    doc.setFontSize(10);
    setColor(sc);
    doc.text(`[${c.status}]`, M, y);

    doc.setFont("helvetica", "bold");
    setColor(INK);
    const labelLines = doc.splitTextToSize(c.label, contentW - 52);
    doc.text(labelLines, M + 52, y);
    y += Math.max(labelLines.length, 1) * 13;

    // reason
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    setColor(SOFT);
    const reasonLines = doc.splitTextToSize(c.reason || "", contentW - 52);
    ensureSpace(reasonLines.length * 12 + 6);
    doc.text(reasonLines, M + 52, y);
    y += reasonLines.length * 12 + 8;
  }

  // --- Disclaimer footer ---
  ensureSpace(60);
  y += 6;
  doc.setDrawColor(220, 214, 199);
  doc.setLineWidth(0.5);
  doc.line(M, y, pageW - M, y);
  y += 14;

  setColor(SOFT);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  const discLines = doc.splitTextToSize(SCREENING_DISCLAIMER, contentW);
  doc.text(discLines, M, y);
  y += discLines.length * 12 + 6;

  const note = doc.splitTextToSize(
    "Dokumen ini dihasilkan otomatis oleh Morby di perangkat pengguna sebagai alat bantu skrining, bukan keputusan kredit.",
    contentW
  );
  doc.text(note, M, y);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `laporan_nik_${(result.nik || "nik").slice(0, 16)}_${stamp}.pdf`;
  return { filename, blob: doc.output("blob") };
}
