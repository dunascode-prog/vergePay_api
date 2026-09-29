import crypto from "crypto";
import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import env from "../env.js";
import logger from "../logger.js";
import * as alpaca from "../services/alpaca.js";
import { setSyncStatus } from "../services/brokerageSync.js";
import { cancelLinkSync, enqueueLinkSync } from "../services/queue.js";
import { destroySecret, storeSecret } from "../services/vault.js";
import { writeAudit } from "../utils/audit.js";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// Investments (API doc 9): connect an external brokerage with OAuth, sync
// its holdings in the background, and read them.
//
//   POST   /v1/brokerage-links                 start connecting (User + 2FA)
//   GET    /v1/brokerage-links/oauth/callback  the brokerage sends the user back here
//   GET    /v1/brokerage-links                 list links (never any token material)
//   POST   /v1/brokerage-links/:id/sync        queue a sync now (202)
//   DELETE /v1/brokerage-links/:id             disconnect (User + 2FA)
//   GET    /v1/holdings[/:id]                  the synced positions
//
// Connecting is two steps because that's how OAuth works: our server never
// sees the brokerage password, only a one-time code the brokerage hands back
// after the user logs in with them directly.

const PROVIDERS = ["alpaca"];
const STATE_TTL_MINUTES = 10;

const startSchema = z.strictObject({
  provider_name: z.enum(PROVIDERS),
  account_id: z.uuid().optional(),
});

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const linkNotFound = () => new NotFoundError({ message: "Brokerage link not found." });

// The investment_wallet account the holdings will sit in: the one named, or
// the user's only one.
async function investmentAccount(userId, accountId) {
  const result = await pool.query(
    `SELECT account_id, account_status FROM account
     WHERE user_id = $1 AND account_type = 'investment_wallet' AND NOT is_system
       AND ($2::uuid IS NULL OR account_id = $2)
     ORDER BY created_at`,
    [userId, accountId ?? null],
  );
  if (result.rowCount === 0) {
    throw new ValidationError({
      details: {
        account_id: [
          accountId
            ? "Not one of your investment_wallet accounts."
            : "Open an investment_wallet account first (POST /v1/accounts).",
        ],
      },
    });
  }
  if (!accountId && result.rowCount > 1) {
    throw new ValidationError({ details: { account_id: ["You have several investment wallets; say which one."] } });
  }
  const account = result.rows[0];
  if (account.account_status !== "active") throw new ConflictError({ message: `The account is ${account.account_status}.` });
  return account.account_id;
}

// POST /v1/brokerage-links
export async function startBrokerageLink(req, res) {
  const validation = startSchema.safeParse(req.body ?? {});
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  const { provider_name: provider, account_id } = validation.data;
  const accountId = await investmentAccount(req.user.sub, account_id);

  // The state ties the callback to this user and request; only its hash is
  // stored, it works once, and it expires quickly.
  const state = crypto.randomBytes(32).toString("base64url");
  const authorizationUrl = alpaca.authorizationUrl(state);
  const saved = await pool.query(
    `INSERT INTO oauth_states (state_hash, user_id, provider_name, account_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))
     RETURNING expires_at`,
    [hash(state), req.user.sub, provider, accountId, STATE_TTL_MINUTES],
  );

  return res.status(200).json({
    authorization_url: authorizationUrl,
    state,
    expires_at: saved.rows[0].expires_at,
  });
}

