DO $$ BEGIN
    CREATE TYPE transaction_type_enum AS ENUM (
        'transfer',
        'card_payment',
        'loan_disbursement',
        'loan_repayment',
        'fee',
        'refund'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE transaction_status_enum AS ENUM (
        'pending',
        'settled',
        'failed',
        'reversed'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    idempotency_key VARCHAR(100) UNIQUE NOT NULL,

    transaction_type transaction_type_enum NOT NULL,

    sender_account_id UUID,

    receiver_account_id UUID,

    card_id UUID,

    loan_id UUID,

    amount_minor BIGINT NOT NULL,

    currency_code CHAR(3) NOT NULL,

    status transaction_status_enum NOT NULL,

    description VARCHAR(255),

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    settled_at TIMESTAMPTZ,

    CONSTRAINT fk_sender_account
        FOREIGN KEY (sender_account_id)
        REFERENCES account(account_id),

    CONSTRAINT fk_receiver_account
        FOREIGN KEY (receiver_account_id)
        REFERENCES account(account_id),

    CONSTRAINT fk_card
        FOREIGN KEY (card_id)
        REFERENCES cards(card_id),

    CONSTRAINT fk_loan
        FOREIGN KEY (loan_id)
        REFERENCES loans(loan_id),

    CONSTRAINT fk_currency
        FOREIGN KEY (currency_code)
        REFERENCES currencies(code)
);

-- Stored keys are namespaced by user ("<user_id>:<client key>").
ALTER TABLE transactions ALTER COLUMN idempotency_key TYPE VARCHAR(255);
ALTER TABLE transactions ALTER COLUMN status SET DEFAULT 'pending';

-- A reversal is a new transaction pointing at the one it undoes; the unique
-- index means a transaction can only ever be reversed once.
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS reverses_transaction_id UUID
    REFERENCES transactions(transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_reverses
    ON transactions(reverses_transaction_id)
    WHERE reverses_transaction_id IS NOT NULL;

DO $$ BEGIN
    ALTER TABLE transactions
        ADD CONSTRAINT txn_amount_positive CHECK (amount_minor > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE transactions
        ADD CONSTRAINT txn_distinct_accounts
        CHECK (sender_account_id IS NULL
            OR receiver_account_id IS NULL
            OR sender_account_id <> receiver_account_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_txn_sender ON transactions(sender_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_txn_receiver ON transactions(receiver_account_id, created_at);

-- Loan disbursements and repayments always name their loan; nothing else does.
DO $$ BEGIN
    ALTER TABLE transactions
        ADD CONSTRAINT txn_loan_link
        CHECK ((transaction_type IN ('loan_disbursement', 'loan_repayment')) = (loan_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_txn_loan ON transactions(loan_id) WHERE loan_id IS NOT NULL;

-- A loan is paid out once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_loan_disbursement
    ON transactions(loan_id)
    WHERE transaction_type = 'loan_disbursement';
