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

CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_txn ON ledger_entries(transaction_id);

-- The ledger is append-only (data model 4.5): a mistake is corrected with a
-- new, opposite entry, never by editing or deleting history. Enforced here so
-- no code path, bug or manual query can bypass it.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION forbid_ledger_mutation();
