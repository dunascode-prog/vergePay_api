CREATE TABLE IF NOT EXISTS loan_repayment_schedule (
    schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    loan_id UUID NOT NULL,

    installment_number SMALLINT NOT NULL,

    due_date DATE NOT NULL,

    installment_amount_minor BIGINT NOT NULL,

    paid_flag BOOLEAN NOT NULL DEFAULT FALSE,

    paid_transaction_id UUID,

    CONSTRAINT fk_schedule_loan
        FOREIGN KEY (loan_id)
        REFERENCES loans(loan_id),

    CONSTRAINT fk_schedule_transaction
        FOREIGN KEY (paid_transaction_id)
        REFERENCES transactions(transaction_id)
);

-- How each installment splits between principal and interest, so a
-- borrower can see what a payment actually pays down.
ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS principal_minor BIGINT NOT NULL;
ALTER TABLE loan_repayment_schedule ADD COLUMN IF NOT EXISTS interest_minor BIGINT NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_installment
    ON loan_repayment_schedule(loan_id, installment_number);

-- (One repayment used to pay exactly one installment, with a unique index
-- on paid_transaction_id. Since loan_rules.sql one payment can finish
-- several installments, so that index is no longer created here.)

DO $$ BEGIN
    ALTER TABLE loan_repayment_schedule
        ADD CONSTRAINT schedule_amounts_add_up
        CHECK (principal_minor >= 0 AND interest_minor >= 0
           AND installment_amount_minor = principal_minor + interest_minor
           AND installment_amount_minor > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- (paid_flag is checked against the installment's paid parts in
-- loan_rules.sql, which replaced the schedule_paid_consistent check.)
