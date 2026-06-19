# PARIKSA — NIK Test Fixtures

Synthetic cases for the PARIKSA validator. Names and numbers are fabricated for testing only and do not belong to real people. Expected results were computed by `validate-nik.reference.js` against the bundled region table.

Verdict rule: any FAIL gives **Inconsistent**; otherwise any WARN gives **Consistent with warnings**; otherwise **Consistent**.

## Known good

### G1 — Clean male card, everything agrees.

- NIK: `3175061708950001`
- Card: LAKI-LAKI, born 17-08-1995, CAKUNG, KOTA ADMINISTRASI JAKARTA TIMUR, DKI JAKARTA
- Expected verdict: **Consistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Cakung, Kota Administrasi Jakarta Timur, DKI Jakarta. |
| Birth date validity | PASS | Decodes to 17-08-1995. |
| Sex consistency | PASS | NIK and card agree: LAKI-LAKI. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | PASS | Sequence 0001. |

### G2 — Female card; tests the day +40 rule.

- NIK: `3203016503880002`
- Card: PEREMPUAN, born 25-03-1988, CIANJUR, KABUPATEN CIANJUR, JAWA BARAT
- Expected verdict: **Consistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Cianjur, Kab. Cianjur, Jawa Barat. |
| Birth date validity | PASS | Decodes to 25-03-1988. |
| Sex consistency | PASS | NIK and card agree: PEREMPUAN. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | PASS | Sequence 0002. |

### G3 — Tests name normalization: "DAERAH ISTIMEWA YOGYAKARTA" vs table "DI Yogyakarta" should still PASS.

- NIK: `3402010102000003`
- Card: LAKI-LAKI, born 01-02-2000, SRANDAKAN, KABUPATEN BANTUL, DAERAH ISTIMEWA YOGYAKARTA
- Expected verdict: **Consistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Srandakan, Kab. Bantul, DI Yogyakarta. |
| Birth date validity | PASS | Decodes to 01-02-2000. |
| Sex consistency | PASS | NIK and card agree: LAKI-LAKI. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | PASS | Sequence 0003. |

## Warnings (well formed, soft issues)

### W1 — Stale/unknown kecamatan code (317599). Province and kabupaten resolve, kecamatan does not. (DPIA risk R6.)

- NIK: `3175991708950011`
- Card: LAKI-LAKI, born 17-08-1995, SOMETHING NEW, KOTA ADMINISTRASI JAKARTA TIMUR, DKI JAKARTA
- Expected verdict: **Consistent with warnings**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | WARN | Well formed but kecamatan (SS) code not found in the snapshot. Codes change over time; refresh the table. |
| Birth date validity | PASS | Decodes to 17-08-1995. |
| Sex consistency | PASS | NIK and card agree: LAKI-LAKI. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | n/a | Region code did not resolve. |
| Sequence number sanity | PASS | Sequence 0011. |

### W2 — Sequence number 0000 is unusual.

- NIK: `3203011708900000`
- Card: LAKI-LAKI, born 17-08-1990, CIANJUR, KABUPATEN CIANJUR, JAWA BARAT
- Expected verdict: **Consistent with warnings**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Cianjur, Kab. Cianjur, Jawa Barat. |
| Birth date validity | PASS | Decodes to 17-08-1990. |
| Sex consistency | PASS | NIK and card agree: LAKI-LAKI. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | WARN | Sequence 0000 is unusual. |

### W3 — Printed sex unreadable, so sex cross check cannot be made.

- NIK: `3174051203850005`
- Card: (sex blank), born 12-03-1985, KEBAYORAN LAMA, KOTA ADMINISTRASI JAKARTA SELATAN, DKI JAKARTA
- Expected verdict: **Consistent with warnings**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Kebayoran Lama, Kota Administrasi Jakarta Selatan, DKI Jakarta. |
| Birth date validity | PASS | Decodes to 12-03-1985. |
| Sex consistency | WARN | NIK implies LAKI-LAKI; printed sex unreadable. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | PASS | Sequence 0005. |

### W4 — Printed kecamatan name differs from the resolved name (genuine mismatch, not a variant).

- NIK: `3203011708920006`
- Card: LAKI-LAKI, born 17-08-1992, CIBEBER, KABUPATEN CIANJUR, JAWA BARAT
- Expected verdict: **Consistent with warnings**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Cianjur, Kab. Cianjur, Jawa Barat. |
| Birth date validity | PASS | Decodes to 17-08-1992. |
| Sex consistency | PASS | NIK and card agree: LAKI-LAKI. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | WARN | Printed name differs from resolved: kecamatan "CIBEBER" vs "Cianjur". |
| Sequence number sanity | PASS | Sequence 0006. |

## Known bad (hard failures)

### B1 — Only 15 digits.

