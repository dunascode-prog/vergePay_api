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

-- A paid invoice can be refunded in full by its issuer: the payment is
-- returned by a new refund transaction and the invoice becomes refunded.
ALTER TYPE invoice_status_enum ADD VALUE IF NOT EXISTS 'refunded';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refund_reason VARCHAR(255);

-- Paid and refunded invoices always name the transaction that settled them,
-- and no other invoice does. (Compared as text: a value added to an enum
-- can't be used in the same transaction that adds it, and db:init runs
-- every file in one transaction.)
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoice_paid_consistent;
ALTER TABLE invoices ADD CONSTRAINT invoice_paid_consistent
    CHECK ((invoice_status::text IN ('paid', 'refunded')) = (settling_transaction_id IS NOT NULL));

-- One transaction settles at most one invoice (data model 5).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_settling_txn
    ON invoices(settling_transaction_id)
    WHERE settling_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_account ON invoices(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invoice_issuer ON invoices(issuer_account_id, created_at);

-- ---------------------------------------------------------------------------
-- Invoicing clients outside VergePay.
--
-- An invoice now goes to a client from the issuer's client book
-- (clients.sql), with line items, and starts as an editable draft. Sending
-- it gives it a number (INV-0001, per issuer) and a pay link: anyone holding
-- the link pays through Flutterwave's checkout, or from a VergePay wallet.
-- Invoices addressed to a VergePay account number (the original model) still
-- work and are sent straight away.

ALTER TYPE invoice_status_enum ADD VALUE IF NOT EXISTS 'draft';

-- the billed VergePay account is known only for account-addressed invoices,
-- and for invoices paid from a wallet
ALTER TABLE invoices ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(client_id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issuer_user_id UUID REFERENCES users(user_id);
UPDATE invoices i SET issuer_user_id = a.user_id
FROM account a WHERE a.account_id = i.issuer_account_id AND i.issuer_user_id IS NULL;
ALTER TABLE invoices ALTER COLUMN issuer_user_id SET NOT NULL;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(20);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes VARCHAR(1000);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
-- A capability URL, like a hosted invoice link: whoever has it can see and
-- pay this one invoice, nothing else. 256 random bits.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pay_token VARCHAR(64);
-- who paid on the pay page (as they typed it at checkout)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_by_name VARCHAR(120);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_by_email VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_pay_token ON invoices(pay_token) WHERE pay_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_number
    ON invoices(issuer_user_id, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_client ON invoices(client_id, created_at);

-- Every invoice is addressed to someone: a client, or a VergePay account.
DO $$ BEGIN
    ALTER TABLE invoices ADD CONSTRAINT invoice_has_recipient CHECK (client_id IS NOT NULL OR account_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The next invoice number per issuer, handed out when an invoice is sent,
-- so drafts that are deleted leave no gaps.
CREATE TABLE IF NOT EXISTS invoice_counters (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    last_number INTEGER NOT NULL DEFAULT 0
);

-- Line items. The invoice's amount_due_minor is always their sum (checked
-- by GET /v1/dev/invariants). quantity allows halves, e.g. 7.5 hours.
CREATE TABLE IF NOT EXISTS invoice_items (
    item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
    position SMALLINT NOT NULL,
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(10, 2) NOT NULL CHECK (quantity > 0),
    unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor > 0),
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    UNIQUE (invoice_id, position)
);

-- A payment started on the pay page is a pending invoice_payment
-- transaction from the processor's clearing account to the issuer; this
-- ties it to its invoice until it settles (or fails).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES invoices(invoice_id);
CREATE INDEX IF NOT EXISTS idx_transactions_invoice ON transactions(invoice_id) WHERE invoice_id IS NOT NULL;

-- Emails sent about invoices (the invoice itself, reminders, receipts). The
-- content is stored as sent, so the issuer can see exactly what went out.
-- Sent by the worker (services/email.js), with retries.
CREATE TABLE IF NOT EXISTS email_log (
    email_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES invoices(invoice_id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('invoice', 'reminder', 'receipt')),
    to_address VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    html TEXT NOT NULL,
    text_body TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
    attempts SMALLINT NOT NULL DEFAULT 0,
    provider_message_id VARCHAR(255),
    -- Ethereal (development) gives a link to view the message as delivered
    preview_url VARCHAR(500),
    error VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_log_invoice ON email_log(invoice_id, created_at);
