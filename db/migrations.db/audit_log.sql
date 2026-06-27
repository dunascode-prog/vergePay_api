CREATE TYPE audit_action_enum AS ENUM (
    'create',
    'update',
    'delete',
    'status_change'
);

CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    actor_id UUID,

    entity_type VARCHAR(50) NOT NULL,

    entity_id UUID NOT NULL,

    action audit_action_enum NOT NULL,

    before_state JSONB,

    after_state JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_audit_actor
        FOREIGN KEY (actor_id)
        REFERENCES users(user_id)
);