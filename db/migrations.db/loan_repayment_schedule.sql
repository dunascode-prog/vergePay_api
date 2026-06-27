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