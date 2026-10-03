import { EventEmitter } from "events";
import Redis from "ioredis";
import env from "../env.js";
import logger from "../logger.js";

// Live events for signed-in browsers ("money arrived", "your balance
// changed"). Anything that changes a user's data calls publishToUser(); every
// API process delivers the event to that user's open WebSockets
// (realtime/websocketServer.js).
//
// Events travel over Redis pub/sub, so an event raised in one process (the
// worker, or another API instance behind a load balancer) reaches sockets
// held by any other. Without REDIS_URL they stay inside this process, which
// is enough for a single API on a laptop.
//
// Delivery is best effort: a browser that is offline misses the event and
// catches up by re-reading on reconnect. The source of truth is always the
// database (notifications, ledger), never this bus.
//
// Events (all JSON, all carry `type`):
//   notification.created   { notification }  a new alert for the bell
//   notifications.read     { notification_ids | all: true }  read in another tab
//   accounts.changed       { account_ids, transaction_id }  balances moved
//   user.changed           {}  the profile changed (e.g. KYC decided)

const CHANNEL = "vergepay:user-events";
const local = new EventEmitter();
local.setMaxListeners(0);

let publisher;
let subscriber;

function redisOptions() {
  return {
    // keep retrying in the background; a Redis blip must never crash the API
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: false,
  };
}

function getPublisher() {
  if (!env.redisUrl) return null;
  if (!publisher) {
    publisher = new Redis(env.redisUrl, redisOptions());
    publisher.on("error", (err) => logger.warn({ message: "realtime publisher error", error: err.message }));
  }
  return publisher;
}

/** Sends an event to every open socket of one user, in any process. Never throws. */
export async function publishToUser(userId, event) {
  const message = JSON.stringify({ userId, event });
  const redis = getPublisher();
  if (!redis) {
    local.emit("message", message);
    return;
  }
  try {
    await redis.publish(CHANNEL, message);
  } catch (err) {
    // Redis is down: still reach sockets held by this process
    logger.warn({ message: "realtime publish failed; delivering locally only", error: err.message });
    local.emit("message", message);
  }
}

/**
 * Calls handler(userId, event) for every event published by any process.
 * Returns a function that stops listening.
 */
export function subscribeToUserEvents(handler) {
  const onMessage = (raw) => {
    try {
      const { userId, event } = JSON.parse(raw);
      if (userId && event?.type) handler(userId, event);
    } catch {
      // not ours or malformed: ignore
    }
  };
  local.on("message", onMessage);

  if (env.redisUrl && !subscriber) {
    subscriber = new Redis(env.redisUrl, { ...redisOptions(), enableOfflineQueue: true });
    subscriber.on("error", (err) => logger.warn({ message: "realtime subscriber error", error: err.message }));
    subscriber.subscribe(CHANNEL).catch((err) =>
      logger.error({ message: "realtime subscribe failed", error: err.message }),
    );
    subscriber.on("message", (channel, raw) => {
      if (channel === CHANNEL) local.emit("redis", raw);
    });
  }
  local.on("redis", onMessage);

  return () => {
    local.off("message", onMessage);
    local.off("redis", onMessage);
  };
}

/**
 * Publishes once the caller's DB transaction commits (see
 * db/withTransaction.js). Outside a transaction it publishes now.
 */
export function publishAfterCommit(client, userId, event) {
  if (typeof client?.afterCommit === "function") {
    client.afterCommit(() => publishToUser(userId, event));
  } else {
    void publishToUser(userId, event);
  }
}

export async function closeRealtime() {
  await Promise.allSettled([publisher?.quit(), subscriber?.quit()]);
  publisher = undefined;
  subscriber = undefined;
}
