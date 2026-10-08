import { byCurrency, day, daysBetween, findByName, listWords, money, moneyList, plural } from "./format.js";
import { addDays, defaultPeriod, inPeriod, parsePeriod } from "./periods.js";

// The questions VergePay's assistant can answer. Each has example phrasings
// (the small language model matches a question to the closest examples)
// and an answer worked out from the customer's own data (snapshot.js), so
// the figures are always real. An answer is { text, actions?, followups? };
// an action is a link in the app, or { kind: "remind", invoice_id }.

const PER_MONTH = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
const unpaid = (s) => s.invoices.filter((i) => i.status === "open" || i.status === "overdue");
const overdue = (s) => s.invoices.filter((i) => i.status === "overdue");
const clientLabel = (i) => i.client_name ?? "a VergePay customer";
const invoiceLine = (i, today) => `${i.invoice_number ?? "Invoice"} · ${clientLabel(i)} · ${money(i.amount_due_minor, i.currency_code)}${
  i.status === "overdue" ? ` · ${plural(daysBetween(i.due_date, today), "day")} late` : ` · due ${day(i.due_date, today)}`
}`;
const period = (s, q, fallback) => parsePeriod(q, s.today) ?? fallback(s.today);
const periodWords = (p) => (["this month", "this year", "today", "yesterday", "this week", "last week", "all time"].includes(p.label) || p.label.startsWith("the ") || p.label.startsWith("since") ? p.label : `in ${p.label}`);

// what a question about spending is narrowed to ("on payroll", "fees")
const CATEGORY_WORDS = [
  [/payroll|salar|staff|wages|pay(ing)? (my )?team|payees/, "Payroll"],
  [/fee|charges/, "Fees"],
  [/loan|repay/, "Loan repayments"],
  [/withdraw|bank account|cash ?out/, "Withdrawn to banks"],
  [/sent to|transfers? to|sent money|send money/, "Sent to others"],
  [/invoices? (i|you) paid|bills? (i )?paid|paying invoices/, "Invoices you paid"],
];
const categoryIn = (q) => CATEGORY_WORDS.find(([re]) => re.test(q.toLowerCase()))?.[1] ?? null;

function revenueIn(s, p) {
  return byCurrency(s.flows.filter((f) => f.is_revenue && inPeriod(f.date, p)));
}
function spendIn(s, p, category = null) {
  return s.flows.filter((f) => f.direction === "out" && inPeriod(f.date, p) && (!category || f.category === category));
}
const localDay = (instant, s) => (instant ? new Date(instant).toLocaleDateString("en-CA", { timeZone: s.user.timezone }) : null);

function askWhichClient(s, what) {
  const names = s.clients.slice(0, 4).map((c) => c.name);
  return {
    text: names.length ? `Which client do you mean? For example: ${listWords(names)}.` : "You haven't added any clients yet.",
    followups: names.slice(0, 3).map((n) => `${what} ${n}?`),
  };
}

