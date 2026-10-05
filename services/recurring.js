import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import logger from "../logger.js";
import AppError from "../utils/appError.js";
import { writeAudit } from "../utils/audit.js";
import {
  INVOICE_SELECT,
  KYC_TO_INVOICE,
  checkClient,
  checkIssuerAccount,
  emailIfWanted,
  markSent,
  replaceItems,
  requireVerifiedKyc,
  shapeInvoice,
} from "./invoices.js";
import { formatMoney, recordUserNotification } from "./notifications.js";

// Recurring billing (db/migrations.db/recurring_plans.sql). A plan invoices
// one client the same amount on a schedule. When a plan is due, billPlan()
// sends the invoice through the same path as a hand-made one: line item,
// number, pay link and, if the plan says so, an email to the client.
//
// The worker's scheduled job (worker.js) bills every due plan; a plan that
// starts today is billed as it's created. Each plan is billed in its own DB
// transaction, with its row locked, and the (plan, cycle) unique index on
// invoices makes a doubled run harmless.

// What every plan read shares. $1 is the owner's user_id.
export const PLAN_SELECT = `
    SELECT p.plan_id,
           p.plan_status,
           p.description,
           p.amount_minor,
           p.currency_code,
           p.notes,
           p.frequency,
           to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
           CASE WHEN p.plan_status = 'cancelled' THEN NULL
                ELSE to_char(p.next_billing_date, 'YYYY-MM-DD') END AS next_billing_date,
           p.days_until_due,
           p.send_email,
           p.issuer_account_id,
           a.account_number AS issuer_account_number,
           a.purpose AS issuer_account_purpose,
           p.client_id,
           c.name AS client_name,
           c.email AS client_email,
           (SELECT count(*)::int FROM invoices i WHERE i.recurring_plan_id = p.plan_id) AS invoices_generated,
           (SELECT max(i.sent_at) FROM invoices i WHERE i.recurring_plan_id = p.plan_id) AS last_invoice_at,
           p.last_error,
           p.last_error_at,
           p.paused_at,
           p.cancelled_at,
           p.created_at,
           p.updated_at
    FROM recurring_plans p
    JOIN account a ON a.account_id = p.issuer_account_id
    JOIN clients c ON c.client_id = p.client_id
    WHERE p.user_id = $1`;

export function shapePlan(row) {
  const { client_id: clientId, client_name: name, client_email: email, ...rest } = row;
  return { ...rest, client: { client_id: clientId, name, email } };
}

export async function loadPlan(db, userId, planId) {
  const result = await db.query(`${PLAN_SELECT} AND p.plan_id = $2`, [userId, planId]);
  return result.rows[0] ? shapePlan(result.rows[0]) : null;
}

/** The invoices a plan has sent, newest first. */
export async function planInvoices(db, userId, planId, limit = 50) {
  const result = await db.query(
    `${INVOICE_SELECT} WHERE i.recurring_plan_id = $2 AND i.issuer_user_id = $1
     ORDER BY i.recurring_cycle DESC LIMIT $3`,
    [userId, planId, limit],
  );
  return result.rows.map((row) => {
    const { items: _items, ...invoice } = shapeInvoice(row, []);
    return invoice;
  });
}

// At most this many missed cycles billed in one go (e.g. after the worker
// was down); the rest go out on the next run.
const MAX_CYCLES_PER_RUN = 12;

const DAY_LABEL = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", DAY_LABEL);

/**
 * Sends every invoice a plan owes as of today (in the owner's timezone),
 * inside the caller's DB transaction. The plan row must be locked. Returns
 * the invoice ids sent, oldest first. Throws if the wallet or client can no
 * longer be billed; nothing is sent then.
 */
