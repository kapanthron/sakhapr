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
