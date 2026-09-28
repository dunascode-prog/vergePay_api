-- Payment-processor plumbing (Flutterwave): clearing accounts, virtual
-- accounts for bank-transfer funding, and received webhook events.

-- The processor clearing account per currency: the other side of every
-- card charge and bank deposit, so its balance is what the processor owes
-- the platform (to reconcile against Flutterwave's settlement reports).
INSERT INTO account (account_type, account_number, currency_code, is_system)
SELECT 'current', 'SYS-FLW-' || code, code, TRUE
FROM currencies
ON CONFLICT (account_number) DO NOTHING;

-- A permanent bank account number (issued by Flutterwave's partner bank)
-- per VergePay account: a transfer into it from any Nigerian bank credits
-- the VergePay account. The BVN used to create it is never stored.
CREATE TABLE IF NOT EXISTS virtual_accounts (
    virtual_account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL UNIQUE REFERENCES account(account_id),

    processor VARCHAR(20) NOT NULL DEFAULT 'flutterwave',

    account_number VARCHAR(20) NOT NULL UNIQUE,

    bank_name VARCHAR(100) NOT NULL,

    -- our reference; deposits into this account arrive with it as tx_ref
    processor_tx_ref VARCHAR(100) NOT NULL UNIQUE,

    processor_order_ref VARCHAR(100),

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every webhook delivery, deduplicated on the processor's event identity
-- (API doc 10.1): providers retry, so the same event can arrive many times.
CREATE TABLE IF NOT EXISTS webhook_events (
    webhook_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    processor VARCHAR(20) NOT NULL,

    dedupe_key VARCHAR(200) NOT NULL,

    event_type VARCHAR(100),

    payload JSONB NOT NULL,

    -- processed / ignored / failed; NULL while in progress
    outcome VARCHAR(20),

    error TEXT,

    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    processed_at TIMESTAMPTZ,

    CONSTRAINT uq_webhook_event UNIQUE (processor, dedupe_key)
);

-- Linking a card: the user pays a small amount on Flutterwave's hosted
-- checkout (it tops up their account), and the verified payment gives us
-- the card's reusable token. One row per attempt; transaction_id is the
-- card_payment it creates.
DO $$ BEGIN
    CREATE TYPE card_link_status_enum AS ENUM ('pending', 'linked', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS card_links (
    card_link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id),

    account_id UUID NOT NULL REFERENCES account(account_id),

    transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(transaction_id),

    checkout_url TEXT,

    status card_link_status_enum NOT NULL DEFAULT 'pending',

    card_id UUID REFERENCES cards(card_id),

    failure_reason VARCHAR(255),

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_card_links_user ON card_links(user_id, created_at);
