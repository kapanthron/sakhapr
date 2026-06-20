/* ============================================================================
   modules/bundle.js  —  builds the 3-file lead package as one .zip under 5 MB
   Combines file a (prescreen .txt), file b (eKTP image), and file c (NIK report
   .pdf) into a single zip. If the total exceeds 5 MB, the eKTP image is
   downscaled/re-encoded with a canvas until the package fits. All in-memory.

   Uses fflate (vendored locally at vendor/fflate/fflate.esm.js).
   ============================================================================ */

import { zipSync } from "../vendor/fflate/fflate.esm.js";

export const MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard ceiling

const u8 = async (blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * Re-encode an image blob to JPEG at a given max dimension and quality.
 * @returns {Promise<Blob>}
 */
function reencodeImage(blob, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error("toBlob returned null"))),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Gagal memuat gambar eKTP untuk diperkecil."));
    };
    img.src = url;
  });
}

/**
 * Shrink the image until imageBytes <= budget (or options run out).
 * @returns {Promise<{blob:Blob, downscaled:boolean}>}
 */
async function fitImage(imageBlob, budget) {
  if (imageBlob.size <= budget) return { blob: imageBlob, downscaled: false };

  const dims = [2000, 1600, 1280, 1024, 800, 640];
  const qualities = [0.8, 0.6, 0.45];
  let best = imageBlob;
  for (const dim of dims) {
    for (const q of qualities) {
      // eslint-disable-next-line no-await-in-loop
      const candidate = await reencodeImage(imageBlob, dim, q);
      if (candidate.size < best.size) best = candidate;
      if (candidate.size <= budget) return { blob: candidate, downscaled: true };
    }
  }
  // Could not reach the budget; return the smallest we achieved.
  return { blob: best, downscaled: true };
}

/**
 * Build the lead package.
 * @param {{fileA:Blob, fileB:Blob, fileC:Blob, baseName?:string}} parts
 * @returns {Promise<{blob:Blob, filename:string, sizeBytes:number, fits:boolean,
 *                    imageDownscaled:boolean, finalImageBytes:number, entries:object}>}
 */
export async function buildBundle({ fileA, fileB, fileC, baseName }) {
  if (!fileA || !fileB || !fileC) {
    throw new Error("Paket membutuhkan file a (transkrip), file b (eKTP), dan file c (laporan).");
  }

  const overhead = 64 * 1024; // headroom for zip structure + a/c files
  const budget = MAX_BYTES - fileA.size - fileC.size - overhead;
  const { blob: imageBlob, downscaled } = await fitImage(fileB, budget);

  const imageName = downscaled ? "eKTP.jpg" : `eKTP${extFromType(fileB.type)}`;
  const files = {
    "prescreen.txt": await u8(fileA),
    [imageName]: await u8(imageBlob),
    "laporan_nik.pdf": await u8(fileC),
  };

  const zipped = zipSync(files, { level: 0 }); // store: image is already compressed
  const blob = new Blob([zipped], { type: "application/zip" });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    blob,
    filename: `${baseName || "sakhapr_lead"}_${stamp}.zip`,
    sizeBytes: blob.size,
    fits: blob.size <= MAX_BYTES,
    imageDownscaled: downscaled,
    finalImageBytes: imageBlob.size,
    entries: Object.keys(files),
  };
}

function extFromType(type) {
  if (/png/.test(type)) return ".png";
  if (/jpe?g/.test(type)) return ".jpg";
  if (/webp/.test(type)) return ".webp";
  return ".img";
}

/** Human-readable size. */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
