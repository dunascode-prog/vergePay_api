import env from "../../env.js";
import logger from "../../logger.js";
import { INTENTS } from "./intents.js";

// Matches a customer's question to one of the questions the assistant can
// answer (intents.js), with a small, free, pretrained sentence-embedding
// model (BAAI bge-small-en-v1.5, MIT licence, about 34 MB) run inside the API
// on the CPU through transformers.js. (all-MiniLM-L6-v2 and gte-small were
// tried too; bge-small matched unseen questions best: postman/assistant-eval.mjs.) Each example phrasing is turned into a
// vector once; a question is matched to the intent with the closest example.
//
// If the model can't be loaded (no network on first start, say), a simple
// word-overlap matcher takes over, so the assistant still works.

let embedder = null; // the loaded model, or a promise of it
let exampleVectors = null; // [{ intent, vector }]
let modelFailed = false;

async function loadModel() {
  const { pipeline, env: hf } = await import("@huggingface/transformers");
  hf.cacheDir = env.assistant.modelCacheDir;
  const extractor = await pipeline("feature-extraction", env.assistant.embeddingModel, { dtype: "q8" });
  const embed = async (texts) => (await extractor(texts, { pooling: "mean", normalize: true })).tolist();
  const examples = INTENTS.flatMap((intent) => intent.examples.map((text) => ({ intent: intent.id, text })));
  const vectors = await embed(examples.map((e) => e.text));
  exampleVectors = examples.map((e, i) => ({ intent: e.intent, vector: vectors[i] }));
  return embed;
}

