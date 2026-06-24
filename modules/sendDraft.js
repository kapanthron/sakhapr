/* ============================================================================
   modules/sendDraft.js  —  Path A send: prefilled email draft (mailto)
   A browser cannot attach a file to an email. So the app downloads the bundle
   locally and opens a prefilled draft (subject + body only); the sales person
   attaches the downloaded bundle and sends from their own the Bank mailbox.

   This is the single trust boundary: data leaves the device only when the human
   attaches and sends.
   ============================================================================ */

export const RECIPIENT = "hendrik.panthron@uob.co.id";
export const SUBJECT = "Moggy lead + eKTP screening";

/**
 * Compose the mailto: URL with a summary body and an attach reminder.
 * @param {{productName?:string, prescreenLabel?:string, prescreenDone?:boolean,
 *          nikVerdict?:string, bundleName:string, bundleSize?:string}} s
 * @returns {string} mailto URL
 */
export function buildMailto(s) {
  const lines = [
    "Halo Tim the response team the Bank,",
    "",
    "Berikut lead KPR dari Moggy beserta hasil skrining eKTP (PARIKSA).",
    "",
    `Produk           : ${s.productName || "(belum dipilih)"}`,
    `Prescreen        : ${s.prescreenLabel || "(tidak ada)"}${s.prescreenDone ? " — selesai" : ""}`,
    `Verdict NIK      : ${s.nikVerdict || "(belum diperiksa)"}`,
    "",
    `Mohon LAMPIRKAN file paket yang sudah diunduh: ${s.bundleName}` +
      (s.bundleSize ? ` (${s.bundleSize})` : ""),
    "Paket berisi: transkrip prescreen (file a), gambar eKTP (file b), dan laporan skrining NIK (file c).",
    "",
    "Catatan: skrining NIK hanya alat bantu struktur/konsistensi, bukan bukti keaslian dokumen dan bukan keputusan kredit. Verifikasi akhir oleh petugas.",
    "",
    "Terima kasih.",
  ];
  const body = lines.join("\r\n");
  return `mailto:${encodeURIComponent(RECIPIENT)}?subject=${encodeURIComponent(SUBJECT)}&body=${encodeURIComponent(body)}`;
}

/** Open the prefilled draft in the user's mail client. */
export function openMailDraft(summary) {
  window.location.href = buildMailto(summary);
}
