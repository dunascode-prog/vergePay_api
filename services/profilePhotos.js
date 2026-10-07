import crypto from "crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from "sharp";
import env from "../env.js";
import logger from "../logger.js";
import { BadRequestError, UnsupportedMediaTypeError } from "../utils/errorStr.js";

// Profile photos in a private S3 bucket. The API never stores what was
// uploaded as-is: it checks the bytes really are a JPG or PNG, crops to a
// square, and re-encodes a 512 × 512 JPEG. Re-encoding drops all metadata
// (GPS location, camera details). Only the owner ever gets a link, signed
// and short-lived.

export const PHOTO_SIZE = 512;
const MIN_SIDE = 100;
const MAX_PIXELS = 40_000_000; // refuses "decompression bombs"

let client = null;
export const photosEnabled = () => Boolean(env.photos.bucket);

function s3() {
  client ??= new S3Client({
    region: env.photos.region,
    ...(env.photos.endpoint && { endpoint: env.photos.endpoint, forcePathStyle: true }),
  });
  return client;
}

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

/** Stores a prepared photo under a new key (never overwritten, so it caches well). */
export async function storePhoto(userId, jpeg) {
  const key = `avatars/${userId}/${crypto.randomUUID()}.jpg`;
  await s3().send(
    new PutObjectCommand({
      Bucket: env.photos.bucket,
      Key: key,
      Body: jpeg,
      ContentType: "image/jpeg",
      CacheControl: "private, max-age=86400, immutable",
    }),
  );
  return key;
}

/** Best effort: a photo left behind is only wasted storage. */
export async function deletePhoto(key) {
  if (!key || !photosEnabled()) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: env.photos.bucket, Key: key }));
  } catch (err) {
    logger.warn({ message: "profile photo not deleted", key, error: err.message });
  }
}

/**
 * A signed link to the photo. It's signed as of the start of the hour and
 * lasts two, so the same link comes back all hour (the browser can cache the
 * image) and always has at least an hour left.
 */
export async function photoUrl(key) {
  if (!key || !photosEnabled()) return null;
  const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  try {
    return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.photos.bucket, Key: key }), {
      expiresIn: 2 * 3600,
      signingDate: hourStart,
    });
  } catch (err) {
    logger.warn({ message: "profile photo link not signed", error: err.message });
    return null;
  }
}

/** A profile row from SQL (with photo_key) → what the API returns (photo_url). */
export async function withPhotoUrl(row) {
  if (!row) return row;
  const { photo_key: key, ...rest } = row;
  return { ...rest, photo_url: await photoUrl(key) };
}
