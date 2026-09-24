DO $$ BEGIN
    CREATE TYPE loan_type_enum AS ENUM (
        'personal',
        'mortgage',
        'cash_advance',
        'asset_finance'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE loan_status_enum AS ENUM (
        'pending_approval',
        'active',
        'repaid',
        'defaulted'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS loans (
    loan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL,

    loan_type loan_type_enum NOT NULL,

    principal_minor BIGINT NOT NULL,

    interest_rate_bps INTEGER NOT NULL,

    currency_code CHAR(3) NOT NULL,

    balance_remaining_minor BIGINT NOT NULL,

    loan_status loan_status_enum NOT NULL,

    disbursed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_loan_account
        FOREIGN KEY (account_id)
        REFERENCES account(account_id),

    CONSTRAINT fk_loan_currency
        FOREIGN KEY (currency_code)
        REFERENCES currencies(code)
);