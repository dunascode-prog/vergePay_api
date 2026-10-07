import { withTransaction } from "../db/withTransaction.js";
import { deletePhoto, photosEnabled, preparePhoto, storePhoto, withPhotoUrl } from "../services/profilePhotos.js";
import { writeAudit } from "../utils/audit.js";
import { ServiceUnavailableError, UnsupportedMediaTypeError } from "../utils/errorStr.js";
import { PROFILE_COLUMNS } from "./userController.js";

// Profile photos:
//
//   PUT    /v1/users/me/photo   the image itself as the body,
//                               Content-Type image/jpeg or image/png, 2 MB at most
//   DELETE /v1/users/me/photo   removes it
//
// Both return the profile, with photo_url (a signed link, or null).

function requireStorage() {
  if (!photosEnabled()) {
    throw new ServiceUnavailableError({ message: "Profile photos aren't available right now." });
  }
}

// Sets the user's photo key in the database; returns the profile and the
// key it replaced.
async function savePhotoKey(userId, key) {
  return withTransaction(async (client) => {
    const before = await client.query(`SELECT photo_key FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
    const oldKey = before.rows[0]?.photo_key ?? null;
    const updated = await client.query(
      `UPDATE users SET photo_key = $2 WHERE user_id = $1 RETURNING ${PROFILE_COLUMNS}`,
      [userId, key],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "user",
      entityId: userId,
      action: "update",
      before: { photo: oldKey ? "set" : "none" },
      after: { photo: key ? "set" : "none" },
    });
    return { profile: updated.rows[0], oldKey };
  });
}

// PUT /v1/users/me/photo  (behind express.raw, so req.body is a Buffer)
export async function uploadPhoto(req, res) {
  requireStorage();
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new UnsupportedMediaTypeError({ message: "Upload a JPG or PNG photo (Content-Type image/jpeg or image/png)." });
  }
  const jpeg = await preparePhoto(req.body);
  const key = await storePhoto(req.user.sub, jpeg);

  let saved;
  try {
    saved = await savePhotoKey(req.user.sub, key);
  } catch (err) {
    await deletePhoto(key); // nothing points at it
    throw err;
  }
  await deletePhoto(saved.oldKey);
  return res.status(200).json(await withPhotoUrl(saved.profile));
}

// DELETE /v1/users/me/photo
export async function removePhoto(req, res) {
  const { profile, oldKey } = await savePhotoKey(req.user.sub, null);
  await deletePhoto(oldKey);
  return res.status(200).json(await withPhotoUrl(profile));
}
