import z from "zod";
import { pool } from "../db/connectDB.js";
import { clientInvoices, loadClients } from "../services/clients.js";
import { ConflictError, NotFoundError, ValidationError, BadRequestError } from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// The client book: who a customer invoices (db/migrations.db/clients.sql).
// Each customer sees only their own clients; anyone else's is a 404. Every
// read includes their payment behaviour and health (services/clients.js).

const name = z.string().trim().min(1, "Enter a name.").max(120);
const email = z.string().trim().toLowerCase().max(255).email("Enter a valid email address.");
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, "Enter a valid phone number.");
const text = (max) => z.string().trim().min(1).max(max);
const contactName = text(120);
const industry = text(80);
const location = text(120);
const notes = z.string().trim().max(2000);

const createSchema = z.strictObject({
  name,
  email: email.optional(),
  phone: phone.optional(),
  contact_name: contactName.optional(),
  industry: industry.optional(),
  location: location.optional(),
  notes: notes.optional(),
  is_vip: z.boolean().optional(),
});

const updateSchema = z
  .strictObject({
    name: name.optional(),
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    contact_name: contactName.nullable().optional(),
    industry: industry.nullable().optional(),
    location: location.nullable().optional(),
    notes: notes.nullable().optional(),
    is_vip: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change." });

const listQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  include_archived: z.enum(["true", "false"]).optional(),
});

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
  const [client] = await loadClients(pool, userId, "AND c.client_id = $2", [clientId]);
  if (!client) throw notFound();
  return client;
}

// POST /v1/clients  { name, email?, phone?, contact_name?, industry?, location?, notes?, is_vip? }
export async function createClient(req, res) {
  const body = parse(createSchema, req.body);
  try {
    const inserted = await pool.query(
      `INSERT INTO clients (user_id, name, email, phone, contact_name, industry, location, notes, is_vip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING client_id`,
      [
        req.user.sub, body.name, body.email ?? null, body.phone ?? null, body.contact_name ?? null,
        body.industry ?? null, body.location ?? null, body.notes || null, body.is_vip ?? false,
      ],
    );
    return res.status(201).json(await findOwnClient(req.user.sub, inserted.rows[0].client_id));
  } catch (err) {
    if (err.code === "23505") throw duplicateEmail();
    throw err;
  }
}

// GET /v1/clients?q=&include_archived=  (alphabetical)
// q matches the name, email, contact, industry or location.
export async function listClients(req, res) {
  const validation = listQuerySchema.safeParse(req.query);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  const { q, include_archived: includeArchived } = validation.data;
  const data = await loadClients(
    pool,
    req.user.sub,
    `AND ($2::boolean OR c.archived_at IS NULL)
     AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' OR c.email ILIKE '%' || $3 || '%'
          OR c.contact_name ILIKE '%' || $3 || '%' OR c.industry ILIKE '%' || $3 || '%' OR c.location ILIKE '%' || $3 || '%')`,
    [includeArchived === "true", q ? q.replace(/[\\%_]/g, (ch) => `\\${ch}`) : null],
    "ORDER BY lower(c.name), c.created_at LIMIT 500",
  );
  return res.status(200).json({ data });
}

// GET /v1/clients/:clientId  (with their latest invoices)
export async function getClient(req, res) {
  const client = await findOwnClient(req.user.sub, req.params.clientId);
  client.invoices = await clientInvoices(pool, req.user.sub, client.client_id);
  return res.status(200).json(client);
}

// PATCH /v1/clients/:clientId  (any profile field; null clears)
export async function updateClient(req, res) {
  const body = parse(updateSchema, req.body);
  const current = await findOwnClient(req.user.sub, req.params.clientId);
  const next = (field) => (field in body ? body[field] : current[field]);
  try {
    await pool.query(
      `UPDATE clients
       SET name = $2, email = $3, phone = $4, contact_name = $5, industry = $6, location = $7, notes = $8,
           is_vip = $9, updated_at = NOW()
       WHERE client_id = $1`,
      [
        current.client_id, body.name ?? current.name, next("email"), next("phone"), next("contact_name"),
        next("industry"), next("location"), next("notes") || null, next("is_vip"),
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

// POST /v1/clients/:clientId/restore  (back from the archive)
export async function restoreClient(req, res) {
  const current = await findOwnClient(req.user.sub, req.params.clientId);
  try {
    await pool.query(`UPDATE clients SET archived_at = NULL, updated_at = NOW() WHERE client_id = $1`, [current.client_id]);
  } catch (err) {
    // another active client took this email while it was archived
    if (err.code === "23505") throw duplicateEmail();
    throw err;
  }
  return res.status(200).json(await findOwnClient(req.user.sub, current.client_id));
}