export const INTENTS = [
  {
    id: "owed",
    title: "How much am I owed?",
    examples: [
      "how much am I owed",
      "how much money do clients owe me",
      "what's outstanding on my invoices",
      "total unpaid invoices",
      "how much is still unpaid",
      "money I'm waiting to receive",
      "how much does northwind owe me",
    ],
    answer(s, q) {
      const client = findByName(q, s.clients);
      const list = unpaid(s).filter((i) => !client || i.client_id === client.client_id);
      const late = list.filter((i) => i.status === "overdue");
      if (!list.length) return { text: client ? `${client.name} doesn't owe you anything right now.` : "Nobody owes you anything right now: every sent invoice is paid." };
      const who = client ? `${client.name} owes you` : "You're owed";
      return {
        text: `${who} ${moneyList(byCurrency(list))} across ${plural(list.length, "unpaid invoice")}${late.length ? `, ${moneyList(byCurrency(late))} of it overdue` : ""}.`,
        actions: [{ label: "See unpaid invoices", href: "/dashboard/invoices" }],
        followups: ["Who owes me the most?", "Which invoices are overdue?"],
      };
    },
  },
  {
    id: "top_debtor",
    title: "Who owes me the most?",
    examples: ["who owes me the most", "which client owes me the most money", "biggest unpaid balance", "who has the largest outstanding amount", "which customer owes the most", "top debtor"],
    answer(s) {
      const groups = new Map();
      for (const i of unpaid(s)) {
        const key = i.payer_key;
        const g = groups.get(key) ?? { name: clientLabel(i), client_id: i.client_id, items: [] };
        g.items.push(i);
        groups.set(key, g);
      }
      if (!groups.size) return { text: "Nobody owes you anything right now." };
      // naira first, then any other currency (never converted)
      const rank = (g) => [byCurrency(g.items).get("NGN") ?? 0, [...byCurrency(g.items).values()].reduce((a, b) => a + b, 0)];
      const sorted = [...groups.values()].sort((a, b) => rank(b)[0] - rank(a)[0] || rank(b)[1] - rank(a)[1]);
      const top = sorted[0];
      const late = top.items.filter((i) => i.status === "overdue");
      const next = sorted.slice(1, 3).map((g) => `${g.name} (${moneyList(byCurrency(g.items))})`);
      const oldest = late.sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
      return {
        text: `${top.name} owes you the most: ${moneyList(byCurrency(top.items))} across ${plural(top.items.length, "invoice")}${
          late.length ? `, ${moneyList(byCurrency(late))} of it overdue` : ""
        }.${next.length ? ` Next: ${listWords(next)}.` : ""}`,
        actions: oldest ? [{ label: `Remind ${top.name}`, kind: "remind", invoice_id: oldest.invoice_id }] : [{ label: "See unpaid invoices", href: "/dashboard/invoices" }],
      };
    },
  },
  {
    id: "overdue",
    title: "Which invoices are overdue?",
    examples: ["which invoices are overdue", "show me late invoices", "who hasn't paid on time", "past due invoices", "what's overdue", "who is late paying me"],
    answer(s) {
      const list = overdue(s).sort((a, b) => a.due_date.localeCompare(b.due_date));
      if (!list.length) return { text: "Nothing is overdue. Every unpaid invoice is still within its due date." };
      const lines = list.slice(0, 5).map((i) => invoiceLine(i, s.today));
      return {
        text: `${plural(list.length, "invoice")} ${list.length === 1 ? "is" : "are"} overdue, ${moneyList(byCurrency(list))} in all:\n${lines.map((l) => `• ${l}`).join("\n")}${list.length > 5 ? `\n…and ${list.length - 5} more.` : ""}`,
        actions: [
          { label: `Remind ${clientLabel(list[0])}`, kind: "remind", invoice_id: list[0].invoice_id },
          { label: "See overdue invoices", href: "/dashboard/invoices" },
        ],
      };
    },
  },
  {
    id: "due_soon",
    title: "What's due to be paid to me this week?",
    examples: ["which invoices are due this week", "what payments are coming in soon", "invoices due soon", "who should pay me next", "upcoming invoice due dates", "what money is coming in"],
    answer(s, q) {
      const p = parsePeriod(q, s.today) ?? { from: s.today, to: addDays(s.today, 7), label: "the next 7 days" };
      const when = p.label === "the next 7 days" ? "in the next 7 days" : periodWords(p);
      const list = s.invoices.filter((i) => i.status === "open" && i.due_date >= s.today && i.due_date <= (p.to < s.today ? addDays(s.today, 7) : p.to)).sort((a, b) => a.due_date.localeCompare(b.due_date));
      if (!list.length) return { text: `No unpaid invoices fall due ${when}.` };
      return {
        text: `${plural(list.length, "invoice")} ${list.length === 1 ? "falls" : "fall"} due ${when}, ${moneyList(byCurrency(list))} in all:\n${list.slice(0, 5).map((i) => `• ${invoiceLine(i, s.today)}`).join("\n")}`,
        actions: [{ label: "See unpaid invoices", href: "/dashboard/invoices" }],
      };
    },
  },
  {
    id: "client_paid",
    title: "How much has a client paid me?",
    examples: ["how much has northwind paid me", "how much did acme pay me this year", "total payments from a client", "what has this client paid so far", "how much money did I get from lagos tech hub"],
    answer(s, q) {
      // "how much does X owe" is about what's unpaid, not what's been paid
      if (/\bowe[sd]?\b|\bowing\b/i.test(q)) return INTENTS.find((i) => i.id === "owed").answer(s, q);
      const client = findByName(q, s.clients);
      if (!client) return askWhichClient(s, "How much has");
      const p = period(s, q, defaultPeriod.allTime);
      const paid = s.invoices.filter((i) => i.client_id === client.client_id && i.status === "paid" && i.paid_at && inPeriod(localDay(i.paid_at, s), p));
      if (!paid.length) return { text: `${client.name} hasn't paid you anything ${p.label === "all time" ? "yet" : periodWords(p)}.` };
      return {
        text: `${client.name} has paid you ${moneyList(byCurrency(paid))} ${p.label === "all time" ? "in all" : periodWords(p)}, across ${plural(paid.length, "invoice")}.`,
        actions: [{ label: `Open ${client.name}`, href: "/dashboard/clients" }],
      };
    },
  },
  {
    id: "client_health",
    title: "Does a client pay on time?",
    examples: ["does northwind pay on time", "how reliable is this client", "is acme a good payer", "how is my client doing", "client payment history", "is this client risky"],
    answer(s, q) {
      const client = findByName(q, s.clients);
      if (!client) return askWhichClient(s, "Does");
      const h = client.health;
      const verdict = { reliable: "is a reliable payer", watch: "is worth keeping an eye on", at_risk: "is at risk", new: "is new: there isn't enough history yet" }[h.label];
      return {
        text: `${client.name} ${verdict}${h.score !== null ? ` (health score ${h.score}/100)` : ""}. ${h.reasons.join(". ")}.`,
        actions: [{ label: `Open ${client.name}`, href: "/dashboard/clients" }],
      };
    },
  },
  {
    id: "late_payers",
    title: "Which clients pay late?",
    examples: ["which clients pay late", "who are my worst payers", "clients that always pay late", "who is risky to work with", "which customers are at risk"],
    answer(s) {
      const risky = s.clients.filter((c) => c.health.label === "at_risk" || c.health.label === "watch").sort((a, b) => (a.health.score ?? 100) - (b.health.score ?? 100));
      if (!risky.length) return { text: "None of your clients stand out as late payers." };
      return {
        text: `${listWords(risky.slice(0, 4).map((c) => `${c.name} (${c.health.label === "at_risk" ? "at risk" : "watch"}${c.health.score !== null ? `, ${c.health.score}/100` : ""})`))}. ${risky[0].health.reasons[0] ?? ""}`.trim(),
        actions: [{ label: "See clients", href: "/dashboard/clients" }],
      };
    },
  },
  {
    id: "top_clients",
    title: "Who are my best clients?",
    examples: ["who are my best clients", "which clients bring the most revenue", "top clients this year", "who pays me the most", "biggest customers by revenue"],
    answer(s, q) {
      const p = period(s, q, defaultPeriod.thisYear);
      const groups = new Map();
      for (const i of s.invoices) {
        if (i.status !== "paid" || !i.paid_at || !inPeriod(localDay(i.paid_at, s), p)) continue;
        const g = groups.get(clientLabel(i)) ?? [];
        g.push(i);
        groups.set(clientLabel(i), g);
      }
      if (!groups.size) return { text: `No invoices were paid ${periodWords(p)}.` };
      const sorted = [...groups.entries()].sort((a, b) => (byCurrency(b[1]).get("NGN") ?? 0) - (byCurrency(a[1]).get("NGN") ?? 0));
      return {
        text: `Your top clients ${periodWords(p)}: ${listWords(sorted.slice(0, 3).map(([name, items]) => `${name} (${moneyList(byCurrency(items))})`))}.`,
        actions: [{ label: "See clients", href: "/dashboard/clients" }],
      };
    },
  },
  {
    id: "revenue",
    title: "How much did I earn this month?",
    examples: ["how much did I earn this month", "how much money came in last month", "what was my revenue in september", "income this year", "how much did I make", "total received in Q3"],
    answer(s, q) {
      const client = findByName(q, s.clients);
      if (client) return INTENTS.find((i) => i.id === "client_paid").answer(s, q);
      const p = period(s, q, defaultPeriod.thisMonth);
      const total = revenueIn(s, p);
      if (!total.size) return { text: `Nothing came in from others ${periodWords(p)}.` };
      return {
        text: `${moneyList(total)} came in from others ${periodWords(p)} (paid invoices, transfers and deposits; your own top-ups and loans aren't counted).`,
        actions: [{ label: "Open analytics", href: "/dashboard/analytics" }],
        followups: ["How much did I spend this month?", "Who are my best clients?"],
      };
    },
  },
  {
    id: "spending",
    title: "How much did I spend this month?",
    examples: ["how much did I spend this month", "how much money went out last month", "what were my expenses in september", "how much did I spend on payroll in Q3", "how much have I paid in fees this year", "where is my money going", "how much went to loan repayments"],
    answer(s, q) {
      const category = categoryIn(q);
      const p = period(s, q, category ? defaultPeriod.thisYear : defaultPeriod.thisMonth);
      const out = spendIn(s, p, category);
      if (!out.length) return { text: `Nothing went out${category ? ` on ${category.toLowerCase()}` : ""} ${periodWords(p)}.` };
      if (category) return { text: `${category}: ${moneyList(byCurrency(out))} ${periodWords(p)}, across ${plural(out.length, "payment")}.`, actions: [{ label: "Open analytics", href: "/dashboard/analytics" }] };
      // the biggest kinds, in the main currency
      const main = byCurrency(out).keys().next().value;
      const cats = new Map();
      for (const f of out.filter((f) => f.currency === main)) cats.set(f.category, (cats.get(f.category) ?? 0) + f.amount_minor);
      const top = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => `${c.toLowerCase()} ${money(v, main)}`);
      return {
        text: `${moneyList(byCurrency(out))} went out ${periodWords(p)}. The biggest: ${listWords(top)}.`,
        actions: [{ label: "Open analytics", href: "/dashboard/analytics" }],
        followups: ["How much did I earn this month?"],
      };
    },
  },
  {
    id: "net",
    title: "Am I making money this month?",
    examples: ["am I making money this month", "what's my profit this year", "net cash flow last month", "did I earn more than I spent", "am I losing money", "profit and loss"],
    answer(s, q) {
      const p = period(s, q, defaultPeriod.thisMonth);
      const inn = revenueIn(s, p);
      const out = byCurrency(spendIn(s, p));
      const currencies = [...new Set([...inn.keys(), ...out.keys()])];
      if (!currencies.length) return { text: `No money moved in or out ${periodWords(p)}.` };
      const lines = currencies.map((c) => {
        const net = (inn.get(c) ?? 0) - (out.get(c) ?? 0);
        return `${c}: ${money(inn.get(c) ?? 0, c)} in, ${money(out.get(c) ?? 0, c)} out, ${net >= 0 ? `${money(net, c)} ahead` : `${money(-net, c)} behind`}`;
      });
      return { text: `${periodWords(p)[0].toUpperCase()}${periodWords(p).slice(1)}:\n${lines.map((l) => `• ${l}`).join("\n")}`, actions: [{ label: "Open business overview", href: "/dashboard/business" }] };
    },
  },
  {
    id: "balance",
    title: "What's my balance?",
    examples: ["what's my balance", "how much money do I have", "how much is in my wallets", "show my account balances", "how much cash do I have", "business wallet balance"],
    answer(s) {
      if (!s.wallets.length) return { text: "You don't have a wallet yet.", actions: [{ label: "Open a wallet", href: "/onboarding" }] };
      const lines = s.wallets.map((w) => `${w.purpose === "business" ? "Business" : "Personal"} wallet (${w.currency_code}): ${money(w.balance_minor, w.currency_code)}`);
      const saved = byCurrency(s.goals, (g) => g.saved_minor);
      return {
        text: `${lines.map((l) => `• ${l}`).join("\n")}${[...saved.values()].some((v) => v > 0) ? `\nPlus ${moneyList(saved)} saved in goals.` : ""}`,
        actions: [{ label: "Go to Home", href: "/dashboard" }],
      };
    },
  },
  {
    id: "payroll_due",
    title: "Who do I need to pay?",
    examples: ["who do I need to pay", "is payroll due", "which payees are due", "when is my next payroll", "who is due a payment", "do I owe my staff"],
    answer(s) {
      const due = s.payees.filter((p) => p.is_due);
      if (!s.payees.length) return { text: "You haven't added any payees yet.", actions: [{ label: "Open payroll", href: "/dashboard/payroll" }] };
      if (!due.length) {
        const next = s.payees.filter((p) => p.payee_status === "active" && p.next_pay_date).sort((a, b) => a.next_pay_date.localeCompare(b.next_pay_date))[0];
        return { text: `Nobody is due right now.${next ? ` Next up: ${next.name} on ${day(next.next_pay_date, s.today)}.` : ""}` };
      }
      return {
        text: `${plural(due.length, "payee")} ${due.length === 1 ? "is" : "are"} due: ${listWords(due.slice(0, 4).map((p) => `${p.name} (${money(p.rate_minor, p.currency_code)})`))}${due.length > 4 ? ` and ${due.length - 4} more` : ""}, ${moneyList(byCurrency(due, (p) => p.rate_minor))} at their usual amounts.`,
        actions: [{ label: "Run payroll", href: "/dashboard/payroll" }],
      };
    },
  },
  {
    id: "goals",
    title: "How are my savings goals doing?",
    examples: ["how are my savings goals doing", "am I on track with my goals", "how much have I saved", "goal progress", "how close am I to my emergency fund", "how much more do I need to save"],
    answer(s, q) {
      if (!s.goals.length) return { text: "You don't have any savings goals yet.", actions: [{ label: "Start a goal", href: "/dashboard/goals" }] };
      const one = findByName(q, s.goals);
      const goals = one ? [one] : s.goals;
      const lines = goals.slice(0, 4).map((g) => {
        const monthsLeft = Math.max(1, Math.ceil(daysBetween(s.today, g.target_date) / 30.4));
        const perMonth = g.remaining_minor > 0 && g.target_date > s.today ? `, about ${money(Math.ceil(g.remaining_minor / monthsLeft), g.currency_code)} a month to make ${day(g.target_date, s.today)}` : "";
        return `${g.name}: ${money(g.saved_minor, g.currency_code)} of ${money(g.target_minor, g.currency_code)} (${g.progress_percent}%)${g.is_funded ? ", fully funded" : g.target_date < s.today ? ", past its date" : perMonth}`;
      });
      return { text: lines.map((l) => `• ${l}`).join("\n"), actions: [{ label: "Open goals", href: "/dashboard/goals" }] };
    },
  },
  {
    id: "loans",
    title: "When is my next loan payment?",
    examples: ["when is my next loan payment", "how much do I owe on my loan", "loan balance", "is my loan overdue", "how many loan payments are left", "my loan status"],
    answer(s) {
      if (!s.loans.length) return { text: "You don't have an active loan.", actions: [{ label: "Loans", href: "/dashboard/loans" }] };
      const shown = [...s.loans].sort((a, b) => (b.days_overdue ?? 0) - (a.days_overdue ?? 0) || (a.next_installment?.due_date ?? "9").localeCompare(b.next_installment?.due_date ?? "9")).slice(0, 3);
      const lines = shown.map((l) => {
        const next = l.next_installment;
        const late = l.days_overdue ? ` It's ${plural(l.days_overdue, "day")} overdue: ${money(l.amount_due_now_minor, l.currency_code)} is due now.` : "";
        return `${money(l.balance_remaining_minor, l.currency_code)} left on your ${l.loan_type.replace(/_/g, " ")} loan (${l.installments_paid} of ${l.installments_total} paid).${
          next ? ` Next: ${money(next.remaining_minor, l.currency_code)} on ${day(next.due_date, s.today)}${l.auto_debit ? ", taken automatically" : ""}.` : ""
        }${late}`;
      });
      const more = s.loans.length - shown.length;
      return {
        text: `${lines.join("\n")}${more > 0 ? `\n…and ${plural(more, "more loan")}.` : ""}`,
        actions: [{ label: "Open loans", href: s.loans.length === 1 ? `/dashboard/loans/${s.loans[0].loan_id}` : "/dashboard/loans" }],
      };
    },
  },
  {
    id: "loan_payoff",
    title: "How much to pay off my loan?",
    examples: ["how much to pay off my loan", "can I pay off my loan early", "payoff amount", "how much would it cost to clear my loan today", "settle my loan", "how much interest do I save paying early"],
    answer(s) {
      const loan = s.loans.find((l) => l.payoff);
      if (!loan) return { text: "You don't have an active loan to pay off." };
      const q = loan.payoff;
      return {
        text: `Paying off today costs ${money(q.total_minor, loan.currency_code)}${q.interest_saved_minor > 0 ? `, which saves ${money(q.interest_saved_minor, loan.currency_code)} in interest` : ""}${q.overdue_minor > 0 ? ` (it includes ${money(q.overdue_minor, loan.currency_code)} already due)` : ""}.`,
        actions: [{ label: "Pay off the loan", href: `/dashboard/loans/${loan.loan_id}` }],
      };
    },
  },
  {
    id: "recurring",
    title: "How much recurring revenue do I have?",
    examples: ["how much recurring revenue do I have", "what's my monthly recurring revenue", "which plans bill next", "my retainers", "subscriptions I bill clients for", "when is the next recurring invoice"],
    answer(s) {
      const active = s.plans.filter((p) => p.plan_status === "active");
      if (!active.length) return { text: "You don't have any active recurring plans.", actions: [{ label: "Recurring billing", href: "/dashboard/recurring" }] };
      const mrr = byCurrency(active, (p) => Math.round(p.amount_minor * PER_MONTH[p.frequency]));
      const next = [...active].sort((a, b) => a.next_billing_date.localeCompare(b.next_billing_date))[0];
      return {
        text: `${plural(active.length, "active plan")} bring in about ${moneyList(mrr)} a month. Next invoice: ${next.client_name}, ${money(next.amount_minor, next.currency_code)} on ${day(next.next_billing_date, s.today)}.`,
        actions: [{ label: "Recurring billing", href: "/dashboard/recurring" }],
      };
    },
  },
  {
    id: "drafts",
    title: "Do I have unsent invoices?",
    examples: ["do I have unsent invoices", "show my draft invoices", "invoices I haven't sent", "drafts waiting", "what invoices still need sending"],
    answer(s) {
      if (!s.drafts.length) return { text: "No drafts: every invoice you've made has been sent." };
      return {
        text: `${plural(s.drafts.length, "draft")} not sent yet, ${moneyList(byCurrency(s.drafts))} in all${s.drafts[0].client_name ? `, the oldest to ${s.drafts.sort((a, b) => a.created_at - b.created_at)[0].client_name}` : ""}.`,
        actions: [{ label: "See drafts", href: "/dashboard/invoices" }],
      };
    },
  },
  {
    id: "next_steps",
    title: "What should I do next?",
    examples: ["what should I do next", "any recommendations", "what needs my attention", "give me advice", "what should I focus on today", "what can I improve"],
    answer: null, // answered from the recommendations (assistant.js)
  },
  {
    id: "help",
    title: "What can you do?",
    examples: ["what can you do", "help", "what can I ask you", "how does this work", "what questions can you answer"],
    answer: null, // lists the questions (assistant.js)
  },
  {
    id: "greeting",
    title: "Hello",
    examples: ["hi", "hello", "hey there", "good morning", "thanks", "thank you"],
    answer: null,
  },
];
