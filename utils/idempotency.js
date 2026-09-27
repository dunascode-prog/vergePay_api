import crypto from "crypto";
import { pool } from "../db/connectDB.js";
import logger from "../logger.js";
import AppError from "./appError.js";
import { BadRequestError, ConflictError } from "./errorStr.js";

// A claimed key with no stored response is "in flight". If it stays that way
// this long the original request is assumed to have died, and a retry may
// take the key over instead of getting 409 until the key expires.
const STALE_IN_FLIGHT_SECONDS = 60;

export class IdempotencyConflictError extends AppError {
  constructor() {
    super({
      message:
        "This Idempotency-Key was already used with a different request.",
      statusCode: 422,
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
  }
}

class IdempotencyInFlightError extends ConflictError {
  constructor() {
    super({
      message:
        "A request with this Idempotency-Key is still being processed. Retry shortly.",
    });
    this.code = "IDEMPOTENCY_KEY_IN_FLIGHT";
  }
}

function hashRequest(req) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([req.method, req.originalUrl, req.body ?? null]),
    )
    .digest("hex");
}

// Implements API doc 1.3:
//   new key                        -> process, store the response
//   repeated key, same payload     -> replay the stored response
//   repeated key, different payload-> 422
//   repeated key, still in flight  -> 409
//   missing key                    -> 400
// Keys are scoped to the caller, so two users can't collide on a key; a
// back-office caller (utils/internalAuth.js) has its own "internal" scope.
// Only 2xx responses are stored; any other outcome releases the key so the
// client can retry.
export const idempotency = async (req, res, next) => {
  const clientKey = req.header("Idempotency-Key");

  if (!clientKey) {
    throw new BadRequestError({
      message: "Idempotency-Key header is required.",
    });
  }
  if (clientKey.length > 200) {
    throw new BadRequestError({
      message: "Idempotency-Key must be at most 200 characters.",
    });
  }

  const scope = req.user?.sub ?? (req.internalCaller ? "internal" : "anonymous");
  const key = `${scope}:${clientKey}`;
  const requestHash = hashRequest(req);

  // Clear this key if it has expired or its original request died mid-flight,
  // then try to claim it. ON CONFLICT makes the claim atomic between racers.
  await pool.query(
    `
    DELETE FROM idempotency_keys
    WHERE key = $1
      AND (
        expires_at <= NOW()
        OR (response IS NULL AND created_at < NOW() - make_interval(secs => $2))
      )
    `,
    [key, STALE_IN_FLIGHT_SECONDS],
  );
  const claim = await pool.query(
    `
    INSERT INTO idempotency_keys (key, request_hash)
    VALUES ($1, $2)
    ON CONFLICT (key) DO NOTHING
    RETURNING key
    `,
    [key, requestHash],
  );

  if (claim.rowCount === 0) {
    const existing = await pool.query(
      `SELECT request_hash, response, status_code FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    const stored = existing.rows[0];
    if (!stored) {
      // released between our insert and select; the client can simply retry
      throw new IdempotencyInFlightError();
    }
    if (stored.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    if (stored.response === null) {
      throw new IdempotencyInFlightError();
    }
    res.set("Idempotent-Replayed", "true");
    return res.status(stored.status_code).json(stored.response);
  }

  // We own the key: record the outcome when the handler responds.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.json = originalJson;
    const succeeded = res.statusCode >= 200 && res.statusCode < 300;
    const record = succeeded
      ? pool.query(
          `UPDATE idempotency_keys SET response = $2, status_code = $3 WHERE key = $1`,
          [key, JSON.stringify(body), res.statusCode],
        )
      : pool.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key]);

    record
      .catch((err) =>
        logger.error({
          requestId: req.requestId,
          message: "failed to record idempotency outcome",
          error: err.message,
        }),
      )
      .finally(() => originalJson(body));
    return res;
  };

  req.idempotencyKey = clientKey;
  next();
};

// For endpoints where the doc makes the key recommended rather than
// required: with a key, the rules above apply; without one, the request
// runs unprotected.
export const optionalIdempotency = (req, res, next) =>
  req.header("Idempotency-Key") ? idempotency(req, res, next) : next();
