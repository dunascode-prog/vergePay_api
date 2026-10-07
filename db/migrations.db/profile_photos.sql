-- Profile photos (services/profilePhotos.js): the S3 key of the current
-- photo. The file lives in a private bucket; only the owner gets a link.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_key VARCHAR(200);
