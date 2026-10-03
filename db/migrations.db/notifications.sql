-- In-app notifications: the alerts a customer sees in the bell, one row per
-- user per event. Written in the same DB transaction as the event itself
-- (services/notifications.js), so an alert exists exactly when the money
-- moved. Delivery to open browsers is separate (services/realtime.js).
CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,

    -- money_received, money_sent, own_transfer, kyc_approved, kyc_rejected
    kind VARCHAR(40) NOT NULL,

    title VARCHAR(160) NOT NULL,

    body VARCHAR(255),

    -- set for money alerts
    transaction_id UUID REFERENCES transactions(transaction_id),
    account_id UUID REFERENCES account(account_id),
    direction VARCHAR(6) CHECK (direction IN ('credit', 'debit')),
    amount_minor BIGINT CHECK (amount_minor > 0),
    currency_code CHAR(3),

    read_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- one alert per user per transaction and kind, so a replayed settlement
-- can never alert twice
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_user_txn_kind
    ON notifications (user_id, transaction_id, kind)
    WHERE transaction_id IS NOT NULL;

-- the bell: newest first, and the unread count
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications (user_id, created_at DESC, notification_id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications (user_id) WHERE read_at IS NULL;
