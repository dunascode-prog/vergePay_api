DO $$ BEGIN
    CREATE TYPE document_type_enum AS ENUM (
        'national_id',
        'passport',
        'drivers_license',
        'bvn'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE verification_status_enum AS ENUM (
        'pending',
        'approved',
        'rejected'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS kyc_verification (
    kyc_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,

    document_type document_type_enum NOT NULL,

    document_reference VARCHAR(255) NOT NULL,

    verification_status verification_status_enum
        NOT NULL DEFAULT 'pending',

    verified_by VARCHAR(100),

    submitted_at TIMESTAMPTZ
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    reviewed_at TIMESTAMPTZ,

    CONSTRAINT fk_kyc_user
        FOREIGN KEY (user_id)
        REFERENCES users(user_id)
);