DO $$ BEGIN
    CREATE TYPE invoice_status_enum AS ENUM (
        'open',
        'paid',
        'overdue',
        'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS invoices (
    invoice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL,

    settling_transaction_id UUID,

    amount_due_minor BIGINT NOT NULL,

    currency_code CHAR(3) NOT NULL,

    due_date DATE NOT NULL,

    invoice_status invoice_status_enum NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_invoice_account
        FOREIGN KEY (account_id)
        REFERENCES account(account_id),

    CONSTRAINT fk_invoice_transaction
        FOREIGN KEY (settling_transaction_id)
        REFERENCES transactions(transaction_id),

    CONSTRAINT fk_invoice_currency
        FOREIGN KEY (currency_code)
        REFERENCES currencies(code)
);

-- An invoice is one user billing another: account_id is the account billed
-- (who pays), issuer_account_id the account that issued it and is paid
-- into. The data model has no payee column, but paying has to move money
-- somewhere.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issuer_account_id UUID NOT NULL
    REFERENCES account(account_id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description VARCHAR(255);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE invoices ALTER COLUMN invoice_status SET DEFAULT 'open';

DO $$ BEGIN
    ALTER TABLE invoices ADD CONSTRAINT invoice_amount_positive CHECK (amount_due_minor > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE invoices ADD CONSTRAINT invoice_distinct_accounts CHECK (issuer_account_id <> account_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A paid invoice always names the transaction that settled it, and only a
-- paid one does.
DO $$ BEGIN
    ALTER TABLE invoices ADD CONSTRAINT invoice_paid_consistent
        CHECK ((invoice_status = 'paid') = (settling_transaction_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One transaction settles at most one invoice (data model 5).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_settling_txn
    ON invoices(settling_transaction_id)
    WHERE settling_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_account ON invoices(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invoice_issuer ON invoices(issuer_account_id, created_at);
