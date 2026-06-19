/* ============================================================================
   modules/regionData.js  —  loads the transformed Kemendagri region table
   for the NIK validator. Public reference data (NOT personal data): three maps
   keyed by digit-only codes.
     provinsi        2-digit code -> name (34 entries)
     kabupaten_kota  4-digit code -> name (514 entries)
     kecamatan       6-digit code -> name (7230 entries)

   The table is data/wilayah_nik.json, already transformed in the starter pack
   (dots stripped). We never regenerate it here and never read the 1.18 MB raw
   source file. Loaded once and cached.
   ============================================================================ */

let dataset = null;

/**
 * Fetch and cache the region dataset.
 * @returns {Promise<{provinsi:object, kabupaten_kota:object, kecamatan:object}>}
 */
export async function loadRegionData() {
  if (dataset) return dataset;
  const res = await fetch("data/wilayah_nik.json");
  if (!res.ok) throw new Error(`HTTP ${res.status} for data/wilayah_nik.json`);
  const raw = await res.json();
  dataset = {
    provinsi: raw.provinsi || {},
    kabupaten_kota: raw.kabupaten_kota || {},
    kecamatan: raw.kecamatan || {},
  };
  return dataset;
}
