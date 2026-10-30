-- Driver OTP and registration are Identity-owned. Earlier migrations are immutable.
BEGIN;
CREATE TABLE driver_otp_challenge (
  challenge_id UUID PRIMARY KEY,
  phone_lookup_hmac BYTEA NOT NULL CHECK (octet_length(phone_lookup_hmac)=32),
  phone_ciphertext BYTEA NOT NULL, phone_nonce BYTEA NOT NULL, phone_tag BYTEA NOT NULL,
  phone_key_version TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose='DRIVER_REGISTRATION'),
  code_digest BYTEA NOT NULL CHECK (octet_length(code_digest)=32),
  delivery_ciphertext BYTEA NOT NULL, delivery_nonce BYTEA NOT NULL,
  delivery_tag BYTEA NOT NULL, delivery_key_version TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('PENDING','DEV_AVAILABLE')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  resend_available_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ
);
CREATE INDEX driver_otp_phone_time ON driver_otp_challenge(phone_lookup_hmac,created_at DESC);
CREATE TABLE driver_phone_verification (
  verification_id UUID PRIMARY KEY,
  challenge_id UUID NOT NULL UNIQUE REFERENCES driver_otp_challenge(challenge_id) ON DELETE RESTRICT,
  phone_lookup_hmac BYTEA NOT NULL CHECK (octet_length(phone_lookup_hmac)=32),
  token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
  verified_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_operation_id UUID UNIQUE,
  consumed_at TIMESTAMPTZ
);
CREATE TABLE driver_registration (
  operation_id UUID PRIMARY KEY,
  account_id UUID NOT NULL UNIQUE REFERENCES account(account_id) ON DELETE RESTRICT,
  driver_id UUID NOT NULL UNIQUE,
  application_id UUID NOT NULL UNIQUE,
  command_id UUID NOT NULL UNIQUE,
  verification_id UUID NOT NULL UNIQUE REFERENCES driver_phone_verification(verification_id) ON DELETE RESTRICT,
  idempotency_key_hmac BYTEA NOT NULL UNIQUE CHECK (octet_length(idempotency_key_hmac)=32),
  request_fingerprint_hmac BYTEA NOT NULL CHECK (octet_length(request_fingerprint_hmac)=32),
  public_status TEXT NOT NULL CHECK (public_status IN ('PROCESSING','SUCCEEDED','FAILED')),
  phase TEXT NOT NULL CHECK (phase IN ('PROVISION_PENDING','PROVISION_UNKNOWN','SUCCEEDED','FAILED')),
  payload_ciphertext BYTEA NOT NULL, payload_nonce BYTEA NOT NULL,
  payload_tag BYTEA NOT NULL, payload_key_version TEXT NOT NULL,
  result_json JSONB,
  terminal_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminal_at TIMESTAMPTZ,
  public_lookup_until TIMESTAMPTZ,
  CHECK ((public_status='PROCESSING' AND phase IN ('PROVISION_PENDING','PROVISION_UNKNOWN')
    AND terminal_at IS NULL AND result_json IS NULL AND terminal_error_code IS NULL)
    OR (public_status='SUCCEEDED' AND phase='SUCCEEDED' AND terminal_at IS NOT NULL
      AND result_json IS NOT NULL AND terminal_error_code IS NULL)
    OR (public_status='FAILED' AND phase='FAILED' AND terminal_at IS NOT NULL
      AND result_json IS NULL AND terminal_error_code IS NOT NULL)),
  CHECK (public_lookup_until IS NULL OR public_lookup_until=terminal_at+interval '168 hours')
);
ALTER TABLE driver_phone_verification ADD CONSTRAINT driver_verification_operation_fk
  FOREIGN KEY (consumed_operation_id) REFERENCES driver_registration(operation_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX driver_registration_recovery ON driver_registration(public_status,updated_at)
  WHERE public_status='PROCESSING';
-- Customer claim ownership remains authoritative for Customer; this index prevents
-- a new Driver account colliding with any live Account contact, including seeded Driver.
CREATE UNIQUE INDEX account_live_email_lookup ON account(email_lookup_hmac)
  WHERE registration_access_state<>'FAILED';
CREATE UNIQUE INDEX account_live_phone_lookup ON account(phone_lookup_hmac)
  WHERE registration_access_state<>'FAILED';
REVOKE ALL ON driver_otp_challenge,driver_phone_verification,driver_registration FROM PUBLIC;
GRANT SELECT,INSERT ON driver_otp_challenge,driver_phone_verification,driver_registration TO identity_runtime;
GRANT UPDATE (invalidated_at,failed_attempts,verified_at,delivery_state) ON driver_otp_challenge TO identity_runtime;
GRANT UPDATE (consumed_operation_id,consumed_at) ON driver_phone_verification TO identity_runtime;
GRANT UPDATE (public_status,phase,result_json,terminal_error_code,updated_at,terminal_at,public_lookup_until)
  ON driver_registration TO identity_runtime;
COMMIT;
