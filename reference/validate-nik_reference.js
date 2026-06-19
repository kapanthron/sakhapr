/*
 * validate-nik.reference.js  (PARIKSA)
 * Reference implementation of the eKTP NIK structure validator.
 * Pure, deterministic, no network. Port directly into modules/validate.js
 * (swap module.exports for an ES export).
 *
 * NIK layout (16 digits): PP RR SS DD MM YY NNNN
 *   PPRRSS = kecamatan code (first 6 digits) -> wilayah-nik.json
 *   DDMMYY = birth date; for female holders DD has 40 added
 *   NNNN   = sequence number from SIAK
 *
 * Each check returns { id, label, status: PASS|WARN|FAIL|NA, reason }.
 * Overall verdict: any FAIL -> Inconsistent; else any WARN -> Consistent with warnings; else Consistent.
 */

function normalize(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/DAERAH ISTIMEWA/g, 'DI')
    .replace(/DAERAH KHUSUS IBUKOTA/g, 'DKI')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripAdmin(s) {
  return normalize(s)
    .replace(/\b(KOTA ADMINISTRASI|KOTA ADM|ADMINISTRASI|KABUPATEN|KAB|KOTA)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function regionNameMatch(printed, resolved, level) {
  if (!printed) return null; // unreadable -> caller decides
  let a = level === 'provinsi' ? normalize(printed) : stripAdmin(printed);
  let b = level === 'provinsi' ? normalize(resolved) : stripAdmin(resolved);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function resolveYear(yy, printedDate) {
  // Prefer the printed 4 digit year; else infer a plausible century.
  if (printedDate && /^\d{2}-\d{2}-\d{4}$/.test(printedDate)) {
    return { year: parseInt(printedDate.slice(6), 10), inferred: false };
  }
  const cur = new Date().getFullYear() % 100;
  const year = yy <= cur ? 2000 + yy : 1900 + yy;
  return { year, inferred: true };
}

function isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validateNik(nikRaw, printed, dataset) {
  printed = printed || {};
  const nik = String(nikRaw == null ? '' : nikRaw).trim();
  const checks = [];
  const add = (id, label, status, reason) => checks.push({ id, label, status, reason });

  // Check 1: format
  const formatOk = /^\d{16}$/.test(nik);
  add('format', 'Format (16 digits, numeric)', formatOk ? 'PASS' : 'FAIL',
    formatOk ? '16 numeric digits.' : `Expected 16 digits, got "${nik}" (length ${nik.length}).`);

  if (!formatOk) {
    ['region', 'date', 'sex', 'birthdate', 'region_name', 'sequence'].forEach(id =>
      add(id, id, 'NA', 'Not evaluated: format failed.'));
    return finalize(nik, checks, null);
  }

  const code6 = nik.slice(0, 6);
  const code2 = nik.slice(0, 2);
  const code4 = nik.slice(0, 4);
  const dd = parseInt(nik.slice(6, 8), 10);
  const mm = parseInt(nik.slice(8, 10), 10);
  const yy = parseInt(nik.slice(10, 12), 10);
  const seq = nik.slice(12, 16);

  const provName = dataset.provinsi[code2];
  const kabName = dataset.kabupaten_kota[code4];
  const kecName = dataset.kecamatan[code6];

  // Check 2: region resolves
  if (kecName) {
    add('region', 'Region code resolves', 'PASS',
      `${kecName}, ${kabName}, ${provName}.`);
  } else {
    let level = !provName ? 'provinsi (PP)' : !kabName ? 'kabupaten/kota (RR)' : 'kecamatan (SS)';
    add('region', 'Region code resolves', 'WARN',
      `Well formed but ${level} code not found in the snapshot. Codes change over time; refresh the table.`);
  }

  // Check 3: date validity
  const female = dd > 40;
  const realDay = female ? dd - 40 : dd;
  const { year, inferred } = resolveYear(yy, printed.tanggal_lahir);
  const dateOk = realDay >= 1 && realDay <= 31 && mm >= 1 && mm <= 12 && isRealDate(year, mm, realDay);
  add('date', 'Birth date validity', dateOk ? 'PASS' : 'FAIL',
    dateOk
      ? `Decodes to ${String(realDay).padStart(2, '0')}-${String(mm).padStart(2, '0')}-${year}${inferred ? ' (century inferred)' : ''}.`
      : `Decoded day/month invalid (day ${realDay}, month ${mm}).`);

  // Check 4: sex consistency
  const inferredSex = female ? 'PEREMPUAN' : 'LAKI-LAKI';
  const printedSex = normalize(printed.jenis_kelamin);
  if (!printedSex) {
    add('sex', 'Sex consistency', 'WARN', `NIK implies ${inferredSex}; printed sex unreadable.`);
  } else if (printedSex.includes(inferredSex.replace('-', ' ')) || normalize(inferredSex) === printedSex) {
    add('sex', 'Sex consistency', 'PASS', `NIK and card agree: ${inferredSex}.`);
  } else {
    add('sex', 'Sex consistency', 'FAIL', `NIK implies ${inferredSex}, card says ${printed.jenis_kelamin}.`);
  }

  // Check 5: birth date consistency vs printed
  if (!printed.tanggal_lahir || !/^\d{2}-\d{2}-\d{4}$/.test(printed.tanggal_lahir)) {
    add('birthdate', 'Birth date consistency', 'WARN', 'Printed birth date missing or unreadable.');
  } else {
    const [pd, pm, py] = printed.tanggal_lahir.split('-').map(Number);
    const match = pd === realDay && pm === mm && (py % 100) === yy;
    add('birthdate', 'Birth date consistency', match ? 'PASS' : 'FAIL',
      match ? 'NIK date matches the printed birth date.'
            : `NIK ${String(realDay).padStart(2,'0')}-${String(mm).padStart(2,'0')}-${String(yy).padStart(2,'0')} vs card ${printed.tanggal_lahir}.`);
  }

  // Check 6: region name consistency (WARN on mismatch, never FAIL)
  if (!kecName) {
    add('region_name', 'Region name consistency', 'NA', 'Region code did not resolve.');
  } else {
    const pairs = [
      ['provinsi', printed.provinsi, provName],
      ['kabupaten/kota', printed.kabupaten_kota, kabName],
      ['kecamatan', printed.kecamatan, kecName],
    ];
    const mismatches = pairs.filter(([lvl, p, r]) => p && regionNameMatch(p, r, lvl === 'provinsi' ? 'provinsi' : 'other') === false);
    const unreadable = pairs.filter(([, p]) => !p).map(([lvl]) => lvl);
    if (mismatches.length) {
      add('region_name', 'Region name consistency', 'WARN',
        'Printed name differs from resolved: ' + mismatches.map(([lvl, p, r]) => `${lvl} "${p}" vs "${r}"`).join('; ') + '.');
    } else {
      add('region_name', 'Region name consistency', 'PASS',
        'Printed names match the resolved region' + (unreadable.length ? ` (unread: ${unreadable.join(', ')})` : '') + '.');
    }
  }

  // Check 7: sequence sanity
  add('sequence', 'Sequence number sanity', seq === '0000' ? 'WARN' : 'PASS',
    seq === '0000' ? 'Sequence 0000 is unusual.' : `Sequence ${seq}.`);

  return finalize(nik, checks, { realDay, mm, year, sex: inferredSex, kecName, kabName, provName });
}

function finalize(nik, checks, decoded) {
  const hasFail = checks.some(c => c.status === 'FAIL');
  const hasWarn = checks.some(c => c.status === 'WARN');
  const verdict = hasFail ? 'Inconsistent' : hasWarn ? 'Consistent with warnings' : 'Consistent';
  return { nik, verdict, decoded, checks };
}

module.exports = { validateNik, normalize, stripAdmin };
