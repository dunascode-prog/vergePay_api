CREATE TABLE IF NOT EXISTS card_providers (
    provider_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    provider_name VARCHAR(50) NOT NULL,

    country_scope VARCHAR(100)
);

-- Card networks, by the name Flutterwave reports in card.type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_provider_name ON card_providers(provider_name);

INSERT INTO card_providers (provider_name, country_scope) VALUES
    ('Visa', NULL),
    ('Mastercard', NULL),
    ('Verve', 'Nigeria'),
    ('American Express', NULL)
ON CONFLICT (provider_name) DO NOTHING;