export async function billDueCycles(client, planId) {
  const sent = [];
  for (let i = 0; i < MAX_CYCLES_PER_RUN; i++) {
    const due = await client.query(
      `SELECT p.*, to_char(p.next_billing_date, 'YYYY-MM-DD') AS billing_date,
              to_char(recurring_billing_date(p.start_date, p.frequency, p.next_cycle + 1) - 1, 'YYYY-MM-DD') AS period_end,
              to_char(GREATEST(p.next_billing_date, (NOW() AT TIME ZONE u.timezone)::date) + p.days_until_due, 'YYYY-MM-DD') AS due_date
       FROM recurring_plans p JOIN users u ON u.user_id = p.user_id
       WHERE p.plan_id = $1 AND p.plan_status = 'active'
         AND p.next_billing_date <= (NOW() AT TIME ZONE u.timezone)::date`,
      [planId],
    );
    const plan = due.rows[0];
    if (!plan) break;

    await requireVerifiedKyc(client, plan.user_id, KYC_TO_INVOICE);
    await checkIssuerAccount(client, plan.user_id, plan.issuer_account_id);
    await checkClient(client, plan.user_id, plan.client_id);

    const inserted = await client.query(
      `INSERT INTO invoices (
          issuer_user_id, issuer_account_id, client_id, amount_due_minor, currency_code,
          due_date, notes, invoice_status, recurring_plan_id, recurring_cycle
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9)
       RETURNING invoice_id`,
      [
        plan.user_id, plan.issuer_account_id, plan.client_id, plan.amount_minor, plan.currency_code,
        plan.due_date, plan.notes, plan.plan_id, plan.next_cycle,
      ],
    );
    const invoiceId = inserted.rows[0].invoice_id;
    const period = `${fmtDay(plan.billing_date)} – ${fmtDay(plan.period_end)}`;
    await replaceItems(client, invoiceId, [
      {
        description: `${plan.description} (${period})`.slice(0, 255),
        quantity: 1,
        unit_amount_minor: Number(plan.amount_minor),
        amount_minor: Number(plan.amount_minor),
      },
    ]);
    await writeAudit(client, {
      actorId: null,
      entityType: "invoice",
      entityId: invoiceId,
      action: "create",
      after: { recurring_plan_id: plan.plan_id, recurring_cycle: plan.next_cycle, amount_due_minor: plan.amount_minor },
    });
    await markSent(client, invoiceId, plan.user_id);
    await emailIfWanted(client, invoiceId, plan.user_id, plan.send_email);

    await client.query(
      `UPDATE recurring_plans
       SET next_cycle = next_cycle + 1,
           next_billing_date = recurring_billing_date(start_date, frequency, next_cycle + 1),
           last_error = NULL, last_error_at = NULL, updated_at = NOW()
       WHERE plan_id = $1`,
      [plan.plan_id],
    );

    const number = await client.query(
      `SELECT i.invoice_number, c.name FROM invoices i JOIN clients c ON c.client_id = i.client_id WHERE i.invoice_id = $1`,
      [invoiceId],
    );
    const { invoice_number: invoiceNumber, name } = number.rows[0];
    await recordUserNotification(client, plan.user_id, {
      kind: "recurring_invoice_sent",
      title: `${invoiceNumber} sent to ${name}: ${formatMoney(plan.amount_minor, plan.currency_code)}`,
      body: `From your ${plan.frequency} plan "${plan.description}". Due ${fmtDay(plan.due_date)}.`,
    });
    sent.push(invoiceId);
  }
  return sent;
}

// What went wrong, in words the customer can act on.
function failureMessage(err) {
  if (err.details && typeof err.details === "object") {
    const first = Object.values(err.details).flat()[0];
    if (typeof first === "string") return first;
  }
  return err.message || "The invoice couldn't be sent.";
}

/**
 * Bills one plan if it's due (the scheduled job). A plan another worker is
 * billing right now is skipped. If the plan can't be billed (its wallet is
 * frozen, its client archived, …), nothing is sent, the reason is saved on
 * the plan and the owner is told once; the next run tries again.
 */
export async function billPlan(planId) {
  try {
    return await withTransaction(async (client) => {
      const locked = await client.query(
        `SELECT plan_id FROM recurring_plans WHERE plan_id = $1 FOR UPDATE SKIP LOCKED`,
        [planId],
      );
      if (!locked.rows[0]) return [];
      return billDueCycles(client, planId);
    });
  } catch (err) {
    // a bug or an outage: leave the plan as it is and let the job log it
    if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
    const message = failureMessage(err).slice(0, 255);
    await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE recurring_plans p SET last_error = $2, last_error_at = NOW()
         WHERE p.plan_id = $1 AND p.last_error IS DISTINCT FROM $2
         RETURNING p.user_id, p.description`,
        [planId, message],
      );
      const plan = updated.rows[0];
      if (plan) {
        await recordUserNotification(client, plan.user_id, {
          kind: "recurring_invoice_failed",
          title: `Couldn't send the invoice for "${plan.description}"`,
          body: `${message} We'll try again; fix it or pause the plan.`,
        });
      }
    });
    logger.warn({ message: "recurring plan not billed", planId, reason: message });
    return [];
  }
}

/** Active plans due today or earlier, in each owner's timezone. */
export async function duePlanIds(limit = 500) {
  const result = await pool.query(
    `SELECT p.plan_id FROM recurring_plans p JOIN users u ON u.user_id = p.user_id
     WHERE p.plan_status = 'active' AND p.next_billing_date <= (NOW() AT TIME ZONE u.timezone)::date
     ORDER BY p.next_billing_date
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => r.plan_id);
}

/** The scheduled job: bills every due plan, one at a time. */
export async function billDuePlans({ planIds = null } = {}) {
  const ids = planIds ?? (await duePlanIds());
  let invoices = 0;
  for (const id of ids) invoices += (await billPlan(id)).length;
  return { plans: ids.length, invoices };
}
