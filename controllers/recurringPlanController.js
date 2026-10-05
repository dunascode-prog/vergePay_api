import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { KYC_TO_INVOICE, checkClient, checkIssuerAccount, requireVerifiedKyc } from "../services/invoices.js";
import { billDueCycles, loadPlan, PLAN_SELECT, planInvoices, shapePlan } from "../services/recurring.js";
import { writeAudit } from "../utils/audit.js";
import { BadRequestError, ConflictError, NotFoundError, ValidationError } from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// Recurring billing plans (services/recurring.js does the billing).
//
//   active -> paused -> active      pausing stops billing; resuming picks up
//                                   at the next date from today, without
//                                   billing the paused time
//   active | paused -> cancelled    final
//
// Edits (amount, description, terms) apply to invoices not yet sent.

const isoDate = z.iso.date("Use the format YYYY-MM-DD.");
const amountMinor = z.number().int().positive().max(1_000_000_000_000);

const createSchema = z.strictObject({
  issuer_account_id: z.uuid(),
  client_id: z.uuid(),
  description: z.string().trim().min(1).max(200),
  amount_minor: amountMinor,
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  start_date: isoDate,
  days_until_due: z.number().int().min(0).max(90).optional(),
  send_email: z.boolean().optional(),
  notes: z.string().trim().max(1000).optional(),
});

const updateSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(200).optional(),
    amount_minor: amountMinor.optional(),
    days_until_due: z.number().int().min(0).max(90).optional(),
    send_email: z.boolean().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change." });

const listQuerySchema = z.strictObject({
  status: z.enum(["active", "paused", "cancelled"]).optional(),
});

