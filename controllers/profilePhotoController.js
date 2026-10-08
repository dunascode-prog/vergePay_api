import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { preparePhoto, withPhotoUrl } from "../services/profilePhotos.js";
import { writeAudit } from "../utils/audit.js";
import { NotFoundError, UnsupportedMediaTypeError } from "../utils/errorStr.js";
import { PROFILE_COLUMNS } from "./userController.js";

// Profile photos:
//
//   PUT    /v1/users/me/photo            the image itself as the body,
//                                        Content-Type image/jpeg or image/png, 2 MB at most
//   DELETE /v1/users/me/photo            removes it
//   GET    /v1/users/me/photo/:photoId   the stored JPEG, to its owner only
//
// PUT and DELETE return the profile, with photo_url (or null).

async function changePhoto(userId, jpeg) {
  return withTransaction(async (client) => {
    await client.query(`SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
    const before = await client.query(`SELECT 1 FROM profile_photos WHERE user_id = $1`, [userId]);
    if (jpeg) {
      // a new photo_id every time, so the new photo has a new URL
      await client.query(
        `INSERT INTO profile_photos (user_id, image) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET image = EXCLUDED.image, photo_id = gen_random_uuid(), created_at = NOW()`,
        [userId, jpeg],
      );
    } else {
      await client.query(`DELETE FROM profile_photos WHERE user_id = $1`, [userId]);
    }
    await writeAudit(client, {
      actorId: userId,
      entityType: "user",
      entityId: userId,
      action: "update",
      before: { photo: before.rowCount ? "set" : "none" },
      after: { photo: jpeg ? "set" : "none" },
    });
    const profile = await client.query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE user_id = $1`, [userId]);
    return withPhotoUrl(profile.rows[0]);
  });
}

// PUT /v1/users/me/photo  (behind express.raw, so req.body is a Buffer)
export async function uploadPhoto(req, res) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new UnsupportedMediaTypeError({ message: "Upload a JPG or PNG photo (Content-Type image/jpeg or image/png)." });
  }
  const jpeg = await preparePhoto(req.body);
  return res.status(200).json(await changePhoto(req.user.sub, jpeg));
}

// DELETE /v1/users/me/photo
export async function removePhoto(req, res) {
  return res.status(200).json(await changePhoto(req.user.sub, null));
}

// GET /v1/users/me/photo/:photoId
export async function getPhoto(req, res) {
  const photoId = z.uuid().safeParse(req.params.photoId);
  if (!photoId.success) throw new NotFoundError({ message: "Photo not found." });
  const found = await pool.query(
    `SELECT image, content_type FROM profile_photos WHERE user_id = $1 AND photo_id = $2`,
    [req.user.sub, photoId.data],
  );
  // an old photo_id (replaced or removed) or someone else's: not found
  if (found.rowCount === 0) throw new NotFoundError({ message: "Photo not found." });
  res.set({
    "Content-Type": found.rows[0].content_type,
    // this URL's photo never changes; a new photo gets a new URL
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  return res.status(200).send(found.rows[0].image);
}
