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
-- What the customer submitted (their legal name and date of birth; the BVN
-- itself lives encrypted in vault_secrets, document_reference holds only the
-- vault: reference), and why a check was rejected, so they can fix it.
ALTER TABLE kyc_verification ADD COLUMN IF NOT EXISTS legal_first_name VARCHAR(100);
ALTER TABLE kyc_verification ADD COLUMN IF NOT EXISTS legal_last_name VARCHAR(100);
ALTER TABLE kyc_verification ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE kyc_verification ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_kyc_verification_user ON kyc_verification(user_id, submitted_at DESC);
