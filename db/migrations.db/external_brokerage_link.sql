DO $$ BEGIN
    CREATE TYPE external_link_status_enum AS ENUM (
        'active',
        'expired',
        'revoked'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS external_brokerage_links (
    link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,

    provider_name VARCHAR(50) NOT NULL,

    oauth_token_reference VARCHAR(255) NOT NULL,

    link_status external_link_status_enum NOT NULL,

    last_synced_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_external_link_user
        FOREIGN KEY (user_id)
        REFERENCES users(user_id)
);

-- A connected brokerage account (API doc 9.1, data model 4.14). The OAuth
-- token itself never sits in this table: oauth_token_reference is a handle
-- into vault_secrets, where the token is stored encrypted.
ALTER TABLE external_brokerage_links ALTER COLUMN link_status SET DEFAULT 'active';
-- the investment_wallet account the synced holdings sit in
ALTER TABLE external_brokerage_links ADD COLUMN IF NOT EXISTS account_id UUID
    REFERENCES account(account_id);
-- the brokerage's own account number, learned on the first sync
ALTER TABLE external_brokerage_links ADD COLUMN IF NOT EXISTS provider_account_id VARCHAR(64);
-- queued / running / succeeded / failed
ALTER TABLE external_brokerage_links ADD COLUMN IF NOT EXISTS last_sync_status VARCHAR(20);
ALTER TABLE external_brokerage_links ADD COLUMN IF NOT EXISTS last_sync_error VARCHAR(500);
ALTER TABLE external_brokerage_links ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE external_brokerage_links ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_brokerage_link_user ON external_brokerage_links(user_id);

-- One brokerage account can be actively linked only once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_brokerage_link_active_account
    ON external_brokerage_links(provider_name, provider_account_id)
    WHERE link_status = 'active' AND provider_account_id IS NOT NULL;

-- A small secrets vault: third-party credentials, encrypted with
-- VAULT_ENCRYPTION_KEY (utils/secretBox.js). Rows are looked up only by
-- their reference and are deleted when the credential is revoked.
CREATE TABLE IF NOT EXISTS vault_secrets (
    secret_ref UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    purpose VARCHAR(50) NOT NULL,

    ciphertext TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The OAuth "state" for a connection in progress: single use, short-lived,
-- and stored only as a SHA-256 hash, so a leaked table can't be replayed.
CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash CHAR(64) PRIMARY KEY,

    user_id UUID NOT NULL REFERENCES users(user_id),

    provider_name VARCHAR(50) NOT NULL,

    account_id UUID NOT NULL REFERENCES account(account_id),

    expires_at TIMESTAMPTZ NOT NULL,

    used_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
