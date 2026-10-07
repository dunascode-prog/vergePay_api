-- Savings goals: money set aside towards a target by a date. Each goal holds
-- real money in its own savings account, so a contribution is a ledger
-- transaction from one of the customer's wallets into the goal's account,
-- and a withdrawal is one back out (controllers/goalController.js). What a
-- goal has saved is that account's balance, never a separate total that
-- could drift from the ledger.

DO $$ BEGIN
    CREATE TYPE goal_category_enum AS ENUM ('emergency_fund', 'equipment', 'investment', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE goal_status_enum AS ENUM ('active', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS goals (
    goal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    -- the savings account that holds the goal's money, one per goal
    account_id UUID NOT NULL UNIQUE REFERENCES account(account_id),

    name VARCHAR(80) NOT NULL,
    category goal_category_enum NOT NULL DEFAULT 'other',
    target_minor BIGINT NOT NULL CHECK (target_minor > 0),
    -- the account's currency, fixed when the goal is made
    currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
    target_date DATE NOT NULL,

    goal_status goal_status_enum NOT NULL DEFAULT 'active',
    closed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT goal_closed_at CHECK ((goal_status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id, created_at);

-- Money moving into and out of a goal is its own kind of transaction, so it
-- can't be reversed like a transfer and reads differently in alerts.
ALTER TYPE transaction_type_enum ADD VALUE IF NOT EXISTS 'goal_contribution';
ALTER TYPE transaction_type_enum ADD VALUE IF NOT EXISTS 'goal_withdrawal';
