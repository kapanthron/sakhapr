/* ============================================================================
   modules/chat.js  —  client for the Workers AI chat endpoint
   Sends the message + recent history to /api/chat (RAG over the knowledge base).
   Throws on any failure so the caller can fall back to the offline keyword
   router + knowledge answers.
   ============================================================================ */

/**
 * @param {string} message
 * @param {Array<{role:'user'|'assistant', content:string}>} history
 * @returns {Promise<string>} the assistant's answer
 */
export async function askLlm(message, history) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history: history || [] }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok || !data.answer) throw new Error(data.error || "empty answer");
  return data.answer;
}

/**
 * Streamed chat. Calls onChunk(partialFullText) as text arrives; returns the
 * final text. Falls back transparently if the server returns JSON (non-stream).
 */
export async function streamLlm(message, history, onChunk, lang) {
  const res = await fetch("/api/chat?stream=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history: history || [], lang: lang || "id" }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);

  const ctype = res.headers.get("Content-Type") || "";
  if (ctype.includes("application/json") || !res.body) {
    const data = await res.json();
    if (!data.ok || !data.answer) throw new Error(data.error || "empty answer");
    if (onChunk) onChunk(data.answer);
    return data.answer;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) {
      full += chunk;
      if (onChunk) onChunk(full);
    }
  }
  if (!full.trim()) throw new Error("empty stream");
  return full;
}
