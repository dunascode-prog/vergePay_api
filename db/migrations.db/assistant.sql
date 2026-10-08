-- Recommendations a customer dismissed ("not now"), by the recommendation's
-- key (services/assistant/recommendations.js). Hidden until dismissed_until;
-- most keys include the invoice, loan installment or month, so the same
-- advice about something new still shows.
CREATE TABLE IF NOT EXISTS recommendation_dismissals (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    rec_key VARCHAR(200) NOT NULL,
    dismissed_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, rec_key)
);
