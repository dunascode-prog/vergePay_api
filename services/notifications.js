import { publishAfterCommit } from "./realtime.js";

// In-app alerts (db/migrations.db/notifications.sql), like a bank's debit
// and credit alerts. They are written inside the DB transaction that moved
// the money, so an alert exists exactly when the money moved, and pushed to
// the user's open browsers only after that transaction commits.

export const NOTIFICATION_COLUMNS = `
    notification_id, kind, title, body, transaction_id, account_id,
    direction, amount_minor, currency_code, read_at, created_at`;

const SYMBOLS = { NGN: "₦", USD: "$" };

export function formatMoney(amountMinor, currencyCode) {
  const major = (amountMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = SYMBOLS[currencyCode];
  return symbol ? `${symbol}${major}` : `${currencyCode} ${major}`;
}

function walletName(account) {
  if (account.account_type === "investment_wallet") return "Investment wallet";
  if (account.account_type === "savings") return "Savings wallet";
  return account.purpose === "business" ? "Business wallet" : "Personal wallet";
}

function displayName(account) {
  const full = [account.first_name, account.last_name].filter(Boolean).join(" ");
  return full || account.username || "a VergePay customer";
}

// The words for each side of a settled transaction. `other` is the account
// on the far side: a customer's, or null for a system account (processor
// clearing, loan holding, the dev funding account).
function creditText(txn, amount, mine, other) {
  const into = `Into your ${walletName(mine)}`;
  const from = other ? displayName(other) : null;
  switch (txn.transaction_type) {
    case "transfer":
      return from
        ? { title: `${from} sent you ${amount}`, body: withNote(into, txn.description) }
        : { title: `${amount} added to your ${walletName(mine)}`, body: txn.description };
    case "bank_deposit":
      return { title: `${amount} received by bank transfer`, body: withNote(into, txn.description) };
    case "card_payment":
      return { title: `${amount} added from your card`, body: into };
    case "loan_disbursement":
      return { title: `Your loan of ${amount} has been paid out`, body: into };
    case "invoice_payment":
      // description: "Invoice INV-0003 · TechCorp"; a pay-link payment has no
      // VergePay sender, so the invoice names who paid
      return { title: `Invoice paid: ${amount}${from ? ` by ${from}` : ""}`, body: withNote(into, txn.description) };
    case "refund":
      return { title: `Refund of ${amount}${from ? ` from ${from}` : ""}`, body: into };
    default:
      return { title: `${amount} credited to your ${walletName(mine)}`, body: txn.description };
  }
}

function debitText(txn, amount, mine, other) {
  const outOf = `From your ${walletName(mine)}`;
  const to = other ? displayName(other) : null;
  switch (txn.transaction_type) {
    case "transfer":
      return { title: to ? `You sent ${amount} to ${to}` : `${amount} sent`, body: withNote(outOf, txn.description) };
    case "loan_repayment":
      return { title: `Loan repayment of ${amount}`, body: withNote(outOf, txn.description) };
    case "invoice_payment":
      return { title: `You paid ${amount}${to ? ` to ${to}` : ""}`, body: withNote(outOf, txn.description ?? "Invoice payment") };
    case "refund":
      return { title: `You refunded ${amount}${to ? ` to ${to}` : ""}`, body: outOf };
    case "fee":
      return { title: `Fee of ${amount}`, body: withNote(outOf, txn.description) };
    default:
      return { title: `${amount} debited from your ${walletName(mine)}`, body: txn.description };
  }
}

function withNote(line, note) {
  return note ? `${line} · ${note}` : line;
}

async function insertNotification(client, row) {
  const result = await client.query(
    `INSERT INTO notifications
        (user_id, kind, title, body, transaction_id, account_id, direction, amount_minor, currency_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, transaction_id, kind) WHERE transaction_id IS NOT NULL DO NOTHING
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [
      row.userId,
      row.kind,
      row.title.slice(0, 160),
      row.body?.slice(0, 255) ?? null,
      row.transactionId ?? null,
      row.accountId ?? null,
      row.direction ?? null,
      row.amountMinor ?? null,
      row.currencyCode ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Called by the ledger (services/ledger.js) for every transaction it
 * settles, inside the same DB transaction. Writes a credit alert for the
 * receiving customer and a debit alert for the sending one; money moved
 * between two wallets of the same customer gets one "moved" alert. After the
 * commit, each owner's browsers are told to refresh balances and are sent
 * the new alert.
 */
export async function recordMoneyNotifications(client, txn) {
  const parties = await client.query(
    `SELECT a.account_id, a.account_type, a.purpose, a.user_id, a.is_system,
            u.username, u.first_name, u.last_name
     FROM account a LEFT JOIN users u ON u.user_id = a.user_id
     WHERE a.account_id = ANY($1::uuid[])`,
    [[txn.sender_account_id, txn.receiver_account_id]],
  );
  const find = (id) => parties.rows.find((a) => a.account_id === id && !a.is_system && a.user_id) ?? null;
  const sender = find(txn.sender_account_id);
  const receiver = find(txn.receiver_account_id);
  if (!sender && !receiver) return;

  const amount = formatMoney(txn.amount_minor, txn.currency_code);
  const money = { transactionId: txn.transaction_id, amountMinor: txn.amount_minor, currencyCode: txn.currency_code };
  const created = [];

  if (sender && receiver && sender.user_id === receiver.user_id) {
    created.push(
      await insertNotification(client, {
        ...money,
        userId: receiver.user_id,
        kind: "own_transfer",
        title: `You moved ${amount} to your ${walletName(receiver)}`,
        body: withNote(`From your ${walletName(sender)}`, txn.description),
        accountId: receiver.account_id,
      }),
    );
  } else {
    if (receiver) {
      created.push(
        await insertNotification(client, {
          ...money,
          ...creditText(txn, amount, receiver, sender),
          userId: receiver.user_id,
          kind: "money_received",
          accountId: receiver.account_id,
          direction: "credit",
        }),
      );
    }
    if (sender) {
      created.push(
        await insertNotification(client, {
          ...money,
          ...debitText(txn, amount, sender, receiver),
          userId: sender.user_id,
          kind: "money_sent",
          accountId: sender.account_id,
          direction: "debit",
        }),
      );
    }
  }

  // live updates: balances first, so a toast never shows before the number
  const accountsByUser = new Map();
  for (const party of [sender, receiver].filter(Boolean)) {
    accountsByUser.set(party.user_id, [...(accountsByUser.get(party.user_id) ?? []), party.account_id]);
  }
  for (const [userId, accountIds] of accountsByUser) {
    publishAfterCommit(client, userId, {
      type: "accounts.changed",
      account_ids: [...new Set(accountIds)],
      transaction_id: txn.transaction_id,
    });
  }
  for (const notification of created.filter(Boolean)) {
    const userId = notification.direction === "debit" ? sender.user_id : receiver.user_id;
    publishAfterCommit(client, userId, { type: "notification.created", notification });
  }
}

/** A non-money alert (e.g. the KYC decision), inside the caller's transaction. */
export async function recordUserNotification(client, userId, { kind, title, body = null }) {
  const notification = await insertNotification(client, { userId, kind, title, body });
  publishAfterCommit(client, userId, { type: "user.changed" });
  if (notification) publishAfterCommit(client, userId, { type: "notification.created", notification });
  return notification;
}
