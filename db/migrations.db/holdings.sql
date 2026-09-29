CREATE TABLE IF NOT EXISTS holdings (
    holding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL,

    security_id UUID NOT NULL,

    external_link_id UUID,

    quantity DECIMAL(18,6) NOT NULL,

    average_cost_minor BIGINT NOT NULL,

    last_synced_at TIMESTAMPTZ,

    CONSTRAINT fk_holding_account
        FOREIGN KEY (account_id)
        REFERENCES account(account_id),

    CONSTRAINT fk_holding_security
        FOREIGN KEY (security_id)
        REFERENCES securities(security_id),

    CONSTRAINT fk_holding_external_link
        FOREIGN KEY (external_link_id)
        REFERENCES external_brokerage_links(link_id)
);

-- One row per (brokerage link, security): a sync upserts the latest state
-- rather than appending, so running it twice changes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_holding_link_security
    ON holdings(external_link_id, security_id)
    WHERE external_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holding_account ON holdings(account_id);

-- Latest price and value from the brokerage, in the security's minor units.
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS current_price_minor BIGINT;
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS market_value_minor BIGINT;
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS unrealized_pl_minor BIGINT;

DO $$ BEGIN
    ALTER TABLE holdings ADD CONSTRAINT holding_quantity_non_negative CHECK (quantity >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Crypto quantities come with 9 decimal places (e.g. 0.001167028 BTC), more
-- than the data model's DECIMAL(18,6) keeps, so widen to 9.
ALTER TABLE holdings ALTER COLUMN quantity TYPE NUMERIC(28,9);
