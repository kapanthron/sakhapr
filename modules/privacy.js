/* ============================================================================
   modules/privacy.js
   Privacy-first core for Morby.

   Responsibilities (Phase 1):
   - Hold ALL personal data in memory only. No localStorage, sessionStorage,
     IndexedDB, Cache API, or cookies are ever used.
   - Track object URLs (e.g. for an uploaded eKTP image in later phases) so they
     can be revoked on demand.
   - Provide a single "Clear all data" action that wipes memory and revokes URLs.
   - A light CSP self-check that warns in the console if the page was opened in a
     way that strips the HTTP CSP header (e.g. file:// without _headers).
   ============================================================================ */

/**
 * The one and only in-memory store. Everything personal lives here and nowhere
 * else. Dropped automatically when the tab closes; wiped on clearAllData().
 */
export const store = {
  // Conversation + intent (filled in later phases)
  messages: [],          // { role: 'user' | 'bot' | 'system', text, ts }
  intent: null,          // last classified intent
  product: null,         // routed product id

  // Prescreen (Phase 3)
  prescreen: null,       // { setId, answers: {...} }

  // eKTP + NIK (Phases 4–5)
  ektp: null,            // { fields: {...}, verdict: {...} }

  // Generated artefacts (Phases 3, 5, 6)
  files: {},             // { fileA: Blob, fileB: Blob, fileC: Blob }

  // Object URLs we must revoke on clear (image previews, downloads)
  _objectUrls: new Set(),
};

/**
 * Create an object URL and register it for automatic revocation on clear.
 * Always use this instead of URL.createObjectURL directly.
 * @param {Blob} blob
 * @returns {string} object URL
 */
export function trackedObjectURL(blob) {
  const url = URL.createObjectURL(blob);
  store._objectUrls.add(url);
  return url;
}

/** Revoke and forget every object URL we created. */
function revokeAllObjectUrls() {
  for (const url of store._objectUrls) {
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
  }
  store._objectUrls.clear();
}

/**
 * Wipe every piece of personal data from memory and revoke object URLs.
 * Returns to a pristine state without reloading the page.
 */
export function clearAllData() {
  revokeAllObjectUrls();
  store.messages = [];
  store.intent = null;
  store.product = null;
  store.prescreen = null;
  store.ektp = null;
  store.files = {};
  // _objectUrls already cleared by revokeAllObjectUrls()
}

/**
 * Rough indicator of whether any personal data is currently held in memory.
 * Used only to drive the on-screen "data status" pill; stores no data itself.
 * @returns {boolean}
 */
export function hasStoredData() {
  return (
    store.messages.length > 0 ||
    store.prescreen != null ||
    store.ektp != null ||
    Object.keys(store.files).length > 0 ||
    store._objectUrls.size > 0
  );
}

/**
 * Defensive assertion: nothing in this app should touch persistent storage.
 * This does not block anything; it just surfaces accidental misuse in dev.
 */
export function assertNoPersistentStorage() {
  const problems = [];
  // The language preference (sakhapr_lang) is a non-personal UI setting and is allowed.
  try {
    const keys = Object.keys(window.localStorage).filter((k) => k !== "sakhapr_lang");
    if (keys.length > 0) problems.push("localStorage");
  } catch { /* blocked = fine */ }
  try { if (window.sessionStorage.length > 0) problems.push("sessionStorage"); } catch { /* blocked = fine */ }
  try { if (document.cookie && document.cookie.trim().length > 0) problems.push("cookies"); } catch { /* */ }
  if (problems.length) {
    console.warn(
      "[Morby privacy] Unexpected persistent storage detected:",
      problems.join(", "),
      "— personal data must stay in memory only."
    );
  }
  return problems;
}

/**
 * Warn (do not block) if the strict CSP header appears to be missing. On
 * Cloudflare Pages the header comes from the repo-root `_headers` file; opening
 * index.html via file:// will not have it, which is fine for local testing but
 * worth flagging so it is never shipped that way.
 */
export function cspSelfCheck() {
  if (location.protocol === "file:") {
    console.info(
      "[Morby privacy] Opened via file:// — the HTTP CSP from `_headers` is " +
      "not applied locally. This is fine for a quick look; deploy to Cloudflare " +
      "Pages (or serve over HTTP) to exercise the real CSP."
    );
  }
}
