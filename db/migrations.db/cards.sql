DO $$ BEGIN
    CREATE TYPE card_status_enum AS ENUM (
        'active',
        'expired',
        'blocked',
        'replaced'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS cards (
    card_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL,

    provider_id UUID NOT NULL,

    card_token VARCHAR(255) UNIQUE NOT NULL,

    pan_bin CHAR(6) NOT NULL,

    pan_last_four CHAR(4) NOT NULL,

    cardholder_name VARCHAR(100) NOT NULL,

    expiry_month SMALLINT NOT NULL,

    expiry_year SMALLINT NOT NULL,

    card_status card_status_enum NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_card_account
        FOREIGN KEY (account_id)
        REFERENCES account(account_id),

    CONSTRAINT fk_card_provider
        FOREIGN KEY (provider_id)
        REFERENCES card_providers(provider_id)
);

-- A card here is a debit card a user links to fund their VergePay account.
-- It is tokenized by the payment processor (Flutterwave); this table only
-- ever holds the processor's token and the display-safe BIN, last four and
-- expiry (data model 4.8). The token is tied to the email used when the card
-- was first charged, so that email is kept with it.
ALTER TYPE card_status_enum ADD VALUE IF NOT EXISTS 'removed';
ALTER TABLE cards ALTER COLUMN card_status SET DEFAULT 'active';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS processor VARCHAR(20) NOT NULL DEFAULT 'flutterwave';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS processor_customer_email VARCHAR(255) NOT NULL;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS issuer VARCHAR(100);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE cards ADD CONSTRAINT card_display_fields CHECK (
        pan_bin ~ '^[0-9]{6}$'
        AND pan_last_four ~ '^[0-9]{4}$'
        AND expiry_month BETWEEN 1 AND 12
        AND expiry_year BETWEEN 2000 AND 2100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_card_account ON cards(account_id);

-- Spending controls live in their own table (API doc 5.4): they change
-- often, are read on every charge, and get their own audit trail.
CREATE TABLE IF NOT EXISTS card_controls (
    card_id UUID PRIMARY KEY REFERENCES cards(card_id),

    -- NULL means no daily limit
    daily_limit_minor BIGINT CHECK (daily_limit_minor IS NULL OR daily_limit_minor > 0),

    online_payments_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    atm_withdrawals_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
