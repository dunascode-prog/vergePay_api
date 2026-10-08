-- Changing the email address (controllers/emailChangeController.js): the
-- customer confirms their password (and a recent 2FA code if 2FA is on),
-- then a 6-digit code goes to the NEW address. Valid 15 minutes, 5 tries.
-- Only a hash of the code is stored. A new request replaces an earlier one.
CREATE TABLE IF NOT EXISTS email_change_codes (
    change_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    new_email VARCHAR(255) NOT NULL,

    -- SHA-256 of the user id, the new address and the code
    code_hash CHAR(64) NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- at most one change in progress per user
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_change_live
    ON email_change_codes(user_id) WHERE used_at IS NULL;

-- 'email_changed': the notice to the old address once the change is made
ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_kind_check;
ALTER TABLE email_log ADD CONSTRAINT email_log_kind_check
    CHECK (kind IN ('invoice', 'reminder', 'receipt', 'password_reset', 'email_change', 'email_changed'));
