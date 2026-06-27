CREATE TYPE invoice_status_enum AS ENUM (
    'open',
    'paid',
    'overdue',
    'cancelled'
);

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