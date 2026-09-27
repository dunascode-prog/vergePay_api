-- Only a SHA-256 hash of each refresh token is stored, never the token itself.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    refresh_token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,

    token_hash CHAR(64) UNIQUE NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    revoked_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_refresh_token_user
        FOREIGN KEY (user_id)
        REFERENCES users(user_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- A session opened with a password but not yet the second factor stays
-- limited across refreshes until the 2FA code is verified (API doc 2.2).
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS two_factor_pending BOOLEAN NOT NULL DEFAULT FALSE;
