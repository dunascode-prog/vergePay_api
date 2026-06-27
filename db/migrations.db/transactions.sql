-- CREATE TYPE transaction_type_enum AS ENUM (
--     'transfer',
--     'card_payment',
--     'loan_disbursement',
--     'loan_repayment',
--     'fee',
--     'refund'
-- );

-- CREATE TYPE transaction_status_enum AS ENUM (
--     'pending',
--     'settled',
--     'failed',
--     'reversed'
-- );

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