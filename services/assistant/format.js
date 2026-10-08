import { formatMoney } from "../notifications.js";

// Wording helpers for the assistant's answers.

export const money = (minor, currency) => formatMoney(Number(minor), currency);

/** Totals per currency, naira first: Map("NGN" → minor). */
export function byCurrency(items, amount = (x) => x.amount_minor ?? x.amount_due_minor, currency = (x) => x.currency ?? x.currency_code) {
  const totals = new Map();
  for (const x of items) totals.set(currency(x), (totals.get(currency(x)) ?? 0) + Number(amount(x)));
  return new Map([...totals.entries()].sort(([a], [b]) => (a === "NGN" ? -1 : b === "NGN" ? 1 : a.localeCompare(b))));
}

/** "₦65,000.00 and $2,000.00" (never added across currencies). */
export function moneyList(totals, empty = "₦0.00") {
  const parts = [...totals.entries()].filter(([, v]) => v !== 0).map(([c, v]) => money(v, c));
  if (!parts.length) return empty;
  return parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "2026-10-09" → "9 Oct" (with the year if it isn't `today`'s). */
export function day(date, today) {
  const [y, m, d] = date.split("-").map(Number);
  const text = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return today && date.slice(0, 4) !== today.slice(0, 4) ? `${text} ${y}` : text;
}

/** Whole days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a, b) {
  const t = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** A list in words: "A, B and C". */
export function listWords(items) {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The name in the question that best matches one of `things` (clients,
 * goals, payees), by whole words, or null. "northwind" finds "Northwind
 * Studio"; one shared short word ("the", "and") doesn't count.
 */
export function findByName(question, things, name = (x) => x.name) {
  const words = new Set(question.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let best = null;
  let bestScore = 0;
  for (const thing of things) {
    const parts = (name(thing).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
    if (!parts.length) continue;
    const hits = parts.filter((w) => words.has(w)).length;
    const score = hits / parts.length + (hits ? 0.01 * hits : 0);
    if (hits && score > bestScore) {
      best = thing;
      bestScore = score;
    }
  }
  return best;
}

const STOP = new Set(["the", "and", "ltd", "limited", "inc", "company", "studio", "global", "group", "services", "fund", "goal"]);
