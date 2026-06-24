/* ============================================================================
   modules/i18n.js  —  tiny EN/ID localisation
   The chosen language is a non-personal UI preference, stored in localStorage
   under "sakhapr_lang" (excluded from the no-persistent-storage check).
   ============================================================================ */

const DICT = {
  id: {
    brand_sub: "the Bank Mortgage Buddy · PARIKSA",
    apply_now: "Ajukan Sekarang",
    clear_data: "Hapus data",
    lang_toggle: "EN",
    pdpa:
      "Aplikasi ini memproses data pribadi Anda sesuai <strong>UU No. 27 Tahun 2022</strong> " +
      "(Pelindungan Data Pribadi) dan berdasarkan persetujuan Anda. Anda dapat menghapus seluruh " +
      "data sesi kapan saja dengan menekan tombol “Hapus data”.",
    composer_ph: "Tanya apa saja tentang KPR the Bank…",
    send: "Kirim",
    footnote: "Data hanya disimpan di memori perangkat · bukan keputusan kredit.",
    data_none: "Tidak ada data tersimpan.",
    data_some: "Data tersimpan di memori ({n} pesan).",
    greeting:
      "Halo! Saya Moggy, the Bank Mortgage Buddy untuk KPR the Bank Indonesia. Saya bisa menjawab pertanyaan seputar KPR, " +
      "membantu memilih produk yang tepat, dan menjalankan prescreen awal. Silakan tanya apa saja, " +
      "atau pilih salah satu di bawah.",
    sug_takeover_l: "Take over KPR",
    sug_takeover_q: "Saya mau take over KPR dari bank lain ke the Bank. Bagaimana caranya dan apa syaratnya?",
    sug_income_l: "Syarat penghasilan",
    sug_income_q: "Berapa minimum gaji untuk mengajukan KPR the Bank?",
    sug_install_l: "Hitung cicilan",
    sug_install_q: "Tolong hitung cicilan KPR. Harga rumah Rp800 juta, DP 20%, tenor 20 tahun.",
    sug_cashback_l: "Cashback promo",
    sug_cashback_q: "Berapa cashback maksimal Kategori A dan apa syaratnya?",
    sug_docs_l: "Dokumen",
    sug_docs_q: "Saya karyawan swasta. Dokumen apa saja yang perlu disiapkan untuk KPR?",
    sug_process_l: "Proses KPR",
    sug_process_q: "Berapa lama proses KPR the Bank dari pengajuan sampai akad?",
    cont_yes: "Ya, lanjut ke pengajuan",
    cont_no: "Tidak, ada pertanyaan lain",
    cont_no_reply: "Baik. Silakan ajukan pertanyaan lain yang ingin Anda ketahui.",
    apply_user_msg: "Saya mau mengajukan KPR.",
    choose_situation: "Untuk prescreen awal, situasi Anda yang mana?",
    set_primary: "KPR PRI (beli baru di developer)",
    set_secondary: "KPR 2ND (beli properti bekas)",
    set_take_over: "KPR TO (pindah dari bank lain)",
    pick_option: "Silakan pilih salah satu opsi di atas.",
    q_prefix: "Pertanyaan {n}. ",
    num_hint: " (masukkan angka)",
    finish_prescreen:
      "Terima kasih, prescreen {label} selesai. Langkah terakhir: unggah foto eKTP Anda dan setujui " +
      "pemrosesan data. Identifikasi dilakukan otomatis — Anda tidak perlu mengisi apa pun.",
    prescreen_load_fail: "Maaf, set pertanyaan prescreen belum bisa dimuat.",
    sim_nudge:
      "Untuk menghitung angsuran bulanan dan potensi cashback secara akurat, silakan isi panel " +
      "\"Simulasi Angsuran & Cashback\" di bawah (pilih fasilitas, skema bunga, plafon, dan tenor).",
    rate_intro: "Berikut tabel suku bunga KPR the Bank:",
    data_load_fail:
      "Maaf, data belum bisa dimuat. Jika Anda membuka file ini langsung (file://), jalankan lewat " +
      "server lokal atau buka versi yang sudah ter-deploy.",
    cleared_all: "Seluruh data telah dihapus dari memori.",
    nothing_clear: "Tidak ada data untuk dihapus.",
    /* eKTP */
    ektp_title: "Unggah eKTP",
    ektp_disclaimer: "Pastikan foto eKTP jelas (tidak blur), datanya benar, dan ukuran file maksimal 3 MB.",
    consent: "Apakah Anda setuju dan telah membaca <a href=\"docs/pernyataan/persetujuan-nasabah.pdf\" target=\"_blank\" rel=\"noopener\">Lembar Pernyataan Persetujuan Nasabah</a> berikut?",
    ektp_hint_off: "Centang persetujuan untuk memilih foto eKTP.",
    ektp_hint_on: "Pilih foto eKTP (jelas, < 3 MB). Sistem membaca NIK otomatis.",
    nik_label: "NIK (16 digit) — pastikan sudah benar sebelum mengirim",
    ektp_too_big: "Ukuran foto {mb} MB melebihi 3 MB. Mohon gunakan foto yang lebih kecil.",
    ektp_reading: "Sedang membaca NIK oleh sistem…",
    ektp_read_progress: "Membaca NIK: {status} {pct}%",
    ektp_read_ok: "NIK terbaca. Mohon periksa & koreksi bila perlu, lalu Kirim.",
    ektp_read_manual: "NIK tidak terbaca otomatis. Mohon ketik NIK (16 digit) secara manual.",
    ektp_ocr_fail: "OCR gagal. Mohon ketik NIK (16 digit) secara manual.",
    nik_ready: "Periksa kembali nomor NIK bila perlu, lalu klik Kirim.",
    nik_count: "Nomor NIK {n}/16 digit.",
    ektp_need_prescreen: "Mohon selesaikan prescreen di atas terlebih dahulu sebelum mengirim.",
    ektp_need_consent: "Mohon centang persetujuan setelah membaca Lembar Pernyataan terlebih dahulu.",
    ektp_building: "Menyusun laporan skrining NIK…",
    ektp_forwarding: "Meneruskan berkas ke the Bank…",
    ektp_done: "Terima kasih. Data Anda telah diteruskan ke tim the Bank the response team untuk ditindaklanjuti. (No. Ref: {ref}).",
    ektp_done_chat: "Pengajuan Anda sudah kami terima dan teruskan ke tim the Bank. Tim akan menghubungi Anda. Terima kasih!",
    ektp_fail: "Maaf, terjadi kendala saat meneruskan data. Mohon coba lagi.",
    /* Simulation */
    sim_title: "Simulasi Angsuran & Cashback",
    sim_disclaimer: "Estimasi memakai suku bunga dari knowledge base the Bank. Angka final mengikuti analisa kredit dan Perjanjian Kredit.",
    sim_facility: "Jenis fasilitas",
    sim_scheme: "Skema bunga",
    sim_plafon: "Plafon kredit (Rp)",
    sim_tenor: "Tenor (tahun)",
    sim_segment: "Segmen (untuk cashback)",
    sim_run: "Hitung",
    fac_primary: "KPR PRI",
    fac_secondary: "KPR 2ND",
    fac_take_over: "KPR TO",
    seg_new: "New to Bank / lainnya",
    seg_pv: "the Bank Privilege (PV)",
    seg_wb: "the Bank Wealth (WB)",
    sim_err_plafon: "Isi plafon kredit (angka).",
    sim_err_tenor: "Isi tenor (tahun).",
    sim_err_plafon_range: "Plafon untuk {name} antara {min} dan {max}.",
    sim_err_tenor_range: "Tenor untuk {name} antara {min}–{max} tahun.",
    sim_err_scheme_min: "Skema \"{label}\" minimal tenor {n} tahun.",
    sim_h_install: "Estimasi angsuran per bulan",
    sim_phase_first: "{m} bln pertama",
    sim_phase_all: "seluruh tenor",
    sim_phase_next: "{m} bln berikutnya",
    sim_phase_row: "• Bunga {rate}% ({span}): {amount} / bln",
    sim_provisi: "Provisi & administrasi (1.1%): {amount}",
    sim_cashback_h: "Potensi cashback",
    sim_cashback_row: "Kategori {cat} · cashback diterima: {amount}",
    sim_cashback_detail: "(1% = {gross}, maksimum {cap} → {capped}, dipotong PPh 5% {pph})",
    sim_ssut: "Syarat: wajib membeli unit trust/reksa dana via Wealth Feature di the Bank digital bank.",
    sim_cashback_low: "Plafon di bawah Rp500 juta belum memenuhi kategori cashback.",
    sim_program_ended: "Catatan: periode program \"{name}\" tercatat berakhir {end}.",
    sim_disc: "— Semua perhitungan bersifat estimasi. Angka final mengikuti analisa kredit dan Perjanjian Kredit.",
    sim_cta_text: "Ingin tabel simulasi angsuran yang lebih lengkap dan personal? Ajukan sekarang agar tim the Bank membantu lebih lanjut.",
    sim_cta_btn: "Ajukan Sekarang",
    flexi_explain:
      "KPR FLX adalah fitur yang menggabungkan manfaat tabungan dengan fasilitas KPR — saldo tabungan Anda " +
      "dapat membantu menekan bunga/pokok KPR. Perbedaannya hanya pada tujuan fasilitas: KPR PRI (beli baru " +
      "di developer), KPR 2ND (properti bekas), atau KPR TO (pindah dari bank lain). Silakan baca " +
      "Ringkasan Informasi Produk & Layanan (Ringkasan Informasi Produk) berikut.",
    sim_fail: "Gagal menghitung. Pastikan halaman termuat penuh.",
    sim_load_fail: "Gagal memuat data. Jalankan lewat server/deploy.",
    plafon_ph: "900000000",
    tenor_ph: "10",
    /* Rate table */
    rate_h_jenis: "Jenis",
    rate_h_fix: "Suku Bunga Fix (eff. p.a)",
    rate_h_float: "Floating setelah fix",
    rate_h_tenor: "Min. Tenor",
    rate_jenis_primary: "PRI",
    rate_jenis_secondary: "2ND / TO",
    rate_year: "Th",
    rate_tenor_unit: "Tahun",
    rate_flexi: "KPR FLX PRI: SRBI + 2,50% (≈ {pct}%), floating sejak awal.",
  },
  en: {
    brand_sub: "the Bank Mortgage Buddy · PARIKSA",
    apply_now: "Apply Now",
    clear_data: "Clear data",
    lang_toggle: "ID",
    pdpa:
      "This app processes your personal data under <strong>Law No. 27 of 2022</strong> " +
      "(Personal Data Protection) and with your consent. You can clear all session data at any " +
      "time using the “Clear data” button.",
    composer_ph: "Ask anything about the Bank mortgages…",
    send: "Send",
    footnote: "Data is kept in device memory only · not a credit decision.",
    data_none: "No data stored.",
    data_some: "Data stored in memory ({n} messages).",
    greeting:
      "Hi! I'm Moggy, your the Bank Mortgage Buddy for KPR at the Bank Indonesia. I can answer mortgage (KPR) questions, " +
      "help you pick the right product, and run an initial prescreen. Ask me anything, or pick one below.",
    sug_takeover_l: "Take over",
    sug_takeover_q: "I want to take over my mortgage from another bank to the Bank. How, and what are the requirements?",
    sug_income_l: "Income requirement",
    sug_income_q: "What is the minimum income to apply for a the Bank mortgage?",
    sug_install_l: "Installment",
    sug_install_q: "Please calculate the mortgage installment. House price Rp800 million, 20% down payment, 20-year tenor.",
    sug_cashback_l: "Cashback promo",
    sug_cashback_q: "What is the maximum Category A cashback and its requirements?",
    sug_docs_l: "Documents",
    sug_docs_q: "I'm a private-sector employee. What documents do I need to prepare for a mortgage?",
    sug_process_l: "Process",
    sug_process_q: "How long does the the Bank mortgage process take from application to signing?",
    cont_yes: "Yes, continue to apply",
    cont_no: "No, another question",
    cont_no_reply: "Sure. Feel free to ask anything else you'd like to know.",
    apply_user_msg: "I'd like to apply for a mortgage.",
    choose_situation: "For the initial prescreen, which situation applies to you?",
    set_primary: "KPR PRI (buying new from a developer)",
    set_secondary: "KPR 2ND (buying a used property)",
    set_take_over: "KPR TO (moving from another bank)",
    pick_option: "Please choose one of the options above.",
    q_prefix: "Question {n}. ",
    num_hint: " (enter a number)",
    finish_prescreen:
      "Thank you, the {label} prescreen is complete. Last step: upload your eKTP photo and consent to " +
      "data processing. Reading is automatic — you don't need to fill anything in.",
    prescreen_load_fail: "Sorry, the prescreen question set couldn't be loaded.",
    sim_nudge:
      "To calculate the monthly installment and potential cashback accurately, please use the " +
      "\"Installment & Cashback Simulation\" panel below (choose facility, rate scheme, principal, tenor).",
    rate_intro: "Here is the the Bank mortgage interest-rate table:",
    data_load_fail:
      "Sorry, data couldn't be loaded. If you opened this file directly (file://), serve it over a local " +
      "server or open the deployed version.",
    cleared_all: "All data has been cleared from memory.",
    nothing_clear: "There is no data to clear.",
    ektp_title: "Upload eKTP",
    ektp_disclaimer: "Make sure the eKTP photo is clear (not blurry), the data is correct, and the file is at most 3 MB.",
    consent: "Do you agree and have you read the following <a href=\"docs/pernyataan/persetujuan-nasabah.pdf\" target=\"_blank\" rel=\"noopener\">Customer Consent Statement</a>?",
    ektp_hint_off: "Tick the consent box to choose an eKTP photo.",
    ektp_hint_on: "Choose an eKTP photo (clear, < 3 MB). The system reads the NIK automatically.",
    nik_label: "NIK (16 digits) — make sure it's correct before sending",
    ektp_too_big: "The photo is {mb} MB, over the 3 MB limit. Please use a smaller photo.",
    ektp_reading: "The system is reading the NIK…",
    ektp_read_progress: "Reading NIK: {status} {pct}%",
    ektp_read_ok: "NIK read. Please check and correct it if needed, then Send.",
    ektp_read_manual: "The NIK couldn't be read automatically. Please type the NIK (16 digits) manually.",
    ektp_ocr_fail: "OCR failed. Please type the NIK (16 digits) manually.",
    nik_ready: "Double-check the NIK if needed, then click Send.",
    nik_count: "NIK {n}/16 digits.",
    ektp_need_prescreen: "Please complete the prescreen above before sending.",
    ektp_need_consent: "Please read the Statement and tick the consent box first.",
    ektp_building: "Building the NIK screening report…",
    ektp_forwarding: "Forwarding the files to the Bank…",
    ektp_done: "Thank you. Your data has been forwarded to the the Bank the response team team for follow-up. (Ref No.: {ref}).",
    ektp_done_chat: "We've received your application and forwarded it to the the Bank team. They will contact you. Thank you!",
    ektp_fail: "Sorry, something went wrong forwarding the data. Please try again.",
    sim_title: "Installment & Cashback Simulation",
    sim_disclaimer: "Estimates use the interest rates from the the Bank knowledge base. Final figures follow credit analysis and the Credit Agreement.",
    sim_facility: "Facility type",
    sim_scheme: "Rate scheme",
    sim_plafon: "Loan principal (Rp)",
    sim_tenor: "Tenor (years)",
    sim_segment: "Segment (for cashback)",
    sim_run: "Calculate",
    fac_primary: "KPR PRI",
    fac_secondary: "KPR 2ND",
    fac_take_over: "KPR TO",
    seg_new: "New to Bank / other",
    seg_pv: "the Bank Privilege (PV)",
    seg_wb: "the Bank Wealth (WB)",
    sim_err_plafon: "Enter the loan principal (a number).",
    sim_err_tenor: "Enter the tenor (years).",
    sim_err_plafon_range: "Principal for {name} must be between {min} and {max}.",
    sim_err_tenor_range: "Tenor for {name} must be {min}–{max} years.",
    sim_err_scheme_min: "Scheme \"{label}\" requires a minimum tenor of {n} years.",
    sim_h_install: "Estimated monthly installment",
    sim_phase_first: "first {m} months",
    sim_phase_all: "entire tenor",
    sim_phase_next: "next {m} months",
    sim_phase_row: "• Rate {rate}% ({span}): {amount} / month",
    sim_provisi: "Provision & admin (1.1%): {amount}",
    sim_cashback_h: "Potential cashback",
    sim_cashback_row: "Category {cat} · cashback received: {amount}",
    sim_cashback_detail: "(1% = {gross}, max {cap} → {capped}, less 5% PPh {pph})",
    sim_ssut: "Condition: must buy unit trust / mutual fund via Wealth Feature in the Bank digital bank.",
    sim_cashback_low: "A principal under Rp500 million doesn't yet qualify for a cashback category.",
    sim_program_ended: "Note: the \"{name}\" program period is recorded as ending {end}.",
    sim_disc: "— All figures are estimates. Final figures follow credit analysis and the Credit Agreement.",
    sim_cta_text: "Want a more complete, personalised installment schedule? Apply now and the the Bank team will assist you further.",
    sim_cta_btn: "Apply Now",
    flexi_explain:
      "KPR FLX is a feature that combines savings benefits with a mortgage facility — your savings balance can " +
      "help reduce the mortgage interest/principal. The only difference is the facility purpose: KPR PRI (new " +
      "from a developer), KPR 2ND (used property), or KPR TO (move from another bank). Please read the " +
      "Product Summary (Ringkasan Informasi Produk) documents below.",
    sim_fail: "Calculation failed. Make sure the page is fully loaded.",
    sim_load_fail: "Couldn't load data. Run via a server / deployed version.",
    plafon_ph: "900000000",
    tenor_ph: "10",
    rate_h_jenis: "Type",
    rate_h_fix: "Fixed rate (eff. p.a)",
    rate_h_float: "Floating after fixed",
    rate_h_tenor: "Min. tenor",
    rate_jenis_primary: "PRI",
    rate_jenis_secondary: "2ND / TO",
    rate_year: "Yr",
    rate_tenor_unit: "Years",
    rate_flexi: "KPR FLX PRI: SRBI + 2.50% (≈ {pct}%), floating from the start.",
  },
};

let lang = "id";
try { const saved = localStorage.getItem("sakhapr_lang"); if (saved === "en" || saved === "id") lang = saved; } catch { /* */ }

export function getLang() { return lang; }
export function setLang(l) {
  lang = l === "en" ? "en" : "id";
  try { localStorage.setItem("sakhapr_lang", lang); } catch { /* */ }
}
export function t(key, vars) {
  let s = (DICT[lang] && DICT[lang][key] != null) ? DICT[lang][key] : (DICT.id[key] != null ? DICT.id[key] : key);
  if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
  return s;
}
export function applyStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.getAttribute("data-i18n-html")); });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"))); });
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}
