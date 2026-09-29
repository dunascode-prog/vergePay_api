import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import logger from "../logger.js";
import * as alpaca from "./alpaca.js";
import { readSecret } from "./vault.js";

// Syncs one brokerage link's holdings from the brokerage (data model 4.14):
// read the link's token from the vault, fetch the positions, and upsert
// them into holdings in one DB transaction. It always writes the latest
// state rather than appending, so running it twice changes nothing, and a
// position the user has since sold is removed.
//
// Runs in the worker process (worker.js), never inside an HTTP request.

// Alpaca asset classes -> ours. Options aren't holdings we model yet.
const ASSET_TYPES = { us_equity: "stock", crypto: "crypto" };

// "123.4567" -> 12346 (minor units, rounded half up), with string maths so
// prices never pass through floating point. Handles a leading minus.
export function decimalToMinor(value) {
  const text = String(value ?? "").trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === "" && !match[3])) return null;
  const [, sign, whole, fraction = ""] = match;
  const padded = (fraction + "000").slice(0, 3);
  let minor = BigInt(whole || "0") * 100n + BigInt(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) minor += 1n;
  const result = Number(sign ? -minor : minor);
  return Number.isSafeInteger(result) ? result : null;
}

const QUANTITY = /^\d+(\.\d+)?$/;

// Updates a link's sync status outside any transaction.
export async function setSyncStatus(linkId, status, error = null) {
  await pool.query(
    `UPDATE external_brokerage_links
     SET last_sync_status = $2, last_sync_error = $3, updated_at = NOW()
     WHERE link_id = $1`,
    [linkId, status, error?.slice(0, 500) ?? null],
  );
}

// The token was refused: the link can't sync until the user reconnects.
export async function expireLink(linkId, reason) {
  await pool.query(
    `UPDATE external_brokerage_links
     SET link_status = 'expired', last_sync_status = 'failed', last_sync_error = $2, updated_at = NOW()
     WHERE link_id = $1 AND link_status = 'active'`,
    [linkId, reason.slice(0, 500)],
  );
}

// Returns { status: "synced", holdings, removed, skipped } or
// { status: "skipped", reason }. Throws alpaca.BrokerageAuthError when the
// token is refused, and alpaca.BrokerageUnavailableError (retryable) when
// the brokerage is down or rate limiting.
export async function syncLink(linkId) {
  const found = await pool.query(
    `SELECT link_id, user_id, account_id, provider_name, oauth_token_reference, link_status, credential_source
     FROM external_brokerage_links WHERE link_id = $1`,
    [linkId],
  );
  const link = found.rows[0];
  if (!link) return { status: "skipped", reason: "link not found" };
  if (link.link_status !== "active") return { status: "skipped", reason: `link is ${link.link_status}` };

  // A user's own account uses their OAuth token from the vault; the shared
  // test account uses the platform's keys from .env.
  let token;
  if (link.credential_source === "platform") {
    token = alpaca.platformAuth();
  } else {
    token = await readSecret(pool, link.oauth_token_reference);
    if (!token) throw new alpaca.BrokerageAuthError("The stored credential is missing. Reconnect the brokerage.");
  }

  // All brokerage calls happen before the DB transaction, so a slow
  // brokerage never holds database locks.
  const positions = await alpaca.getPositions(token);
  const items = [];
  const skipped = [];
  const knownNames = new Map(
    (await pool.query(`SELECT ticker_symbol, company_name FROM securities`)).rows.map((r) => [r.ticker_symbol, r.company_name]),
  );
  for (const position of positions) {
    const assetType = ASSET_TYPES[position.asset_class];
    const averageCost = decimalToMinor(position.avg_entry_price);
    if (!assetType || !position.symbol || !QUANTITY.test(String(position.qty)) || averageCost === null) {
      skipped.push(position.symbol ?? "?");
      continue;
    }
    let name = knownNames.get(position.symbol);
    if (!name) {
      name = (await alpaca.getAsset(token, position.symbol)).name || position.symbol;
      knownNames.set(position.symbol, name);
    }
    items.push({
      ticker: position.symbol.slice(0, 15),
      // Alpaca's names can carry doubled spaces ("Bitcoin  / US Dollar")
      name: name.replace(/\s+/g, " ").trim().slice(0, 150),
      assetType,
      exchange: position.exchange?.slice(0, 50) ?? null,
      quantity: String(position.qty),
      averageCost,
      price: decimalToMinor(position.current_price),
      value: decimalToMinor(position.market_value),
      pl: decimalToMinor(position.unrealized_pl),
    });
  }

  return withTransaction(async (client) => {
    // Two syncs of the same link (a manual one and a scheduled one) take turns.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [linkId]);
    const current = await client.query(
      `SELECT link_status FROM external_brokerage_links WHERE link_id = $1 FOR UPDATE`,
      [linkId],
    );
    if (current.rows[0]?.link_status !== "active") {
      return { status: "skipped", reason: "link was disconnected during the sync" };
    }

    const securityIds = [];
    for (const item of items) {
      const security = await client.query(
        `INSERT INTO securities (ticker_symbol, company_name, asset_type, exchange, currency_code)
         VALUES ($1, $2, $3, $4, 'USD')
         ON CONFLICT (ticker_symbol) DO UPDATE
           SET company_name = EXCLUDED.company_name, exchange = COALESCE(EXCLUDED.exchange, securities.exchange)
         RETURNING security_id`,
        [item.ticker, item.name, item.assetType, item.exchange],
      );
      const securityId = security.rows[0].security_id;
      securityIds.push(securityId);
      await client.query(
        `INSERT INTO holdings (
            account_id, security_id, external_link_id, quantity, average_cost_minor,
            current_price_minor, market_value_minor, unrealized_pl_minor, last_synced_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (external_link_id, security_id) WHERE external_link_id IS NOT NULL DO UPDATE
           -- the link may have been moved to another wallet since the last sync
           SET account_id = EXCLUDED.account_id,
               quantity = EXCLUDED.quantity,
               average_cost_minor = EXCLUDED.average_cost_minor,
               current_price_minor = EXCLUDED.current_price_minor,
               market_value_minor = EXCLUDED.market_value_minor,
               unrealized_pl_minor = EXCLUDED.unrealized_pl_minor,
               last_synced_at = NOW()`,
        [link.account_id, securityId, linkId, item.quantity, item.averageCost, item.price, item.value, item.pl],
      );
    }

    // Positions no longer at the brokerage (sold) disappear here too.
    const removed = await client.query(
      `DELETE FROM holdings WHERE external_link_id = $1 AND NOT (security_id = ANY($2::uuid[]))`,
      [linkId, securityIds],
    );
    await client.query(
      `UPDATE external_brokerage_links
       SET last_synced_at = NOW(), last_sync_status = 'succeeded', last_sync_error = NULL, updated_at = NOW()
       WHERE link_id = $1`,
      [linkId],
    );
    if (skipped.length) logger.error({ message: "brokerage positions skipped", linkId, skipped });
    return { status: "synced", holdings: items.length, removed: removed.rowCount, skipped: skipped.length };
  });
}

// For the scheduled job: active links that haven't synced within the interval.
export async function dueLinkIds(intervalMs) {
  const result = await pool.query(
    `SELECT link_id FROM external_brokerage_links
     WHERE link_status = 'active'
       AND (last_synced_at IS NULL OR last_synced_at < NOW() - make_interval(secs => $1))`,
    [Math.floor(intervalMs / 1000) - 30],
  );
  return result.rows.map((r) => r.link_id);
}
