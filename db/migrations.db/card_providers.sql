CREATE TABLE IF NOT EXISTS card_providers (
    provider_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    provider_name VARCHAR(50) NOT NULL,

    country_scope VARCHAR(100)
);