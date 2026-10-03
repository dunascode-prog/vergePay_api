import z from "zod";
import { pool } from "../db/connectDB.js";
import { NOTIFICATION_COLUMNS } from "../services/notifications.js";
import { publishToUser } from "../services/realtime.js";
import { NotFoundError, ValidationError } from "../utils/errorStr.js";
import { decodeCursor, encodeCursor } from "../utils/pagination.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// The bell: a customer's in-app alerts (services/notifications.js). Alerts
// are created by the events themselves, never through this API; the
// customer can only read them and mark them read.

const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  after: z.string().optional(),
  unread: z.enum(["true", "false"]).optional(),
});

async function unreadCount(userId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return result.rows[0].count;
}

// GET /v1/notifications?limit&after&unread=true
// Newest first. unread_count is always the total, not just this page.
export async function listNotifications(req, res) {
  const validation = listQuerySchema.safeParse(req.query);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const q = validation.data;
  const cursor = q.after ? decodeCursor(q.after) : null;

  const result = await pool.query(
    `SELECT ${NOTIFICATION_COLUMNS}, created_at::text AS cursor_ts
     FROM notifications
     WHERE user_id = $1
       AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
       AND ($3::timestamptz IS NULL OR (created_at, notification_id) < ($3::timestamptz, $4::uuid))
     ORDER BY created_at DESC, notification_id DESC
     LIMIT $5`,
    [req.user.sub, q.unread === "true", cursor?.t ?? null, cursor?.id ?? null, q.limit + 1],
  );

  const hasMore = result.rows.length > q.limit;
  const page = result.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return res.status(200).json({
    data: page.map(({ cursor_ts, ...row }) => row),
    next_cursor: hasMore ? encodeCursor(last.cursor_ts, last.notification_id) : null,
    has_more: hasMore,
    unread_count: await unreadCount(req.user.sub),
  });
}

// POST /v1/notifications/:notificationId/read
// Marking one that's already read changes nothing and still answers 200.
export async function markNotificationRead(req, res) {
  const { notificationId } = req.params;
  if (!isUuid(notificationId)) throw new NotFoundError({ message: "Notification not found." });
  const result = await pool.query(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, NOW())
     WHERE notification_id = $1 AND user_id = $2
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, req.user.sub],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Notification not found." });
  // other open tabs clear their badge too
  void publishToUser(req.user.sub, { type: "notifications.read", notification_ids: [notificationId] });
  return res.status(200).json({ ...result.rows[0], unread_count: await unreadCount(req.user.sub) });
}

// POST /v1/notifications/read-all
export async function markAllNotificationsRead(req, res) {
  const result = await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
    [req.user.sub],
  );
  void publishToUser(req.user.sub, { type: "notifications.read", all: true });
  return res.status(200).json({ updated: result.rowCount, unread_count: 0 });
}
