import sharp from "sharp";
import { BadRequestError, UnsupportedMediaTypeError } from "../utils/errorStr.js";

// Profile photos, kept in Postgres (db/migrations.db/profile_photos.sql).
// The API never stores what was uploaded as-is: it checks the bytes really
// are a JPG or PNG, crops to a square, and re-encodes a 512 × 512 JPEG.
// Re-encoding drops all metadata (GPS location, camera details). Only the
// signed-in owner can fetch it (GET /v1/users/me/photo/:photoId).

export const PHOTO_SIZE = 512;
const MIN_SIDE = 100;
const MAX_PIXELS = 40_000_000; // refuses "decompression bombs"

/** "jpeg" | "png" from the file's first bytes, or null. */
export function sniffImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  return null;
}

/** Checks an upload and returns the square JPEG to store. */
export async function preparePhoto(buffer) {
  if (!sniffImage(buffer)) {
    throw new UnsupportedMediaTypeError({ message: "Upload a JPG or PNG photo." });
  }
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new BadRequestError({ message: "That photo couldn't be read. Try another one." });
  }
  // the orientation flag can swap width and height
  const [w, h] = (meta.orientation ?? 1) >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
  if (!w || !h || Math.min(w, h) < MIN_SIDE) {
    throw new BadRequestError({ message: `That photo is too small. Use one at least ${MIN_SIDE} × ${MIN_SIDE} pixels.` });
  }
  try {
    return await sharp(buffer, { limitInputPixels: MAX_PIXELS })
      .rotate() // upright, from the camera's orientation flag
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover", position: "attention" })
      .flatten({ background: "#ffffff" }) // a transparent PNG gets a white background
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new BadRequestError({ message: "That photo couldn't be read. Try another one." });
  }
}

/** Where the owner fetches their photo (through the UI's /v1 proxy, with their session). */
export const photoPath = (photoId) => `/v1/users/me/photo/${photoId}`;

/** A profile row from SQL (with photo_id) → what the API returns (photo_url). */
export function withPhotoUrl(row) {
  if (!row) return row;
  const { photo_id: photoId, ...rest } = row;
  return { ...rest, photo_url: photoId ? photoPath(photoId) : null };
}
