/* ============================================================================
   modules/geminiOcr.js  —  client for the server-side Gemini Vision OCR
   Posts the eKTP image to /api/ocr; the Worker forwards it to Gemini and returns
   structured fields + a face-photo bounding box. Far more accurate than the
   on-device Tesseract fallback. Throws on any failure so the caller can fall
   back to runOcr().

   Privacy note: this path sends the eKTP image to Google (Gemini). It must be
   covered by the displayed consent and the DPIA.
   ============================================================================ */

/**
 * @param {Blob} file  the eKTP image
 * @returns {Promise<{fields:object, photo_box:number[]|null, model:string}>}
 */
export async function geminiOcr(file, timeoutMs = 30000) {
  const fd = new FormData();
  fd.append("ektp", file);
  // Abort a slow/hanging server (e.g. rate-limited upstream) so the caller can
  // fall back to on-device OCR instead of waiting forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch("/api/ocr", { method: "POST", body: fd, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let msg = `OCR HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "OCR gagal");
  return data;
}

function loadImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Gagal memuat gambar.")); };
    img.src = url;
  });
}

/**
 * Crop the face photo client-side from Gemini's bounding box. Box is
 * [ymin, xmin, ymax, xmax] normalised to 0–1000 over the whole image. Adds a
 * little padding (more at the bottom for shoulders + the caption strip).
 * @returns {Promise<Blob|null>}
 */
export async function cropByBox(file, box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const img = await loadImg(file);
  const W = img.naturalWidth, H = img.naturalHeight;
  let [ymin, xmin, ymax, xmax] = box.map(Number);
  if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) return null;

  let x0 = (Math.min(xmin, xmax) / 1000) * W;
  let y0 = (Math.min(ymin, ymax) / 1000) * H;
  let x1 = (Math.max(xmin, xmax) / 1000) * W;
  let y1 = (Math.max(ymin, ymax) / 1000) * H;
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;

  x0 = Math.max(0, x0 - w * 0.06);
  y0 = Math.max(0, y0 - h * 0.06);
  x1 = Math.min(W, x1 + w * 0.06);
  y1 = Math.min(H, y1 + h * 0.18); // room for shoulders + the place/date caption
  const cw = Math.round(x1 - x0), ch = Math.round(y1 - y0);
  if (cw < 8 || ch < 8) return null;

  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  c.getContext("2d").drawImage(img, Math.round(x0), Math.round(y0), cw, ch, 0, 0, cw, ch);
  return await new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.92));
}
