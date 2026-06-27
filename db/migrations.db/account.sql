CREATE TYPE account_type_enum AS ENUM (
    'current',
    'savings',
    'investment_wallet',
    'loan_holding'
);

CREATE TYPE account_status_enum AS ENUM (
    'active',
    'frozen',
    'closed'
);

CREATE TABLE IF NOT EXISTS account (
    account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,

    account_type account_type_enum NOT NULL DEFAULT 'current',

    account_number VARCHAR(20) UNIQUE NOT NULL,

    currency_code CHAR(3) NOT NULL,

    balance_minor BIGINT NOT NULL,

    income_minor BIGINT,

    total_savings_minor BIGINT,

    account_status account_status_enum NOT NULL DEFAULT 'active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_currency_code
        FOREIGN KEY (currency_code)
        REFERENCES currencies(code),

    CONSTRAINT fk_user_id
        FOREIGN KEY (user_id)
        REFERENCES users(user_id)
);