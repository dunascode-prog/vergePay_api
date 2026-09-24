DO $$ BEGIN
    CREATE TYPE ledger_direction_enum AS ENUM (
        'DEBIT',
        'CREDIT'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ledger_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL,

    transaction_id UUID NOT NULL,

    direction ledger_direction_enum NOT NULL,

    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),

    currency_code CHAR(3) NOT NULL,

    running_balance_after_minor BIGINT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_ledger_account
        FOREIGN KEY (account_id)
        REFERENCES account(account_id),

    CONSTRAINT fk_ledger_transaction
        FOREIGN KEY (transaction_id)
        REFERENCES transactions(transaction_id),

    CONSTRAINT fk_ledger_currency
        FOREIGN KEY (currency_code)
        REFERENCES currencies(code)
);