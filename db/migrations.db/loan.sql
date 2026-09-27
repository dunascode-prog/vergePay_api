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

-- A loan row is created only when an application is approved, and is paid
-- out later by a separate disburse action, so it needs a state between the
-- two: approved (terms fixed, no money moved yet).
ALTER TYPE loan_status_enum ADD VALUE IF NOT EXISTS 'approved' AFTER 'pending_approval';

DO $$ BEGIN
    CREATE TYPE loan_application_status_enum AS ENUM (
        'pending_review',
        'approved',
        'rejected'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- An application is a request for credit, a separate resource from the loan
-- it may lead to: it has no principal, schedule or ledger rows (API doc 7.1).
CREATE TABLE IF NOT EXISTS loan_applications (
    application_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id),

    -- the account the loan would be paid into
    account_id UUID NOT NULL REFERENCES account(account_id),

    loan_type loan_type_enum NOT NULL,

    requested_amount_minor BIGINT NOT NULL CHECK (requested_amount_minor > 0),

    currency_code CHAR(3) NOT NULL REFERENCES currencies(code),

    term_months SMALLINT NOT NULL CHECK (term_months BETWEEN 1 AND 360),

    purpose VARCHAR(255),

    status loan_application_status_enum NOT NULL DEFAULT 'pending_review',

    decision_reason VARCHAR(255),

    decided_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_loan_app_user ON loan_applications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_loan_app_status ON loan_applications(status, created_at);

-- A user has at most one application waiting for a decision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_app_one_pending
    ON loan_applications(user_id)
    WHERE status = 'pending_review';

-- Every loan points back to the application that led to it, one to one.
ALTER TABLE loans ADD COLUMN IF NOT EXISTS application_id UUID UNIQUE
    REFERENCES loan_applications(application_id);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS term_months SMALLINT NOT NULL
    CHECK (term_months BETWEEN 1 AND 360);
ALTER TABLE loans ALTER COLUMN loan_status SET DEFAULT 'pending_approval';

DO $$ BEGIN
    ALTER TABLE loans ADD CONSTRAINT loan_principal_positive CHECK (principal_minor > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Rates are basis points: 0 to 100% a year.
DO $$ BEGIN
    ALTER TABLE loans ADD CONSTRAINT loan_rate_range CHECK (interest_rate_bps BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE loans ADD CONSTRAINT loan_balance_non_negative CHECK (balance_remaining_minor >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_loan_account ON loans(account_id);

-- The platform's loan-holding account per currency: disbursements are paid
-- out of it and repayments are paid back into it, so its balance is minus
-- the principal still out on loan, plus the interest collected.
INSERT INTO account (account_type, account_number, currency_code, is_system)
SELECT 'loan_holding', 'SYS-LOAN-' || code, code, TRUE
FROM currencies
ON CONFLICT (account_number) DO NOTHING;