function backToApp(res, params) {
  const url = new URL(env.brokerage.returnUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return res.redirect(302, url.toString());
}

// GET /v1/brokerage-links/oauth/callback?code&state   (public)
// The brokerage redirects the user's browser here. Protected by the state
// (unguessable, single use, short-lived) and the code itself. Always ends by
// redirecting back to the app with ?status=linked|failed.
export async function brokerageOauthCallback(req, res) {
  const { code, state, error } = req.query;
  if (typeof state !== "string" || !state) return backToApp(res, { status: "failed", reason: "missing_state" });

  // Consume the state atomically: a second use, or a late one, finds nothing.
  const claimed = await pool.query(
    `UPDATE oauth_states SET used_at = NOW()
     WHERE state_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING user_id, provider_name, account_id`,
    [hash(state)],
  );
  const pending = claimed.rows[0];
  if (!pending) return backToApp(res, { status: "failed", reason: "expired_or_used_state" });
  if (error) return backToApp(res, { status: "failed", reason: String(error).slice(0, 50) });
  if (typeof code !== "string" || !code) return backToApp(res, { status: "failed", reason: "missing_code" });

  let token;
  let brokerageAccount;
  try {
    token = await alpaca.exchangeCode(code);
    brokerageAccount = await alpaca.getAccount(token);
  } catch (err) {
    logger.error({ message: "brokerage connection failed", error: err.message });
    return backToApp(res, { status: "failed", reason: "brokerage_rejected" });
  }
  const providerAccountId = String(brokerageAccount.account_number ?? brokerageAccount.id ?? "");
  if (!providerAccountId) return backToApp(res, { status: "failed", reason: "no_brokerage_account" });

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      // The same brokerage account already connected: reconnect it (a new
      // token for this user's link), or refuse if it belongs to someone else.
      const existing = await client.query(
        `SELECT link_id, user_id, link_status, oauth_token_reference
         FROM external_brokerage_links
         WHERE provider_name = $1 AND provider_account_id = $2 AND link_status IN ('active', 'expired')
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [pending.provider_name, providerAccountId],
      );
      const previous = existing.rows[0];
      if (previous && previous.user_id !== pending.user_id) return { refused: "linked_to_another_user" };

      const reference = await storeSecret(client, `${pending.provider_name}_oauth_token`, token);
      if (previous) {
        await client.query(
          `UPDATE external_brokerage_links
           SET oauth_token_reference = $2, link_status = 'active', account_id = $3,
               last_sync_status = 'queued', last_sync_error = NULL, updated_at = NOW()
           WHERE link_id = $1`,
          [previous.link_id, reference, pending.account_id],
        );
        await destroySecret(client, previous.oauth_token_reference);
        await writeAudit(client, {
          actorId: pending.user_id,
          entityType: "brokerage_link",
          entityId: previous.link_id,
          action: "status_change",
          before: { link_status: previous.link_status },
          after: { link_status: "active", reconnected: true },
        });
        return { linkId: previous.link_id };
      }

      const inserted = await client.query(
        `INSERT INTO external_brokerage_links (
            user_id, provider_name, oauth_token_reference, link_status,
            account_id, provider_account_id, last_sync_status
         )
         VALUES ($1, $2, $3, 'active', $4, $5, 'queued')
         RETURNING link_id`,
        [pending.user_id, pending.provider_name, reference, pending.account_id, providerAccountId],
      );
      await writeAudit(client, {
        actorId: pending.user_id,
        entityType: "brokerage_link",
        entityId: inserted.rows[0].link_id,
        action: "create",
        after: { provider_name: pending.provider_name, account_id: pending.account_id },
      });
      return { linkId: inserted.rows[0].link_id };
    });
  } catch (err) {
    logger.error({ message: "saving the brokerage link failed", error: err.message });
    return backToApp(res, { status: "failed", reason: "server_error" });
  }
  if (outcome.refused) return backToApp(res, { status: "failed", reason: outcome.refused });

  // The first sync. The link exists either way; if the queue is down it
  // simply waits for the next scheduled sync or a manual one.
  try {
    await enqueueLinkSync(outcome.linkId, "connected");
  } catch (err) {
    await setSyncStatus(outcome.linkId, "not_queued", err.message);
  }
  return backToApp(res, { status: "linked", link_id: outcome.linkId });
}

const LINK_COLUMNS = `
    link_id, provider_name, account_id,
    CASE WHEN provider_account_id IS NULL THEN NULL
         ELSE '••••' || right(provider_account_id, 4) END AS provider_account,
    link_status, last_synced_at, last_sync_status, last_sync_error, created_at`;

// GET /v1/brokerage-links   (the token reference is never returned)
export async function listBrokerageLinks(req, res) {
  const result = await pool.query(
    `SELECT ${LINK_COLUMNS} FROM external_brokerage_links
     WHERE user_id = $1 AND link_status <> 'revoked'
     ORDER BY created_at DESC`,
    [req.user.sub],
  );
  return res.status(200).json({ data: result.rows });
}

async function findOwnLink(db, userId, linkId, { lock = false } = {}) {
  if (!isUuid(linkId)) throw linkNotFound();
  const result = await db.query(
    `SELECT * FROM external_brokerage_links WHERE link_id = $1 AND user_id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [linkId, userId],
  );
  if (result.rowCount === 0) throw linkNotFound();
  return result.rows[0];
}

// POST /v1/brokerage-links/:linkId/sync
// 202: the sync is queued for the worker, never run inside this request.
// Asking again while one is waiting returns the same job (safe to repeat).
export async function syncBrokerageLink(req, res) {
  const link = await findOwnLink(pool, req.user.sub, req.params.linkId);
  if (link.link_status !== "active") {
    throw new ConflictError({
      message:
        link.link_status === "expired"
          ? "This connection has expired. Reconnect it with POST /v1/brokerage-links."
          : `This connection is ${link.link_status}.`,
    });
  }
  const { jobId, state } = await enqueueLinkSync(link.link_id, "manual");
  if (state === "waiting" || state === "delayed" || state === "prioritized") await setSyncStatus(link.link_id, "queued");
  return res.status(202).json({ link_id: link.link_id, sync_status: state === "active" ? "running" : "queued", job_id: jobId });
}

// DELETE /v1/brokerage-links/:linkId   (User + 2FA)
// Destroys the stored token, so nothing can use it again, and removes the
// holdings that came from this link.
export async function deleteBrokerageLink(req, res) {
  const userId = req.user.sub;
  const link = await withTransaction(async (client) => {
    const link = await findOwnLink(client, userId, req.params.linkId, { lock: true });
    if (link.link_status === "revoked") throw new ConflictError({ message: "This connection is already disconnected." });
    await destroySecret(client, link.oauth_token_reference);
    await client.query(`DELETE FROM holdings WHERE external_link_id = $1`, [link.link_id]);
    await client.query(
      `UPDATE external_brokerage_links
       SET link_status = 'revoked', revoked_at = NOW(), oauth_token_reference = 'revoked', updated_at = NOW()
       WHERE link_id = $1`,
      [link.link_id],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "brokerage_link",
      entityId: link.link_id,
      action: "status_change",
      before: { link_status: link.link_status },
      after: { link_status: "revoked" },
    });
    return link;
  });
  try {
    await cancelLinkSync(link.link_id);
  } catch {
    // a queued sync would find the link revoked and skip anyway
  }
  return res.status(200).json({ link_id: link.link_id, link_status: "revoked" });
}

