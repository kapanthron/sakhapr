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

  // Pass 2: NIK-focused. Crop to the digit value only (excluding the "NIK :"
  // label, whose colon would otherwise be read as a leading "1"), upscale, then
  // re-read with a digits-only whitelist. The parsed birth date anchors the
  // 16-digit window so a stray edge mark can't shift the number.
  try {
    const hintDob = (fields.tanggal_lahir || "").replace(/\D/g, ""); // ddmmyyyy
    const focused = await readNikFocused(worker, canvas, data, hintDob);
    // Only override the pass-1 NIK when the focused read is at least as
    // internally consistent (valid date, matches the card's birth date, …).
    if (focused.nik && focused.score >= scoreNik(fields.nik, hintDob)) fields.nik = focused.nik;
  } catch (err) {
    /* keep the pass-1 NIK */
  }

  // Auto-crop the printed photo (pasfoto) for the admin Pariksa download.
  let photo = null;
  try { photo = await cropEktpPhoto(imageFile, canvas, data); } catch { photo = null; }

  return { text, fields, photo };
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

/**
 * Find the bbox of just the NIK *value* (the digits), excluding the "NIK :"
 * label. The colon, under a digits-only whitelist, is read as a spurious "1"
 * that prepends to the number — so we crop to the digit words only.
 */
function findNikValueBbox(data) {
  const blocks = data && data.blocks;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    for (const p of (b.paragraphs || [])) {
      for (const l of (p.lines || [])) {
        if (!/n\s*[i1l]\s*k/i.test(l.text || "") || !/\d/.test(l.text || "")) continue;
        const words = (l.words || []).filter((w) => w && w.bbox);
        const valWords = words.filter((w) => {
          const t = String(w.text || "");
          const letters = t.replace(/[^a-z]/gi, "");
          if (/^n[i1l]k$/i.test(letters)) return false;          // the "NIK" label word
          return digitFix(t).replace(/\D/g, "").length >= 3;      // a real chunk of digits
        });
        const pick = valWords.length ? valWords : words;
        if (!pick.length) return l.bbox || null;
        return {
          x0: Math.min(...pick.map((w) => w.bbox.x0)),
          y0: Math.min(...pick.map((w) => w.bbox.y0)),
          x1: Math.max(...pick.map((w) => w.bbox.x1)),
          y1: Math.max(...pick.map((w) => w.bbox.y1)),
        };
      }
    }
  }
  return null;
}

function cropCanvas(src, bbox, scale = 1) {
  const pad = 8;
  const x = Math.max(0, Math.floor(bbox.x0 - pad));
  const y = Math.max(0, Math.floor(bbox.y0 - pad));
  const w = Math.min(src.width - x, Math.ceil(bbox.x1 - bbox.x0 + pad * 2));
  const h = Math.min(src.height - y, Math.ceil(bbox.y1 - bbox.y0 + pad * 2));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = true;
  cx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

/**
 * Otsu binarisation: pick the global threshold that best separates ink from
 * paper, then render pure black-on-white. Tesseract is markedly more accurate on
 * a clean bitonal image than on a grey phone photo.
 */
function otsuBinarize(src) {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    hist[g]++;
  }
  const total = c.width * c.height;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, max = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thr = t; }
  }
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const v = g > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

/**
 * Score a 16-digit NIK by internal consistency, so we can pick the best read
 * among several OCR attempts. Higher = more likely correct.
 * @param {string} nik
 * @param {string} hintDob  ddmmyyyy from the card's printed birth date
 */
function scoreNik(nik, hintDob) {
  if (!/^\d{16}$/.test(nik)) return -1;
  let score = 0;
  let dd = +nik.slice(6, 8);
  const mm = +nik.slice(8, 10);
  const yy = nik.slice(10, 12);
  if (dd > 40) dd -= 40;            // females: day + 40
  if (dd >= 1 && dd <= 31) score += 2;
  if (mm >= 1 && mm <= 12) score += 2;
  const pp = +nik.slice(0, 2);
  if (pp >= 11 && pp <= 94) score += 1; // plausible province code
  if (nik.slice(12) !== "0000") score += 1;
  const dob = String(hintDob || "").replace(/\D/g, ""); // ddmmyyyy
  if (dob.length === 8) {
    const cardDD = +dob.slice(0, 2), cardMM = +dob.slice(2, 4), cardYY = dob.slice(6, 8);
    if (mm === cardMM) score += 3;
    if (yy === cardYY) score += 3;
    if (dd === cardDD) score += 3;   // strongest single signal
  }
  return score;
}

