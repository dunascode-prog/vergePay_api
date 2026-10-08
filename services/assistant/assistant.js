import { INTENTS } from "./intents.js";
import { pickIntent, reword } from "./llm.js";
import { CONFIDENT, rankIntents } from "./matcher.js";
import { buildRecommendations } from "./recommendations.js";
import { loadSnapshot } from "./snapshot.js";

// "Ask VergePay": a question in, an answer out.
//   1. the small model matches the question to a known question (matcher.js);
//   2. VergePay works out the answer from the customer's data (intents.js);
//   3. if the open model is on, it rewords the answer, figures unchanged (llm.js).
// When no known question matches well enough, the open model (if on) gets
// to pick one; otherwise the closest questions are offered instead.

const byId = new Map(INTENTS.map((i) => [i.id, i]));
const answerable = INTENTS.filter((i) => i.answer || i.id === "next_steps");

/** Recommendations not dismissed (or whose snooze has run out), best first. */
export async function activeRecommendations(db, userId, snapshot) {
  const s = snapshot ?? (await loadSnapshot(db, userId));
  const dismissed = await db.query(
    `SELECT rec_key FROM recommendation_dismissals WHERE user_id = $1 AND dismissed_until > NOW()`,
    [userId],
  );
  const hidden = new Set(dismissed.rows.map((r) => r.rec_key));
  return buildRecommendations(s).filter((r) => !hidden.has(r.key));
}

function helpAnswer() {
  const titles = answerable.filter((i) => !["greeting", "help"].includes(i.id)).map((i) => i.title);
  return {
    text: `I answer questions about your own VergePay money, from your real figures. For example:\n${titles.slice(0, 8).map((t) => `• ${t}`).join("\n")}`,
    followups: titles.slice(0, 3),
  };
}

async function answerFor(intentId, s, question, db) {
  if (intentId === "help") return helpAnswer();
  if (intentId === "greeting") {
    const name = s.user.first_name ?? s.user.username;
    return /thank/i.test(question)
      ? { text: "You're welcome. Ask me anything else about your money." }
      : { text: `Hi ${name}. Ask me about what you're owed, what you spent, your payroll, goals or loans.`, followups: ["What should I do next?", "Who owes me the most?", "How much did I spend this month?"] };
  }
  if (intentId === "next_steps") {
    const recs = (await activeRecommendations(db, s.user.user_id, s)).slice(0, 3);
    if (!recs.length) return { text: "Nothing needs your attention right now. Everything's on track." };
    return {
      text: `Here's what I'd do next:\n${recs.map((r, n) => `${n + 1}. ${r.title}`).join("\n")}`,
      actions: recs.map((r) => r.action).slice(0, 2),
    };
  }
  return byId.get(intentId).answer(s, question);
}

export async function ask(db, userId, question) {
  const s = await loadSnapshot(db, userId);
  const { method, ranked } = await rankIntents(question);
  const [best] = ranked;
  let intentId = best.score >= CONFIDENT[method] ? best.intent : null;
  let matchedBy = method;

  if (!intentId) {
    // only among the small model's closest few, never anything at all
    const candidates = ranked.slice(0, 4).map((r) => byId.get(r.intent)).filter((i) => i.answer || i.id === "next_steps");
    intentId = await pickIntent(question, candidates);
    if (intentId) matchedBy = "llm";
  }
  if (!intentId) {
    const close = ranked.filter((r) => !["greeting", "help"].includes(r.intent)).slice(0, 3).map((r) => byId.get(r.intent).title);
    return {
      answer: "I'm not sure I understood. I can answer questions about your own money, like these:",
      intent: null,
      confidence: Number(best.score.toFixed(3)),
      matched_by: method,
      worded_by: "vergepay",
      actions: [],
      followups: close,
    };
  }

  const result = await answerFor(intentId, s, question, db);
  const worded = await reword(question, result.text);
  // when the open model chose the question, say which one, so a misreading shows
  const lead = matchedBy === "llm" ? `Answering: "${byId.get(intentId).title}"
` : "";
  return {
    answer: lead + worded.text,
    intent: intentId,
    confidence: matchedBy === "llm" ? null : Number(best.score.toFixed(3)),
    matched_by: matchedBy,
    worded_by: worded.by,
    actions: result.actions ?? [],
    followups: result.followups ?? [],
  };
}

/** Starter questions, chosen from what's in the customer's data. */
export async function starterQuestions(db, userId) {
  const s = await loadSnapshot(db, userId);
  const q = ["What should I do next?"];
  if (s.invoices.some((i) => i.status === "overdue")) q.push("Which invoices are overdue?");
  if (s.invoices.some((i) => i.status === "open" || i.status === "overdue")) q.push("Who owes me the most?");
  q.push("How much did I spend this month?");
  if (s.payees.length) q.push("Who do I need to pay?");
  if (s.goals.length) q.push("How are my savings goals doing?");
  if (s.loans.length) q.push("When is my next loan payment?");
  q.push("Am I making money this month?");
  return q.slice(0, 6);
}
