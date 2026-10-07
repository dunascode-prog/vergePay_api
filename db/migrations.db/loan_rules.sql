-- Loan repayment rules (services/loanRepayments.js):
--
--   * any amount can be paid: late fees first, then the oldest installments
--     (interest, then principal), then the next one; money beyond that pays
--     the last installments' principal, shortening the loan
--   * paying off early costs the principal left plus interest to date only
--   * 3 days after a due date an unpaid installment gets a one-off late fee
--     (by default 5% of the installment, at least ₦500; env.loans)
--   * auto-debit from the loan's wallet on the due date and daily after
--   * 90 days overdue: defaulted, until it's caught up
--
-- An installment can now be paid in parts, so each one records what has
-- been paid, waived and charged, and every payment records how it was split.

ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS principal_paid_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS interest_paid_minor BIGINT NOT NULL DEFAULT 0;
-- interest not owed after all: paid off early, or the loan was shortened
ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS interest_waived_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS late_fee_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS late_fee_paid_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS late_fee_charged_at TIMESTAMPTZ;
ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- One payment can now finish several installments, and an installment can
-- take several payments: paid_transaction_id is the payment that finished it.
ALTER TABLE loan_repayment_schedule DROP CONSTRAINT IF EXISTS schedule_paid_consistent;
DROP INDEX IF EXISTS uq_schedule_paid_txn;

-- Installments paid in full before these rules: everything was paid.
UPDATE loan_repayment_schedule s
SET principal_paid_minor = s.principal_minor,
    interest_paid_minor = s.interest_minor,
    paid_at = COALESCE(s.paid_at, (SELECT t.settled_at FROM transactions t WHERE t.transaction_id = s.paid_transaction_id))
WHERE s.paid_flag AND s.principal_paid_minor = 0 AND s.interest_paid_minor = 0;

DO $$ BEGIN
    ALTER TABLE loan_repayment_schedule ADD CONSTRAINT schedule_parts_within_amounts CHECK (
        principal_paid_minor BETWEEN 0 AND principal_minor
        AND interest_paid_minor >= 0 AND interest_waived_minor >= 0
        AND interest_paid_minor + interest_waived_minor <= interest_minor
        AND late_fee_minor >= 0 AND late_fee_paid_minor BETWEEN 0 AND late_fee_minor);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Paid exactly when nothing is left on it.
DO $$ BEGIN
    ALTER TABLE loan_repayment_schedule ADD CONSTRAINT schedule_paid_when_settled CHECK (
        paid_flag = (principal_paid_minor = principal_minor
                     AND interest_paid_minor + interest_waived_minor = interest_minor
                     AND late_fee_paid_minor = late_fee_minor)
        AND paid_flag = (paid_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One row per repayment transaction, with the balance it left.
CREATE TABLE IF NOT EXISTS loan_payments (
    transaction_id UUID PRIMARY KEY REFERENCES transactions(transaction_id),
    loan_id UUID NOT NULL REFERENCES loans(loan_id),
    -- how it was made: by the borrower, a payoff, or an automatic collection
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('repayment', 'payoff', 'auto_debit')),
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    balance_after_minor BIGINT NOT NULL CHECK (balance_after_minor >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_loan_payments_loan ON loan_payments(loan_id, created_at);

-- How each payment was split across installments.
CREATE TABLE IF NOT EXISTS loan_payment_allocations (
    allocation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES loan_payments(transaction_id),
    schedule_id UUID NOT NULL REFERENCES loan_repayment_schedule(schedule_id),
    late_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (late_fee_minor >= 0),
    interest_minor BIGINT NOT NULL DEFAULT 0 CHECK (interest_minor >= 0),
    principal_minor BIGINT NOT NULL DEFAULT 0 CHECK (principal_minor >= 0),
    interest_waived_minor BIGINT NOT NULL DEFAULT 0 CHECK (interest_waived_minor >= 0),
    CONSTRAINT uq_allocation UNIQUE (transaction_id, schedule_id)
);
CREATE INDEX IF NOT EXISTS idx_allocations_schedule ON loan_payment_allocations(schedule_id);

-- The payments made before these rules, as payments of one whole installment each.
INSERT INTO loan_payments (transaction_id, loan_id, kind, amount_minor, balance_after_minor, created_at)
SELECT s.paid_transaction_id, s.loan_id, 'repayment', s.installment_amount_minor,
       (SELECT COALESCE(sum(later.installment_amount_minor), 0) FROM loan_repayment_schedule later
        WHERE later.loan_id = s.loan_id AND later.installment_number > s.installment_number),
       COALESCE(s.paid_at, NOW())
FROM loan_repayment_schedule s
WHERE s.paid_transaction_id IS NOT NULL
ON CONFLICT (transaction_id) DO NOTHING;

INSERT INTO loan_payment_allocations (transaction_id, schedule_id, interest_minor, principal_minor)
SELECT s.paid_transaction_id, s.schedule_id, s.interest_minor, s.principal_minor
FROM loan_repayment_schedule s
WHERE s.paid_transaction_id IS NOT NULL
ON CONFLICT (transaction_id, schedule_id) DO NOTHING;

-- Automatic repayments: agreed when applying, or switched on later.
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS auto_debit_consent BOOLEAN NOT NULL DEFAULT FALSE;
-- which loan terms the borrower agreed to, and when (services/loanTerms.js);
-- empty for applications made before terms were recorded
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS terms_version VARCHAR(40);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS auto_debit BOOLEAN NOT NULL DEFAULT FALSE;
-- the borrower's day of the last collection attempt, and the last "couldn't collect" alert
ALTER TABLE loans ADD COLUMN IF NOT EXISTS auto_debit_last_attempt_on DATE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS auto_debit_last_alert_at TIMESTAMPTZ;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS defaulted_at TIMESTAMPTZ;

-- Late fees and defaults apply from the day these rules went live for loans
-- that already existed: an installment due before then never gets a late
-- fee, and its 90-day default clock starts on that day. New loans get the
-- column's default, so the rules apply to them in full.
ALTER TABLE loans ADD COLUMN IF NOT EXISTS rules_from DATE;
UPDATE loans SET rules_from = CURRENT_DATE WHERE rules_from IS NULL;
ALTER TABLE loans ALTER COLUMN rules_from SET DEFAULT DATE '2000-01-01';
ALTER TABLE loans ALTER COLUMN rules_from SET NOT NULL;