/**
 * Pick the 16-digit NIK from a noisy digit string. Label/edge artifacts cling
 * to the LEFT, so on an overshoot the true number is right-aligned. The birth
 * date (positions 9–12 = MMYY) anchors the correct window when available.
 * @param {string} text     raw recognised text (any chars)
 * @param {string} hintDob  ddmmyyyy from the parsed birth date (optional)
 */
function pickNik(text, hintDob) {
  const digits = String(text || "").replace(/\D/g, "");
  if (digits.length < 16) {
    const m = digits.match(/\d{16}/);
    return m ? m[0] : "";
  }
  if (digits.length === 16) return digits;
  const cands = [];
  for (let i = 0; i + 16 <= digits.length; i++) cands.push(digits.slice(i, i + 16));
  // Prefer the window that best matches the card's birth date, else right-aligned.
  let best = cands[cands.length - 1], bestScore = -1;
  for (const c of cands) {
    const s = scoreNik(c, hintDob);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

/**
 * Re-OCR the NIK region across several binarisation + page-segmentation variants
 * and keep the most internally-consistent 16-digit read. Returns {nik, score}.
 */
async function readNikFocused(worker, canvas, data, hintDob) {
  const bbox = findNikValueBbox(data) || findNikBbox(data);
  let region = canvas;
  if (bbox && canvas && canvas.getContext) region = cropCanvas(canvas, bbox, 3); // upscale 3× for legibility
  const variants = bbox ? [otsuBinarize(region), region] : [region];
  const psms = bbox ? ["7", "13"] : ["6"]; // 7 = single line, 13 = raw line
  const tally = new Map(); // nik -> { count, score }
  try {
    await worker.setParameters({ tessedit_char_whitelist: "0123456789" });
    for (const v of variants) {
      for (const psm of psms) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        const { data: d2 } = await worker.recognize(v);
        const nik = pickNik(d2.text || "", hintDob);
        if (/^\d{16}$/.test(nik)) {
          const e = tally.get(nik) || { count: 0, score: scoreNik(nik, hintDob) };
          e.count++;
          tally.set(nik, e);
        }
      }
    }
  } finally {
    try { await worker.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "6" }); } catch { /* ignore */ }
  }
  // Best = highest structural score, tie-broken by how often it was read.
  let best = "", bestScore = -1, bestKey = -2;
  for (const [nik, e] of tally) {
    const key = e.score * 10 + e.count;
    if (key > bestKey) { bestKey = key; best = nik; bestScore = e.score; }
  }
  return { nik: best, score: bestScore };
}

/**
 * Locate the printed photo (pasfoto) region from the OCR text layout: it is the
 * column to the RIGHT of the data block, from the NIK line down to the bottom of
 * that block. Coordinates are in the preprocessed-canvas space.
 */
