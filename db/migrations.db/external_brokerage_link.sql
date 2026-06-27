CREATE TYPE external_link_status_enum AS ENUM (
    'active',
    'expired',
    'revoked'
);

CREATE TABLE IF NOT EXISTS external_brokerage_links (
    link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,

    provider_name VARCHAR(50) NOT NULL,

    oauth_token_reference VARCHAR(255) NOT NULL,

    link_status external_link_status_enum NOT NULL,

    last_synced_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_external_link_user
        FOREIGN KEY (user_id)
        REFERENCES users(user_id)
);