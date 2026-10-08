// Checks how well the assistant's small model matches questions it hasn't
// seen (none of these are in the intents' examples) to the right intent.
//
//   node postman/assistant-eval.mjs           (ASSISTANT_EMBEDDING_MODEL to try another model)
import { CONFIDENT, rankIntents, warmUp } from "../services/assistant/matcher.js";

const CASES = [
  ["what do my clients owe me in total", "owed"],
  ["how much money is outstanding", "owed"],
  ["total I'm still waiting on", "owed"],
  ["how much does acme owe", "owed"],
  ["which client has the highest unpaid bill", "top_debtor"],
  ["who owes the most", "top_debtor"],
  ["largest debt from a customer", "top_debtor"],
  ["any late invoices?", "overdue"],
  ["list the invoices past their due date", "overdue"],
  ["who hasn't paid me yet and is late", "overdue"],
  ["what's coming due in the next few days", "due_soon"],
  ["invoices due next week", "due_soon"],
  ["expected payments this week", "due_soon"],
  ["how much has northwind paid in total", "client_paid"],
  ["payments received from acme this year", "client_paid"],
  ["is northwind reliable", "client_health"],
  ["does acme usually pay late", "client_health"],
  ["which customers are bad payers", "late_payers"],
  ["clients I should worry about", "late_payers"],
  ["my top customers", "top_clients"],
  ["who brought in the most money this year", "top_clients"],
  ["what did I make last month", "revenue"],
  ["revenue so far this year", "revenue"],
  ["how much income in august", "revenue"],
  ["money received this month", "revenue"],
  ["what did I spend in september", "spending"],
  ["my expenses this month", "spending"],
  ["how much went on salaries this year", "spending"],
  ["total fees paid", "spending"],
  ["how much have I withdrawn to my bank", "spending"],
  ["where did my money go last month", "spending"],
  ["did I make a profit last month", "net"],
  ["am I in the red this month", "net"],
  ["income minus expenses this year", "net"],
  ["how much do I have", "balance"],
  ["what's in my business wallet", "balance"],
  ["current account balance", "balance"],
  ["is anyone due a salary", "payroll_due"],
  ["do I need to run payroll", "payroll_due"],
  ["which staff should I pay this week", "payroll_due"],
  ["am I on track to hit my savings target", "goals"],
  ["how is my emergency fund going", "goals"],
  ["how much is saved in my goals", "goals"],
  ["when's my loan due", "loans"],
  ["remaining balance on my loan", "loans"],
  ["am I late on my loan", "loans"],
  ["what would it take to clear the loan now", "loan_payoff"],
  ["early repayment amount", "loan_payoff"],
  ["how much do I earn monthly from retainers", "recurring"],
  ["next subscription invoice", "recurring"],
  ["any invoices I forgot to send", "drafts"],
  ["unsent drafts", "drafts"],
  ["what should I be doing right now", "next_steps"],
  ["anything I should take care of", "next_steps"],
  ["what are you able to help with", "help"],
  ["what can I ask", "help"],
  ["hiya", "greeting"],
  ["thanks a lot", "greeting"],
  // should NOT match confidently
  ["what's the weather in lagos", null],
  ["write me a poem about money", null],
];

// A second set, written after the money-word cues, to check they generalise.
const FRESH = [
  ["how much cash is tied up in unpaid invoices", "owed"],
  ["sum of everything clients still owe", "owed"],
  ["which customer is furthest behind on paying", "top_debtor"],
  ["show me the overdue ones", "overdue"],
  ["has anybody missed their payment date", "overdue"],
  ["which invoices fall due tomorrow", "due_soon"],
  ["what has lagos tech hub paid me so far", "client_paid"],
  ["can I trust northwind to pay on time", "client_health"],
  ["who pays slowly", "late_payers"],
  ["my biggest clients last quarter", "top_clients"],
  ["what were my earnings in july", "revenue"],
  ["how much came in yesterday", "revenue"],
  ["what did I pay out this week", "spending"],
  ["how much did payroll cost me in august", "spending"],
  ["breakdown of my spending this year", "spending"],
  ["did I spend more than I earned in september", "net"],
  ["was last month profitable", "net"],
  ["how much money is in my account right now", "balance"],
  ["who's waiting to be paid on my team", "payroll_due"],
  ["is it time to pay my staff", "payroll_due"],
  ["how far along is my laptop fund", "goals"],
  ["will I reach my savings goal in time", "goals"],
  ["how many installments left on the loan", "loans"],
  ["what's the full amount to settle my loan today", "loan_payoff"],
  ["how much do my recurring plans bring in", "recurring"],
  ["which retainer bills next", "recurring"],
  ["do I have invoices still in draft", "drafts"],
  ["what needs doing today", "next_steps"],
  ["how do I use you", "help"],
  ["good evening", "greeting"],
  ["who won the football last night", null],
  ["tell me a joke", null],
];
const SETS = process.argv.includes("--fresh") ? FRESH : CASES;

await warmUp();
let right = 0, confidentWrong = 0, unsure = 0, nullOk = 0;
const misses = [];
for (const [question, expected] of SETS) {
  const { method, ranked } = await rankIntents(question);
  const [best] = ranked;
  const confident = best.score >= CONFIDENT[method];
  const got = confident ? best.intent : null;
  if (expected === null) {
    if (got === null) nullOk++;
    else misses.push(`  should be unsure: "${question}" → ${got} (${best.score.toFixed(2)})`);
    continue;
  }
  if (got === expected) right++;
  else if (got === null) {
    unsure++;
    misses.push(`  unsure: "${question}" → ${best.intent} ${best.score.toFixed(2)} (want ${expected}; top 2: ${ranked.slice(0, 2).map((r) => `${r.intent} ${r.score.toFixed(2)}`).join(", ")})`);
  } else {
    confidentWrong++;
    misses.push(`  WRONG: "${question}" → ${got} ${best.score.toFixed(2)} (want ${expected})`);
  }
}
const total = SETS.filter(([, e]) => e).length;
const top1 = SETS.filter(([, e]) => e).length;
console.log(`method: ${(await rankIntents("x")).method}`);
console.log(`right ${right}/${total}, unsure ${unsure}, confidently wrong ${confidentWrong}; off-topic left unanswered ${nullOk}/${SETS.length - total}`);
console.log(misses.join("\n"));