/** Loads the model (once). Called at start-up so the first question isn't slow. */
export function warmUp() {
  if (embedder || modelFailed) return embedder;
  const started = Date.now();
  embedder = loadModel()
    .then((embed) => {
      logger.info({ message: "assistant model ready", model: env.assistant.embeddingModel, ms: Date.now() - started });
      return embed;
    })
    .catch((err) => {
      modelFailed = true;
      embedder = null;
      logger.warn({ message: "assistant model unavailable; using word matching", error: err.message });
      return null;
    });
  return embedder;
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// ---- the fallback: shared words with each intent's examples
const words = (text) => new Set(text.toLowerCase().match(/[a-z]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? []);
const STOP = new Set(["the", "and", "how", "what", "much", "did", "does", "my", "me", "you", "your", "this", "that", "are", "is", "for", "with", "have", "has", "can", "which", "who", "when", "show"]);
function wordScores(question) {
  const q = words(question);
  return INTENTS.map((intent) => {
    let best = 0;
    for (const example of intent.examples) {
      const e = words(example);
      const shared = [...q].filter((w) => e.has(w)).length;
      if (e.size) best = Math.max(best, shared / Math.sqrt(e.size * Math.max(q.size, 1)));
    }
    return { intent: intent.id, score: best };
  }).sort((a, b) => b.score - a.score);
}

// ---- money words: small nudges the model can't learn from a few examples
// (e.g. "where did my money go" is about spending, not income). Each cue
// adds to the listed intents' scores when the question contains it.
const CUES = [
  [/\bowe[sd]?\b|\bowing\b|outstanding|unpaid|waiting (on|for)/, { owed: 0.1 }],
  [/\b(most|biggest|largest|highest|top)\b.*\b(owe|owing|unpaid|debt)|\b(owe|owing|unpaid|debt)\b.*\b(most|biggest|largest|highest)\b/, { top_debtor: 0.1 }],
  [/\b(late|overdue|past (its |their )?due|past due)\b/, { overdue: 0.08 }],
  [/\b(due (this|next|soon|in)|coming (in|due)|upcoming|expected|due dates?)\b/, { due_soon: 0.09 }],
  [/\bpaid me\b|payments? (received )?from|\bhas .* paid\b|\bpaid (in total|so far)\b/, { client_paid: 0.08 }],
  [/\b(reliable|on time|good payer|trust|usually pay|pay late)\b/, { client_health: 0.08 }],
  [/\b(worst|bad payers?|risky|worry|at risk|problem clients?)\b/, { late_payers: 0.12 }],
  [/\b(best|top|biggest|main) (clients?|customers?)|\bbrought in the most\b|\bpays? me the most\b/, { top_clients: 0.12 }],
  [/\b(earn(ed|ings)?|income|revenue|came in|received|takings)\b/, { revenue: 0.06 }],
  [/\b(spen[dt]|spending|expenses?|outgoings?|went (out|on|to)|money go|withdr[ae]wn?|withdrawals?|fees?|charges|salar(y|ies)|wages)\b/, { spending: 0.12 }],
  [/\b(profit|net|minus|in the red|losing|loss|break even|ahead|behind)\b/, { net: 0.14 }],
  [/\b(balance|in my wallets?|how much (money )?(do )?i have|cash (do )?i have)\b/, { balance: 0.08 }],
  [/\b(payroll|payees?|staff|salar(y|ies)|wages|team)\b/, { payroll_due: 0.05, spending: 0.02 }],
  [/\b(need to|should i|have to|due a|due to be) pay\b|\bdue (a )?salary\b|\brun payroll\b/, { payroll_due: 0.1 }],
  [/\b(goals?|sav(e|ed|ing|ings)|emergency fund|target)\b/, { goals: 0.08 }],
  [/\bloan\b/, { loans: 0.08, loan_payoff: 0.06 }],
  [/\b(pay(ing)? (it )?off|payoff|clear|settle|early|in full)\b/, { loan_payoff: 0.1 }],
  [/\b(retainers?|recurring|subscriptions?|plans?|mrr)\b/, { recurring: 0.12 }],
  [/\b(drafts?|unsent|not sent|haven'?t sent|forgot to send)\b/, { drafts: 0.12 }],
  [/\b(what should i|next steps?|recommend|advice|attention|take care of|focus on|to ?do)\b/, { next_steps: 0.1 }],
  [/\b(help|what can (you|i)|able to|how does this work)\b/, { help: 0.08 }],
  [/^(hi+|hello|hey|hiya|good (morning|afternoon|evening)|thanks?|thank you)\b/, { greeting: 0.12 }],
];

// money in and money out in one question ("income minus expenses", "did I
// spend more than I earned") is about the difference: profit
const IN_WORDS = /\b(earn(ed|ings)?|income|revenue|came in|made)\b/;
const OUT_WORDS = /\b(spen[dt]|spending|expenses?|outgoings?|paid out)\b/;

function cueBonus(question) {
  const q = question.toLowerCase();
  const bonus = new Map();
  const add = (intent, n) => bonus.set(intent, (bonus.get(intent) ?? 0) + n);
  for (const [re, adds] of CUES) {
    if (!re.test(q)) continue;
    for (const [intent, n] of Object.entries(adds)) add(intent, n);
  }
  if (IN_WORDS.test(q) && OUT_WORDS.test(q)) add("net", 0.2);
  return bonus;
}

/**
 * The intents ranked for a question: [{ intent, score }], best first. Scores
 * are the model's cosine similarity to the closest example (0–1) plus the
 * money-word cues, or word-overlap scores if the model isn't available;
 * `method` says which.
 */
export async function rankIntents(question) {
  const embed = await warmUp();
  const bonus = cueBonus(question);
  if (!embed) {
    return { method: "words", ranked: wordScores(question).map((r) => ({ ...r, score: r.score + (bonus.get(r.intent) ?? 0) })).sort((a, b) => b.score - a.score) };
  }
  const [v] = await embed([question]);
  const best = new Map();
  for (const { intent, vector } of exampleVectors) best.set(intent, Math.max(best.get(intent) ?? -1, dot(v, vector)));
  return {
    method: "model",
    ranked: [...best.entries()].map(([intent, score]) => ({ intent, score: score + (bonus.get(intent) ?? 0) })).sort((a, b) => b.score - a.score),
  };
}

/** How sure a match must be to answer it (otherwise: "did you mean…"). */
export const CONFIDENT = { model: Number(process.env.ASSISTANT_CONFIDENCE) || 0.72, words: 0.35 };