- NIK: `317506170895001`
- Card: LAKI-LAKI, born 17-08-1995, CAKUNG, KOTA ADMINISTRASI JAKARTA TIMUR, DKI JAKARTA
- Expected verdict: **Inconsistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | FAIL | Expected 16 digits, got "317506170895001" (length 15). |
| region | n/a | Not evaluated: format failed. |
| date | n/a | Not evaluated: format failed. |
| sex | n/a | Not evaluated: format failed. |
| birthdate | n/a | Not evaluated: format failed. |
| region_name | n/a | Not evaluated: format failed. |
| sequence | n/a | Not evaluated: format failed. |

### B2 — Contains a letter O instead of a zero.

- NIK: `31750617O8950001`
- Card: LAKI-LAKI, born 17-08-1995, CAKUNG, KOTA ADMINISTRASI JAKARTA TIMUR, DKI JAKARTA
- Expected verdict: **Inconsistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | FAIL | Expected 16 digits, got "31750617O8950001" (length 16). |
| region | n/a | Not evaluated: format failed. |
| date | n/a | Not evaluated: format failed. |
| sex | n/a | Not evaluated: format failed. |
| birthdate | n/a | Not evaluated: format failed. |
| region_name | n/a | Not evaluated: format failed. |
| sequence | n/a | Not evaluated: format failed. |

### B3 — NIK day is 65 (female coded) but card says LAKI-LAKI.

- NIK: `3203016503880007`
- Card: LAKI-LAKI, born 25-03-1988, CIANJUR, KABUPATEN CIANJUR, JAWA BARAT
- Expected verdict: **Inconsistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Cianjur, Kab. Cianjur, Jawa Barat. |
| Birth date validity | PASS | Decodes to 25-03-1988. |
| Sex consistency | FAIL | NIK implies PEREMPUAN, card says LAKI-LAKI. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | PASS | Sequence 0007. |

### B4 — NIK encodes 17-08-1995 but the card prints 18-08-1995.

- NIK: `3175061708950008`
- Card: LAKI-LAKI, born 18-08-1995, CAKUNG, KOTA ADMINISTRASI JAKARTA TIMUR, DKI JAKARTA
- Expected verdict: **Inconsistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Cakung, Kota Administrasi Jakarta Timur, DKI Jakarta. |
| Birth date validity | PASS | Decodes to 17-08-1995. |
| Sex consistency | PASS | NIK and card agree: LAKI-LAKI. |
| Birth date consistency | FAIL | NIK 17-08-95 vs card 18-08-1995. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | PASS | Sequence 0008. |

### B5 — NIK day field is 35 (not female coded, and not a valid day).

- NIK: `3203013503900009`
- Card: LAKI-LAKI, born (date blank), CIANJUR, KABUPATEN CIANJUR, JAWA BARAT
- Expected verdict: **Inconsistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Cianjur, Kab. Cianjur, Jawa Barat. |
| Birth date validity | FAIL | Decoded day/month invalid (day 35, month 3). |
| Sex consistency | PASS | NIK and card agree: LAKI-LAKI. |
| Birth date consistency | WARN | Printed birth date missing or unreadable. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | PASS | Sequence 0009. |

### B6 — NIK day is 12 (male coded) but card says PEREMPUAN.

- NIK: `3174051203850010`
- Card: PEREMPUAN, born 12-03-1985, KEBAYORAN LAMA, KOTA ADMINISTRASI JAKARTA SELATAN, DKI JAKARTA
- Expected verdict: **Inconsistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | PASS | Kebayoran Lama, Kota Administrasi Jakarta Selatan, DKI Jakarta. |
| Birth date validity | PASS | Decodes to 12-03-1985. |
| Sex consistency | FAIL | NIK implies LAKI-LAKI, card says PEREMPUAN. |
| Birth date consistency | PASS | NIK date matches the printed birth date. |
| Region name consistency | PASS | Printed names match the resolved region. |
| Sequence number sanity | PASS | Sequence 0010. |

### B7 — Unknown region code AND impossible month: a FAIL outranks the WARN.

- NIK: `3299991345000011`
- Card: LAKI-LAKI, born (date blank), UNKNOWN, UNKNOWN, JAWA BARAT
- Expected verdict: **Inconsistent**

| Check | Status | Reason |
|---|---|---|
| Format (16 digits, numeric) | PASS | 16 numeric digits. |
| Region code resolves | WARN | Well formed but kabupaten/kota (RR) code not found in the snapshot. Codes change over time; refresh the table. |
| Birth date validity | FAIL | Decoded day/month invalid (day 13, month 45). |
| Sex consistency | PASS | NIK and card agree: LAKI-LAKI. |
| Birth date consistency | WARN | Printed birth date missing or unreadable. |
| Region name consistency | n/a | Region code did not resolve. |
| Sequence number sanity | PASS | Sequence 0011. |

