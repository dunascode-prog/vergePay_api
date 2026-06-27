
CREATE TYPE kyc_status_enum AS ENUM (
    'PENDING',
    'IN_REVIEW',
    'VERIFIED',
    'REJECTED'
);

CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,

    first_name VARCHAR(80) NOT NULL,
    last_name VARCHAR(80) NOT NULL,

    date_of_birth DATE NOT NULL,

    present_addr VARCHAR(255) NOT NULL,
    permanent_addr VARCHAR(255) NOT NULL,

    city VARCHAR(100) NOT NULL,
    postal_code VARCHAR(20) NOT NULL,

    country_code CHAR(2) NOT NULL,
    default_currency_code CHAR(3) NOT NULL,
    timezone VARCHAR(100) NOT NULL,

    two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    kyc_status kyc_status_enum NOT NULL DEFAULT 'PENDING',

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


CREATE TRIGGER users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();
