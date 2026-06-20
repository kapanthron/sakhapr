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
  workerPromise = (async () => {
    const w = await Tesseract.createWorker("ind+eng", 1, {
      workerPath: asset("worker.min.js"),
      corePath: asset("tesseract-core-simd-lstm.wasm.js"), // specific file: skips CDN/relaxed-simd probing
      langPath: asset(""), // directory holding ind/eng .traineddata.gz
      gzip: true,
      cacheMethod: "none", // never persist the model (no IndexedDB)
      workerBlobURL: true, // worker.min.js -> blob worker (CSP worker-src 'self' blob:)
      logger,
    });
    // PSM 6 = a single uniform block of text (good for an ID card).
    try { await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" }); } catch { /* ignore */ }
    return w;
  })();
  return workerPromise;
}

/** Load an image blob into an <img>. */
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Gagal memuat gambar.")); };
    img.src = url;
  });
}

/**
 * Pre-process for OCR: scale to a legible width, greyscale, and stretch contrast.
 * This markedly improves NIK/field recognition on phone photos.
 * @returns {Promise<HTMLCanvasElement>}
 */
async function preprocess(blob) {
  const img = await loadImage(blob);
  const targetW = Math.min(2000, Math.max(1200, img.width)); // upscale small, cap large
  const ratio = targetW / img.width;
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let v = (g - 128) * 1.3 + 128; // mild contrast; let Tesseract binarise
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
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
  let canvas = imageFile;
  try { canvas = await preprocess(imageFile); } catch { canvas = imageFile; }

  // Pass 1: full OCR (text + word boxes).
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const text = data.text || "";
  const fields = parseEktp(text);

  // Pass 2: NIK-focused. Crop the NIK line if we can locate it, then re-read
  // with a digits-only whitelist (Tesseract can't substitute letters), which
  // is markedly more accurate for the 16-digit number.
  try {
    const nik = await readNikFocused(worker, canvas, data);
    if (nik) fields.nik = nik;
  } catch (err) {
    /* keep the pass-1 NIK */
  }
  return { text, fields };
}

/** Find the bbox of the line that contains the NIK, from Tesseract blocks. */
function findNikBbox(data) {
  const blocks = data && data.blocks;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    for (const p of (b.paragraphs || [])) {
      for (const l of (p.lines || [])) {
        if (/n\s*[i1l]\s*k/i.test(l.text || "") && /\d/.test(l.text || "")) return l.bbox || null;
      }
    }
  }
  return null;
}

function cropCanvas(src, bbox) {
  const pad = 8;
  const x = Math.max(0, Math.floor(bbox.x0 - pad));
  const y = Math.max(0, Math.floor(bbox.y0 - pad));
  const w = Math.min(src.width - x, Math.ceil(bbox.x1 - bbox.x0 + pad * 2));
  const h = Math.min(src.height - y, Math.ceil(bbox.y1 - bbox.y0 + pad * 2));
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  c.getContext("2d").drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

/** Re-OCR the NIK region with a digits-only whitelist; returns 16 digits or "". */
async function readNikFocused(worker, canvas, data) {
  const bbox = findNikBbox(data);
  let region = canvas;
  if (bbox && canvas && canvas.getContext) region = cropCanvas(canvas, bbox);
  try {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: bbox ? "7" : "6", // 7 = single line (cropped); else block
    });
    const { data: d2 } = await worker.recognize(region);
    const digits = (d2.text || "").replace(/[^0-9]/g, "");
    const m = digits.match(/\d{16}/);
    return m ? m[0] : "";
  } finally {
    // Restore defaults for the next card.
    try { await worker.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "6" }); } catch { /* ignore */ }
  }
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
/** Map common OCR letter↔digit confusions to digits (for NIK only). */
function digitFix(s) {
  return s
    .replace(/[OoQ]/g, "0").replace(/[IilL|!]/g, "1").replace(/[Bb]/g, "8")
    .replace(/[Ss]/g, "5").replace(/[Zz]/g, "2").replace(/[Tt]/g, "7")
    .replace(/[gqG]/g, "9").replace(/[A]/g, "4").replace(/[eE]/g, "3");
}

/** Pull a 16-digit NIK out of OCR text, tolerating letter↔digit confusions. */
function extractNik(raw) {
  const lines = raw.split(/\r?\n/);
  const tryGet = (s) => {
    const fixed = digitFix(s).replace(/[^0-9]/g, "");
    const m = fixed.match(/\d{16}/);
    return m ? m[0] : "";
  };
  // 1) The line that mentions NIK (best signal), text after the label first.
  const nikLine = lines.find((l) => /n\s*[i1l]\s*k/i.test(l));
  if (nikLine) {
    const after = nikLine.replace(/.*n\s*[i1l]\s*k\s*[:.\-]?/i, "");
    const n = tryGet(after) || tryGet(nikLine);
    if (n) return n;
  }
  // 2) Any line with ~16 alphanumerics that fixes to 16 digits.
  for (const l of lines) {
    if ((l.replace(/[^0-9A-Za-z]/g, "").length) >= 16) {
      const n = tryGet(l);
      if (n) return n;
    }
  }
  // 3) Last resort: a plain 16-digit run anywhere.
  const m = raw.replace(/[^0-9]/g, " ").match(/\d{16}/);
  return m ? m[0] : "";
}

export function parseEktp(text) {
  const raw = String(text || "");
  const upper = raw.toUpperCase();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const nik = extractNik(raw);

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
