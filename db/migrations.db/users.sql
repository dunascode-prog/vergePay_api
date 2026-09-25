
DO $$ BEGIN
    CREATE TYPE kyc_status_enum AS ENUM (
        'unverified',
        'pending',
        'verified',
        'rejected'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Signup is two-step: only username, email and password are collected at
-- registration. Profile fields are filled in later (PATCH /v1/users/me)
-- before KYC, so they are nullable here.
CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,

    first_name VARCHAR(80),
    last_name VARCHAR(80),

    date_of_birth DATE,

    present_address VARCHAR(255),
    permanent_address VARCHAR(255),

    city VARCHAR(100),
    postal_code VARCHAR(20),

    country_code CHAR(2) NOT NULL DEFAULT 'NG',
    default_currency_code CHAR(3) NOT NULL DEFAULT 'NGN',
    timezone VARCHAR(100) NOT NULL DEFAULT 'Africa/Lagos',

    two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    kyc_status kyc_status_enum NOT NULL DEFAULT 'unverified',

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_country
        FOREIGN KEY (country_code)
        REFERENCES countries(code),

    CONSTRAINT fk_currency
        FOREIGN KEY (default_currency_code)
        REFERENCES currencies(code),

    CONSTRAINT fk_timezone
        FOREIGN KEY (timezone)
        REFERENCES timezones(name)
);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();
