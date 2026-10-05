-- Recurring billing: a plan invoices one client the same amount on a
-- schedule (weekly, monthly, quarterly or yearly). The worker's scheduled
-- job (services/recurring.js) sends each due invoice through the normal
-- invoice path: a number, a pay link and, if asked, an email to the client.
--
-- Billing dates are always worked out from the start date and a cycle
-- count, never by adding to the previous date, so a plan started on the
-- 31st bills on the 31st whenever the month has one (and on the last day
-- when it doesn't) instead of drifting to the 28th.

DO $$ BEGIN
    CREATE TYPE recurring_frequency_enum AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE recurring_status_enum AS ENUM ('active', 'paused', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The billing date of cycle n (0 = the start date).
CREATE OR REPLACE FUNCTION recurring_billing_date(start_date DATE, frequency recurring_frequency_enum, n INTEGER)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
    SELECT (CASE frequency
        WHEN 'weekly' THEN start_date + n * 7
        WHEN 'monthly' THEN (start_date + make_interval(months => n))::date
        WHEN 'quarterly' THEN (start_date + make_interval(months => 3 * n))::date
        WHEN 'yearly' THEN (start_date + make_interval(years => n))::date
    END)::date
$$;

CREATE TABLE IF NOT EXISTS recurring_plans (
    plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- the customer who bills, the wallet paid into, and who is billed
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    issuer_account_id UUID NOT NULL REFERENCES account(account_id),
    client_id UUID NOT NULL REFERENCES clients(client_id),

    -- each invoice has one line: this description, this amount
    description VARCHAR(255) NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    -- the issuing wallet's currency, fixed when the plan is made
    currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
    notes VARCHAR(1000),

    frequency recurring_frequency_enum NOT NULL,
    start_date DATE NOT NULL,
    -- the cycle the next invoice is for; next_billing_date is always
    -- recurring_billing_date(start_date, frequency, next_cycle)
    next_cycle INTEGER NOT NULL DEFAULT 0 CHECK (next_cycle >= 0),
    next_billing_date DATE NOT NULL,
    -- payment terms: each invoice is due this many days after it's sent
    days_until_due SMALLINT NOT NULL DEFAULT 14 CHECK (days_until_due BETWEEN 0 AND 90),
    -- email each invoice to the client (when they have an email address)
    send_email BOOLEAN NOT NULL DEFAULT TRUE,

    plan_status recurring_status_enum NOT NULL DEFAULT 'active',
    paused_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,

    -- why the last billing attempt failed (e.g. the wallet was frozen);
    -- cleared by the next invoice that goes out
    last_error VARCHAR(255),
    last_error_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- the scheduled job looks for active plans that are due
CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_plans (next_billing_date) WHERE plan_status = 'active';
CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_plans (user_id, created_at);

-- An invoice a plan sent names the plan and the cycle it bills. One invoice
-- per cycle, so a retried or doubled run can't bill a client twice.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurring_plan_id UUID REFERENCES recurring_plans(plan_id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurring_cycle INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_recurring_cycle
    ON invoices (recurring_plan_id, recurring_cycle) WHERE recurring_plan_id IS NOT NULL;
