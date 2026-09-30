DO $$ BEGIN
    CREATE TYPE account_type_enum AS ENUM (
        'current',
        'savings',
        'investment_wallet',
        'loan_holding'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE account_status_enum AS ENUM (
        'active',
        'frozen',
        'closed'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS account (
    account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,

    account_type account_type_enum NOT NULL DEFAULT 'current',

    account_number VARCHAR(20) UNIQUE NOT NULL,

    currency_code CHAR(3) NOT NULL,

    balance_minor BIGINT NOT NULL,

    income_minor BIGINT,

    total_savings_minor BIGINT,

    account_status account_status_enum NOT NULL DEFAULT 'active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_currency_code
        FOREIGN KEY (currency_code)
        REFERENCES currencies(code),

    CONSTRAINT fk_user_id
        FOREIGN KEY (user_id)
        REFERENCES users(user_id)
);

-- System accounts are platform-owned ledger accounts (no user), such as the
-- external funding account on the other side of every top-up. They are the
-- only accounts allowed to go negative.
ALTER TABLE account ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account ALTER COLUMN user_id DROP NOT NULL;

DO $$ BEGIN
    ALTER TABLE account
        ADD CONSTRAINT account_owner_required CHECK (is_system OR user_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Balance is never negative for customer accounts (data model 6.4). With the
-- row lock taken when money moves, this is what stops a double-spend.
ALTER TABLE account ALTER COLUMN balance_minor SET DEFAULT 0;
ALTER TABLE account DROP CONSTRAINT IF EXISTS balance_non_negative;
ALTER TABLE account
    ADD CONSTRAINT balance_non_negative CHECK (is_system OR balance_minor >= 0);

CREATE INDEX IF NOT EXISTS idx_account_user ON account(user_id);

-- One external funding account per supported currency.
INSERT INTO account (account_type, account_number, currency_code, is_system)
SELECT 'current', 'SYS-FUND-' || code, code, TRUE
FROM currencies
ON CONFLICT (account_number) DO NOTHING;

-- What an account is for, so the app can show personal and business money
-- apart (and together). It's a label only: it never changes how money moves.
DO $$ BEGIN
    CREATE TYPE account_purpose_enum AS ENUM (
        'personal',
        'business'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE account ADD COLUMN IF NOT EXISTS purpose account_purpose_enum NOT NULL DEFAULT 'personal';
