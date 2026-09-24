-- Stores the outcome of each Idempotency-Key so retries replay the original
-- response instead of repeating the side effect. Keys expire after 24 hours.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(255) PRIMARY KEY,

    request_hash CHAR(64) NOT NULL,

    response JSONB,

    status_code SMALLINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    expires_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);
