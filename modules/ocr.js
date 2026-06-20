/* ============================================================================
   modules/ocr.js  —  on-device eKTP OCR via Tesseract.js (vendored locally)
   The image is read entirely in the browser through WebAssembly. Nothing is
   uploaded: the worker, the WASM core, and the traineddata all load from
   vendor/tesseract/ (same origin), and cacheMethod is 'none' so no model is
   written to IndexedDB.

   Engine: LSTM-only (OEM 1), languages ind+eng (Indonesian KTP + Latin).
   ============================================================================ */

import Tesseract from "../vendor/tesseract/tesseract.esm.min.js";

// Absolute URLs to the vendored assets, resolved relative to this module so the
// app works whether opened at the site root or a subpath.
const asset = (f) => new URL(`../vendor/tesseract/${f}`, import.meta.url).href;

let workerPromise = null;

async function getWorker(logger) {
  if (workerPromise) return workerPromise;
  workerPromise = Tesseract.createWorker("ind+eng", 1, {
    workerPath: asset("worker.min.js"),
    corePath: asset("tesseract-core-simd-lstm.wasm.js"), // specific file: skips CDN/relaxed-simd probing
    langPath: asset(""), // directory holding ind/eng .traineddata.gz
    gzip: true,
    cacheMethod: "none", // never persist the model (no IndexedDB)
    workerBlobURL: true, // worker.min.js -> blob worker (CSP worker-src 'self' blob:)
    logger,
  });
  return workerPromise;
}

/**
 * Run OCR over an eKTP image file/blob.
 * @param {Blob} imageFile
 * @param {(m:{status:string,progress:number})=>void} [onProgress]
 * @returns {Promise<{text:string, fields:object}>}
 */
export async function runOcr(imageFile, onProgress) {
  const worker = await getWorker((m) => {
    if (onProgress && m && typeof m.progress === "number") onProgress(m);
  });
  const { data } = await worker.recognize(imageFile);
  return { text: data.text || "", fields: parseEktp(data.text || "") };
}

/** Free the OCR worker (call on Clear all data). */
export async function terminateOcr() {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch {
    /* already gone */
  }
  workerPromise = null;
}

/**
 * Best-effort extraction of the printed eKTP fields from raw OCR text. OCR is
 * imperfect, so the UI shows these as editable boxes for correction.
 * @param {string} text
 */
export function parseEktp(text) {
  const raw = String(text || "");
  const upper = raw.toUpperCase();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const onlyDigits = (s) => (s.match(/[0-9]/g) || []).join("");

  // NIK — prefer the line mentioning NIK, else the first 16-digit run anywhere.
  let nik = "";
  const nikLine = lines.find((l) => /NIK/i.test(l));
  if (nikLine) {
    const d = onlyDigits(nikLine);
    if (d.length >= 16) nik = d.slice(0, 16);
  }
  if (!nik) {
    const m = raw.replace(/[^0-9]/g, " ").match(/\d{16}/);
    if (m) nik = m[0];
  }

  // Birth date dd-mm-yyyy (tolerate separators / OCR spaces).
  let tanggal_lahir = "";
  const dm = raw.match(/(\d{2})\s*[-/.]\s*(\d{2})\s*[-/.]\s*(\d{4})/);
  if (dm) tanggal_lahir = `${dm[1]}-${dm[2]}-${dm[3]}`;

  // Sex.
  let jenis_kelamin = "";
  if (/PEREMPUAN/.test(upper)) jenis_kelamin = "PEREMPUAN";
  else if (/LAKI/.test(upper)) jenis_kelamin = "LAKI-LAKI";

  // Province (line containing PROVINSI).
  let provinsi = "";
  const provLine = lines.find((l) => /PROVINSI/i.test(l));
  if (provLine) provinsi = provLine.replace(/.*PROVINSI/i, "").trim();

  // Kabupaten/Kota header line (starts with KOTA or KABUPATEN).
  let kabupaten_kota = "";
  const kabLine = lines.find((l) => /^(KOTA|KABUPATEN)\b/i.test(l));
  if (kabLine) kabupaten_kota = kabLine.trim();

  // Kecamatan (line containing KECAMATAN).
  let kecamatan = "";
  const kecLine = lines.find((l) => /KECAMATAN/i.test(l));
  if (kecLine) kecamatan = kecLine.replace(/.*KECAMATAN\s*:?/i, "").trim();

  return { nik, tanggal_lahir, jenis_kelamin, provinsi, kabupaten_kota, kecamatan };
}
