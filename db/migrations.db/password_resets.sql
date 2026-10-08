-- Forgot password (controllers/passwordResetController.js): a 6-digit code
-- sent by email, valid for 15 minutes, with 5 tries. Only a hash of the
-- code is stored. A new code replaces any earlier one for that user.
CREATE TABLE IF NOT EXISTS password_reset_codes (
    reset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- SHA-256 of the user id and the code, so equal codes don't hash alike
    code_hash CHAR(64) NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- at most one live code per user
CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_live
    ON password_reset_codes(user_id) WHERE used_at IS NULL;

-- Account emails (password reset codes, and confirming a new email address)
-- go through the same email log and queue as invoice emails. The list
-- matches email_changes.sql, so re-running every migration in order never
-- narrows it below rows that already exist.
ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_kind_check;
ALTER TABLE email_log ADD CONSTRAINT email_log_kind_check
    CHECK (kind IN ('invoice', 'reminder', 'receipt', 'password_reset', 'email_change', 'email_changed'));

-- when the password was last changed (by a reset, for now)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
