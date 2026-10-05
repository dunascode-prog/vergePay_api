-- A customer's client book: the people and businesses they invoice. A
-- client doesn't need a VergePay account; they pay an invoice through its
-- pay link (controllers/payLinkController.js).
CREATE TABLE IF NOT EXISTS clients (
    client_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- the VergePay customer whose client this is
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    name VARCHAR(120) NOT NULL,

    -- where invoices and reminders are emailed; optional (a pay link can
    -- also be shared by hand)
    email VARCHAR(255),

    phone VARCHAR(30),

    -- archived clients are hidden from pickers but keep their invoices
    archived_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- one active client per email per customer
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_user_email
    ON clients (user_id, lower(email))
    WHERE email IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clients_user_name ON clients (user_id, lower(name));

-- A fuller client profile, for the clients page: who to talk to, what they
-- do, where they are, private notes, and a VIP flag the customer sets
-- themselves. Payment behaviour (revenue, how fast they pay, health) is
-- worked out from their invoices when read, never stored.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_name VARCHAR(120);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS industry VARCHAR(80);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS location VARCHAR(120);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes VARCHAR(2000);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_vip BOOLEAN NOT NULL DEFAULT FALSE;
