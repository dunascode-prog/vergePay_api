-- Profile photos (services/profilePhotos.js), kept in Postgres: one per
-- user, already re-encoded as a 512 × 512 JPEG (about 20–60 KB). Each new
-- photo gets a new photo_id, which is part of its URL, so a browser can
-- cache a photo for good and still see a new one at once.
CREATE TABLE IF NOT EXISTS profile_photos (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    photo_id UUID NOT NULL DEFAULT gen_random_uuid(),

    image BYTEA NOT NULL CHECK (octet_length(image) <= 1048576),
    content_type VARCHAR(30) NOT NULL DEFAULT 'image/jpeg',

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- an S3 key column from an earlier draft of this feature
ALTER TABLE users DROP COLUMN IF EXISTS photo_key;
