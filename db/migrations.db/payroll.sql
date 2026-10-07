-- Payroll: a customer pays the people who work for them, who are VergePay
-- customers too. A payee is someone's wallet with how they're paid; a pay
-- run pays one or more payees from one of the customer's wallets, all or
-- nothing, one ledger transaction per payee (controllers/payrollController.js).

DO $$ BEGIN
    CREATE TYPE payee_pay_type_enum AS ENUM ('retainer', 'per_project', 'hourly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE payee_frequency_enum AS ENUM ('monthly', 'biweekly', 'one_off');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE payee_status_enum AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payees (
    payee_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- who pays, and the wallet they're paid into (another customer's)
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES account(account_id),

    name VARCHAR(120) NOT NULL,
    role VARCHAR(80),
    pay_type payee_pay_type_enum NOT NULL,
    frequency payee_frequency_enum NOT NULL,
    -- the usual amount for one payment; a run can pay a different amount
    rate_minor BIGINT NOT NULL CHECK (rate_minor > 0),
    -- the payee wallet's currency, fixed when the payee is added
    currency_code CHAR(3) NOT NULL REFERENCES currencies(code),

    payee_status payee_status_enum NOT NULL DEFAULT 'active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- one payee per wallet in a customer's payroll
    CONSTRAINT uq_payee_wallet UNIQUE (user_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_payees_user ON payees(user_id, created_at);

CREATE TABLE IF NOT EXISTS payroll_runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    source_account_id UUID NOT NULL REFERENCES account(account_id),
    currency_code CHAR(3) NOT NULL REFERENCES currencies(code),

    -- the caller's Idempotency-Key: a retried run is answered from here
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,

    total_minor BIGINT NOT NULL CHECK (total_minor > 0),
    payment_count INTEGER NOT NULL CHECK (payment_count > 0),
    note VARCHAR(120),

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_user ON payroll_runs(user_id, created_at);

CREATE TABLE IF NOT EXISTS payroll_payments (
    payment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    run_id UUID NOT NULL REFERENCES payroll_runs(run_id) ON DELETE CASCADE,
    payee_id UUID NOT NULL REFERENCES payees(payee_id),
    -- the ledger transaction that paid it
    transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(transaction_id),

    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- a run pays each payee once
    CONSTRAINT uq_payroll_run_payee UNIQUE (run_id, payee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_payments_payee ON payroll_payments(payee_id, created_at);

-- Paying someone through payroll is its own kind of transaction, so it reads
-- as payroll in alerts and can't be reversed like a transfer.
ALTER TYPE transaction_type_enum ADD VALUE IF NOT EXISTS 'payroll_payment';
