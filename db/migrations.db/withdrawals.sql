-- Withdrawals to Nigerian bank accounts, paid out with Flutterwave Transfers
-- from VergePay's one Flutterwave balance (services/payouts.js).
--
-- How the money moves in the ledger:
--   accepted   wallet -> SYS-PAYOUT-NGN   the amount (withdrawal)
--              wallet -> SYS-FEES-NGN     the customer's half of the fee (fee)
--   paid       SYS-PAYOUT-NGN -> SYS-FLW-NGN   the money has left Flutterwave
--              SYS-FEES-NGN -> SYS-FLW-NGN     Flutterwave took its whole fee
--   failed     SYS-PAYOUT-NGN -> wallet, SYS-FEES-NGN -> wallet (refunds)
--
-- So SYS-PAYOUT holds exactly the money on its way to banks, and SYS-FEES
-- holds what customers paid in fees less what Flutterwave charged: VergePay's
-- share of the transfer fees shows as its (negative) balance.

-- One payout account and one fee account per currency.
INSERT INTO account (account_type, account_number, currency_code, is_system)
SELECT 'current', 'SYS-PAYOUT-' || code, code, TRUE FROM currencies
ON CONFLICT (account_number) DO NOTHING;

INSERT INTO account (account_type, account_number, currency_code, is_system)
SELECT 'current', 'SYS-FEES-' || code, code, TRUE FROM currencies
ON CONFLICT (account_number) DO NOTHING;

-- A customer's saved bank accounts. The holder's name comes from
-- Flutterwave's name enquiry when it's saved, never from the client.
CREATE TABLE IF NOT EXISTS bank_accounts (
    bank_account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    bank_code VARCHAR(20) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    account_number CHAR(10) NOT NULL,
    account_name VARCHAR(150) NOT NULL,
    currency_code CHAR(3) NOT NULL DEFAULT 'NGN' REFERENCES currencies(code),

    removed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- the same bank account saved once per customer (removing frees it)
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_account_saved
    ON bank_accounts(user_id, bank_code, account_number) WHERE removed_at IS NULL;

DO $$ BEGIN
    CREATE TYPE withdrawal_status_enum AS ENUM ('pending', 'successful', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS withdrawals (
    withdrawal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id),
    account_id UUID NOT NULL REFERENCES account(account_id),
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(bank_account_id),
    currency_code CHAR(3) NOT NULL REFERENCES currencies(code),

    -- what reaches the bank account
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    -- Flutterwave's whole fee, and the customer's half of it (rounded down)
    processor_fee_minor BIGINT NOT NULL CHECK (processor_fee_minor >= 0),
    customer_fee_minor BIGINT NOT NULL CHECK (customer_fee_minor >= 0 AND customer_fee_minor <= processor_fee_minor),

    narration VARCHAR(100),
    status withdrawal_status_enum NOT NULL DEFAULT 'pending',

    -- our reference, sent to Flutterwave; it rejects a second transfer with
    -- the same one, so re-sending after a lost reply can't pay twice
    reference VARCHAR(100) NOT NULL UNIQUE,
    processor_transfer_id VARCHAR(50) UNIQUE,
    -- the customer's Idempotency-Key
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,

    transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(transaction_id),
    fee_transaction_id UUID UNIQUE REFERENCES transactions(transaction_id),

    failure_reason VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,

    CONSTRAINT withdrawal_completed_at CHECK ((status = 'pending') = (completed_at IS NULL)),
    CONSTRAINT withdrawal_fee_txn CHECK ((customer_fee_minor > 0) = (fee_transaction_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_withdrawals_pending ON withdrawals(created_at) WHERE status = 'pending';

-- Money leaving for a bank account is its own kind of transaction.
ALTER TYPE transaction_type_enum ADD VALUE IF NOT EXISTS 'withdrawal';