// The security is nested on every row (API doc 9.2): a portfolio screen
// needs the ticker and name on each line.
const HOLDING_SELECT = `
    SELECT h.holding_id,
           h.account_id,
           json_build_object(
             'ticker_symbol', s.ticker_symbol,
             'company_name', s.company_name,
             'asset_type', s.asset_type,
             'exchange', s.exchange,
             'currency_code', s.currency_code
           ) AS security,
           h.quantity::text AS quantity,
           h.average_cost_minor,
           h.current_price_minor,
           h.market_value_minor,
           h.unrealized_pl_minor,
           h.external_link_id,
           l.provider_name,
           h.last_synced_at
    FROM holdings h
    JOIN securities s ON s.security_id = h.security_id
    JOIN account a ON a.account_id = h.account_id
    LEFT JOIN external_brokerage_links l ON l.link_id = h.external_link_id`;

const holdingsQuery = z.strictObject({ account_id: z.uuid().optional() });

// GET /v1/holdings[?account_id=]
export async function listHoldings(req, res) {
  const validation = holdingsQuery.safeParse(req.query);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  const result = await pool.query(
    `${HOLDING_SELECT}
     WHERE a.user_id = $1 AND ($2::uuid IS NULL OR h.account_id = $2)
     ORDER BY h.market_value_minor DESC NULLS LAST, s.ticker_symbol`,
    [req.user.sub, validation.data.account_id ?? null],
  );
  return res.status(200).json({ data: result.rows });
}

// GET /v1/holdings/:holdingId
export async function getHolding(req, res) {
  const { holdingId } = req.params;
  if (!isUuid(holdingId)) throw new NotFoundError({ message: "Holding not found." });
  const result = await pool.query(`${HOLDING_SELECT} WHERE h.holding_id = $1 AND a.user_id = $2`, [holdingId, req.user.sub]);
  if (result.rowCount === 0) throw new NotFoundError({ message: "Holding not found." });
  return res.status(200).json(result.rows[0]);
}
