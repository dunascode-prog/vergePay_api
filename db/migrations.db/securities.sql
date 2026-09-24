DO $$ BEGIN
    CREATE TYPE asset_type_enum AS ENUM (
        'stock',
        'bond',
        'etf',
        'mutual_fund'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS securities (
    security_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    ticker_symbol VARCHAR(15) NOT NULL,

    company_name VARCHAR(150) NOT NULL,

    asset_type asset_type_enum NOT NULL,

    exchange VARCHAR(50),

    currency_code CHAR(3) NOT NULL,

    CONSTRAINT uq_ticker_symbol
        UNIQUE (ticker_symbol),

    CONSTRAINT fk_security_currency
        FOREIGN KEY (currency_code)
        REFERENCES currencies(code)
);