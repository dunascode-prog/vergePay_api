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