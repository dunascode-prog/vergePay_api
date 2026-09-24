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