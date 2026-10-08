import { byCurrency, day, daysBetween, money, moneyList, plural } from "./format.js";
import { addDays } from "./periods.js";

// "What to do next": a short, ranked list built by plain rules from the
// customer's data (snapshot.js), never by a model. Each one has a stable key
// (so it can be dismissed for a while), a tone, a one-line title, a line of
// detail and one action. Only the highest few are shown.

const DAY_MS = 86_400_000;
const localDay = (instant, tz) => new Date(instant).toLocaleDateString("en-CA", { timeZone: tz });

export function buildRecommendations(s) {
  const recs = [];
  const add = (r) => recs.push(r);
  const tz = s.user.timezone;
  const walletIn = (currency, purpose) => s.wallets.find((w) => w.currency_code === currency && (!purpose || w.purpose === purpose));

  // ---- money owed to the customer
  const overdue = s.invoices.filter((i) => i.status === "overdue").sort((a, b) => a.due_date.localeCompare(b.due_date));
  const seenClients = new Set();
  for (const i of overdue) {
    const who = i.payer_key;
    if (seenClients.has(who) || seenClients.size >= 3) continue; // one per client, three at most
    seenClients.add(who);
    const late = daysBetween(i.due_date, s.today);
    const remindedAgo = i.last_reminder_at ? Math.floor((Date.now() - new Date(i.last_reminder_at).getTime()) / DAY_MS) : null;
    const canRemind = remindedAgo === null || remindedAgo >= 1;
    add({
      key: `overdue:${i.invoice_id}`,
      kind: "collect",
      tone: late > 14 ? "urgent" : "warning",
      priority: 80 + Math.min(late, 15),
      title: `Chase ${i.client_name ?? "your client"}: ${money(i.amount_due_minor, i.currency_code)} is ${plural(late, "day")} late`,
      body: `${i.invoice_number ?? "The invoice"} was due ${day(i.due_date, s.today)}. ${
        remindedAgo === null ? "No reminder sent yet." : remindedAgo === 0 ? "You reminded them today." : `Last reminder ${plural(remindedAgo, "day")} ago.`
      }`,
      action: canRemind ? { label: "Send reminder", kind: "remind", invoice_id: i.invoice_id } : { label: "Open invoice", href: `/dashboard/invoices/${i.invoice_id}` },
    });
  }
  const soon = s.invoices.filter((x) => x.status === "open" && x.due_date >= s.today && x.due_date <= addDays(s.today, 3) && !x.last_reminder_at);
  for (const i of soon.filter((x, n) => soon.findIndex((y) => y.payer_key === x.payer_key) === n).slice(0, 2)) {
    add({
      key: `due-soon:${i.invoice_id}`,
      kind: "collect",
      tone: "tip",
      priority: 35,
      title: `${i.client_name ?? "A client"}'s ${money(i.amount_due_minor, i.currency_code)} is due ${i.due_date === s.today ? "today" : day(i.due_date, s.today)}`,
      body: "A friendly reminder before the due date gets invoices paid sooner.",
      action: { label: "Send reminder", kind: "remind", invoice_id: i.invoice_id },
    });
  }
  const oldDrafts = s.drafts.filter((d) => Date.now() - new Date(d.created_at).getTime() > 2 * DAY_MS);
  if (oldDrafts.length) {
    add({
      key: `drafts:${oldDrafts.map((d) => d.invoice_id).sort()[0]}`,
      kind: "collect",
      tone: "tip",
      priority: 45,
      title: `Send ${plural(oldDrafts.length, "draft invoice")} (${moneyList(byCurrency(oldDrafts))})`,
      body: "They've been waiting more than 2 days. Clients can't pay an invoice they haven't received.",
      action: { label: "See drafts", href: "/dashboard/invoices" },
    });
  }

  // ---- money the customer owes
  for (const loan of s.loans) {
    const next = loan.next_installment;
    if (!next) continue;
    const wallet = s.wallets.find((w) => w.account_id === loan.account_id);
    const balance = Number(wallet?.balance_minor ?? 0);
    if (loan.days_overdue) {
      add({
        key: `loan-overdue:${loan.loan_id}:${next.installment_number}`,
        kind: "loan",
        tone: "urgent",
        priority: 98,
        title: `Your loan payment is ${plural(loan.days_overdue, "day")} overdue: ${money(loan.amount_due_now_minor, loan.currency_code)} is due now`,
        body: loan.days_overdue > 3 ? "A late fee has been added. Paying now stops it going any further." : "Pay within 3 days of the due date to avoid a late fee.",
        action: { label: "Pay now", href: `/dashboard/loans/${loan.loan_id}` },
      });
      continue;
    }
    const daysToGo = daysBetween(s.today, next.due_date);
    if (daysToGo >= 0 && daysToGo <= 5) {
      const short = Number(next.remaining_minor) - balance;
      add({
        key: `loan-due:${loan.loan_id}:${next.installment_number}`,
        kind: "loan",
        tone: short > 0 ? "warning" : "tip",
        priority: short > 0 ? 85 : 55,
        title: short > 0
          ? `Top up ${money(short, loan.currency_code)} before ${day(next.due_date, s.today)}: your loan payment is ${money(next.remaining_minor, loan.currency_code)}`
          : `Loan payment of ${money(next.remaining_minor, loan.currency_code)} on ${day(next.due_date, s.today)}`,
        body: loan.auto_debit
          ? short > 0 ? "It's taken automatically from your wallet, which doesn't hold enough yet." : "It's taken automatically; your wallet has enough."
          : "Automatic repayment is off, so pay it yourself on or before the date.",
        action: { label: short > 0 ? "Add money" : "Open loan", href: short > 0 ? "/dashboard" : `/dashboard/loans/${loan.loan_id}` },
      });
    }
    const quote = loan.payoff;
    if (quote && quote.interest_saved_minor > 0 && balance >= quote.total_minor) {
      add({
        key: `loan-payoff:${loan.loan_id}:${s.today.slice(0, 7)}`,
        kind: "loan",
        tone: "tip",
        priority: 40,
        title: `Pay off your loan early and save ${money(quote.interest_saved_minor, loan.currency_code)} in interest`,
        body: `Your wallet holds enough: paying off today costs ${money(quote.total_minor, loan.currency_code)}.`,
        action: { label: "See payoff", href: `/dashboard/loans/${loan.loan_id}` },
      });
    }
  }

  // one tip for every loan without automatic repayments
  const manual = s.loans.filter((l) => !l.auto_debit && l.next_installment);
  if (manual.length) {
    add({
      key: `loan-autodebit:${manual.map((l) => l.loan_id).sort()[0]}`,
      kind: "loan",
      tone: "tip",
      priority: 30,
      title: manual.length === 1 ? "Turn on automatic loan repayments" : `Turn on automatic repayments for your ${manual.length} loans`,
      body: "Each installment is then taken on its due date, so you never pay a late fee by forgetting.",
      action: { label: "Open loans", href: manual.length === 1 ? `/dashboard/loans/${manual[0].loan_id}` : "/dashboard/loans" },
    });
  }

  const due = s.payees.filter((p) => p.is_due);
  if (due.length) {
    const totals = byCurrency(due, (p) => p.rate_minor);
    const [currency, total] = [...totals.entries()][0];
    const wallet = walletIn(currency, "business") ?? walletIn(currency);
    const short = total - Number(wallet?.balance_minor ?? 0);
    add({
      key: `payroll-due:${due.map((p) => p.payee_id).sort().join(",").slice(0, 80)}`,
      kind: "payroll",
      tone: short > 0 ? "warning" : "tip",
      priority: short > 0 ? 75 : 65,
      title: `Pay ${plural(due.length, "payee")}: ${moneyList(totals)} is due`,
      body: short > 0
        ? `Your ${wallet?.purpose ?? ""} wallet has ${money(wallet?.balance_minor ?? 0, currency)}; top up ${money(short, currency)} first.`.replace("  ", " ")
        : `${due.slice(0, 3).map((p) => p.name).join(", ")}${due.length > 3 ? ` and ${due.length - 3} more` : ""}, at their usual amounts.`,
      action: { label: short > 0 ? "Add money" : "Run payroll", href: short > 0 ? "/dashboard" : "/dashboard/payroll" },
    });
  }

  for (const p of s.plans.filter((x) => x.plan_status === "active" && x.last_error)) {
    add({
      key: `plan-error:${p.plan_id}`,
      kind: "billing",
      tone: "warning",
      priority: 75,
      title: `${p.client_name}'s recurring invoice couldn't be sent`,
      body: p.last_error,
      action: { label: "Fix the plan", href: `/dashboard/recurring/${p.plan_id}` },
    });
  }

  // ---- saving
  for (const g of s.goals) {
    if (g.is_funded || g.target_date <= s.today) continue;
    const start = localDay(g.created_at, tz);
    const span = Math.max(1, daysBetween(start, g.target_date));
    const elapsed = Math.max(0, daysBetween(start, s.today));
    const expected = Math.round((Number(g.target_minor) * elapsed) / span);
    const gap = expected - Number(g.saved_minor);
    if (elapsed < 14 || gap < Number(g.target_minor) * 0.05) continue; // too early, or close enough
    const wallet = walletIn(g.currency_code);
    const spare = Number(wallet?.balance_minor ?? 0);
    add({
      key: `goal-behind:${g.goal_id}:${s.today.slice(0, 7)}`,
      kind: "save",
      tone: "tip",
      priority: 50,
      title: `${g.name} is behind: add ${money(gap, g.currency_code)} to get back on pace`,
      body: `${g.progress_percent}% saved, with ${plural(daysBetween(s.today, g.target_date), "day")} to go.${spare >= gap ? " Your wallet has enough to catch up now." : ""}`,
      action: { label: "Add money to goal", href: `/dashboard/goals/${g.goal_id}` },
    });
  }

  // ---- concentration: one client bringing most of the last 90 days' revenue
  const since = addDays(s.today, -90);
  const recent = s.invoices.filter((i) => i.status === "paid" && i.paid_at && i.currency_code === "NGN" && localDay(i.paid_at, tz) >= since);
  const total = recent.reduce((t, i) => t + Number(i.amount_due_minor), 0);
  if (recent.length >= 3 && total > 0) {
    const byClient = new Map();
    for (const i of recent) byClient.set(i.client_name ?? "One customer", (byClient.get(i.client_name ?? "One customer") ?? 0) + Number(i.amount_due_minor));
    const [name, amount] = [...byClient.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = Math.round((amount / total) * 100);
    if (share >= 60) {
      add({
        key: `concentration:${name}:${s.today.slice(0, 7)}`,
        kind: "insight",
        tone: "info",
        priority: 15,
        title: `${name} brought in ${share}% of your naira revenue in the last 90 days`,
        body: "Relying on one client is a risk if they pause or pay late. Recurring plans with other clients spread it out.",
        action: { label: "See clients", href: "/dashboard/clients" },
      });
    }
  }

  // ---- account safety
  if (s.user.kyc_status === "unverified" || s.user.kyc_status === "rejected") {
    add({
      key: "kyc",
      kind: "account",
      tone: "tip",
      priority: 60,
      title: "Verify your identity to start moving money",
      body: "It takes a minute with your BVN, and you'll be asked the first time you add money, send or withdraw.",
      action: { label: "Add money", href: "/dashboard" },
    });
  }
  if (!s.user.two_factor_enabled) {
    add({
      key: "2fa",
      kind: "account",
      tone: "tip",
      priority: 20,
      title: "Turn on two-factor authentication",
      body: "Signing in then needs a code from your phone as well as your password.",
      action: { label: "Turn on", href: "/dashboard/profile" },
    });
  }

  return recs.sort((a, b) => b.priority - a.priority);
}
