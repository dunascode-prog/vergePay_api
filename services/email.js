import nodemailer from "nodemailer";
import { pool } from "../db/connectDB.js";
import env from "../env.js";
import logger from "../logger.js";
import { emailQueue } from "./queue.js";

// Outgoing email: invoices, reminders and receipts. Each message is first
// saved to email_log exactly as it will go out, then sent by the worker
// (worker.js, the "email" queue) with retries, so a slow or failing mail
// server never holds up an HTTP request.
//
// Transports (env.email.transport):
//   smtp      any SMTP service from SMTP_URL (e.g. Brevo's free plan)
//   ethereal  development default: real SMTP into a fake inbox, with a
//             preview link per message saved as email_log.preview_url
//   json      builds the message but sends nothing (the test suite)

let transporter;
async function getTransporter() {
  if (transporter) return transporter;
  const { transport, smtpUrl } = env.email;
  if (transport === "json") {
    transporter = nodemailer.createTransport({ jsonTransport: true });
  } else if (transport === "smtp" && smtpUrl) {
    transporter = nodemailer.createTransport(smtpUrl);
  } else if (transport === "ethereal" && env.nodeEnv !== "production") {
    const account = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    logger.info({ message: "email: using an Ethereal test inbox", user: account.user });
  } else {
    throw new Error("Email isn't configured on this server (set SMTP_URL).");
  }
  return transporter;
}

/**
 * Sends one saved email (an email_log row) and records the outcome. Throws
 * on failure so the queue retries; the last attempt's error stays on the row.
 */
export async function deliverEmail(emailId, { lastAttempt = true } = {}) {
  const found = await pool.query(`SELECT * FROM email_log WHERE email_id = $1`, [emailId]);
  const email = found.rows[0];
  if (!email || email.status === "sent") return email ?? null;

  try {
    const mailer = await getTransporter();
    const info = await mailer.sendMail({
      from: env.email.from,
      to: email.to_address,
      subject: email.subject,
      html: email.html,
      text: email.text_body,
    });
    const previewUrl = nodemailer.getTestMessageUrl(info) || null;
    const updated = await pool.query(
      `UPDATE email_log
       SET status = 'sent', attempts = attempts + 1, provider_message_id = $2, preview_url = $3,
           error = NULL, sent_at = NOW()
       WHERE email_id = $1 RETURNING *`,
      [emailId, String(info.messageId ?? "").slice(0, 255) || null, previewUrl],
    );
    if (previewUrl) logger.info({ message: "email sent (preview)", emailId, previewUrl });
    return updated.rows[0];
  } catch (err) {
    await pool.query(
      `UPDATE email_log SET attempts = attempts + 1, error = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END
       WHERE email_id = $1`,
      [emailId, err.message.slice(0, 500), lastAttempt],
    );
    logger.error({ message: "email send failed", emailId, error: err.message });
    throw err;
  }
}

/**
 * Saves an email and queues it for the worker. With no job queue (no
 * REDIS_URL), it's sent from this process instead, in the background.
 * Returns the email_log row as saved (status "queued").
 */
export async function queueEmail(db, { userId, invoiceId = null, kind, to, subject, html, text }) {
  const saved = await db.query(
    `INSERT INTO email_log (user_id, invoice_id, kind, to_address, subject, html, text_body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING email_id, kind, to_address, subject, status, created_at`,
    [userId, invoiceId, kind, to, subject.slice(0, 255), html, text],
  );
  const email = saved.rows[0];
  const enqueue = async () => {
    try {
      await emailQueue().add("send-email", { emailId: email.email_id }, { jobId: `email-${email.email_id}` });
    } catch (err) {
      logger.warn({ message: "email queue unavailable; sending from the API process", error: err.message });
      deliverEmail(email.email_id).catch(() => {});
    }
  };
  // inside a DB transaction, the row only exists for the worker after commit
  if (typeof db.afterCommit === "function") db.afterCommit(enqueue);
  else await enqueue();
  return email;
}