function parse(schema, body) {
  const validation = schema.safeParse(body ?? {});
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

const notFound = () => new NotFoundError({ message: "Plan not found." });

async function respondWithPlan(res, status, userId, planId) {
  const plan = await loadPlan(pool, userId, planId);
  plan.invoices = await planInvoices(pool, userId, planId);
  return res.status(status).json(plan);
}

// POST /v1/recurring-plans
export async function createPlan(req, res) {
  if (!req.body || Object.keys(req.body).length === 0) throw new BadRequestError({ message: "Request body is empty." });
  const body = parse(createSchema, req.body);
  const userId = req.user.sub;

  const planId = await withTransaction(async (client) => {
    await requireVerifiedKyc(client, userId, KYC_TO_INVOICE);
    const from = await checkIssuerAccount(client, userId, body.issuer_account_id);
    await checkClient(client, userId, body.client_id);
    if (body.start_date < from.today) {
      throw new ValidationError({ details: { start_date: ["Can't be in the past."] } });
    }
    const latest = await client.query(`SELECT ($1::date + 365)::text AS d`, [from.today]);
    if (body.start_date > latest.rows[0].d) {
      throw new ValidationError({ details: { start_date: ["Start within the next year."] } });
    }

    const inserted = await client.query(
      `INSERT INTO recurring_plans (
          user_id, issuer_account_id, client_id, description, amount_minor, currency_code, notes,
          frequency, start_date, next_billing_date, days_until_due, send_email
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11)
       RETURNING plan_id`,
      [
        userId, body.issuer_account_id, body.client_id, body.description, body.amount_minor, from.currency_code,
        body.notes || null, body.frequency, body.start_date, body.days_until_due ?? 14, body.send_email ?? true,
      ],
    );
    const id = inserted.rows[0].plan_id;
    await writeAudit(client, {
      actorId: userId,
      entityType: "recurring_plan",
      entityId: id,
      action: "create",
      after: { client_id: body.client_id, amount_minor: body.amount_minor, frequency: body.frequency, start_date: body.start_date },
    });
    // a plan that starts today sends its first invoice now
    await billDueCycles(client, id);
    return id;
  });

  return respondWithPlan(res, 201, userId, planId);
}

// GET /v1/recurring-plans?status=
export async function listPlans(req, res) {
  const query = parse(listQuerySchema, req.query);
  const params = [req.user.sub];
  let filter = "";
  if (query.status) {
    params.push(query.status);
    filter = ` AND p.plan_status = $2`;
  }
  const result = await pool.query(`${PLAN_SELECT}${filter} ORDER BY p.created_at DESC LIMIT 200`, params);
  return res.status(200).json({ data: result.rows.map(shapePlan) });
}

// GET /v1/recurring-plans/:planId
export async function getPlan(req, res) {
  const { planId } = req.params;
  if (!isUuid(planId)) throw notFound();
  const plan = await loadPlan(pool, req.user.sub, planId);
  if (!plan) throw notFound();
  return respondWithPlan(res, 200, req.user.sub, planId);
}

async function lockOwnPlan(client, userId, planId) {
  if (!isUuid(planId)) throw notFound();
  const result = await client.query(
    `SELECT plan_id, plan_status, description, amount_minor, days_until_due, send_email, notes
     FROM recurring_plans WHERE plan_id = $1 AND user_id = $2 FOR UPDATE`,
    [planId, userId],
  );
  if (!result.rows[0]) throw notFound();
  return result.rows[0];
}

// PATCH /v1/recurring-plans/:planId
export async function updatePlan(req, res) {
  const body = parse(updateSchema, req.body);
  const userId = req.user.sub;
  await withTransaction(async (client) => {
    const plan = await lockOwnPlan(client, userId, req.params.planId);
    if (plan.plan_status === "cancelled") throw new ConflictError({ message: "This plan is cancelled." });
    const fields = Object.keys(body);
    const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    await client.query(`UPDATE recurring_plans SET ${sets}, updated_at = NOW() WHERE plan_id = $1`, [
      plan.plan_id,
      ...fields.map((f) => (f === "notes" ? body.notes || null : body[f])),
    ]);
    await writeAudit(client, {
      actorId: userId,
      entityType: "recurring_plan",
      entityId: plan.plan_id,
      action: "update",
      before: Object.fromEntries(fields.map((f) => [f, plan[f]])),
      after: body,
    });
  });
  return respondWithPlan(res, 200, userId, req.params.planId);
}

async function changeStatus(req, res, { from, to, message }) {
  const userId = req.user.sub;
  await withTransaction(async (client) => {
    const plan = await lockOwnPlan(client, userId, req.params.planId);
    if (!from.includes(plan.plan_status)) throw new ConflictError({ message: message(plan.plan_status) });
    if (to === "active") {
      // pick up at the first billing date from today: the paused time isn't billed
      const next = await client.query(
        `SELECT min(n) AS n
         FROM recurring_plans p JOIN users u ON u.user_id = p.user_id,
              generate_series(p.next_cycle, p.next_cycle + 6000) n
         WHERE p.plan_id = $1
           AND recurring_billing_date(p.start_date, p.frequency, n) >= (NOW() AT TIME ZONE u.timezone)::date`,
        [plan.plan_id],
      );
      await client.query(
        `UPDATE recurring_plans
         SET plan_status = 'active', paused_at = NULL, updated_at = NOW(),
             next_cycle = $2, next_billing_date = recurring_billing_date(start_date, frequency, $2)
         WHERE plan_id = $1`,
        [plan.plan_id, next.rows[0].n],
      );
      // due today: bill it now rather than at the next scheduled run
      await billDueCycles(client, plan.plan_id);
    } else {
      await client.query(
        `UPDATE recurring_plans
         SET plan_status = $2::recurring_status_enum, updated_at = NOW(),
             paused_at = CASE WHEN $2::recurring_status_enum = 'paused' THEN NOW() ELSE paused_at END,
             cancelled_at = CASE WHEN $2::recurring_status_enum = 'cancelled' THEN NOW() ELSE cancelled_at END
         WHERE plan_id = $1`,
        [plan.plan_id, to],
      );
    }
    await writeAudit(client, {
      actorId: userId,
      entityType: "recurring_plan",
      entityId: plan.plan_id,
      action: "status_change",
      before: { plan_status: plan.plan_status },
      after: { plan_status: to },
    });
  });
  return respondWithPlan(res, 200, userId, req.params.planId);
}

// POST /v1/recurring-plans/:planId/pause
export const pausePlan = (req, res) =>
  changeStatus(req, res, { from: ["active"], to: "paused", message: (s) => `Only an active plan can be paused; this one is ${s}.` });

// POST /v1/recurring-plans/:planId/resume
export const resumePlan = (req, res) =>
  changeStatus(req, res, { from: ["paused"], to: "active", message: (s) => `Only a paused plan can be resumed; this one is ${s}.` });

// POST /v1/recurring-plans/:planId/cancel
export const cancelPlan = (req, res) =>
  changeStatus(req, res, { from: ["active", "paused"], to: "cancelled", message: () => "This plan is already cancelled." });
