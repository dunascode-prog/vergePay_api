import env from "../../env.js";
import logger from "../../logger.js";

// Optional: an open chat model served by Ollama (for example Qwen 2.5 3B,
// Apache 2.0) on a server you run. Off unless OLLAMA_URL is set; the
// assistant works without it. It's used for two things only:
//
//   1. rewording an answer VergePay has already worked out, more naturally.
//      Its reply must keep every figure of VergePay's answer and add none,
//      or it's thrown away and VergePay's wording is used.
//   2. choosing among the small model's few closest known questions when it
//      wasn't sure (VergePay then answers the chosen question itself).
//
// It never computes figures, and it gets no tools or database access.

export const llmEnabled = () => Boolean(env.ai.ollamaUrl);

async function chat(messages, { maxTokens = 220 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ai.timeoutMs);
  try {
    const res = await fetch(`${env.ai.ollamaUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(env.ai.ollamaApiKey && { Authorization: `Bearer ${env.ai.ollamaApiKey}` }) },
      body: JSON.stringify({ model: env.ai.model, messages, stream: false, options: { temperature: 0.2, num_predict: maxTokens } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    const body = await res.json();
    return body.message?.content?.trim() ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// every number in a text: "₦65,000.00" → "65000", "9 days" → "9" (".00" is
// dropped, so writing ₦65,000 for ₦65,000.00 is fine)
const numbers = (text) => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));

/**
 * True if the reworded `reply` keeps the facts of VergePay's `source`: it
 * has every number the source has and no others, and isn't much longer. An
 * answer with no numbers at all isn't reworded (there'd be nothing to check
 * the model against).
 */
export function keepsTheFacts(reply, source) {
  const want = new Set(numbers(source));
  const got = new Set(numbers(reply));
  if (!want.size) return false;
  if (reply.length > source.length * 1.6 + 40) return false;
  return [...got].every((n) => want.has(n)) && [...want].every((n) => got.has(n));
}

/** VergePay's answer, reworded by the open model when it's on and safe; otherwise as is. */
export async function reword(question, answer) {
  if (!llmEnabled() || !numbers(answer).length) return { text: answer, by: "vergepay" };
  try {
    const reply = await chat([
      {
        role: "system",
        content:
          "You reword answers for VergePay, a Nigerian fintech app, so they read naturally and warmly. " +
          "Use ONLY the facts in the answer you're given. Keep every amount, date, name and number exactly as written. " +
          "Don't add advice, figures or facts. Keep it short (at most 3 sentences, or keep the bullet list). Reply with the reworded answer only.",
      },
      { role: "user", content: `Customer asked: ${question}\n\nAnswer to reword:\n${answer}` },
    ]);
    if (reply && keepsTheFacts(reply, answer)) return { text: reply, by: "llm" };
    logger.info({ message: "open model reply not used: it changed or dropped figures" });
  } catch (err) {
    logger.warn({ message: "open model unavailable", error: err.message });
  }
  return { text: answer, by: "vergepay" };
}

/**
 * Asks the open model which of the small model's closest candidates fits a
 * question it wasn't sure about; null if it's off, unsure, or picks another.
 */
export async function pickIntent(question, intents) {
  if (!llmEnabled()) return null;
  try {
    const list = intents.map((i) => `${i.id}: ${i.title}`).join("\n");
    const reply = await chat(
      [
        { role: "system", content: "Classify a customer's question about their own money into one of the listed question types. Reply with the id only, or none if nothing fits." },
        { role: "user", content: `Question types:\n${list}\n\nQuestion: ${question}` },
      ],
      { maxTokens: 12 },
    );
    const id = reply.toLowerCase().match(/[a-z_]+/)?.[0];
    return intents.some((i) => i.id === id) ? id : null;
  } catch (err) {
    logger.warn({ message: "open model unavailable", error: err.message });
    return null;
  }
}