function findPhotoRegion(data, cw, ch) {
  const words = [];
  for (const b of (data.blocks || []))
    for (const p of (b.paragraphs || []))
      for (const l of (p.lines || []))
        for (const w of (l.words || [])) if (w && w.bbox) words.push(w);
  if (!words.length) return null;

  const leftCol = words.filter((w) => w.bbox.x0 < cw * 0.55); // the label/value column
  const textRight = leftCol.length ? Math.max(...leftCol.map((w) => w.bbox.x1)) : cw * 0.6;
  const rightExtent = Math.max(...words.map((w) => w.bbox.x1));
  const nik = findNikBbox(data);
  const headerWords = words.filter((w) => /provinsi|kabupaten|kota/i.test(w.text || ""));
  const headerBottom = headerWords.length ? Math.max(...headerWords.map((w) => w.bbox.y1)) : ch * 0.18;
  const top = nik ? nik.y0 : headerBottom;
  const bottom = Math.max(ch * 0.55, ...leftCol.map((w) => w.bbox.y1));

  const gap = cw * 0.015;
  let x0 = Math.min(textRight + gap, cw * 0.9);
  let x1 = Math.min(cw, rightExtent + gap);
  if (x1 - x0 < cw * 0.12) x1 = cw; // ensure a sensible width
  const y0 = Math.max(0, top - ch * 0.01);
  const y1 = Math.min(ch, bottom + ch * 0.02);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Detect the printed photo by its SOLID coloured background. eKTP photos sit on
 * a saturated red or blue panel, unlike the card's pale low-saturation
 * watermark. We mark those pixels on a downscaled copy, take the largest
 * connected blob, and return its bounding box in source-image coordinates.
 */
function detectPhotoBox(srcCanvas) {
  const W = 200;
  const scale = W / srcCanvas.width;
  const H = Math.max(1, Math.round(srcCanvas.height * scale));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.drawImage(srcCanvas, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;

  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const isRed = r > 110 && r - g > 35 && r - b > 35;        // red/orange panel
    const isBlue = b > 90 && b - r > 25 && b - g > -10 && max < 240; // blue panel
    if (sat > 0.32 && (isRed || isBlue)) mask[i] = 1;
  }

  // Largest 4-connected component.
  const seen = new Uint8Array(W * H);
  const stack = [];
  let best = { area: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) continue;
    seen[i] = 1; stack.length = 0; stack.push(i);
    let area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (stack.length) {
      const p = stack.pop();
      const px = p % W, py = (p / W) | 0;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (px < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (py < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    if (area > best.area) best = { area, x0, y0, x1, y1 };
  }
  if (best.area < W * H * 0.008) return null; // no convincing colour panel
  return {
    x0: best.x0 / scale, y0: best.y0 / scale,
    x1: (best.x1 + 1) / scale, y1: (best.y1 + 1) / scale,
  };
}

/**
 * Auto-crop the eKTP photo from the original (colour) image; returns a Blob.
 * Primary method: detect the coloured photo panel. Fallback: OCR text layout.
 */
async function cropEktpPhoto(imageFile, canvas, data) {
  const img = await loadImage(imageFile);
  const full = document.createElement("canvas");
  full.width = img.width; full.height = img.height;
  full.getContext("2d").drawImage(img, 0, 0);

  let box = detectPhotoBox(full);
  if (box) {
    const ar = (box.x1 - box.x0) / (box.y1 - box.y0); // eKTP photo ≈ 3:4 (0.75)
    if (ar < 0.45 || ar > 1.25) box = null;           // implausible → fall back
  }
  if (!box && canvas && data) {
    const region = findPhotoRegion(data, canvas.width, canvas.height);
    if (region) {
      const rx = img.width / canvas.width, ry = img.height / canvas.height;
      box = { x0: region.x0 * rx, y0: region.y0 * ry, x1: region.x1 * rx, y1: region.y1 * ry };
    }
  }
  if (!box) return null;

  // Pad: small on sides/top, more at the bottom to include shoulders + caption.
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const x = Math.max(0, Math.round(box.x0 - w * 0.08));
  const y = Math.max(0, Math.round(box.y0 - h * 0.08));
  const x1 = Math.min(img.width, Math.round(box.x1 + w * 0.08));
  const y1 = Math.min(img.height, Math.round(box.y1 + h * 0.22));
  const cw = x1 - x, ch = y1 - y;
  if (cw < 8 || ch < 8) return null;
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  c.getContext("2d").drawImage(img, x, y, cw, ch, 0, 0, cw, ch);
  return await new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.92));
}

/**
 * Deterministic, OCR-independent face-photo crop (coloured-panel detection).
 * Use this for the pas foto so its quality does not depend on the LLM model.
 * @param {Blob} imageFile
 * @returns {Promise<Blob|null>}
 */
export async function cropFacePhoto(imageFile) {
  try { return await cropEktpPhoto(imageFile); } catch { return null; }
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
function extractNik(raw, hintDob) {
  const lines = raw.split(/\r?\n/);
  const tryGet = (s) => pickNik(digitFix(s), hintDob);
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

  // Birth date dd-mm-yyyy (tolerate separators / OCR spaces). Computed first so
  // it can anchor the NIK's date digits.
  let tanggal_lahir = "";
  const dm = raw.match(/(\d{2})\s*[-/.]\s*(\d{2})\s*[-/.]\s*(\d{4})/);
  if (dm) tanggal_lahir = `${dm[1]}-${dm[2]}-${dm[3]}`;

  const nik = extractNik(raw, tanggal_lahir.replace(/\D/g, ""));

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
