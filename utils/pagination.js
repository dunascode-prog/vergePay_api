import { BadRequestError } from "./errorStr.js";
import { isUuid } from "./validation.js";

// Keyset pagination cursors, opaque to clients: base64url of the last row's
// (timestamp, id) position. Pass the timestamp as text (e.g. created_at::text)
// so no precision is lost on the round trip.
export function encodeCursor(timestamp, id) {
  return Buffer.from(JSON.stringify({ t: timestamp, id })).toString("base64url");
}

export function decodeCursor(cursor) {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof t === "string" && isUuid(id) && !Number.isNaN(Date.parse(t))) return { t, id };
  } catch {
    // fall through
  }
  throw new BadRequestError({ message: "Invalid pagination cursor." });
}
