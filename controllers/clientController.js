import z from "zod";
import { pool } from "../db/connectDB.js";
import { ConflictError, NotFoundError, ValidationError, BadRequestError } from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// The client book: who a customer invoices (db/migrations.db/clients.sql).
// Each customer sees only their own clients; anyone else's is a 404.

const name = z.string().trim().min(1, "Enter a name.").max(120);
const email = z.string().trim().toLowerCase().max(255).email("Enter a valid email address.");
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, "Enter a valid phone number.");

const createSchema = z.strictObject({
  name,
  email: email.optional(),
  phone: phone.optional(),
});

const updateSchema = z
  .strictObject({
    name: name.optional(),
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change." });

const listQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  include_archived: z.enum(["true", "false"]).optional(),
});

const CLIENT_SELECT = `
    SELECT c.client_id, c.name, c.email, c.phone, c.archived_at, c.created_at, c.updated_at,
           (SELECT count(*)::int FROM invoices i WHERE i.client_id = c.client_id AND i.invoice_status <> 'draft') AS invoice_count,
           COALESCE((
             SELECT json_agg(json_build_object('currency_code', o.currency_code, 'amount_minor', o.amount_minor))
             FROM (SELECT i.currency_code, sum(i.amount_due_minor)::bigint AS amount_minor
                   FROM invoices i WHERE i.client_id = c.client_id AND i.invoice_status = 'open'
                   GROUP BY i.currency_code) o
           ), '[]'::json) AS outstanding,
           (SELECT max(i.sent_at) FROM invoices i WHERE i.client_id = c.client_id) AS last_invoiced_at
    FROM clients c`;

function parse(schema, body) {
  if (!body || Object.keys(body).length === 0) throw new BadRequestError({ message: "Request body is empty." });
  const validation = schema.safeParse(body);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

const notFound = () => new NotFoundError({ message: "Client not found." });
const duplicateEmail = () =>
  new ConflictError({ message: "You already have a client with this email address.", field: "email" });

async function findOwnClient(userId, clientId) {
  if (!isUuid(clientId)) throw notFound();
  const result = await pool.query(`${CLIENT_SELECT} WHERE c.client_id = $1 AND c.user_id = $2`, [clientId, userId]);
  if (result.rowCount === 0) throw notFound();
  return result.rows[0];
}

// POST /v1/clients  { name, email?, phone? }
export async function createClient(req, res) {
  const body = parse(createSchema, req.body);
  try {
    const inserted = await pool.query(
      `INSERT INTO clients (user_id, name, email, phone) VALUES ($1, $2, $3, $4) RETURNING client_id`,
      [req.user.sub, body.name, body.email ?? null, body.phone ?? null],
    );
    return res.status(201).json(await findOwnClient(req.user.sub, inserted.rows[0].client_id));
  } catch (err) {
    if (err.code === "23505") throw duplicateEmail();
    throw err;
  }
}

// GET /v1/clients?q=&include_archived=  (alphabetical)
export async function listClients(req, res) {
  const validation = listQuerySchema.safeParse(req.query);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  const { q, include_archived: includeArchived } = validation.data;
  const result = await pool.query(
    `${CLIENT_SELECT}
     WHERE c.user_id = $1
       AND ($2::boolean OR c.archived_at IS NULL)
       AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' OR c.email ILIKE '%' || $3 || '%')
     ORDER BY lower(c.name), c.created_at
     LIMIT 500`,
    [req.user.sub, includeArchived === "true", q ? q.replace(/[\\%_]/g, (ch) => `\\${ch}`) : null],
  );
  return res.status(200).json({ data: result.rows });
}

// GET /v1/clients/:clientId
export async function getClient(req, res) {
  return res.status(200).json(await findOwnClient(req.user.sub, req.params.clientId));
}

// PATCH /v1/clients/:clientId  { name?, email?, phone? }  (null clears)
export async function updateClient(req, res) {
  const body = parse(updateSchema, req.body);
  const current = await findOwnClient(req.user.sub, req.params.clientId);
  try {
    await pool.query(
      `UPDATE clients SET name = $2, email = $3, phone = $4, updated_at = NOW() WHERE client_id = $1`,
      [
        current.client_id,
        body.name ?? current.name,
        "email" in body ? body.email : current.email,
        "phone" in body ? body.phone : current.phone,
      ],
    );
  } catch (err) {
    if (err.code === "23505") throw duplicateEmail();
    throw err;
  }
  return res.status(200).json(await findOwnClient(req.user.sub, current.client_id));
}

// DELETE /v1/clients/:clientId  (archives: hidden from pickers, invoices kept)
export async function archiveClient(req, res) {
  const current = await findOwnClient(req.user.sub, req.params.clientId);
  await pool.query(`UPDATE clients SET archived_at = COALESCE(archived_at, NOW()), updated_at = NOW() WHERE client_id = $1`, [
    current.client_id,
  ]);
  return res.status(200).json(await findOwnClient(req.user.sub, current.client_id));
}
