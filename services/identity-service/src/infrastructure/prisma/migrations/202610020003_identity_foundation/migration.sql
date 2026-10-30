-- Production Identity V1. Review before deploy; no probe tables or cross-database references.
BEGIN;
CREATE TABLE account (
  account_id UUID PRIMARY KEY,
  full_name TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  email_ciphertext BYTEA NOT NULL, email_nonce BYTEA NOT NULL, email_tag BYTEA NOT NULL,
  email_key_version TEXT NOT NULL CHECK (length(email_key_version) > 0),
  phone_ciphertext BYTEA NOT NULL, phone_nonce BYTEA NOT NULL, phone_tag BYTEA NOT NULL,
  phone_key_version TEXT NOT NULL CHECK (length(phone_key_version) > 0),
  email_lookup_hmac BYTEA NOT NULL CHECK (octet_length(email_lookup_hmac) = 32),
  phone_lookup_hmac BYTEA NOT NULL CHECK (octet_length(phone_lookup_hmac) = 32),
  lookup_key_version TEXT NOT NULL CHECK (length(lookup_key_version) > 0),
  password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER','DRIVER','OPERATOR')),
  account_status TEXT NOT NULL CHECK (account_status IN ('ACTIVE','INACTIVE','SUSPENDED')),
  registration_access_state TEXT NOT NULL DEFAULT 'BLOCKED'
    CHECK (registration_access_state IN ('BLOCKED','READY','FAILED')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  confirmed_profile_id UUID,
  profile_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_confirmation_pair CHECK ((confirmed_profile_id IS NULL) = (profile_confirmed_at IS NULL)),
  CONSTRAINT account_ready_profile CHECK (registration_access_state <> 'READY' OR confirmed_profile_id IS NOT NULL),
  CONSTRAINT account_failed_profile CHECK (registration_access_state <> 'FAILED' OR confirmed_profile_id IS NULL)
);
CREATE INDEX account_role_status_idx ON account(role, account_status);

CREATE TABLE registration_operation (
  operation_id VARCHAR(128) PRIMARY KEY CHECK (length(btrim(operation_id)) > 0),
  flow_type TEXT NOT NULL CHECK (flow_type = 'CUSTOMER'),
  account_id UUID NOT NULL REFERENCES account(account_id) ON DELETE RESTRICT,
  target_profile_id UUID NOT NULL,
  public_status TEXT NOT NULL CHECK (public_status IN ('PROCESSING','SUCCEEDED','FAILED')),
  internal_phase TEXT NOT NULL CHECK (internal_phase IN
    ('PROVISION_PENDING','PROVISION_UNKNOWN','FINALIZING','COMPENSATING','SUCCEEDED','FAILED')),
  idempotency_key_hmac BYTEA NOT NULL CHECK (octet_length(idempotency_key_hmac) = 32),
  idempotency_key_version TEXT NOT NULL CHECK (length(idempotency_key_version) > 0),
  recovery_token_digest BYTEA NOT NULL CHECK (octet_length(recovery_token_digest) = 32),
  recovery_digest_key_version TEXT NOT NULL CHECK (length(recovery_digest_key_version) > 0),
  request_fingerprint_hmac BYTEA NOT NULL CHECK (octet_length(request_fingerprint_hmac) = 32),
  fingerprint_key_version TEXT NOT NULL CHECK (length(fingerprint_key_version) > 0),
  customer_provision_state TEXT CHECK (customer_provision_state IN ('PROVISIONED','PROVISION_CANCELLED')),
  terminal_error_code TEXT,
  result_snapshot_ciphertext BYTEA, result_snapshot_nonce BYTEA, result_snapshot_tag BYTEA,
  result_snapshot_key_version TEXT, result_snapshot_format_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminal_at TIMESTAMPTZ,
  public_lookup_until TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT registration_account_binding UNIQUE (operation_id, account_id),
  CONSTRAINT registration_key UNIQUE (flow_type, idempotency_key_hmac),
  CONSTRAINT registration_profile UNIQUE (flow_type, target_profile_id),
  CONSTRAINT registration_terminal_pair CHECK ((terminal_at IS NULL) = (public_lookup_until IS NULL)),
  CONSTRAINT registration_public_window CHECK (public_lookup_until IS NULL OR public_lookup_until = terminal_at + interval '168 hours'),
  CONSTRAINT registration_snapshot_bundle CHECK (
    (result_snapshot_ciphertext IS NULL AND result_snapshot_nonce IS NULL AND result_snapshot_tag IS NULL
      AND result_snapshot_key_version IS NULL AND result_snapshot_format_version IS NULL)
    OR
    (result_snapshot_ciphertext IS NOT NULL AND result_snapshot_nonce IS NOT NULL AND result_snapshot_tag IS NOT NULL
      AND result_snapshot_key_version IS NOT NULL AND result_snapshot_format_version > 0)),
  CONSTRAINT registration_state_consistency CHECK (
    (public_status = 'PROCESSING' AND internal_phase IN
      ('PROVISION_PENDING','PROVISION_UNKNOWN','FINALIZING','COMPENSATING')
      AND terminal_at IS NULL AND result_snapshot_ciphertext IS NULL AND terminal_error_code IS NULL)
    OR (public_status = 'SUCCEEDED' AND internal_phase = 'SUCCEEDED'
      AND terminal_at IS NOT NULL AND customer_provision_state = 'PROVISIONED'
      AND result_snapshot_ciphertext IS NOT NULL AND terminal_error_code IS NULL)
    OR (public_status = 'FAILED' AND internal_phase = 'FAILED'
      AND terminal_at IS NOT NULL AND customer_provision_state = 'PROVISION_CANCELLED'
      AND result_snapshot_ciphertext IS NULL AND terminal_error_code IS NOT NULL))
);
CREATE INDEX registration_public_scan_idx ON registration_operation(public_status, updated_at);
CREATE INDEX registration_phase_scan_idx ON registration_operation(internal_phase, updated_at);

-- Historical encrypted contacts remain on account; this claim alone controls current ownership.
CREATE TABLE contact_claim (
  claim_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES account(account_id) ON DELETE RESTRICT,
  operation_id VARCHAR(128) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('EMAIL','PHONE')),
  lookup_hmac BYTEA NOT NULL CHECK (octet_length(lookup_hmac) = 32),
  lookup_key_version TEXT NOT NULL CHECK (length(lookup_key_version) > 0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  CONSTRAINT contact_claim_operation_account FOREIGN KEY (operation_id,account_id)
    REFERENCES registration_operation(operation_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT contact_claim_account_kind UNIQUE (account_id,kind),
  CONSTRAINT contact_claim_operation_kind UNIQUE (operation_id,kind),
  CONSTRAINT contact_claim_time CHECK (released_at IS NULL OR released_at >= claimed_at)
);
CREATE UNIQUE INDEX contact_claim_one_active_digest ON contact_claim(kind,lookup_hmac)
  WHERE released_at IS NULL;
CREATE INDEX contact_claim_lookup_idx ON contact_claim(kind,lookup_hmac);

-- A claim can only be released after the same local transaction records terminal FAILED.
CREATE FUNCTION guard_contact_claim_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM registration_operation ro JOIN account a ON a.account_id = ro.account_id
      WHERE ro.operation_id = NEW.operation_id AND ro.account_id = NEW.account_id
        AND ro.public_status = 'FAILED' AND ro.internal_phase = 'FAILED'
        AND ro.customer_provision_state = 'PROVISION_CANCELLED'
        AND a.registration_access_state = 'FAILED'
    ) THEN
      RAISE EXCEPTION 'contact claim release requires confirmed failed registration';
    END IF;
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'released contact claim is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_claim_release_guard BEFORE UPDATE ON contact_claim
  FOR EACH ROW EXECUTE FUNCTION guard_contact_claim_release();

CREATE TABLE session (
  session_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES account(account_id) ON DELETE RESTRICT,
  refresh_token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(refresh_token_digest) = 32),
  digest_key_version TEXT NOT NULL CHECK (length(digest_key_version) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT session_absolute_expiry CHECK (expires_at = created_at + interval '168 hours'),
  CONSTRAINT session_rotation_time CHECK (rotated_at IS NULL OR rotated_at >= created_at),
  CONSTRAINT session_revocation_time CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX session_account_state_idx ON session(account_id,revoked_at,expires_at);

CREATE FUNCTION guard_session_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM account a WHERE a.account_id = NEW.account_id
      AND a.registration_access_state = 'READY' AND a.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'session account is not eligible';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_access_guard BEFORE INSERT OR UPDATE ON session
  FOR EACH ROW EXECUTE FUNCTION guard_session_access();

CREATE FUNCTION guard_account_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.registration_access_state = 'FAILED' AND OLD.registration_access_state IS DISTINCT FROM 'FAILED'
    AND EXISTS (SELECT 1 FROM session s WHERE s.account_id = NEW.account_id AND s.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'failed registration must revoke sessions first';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_failure_guard BEFORE UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION guard_account_failure();

CREATE TABLE registration_step (
  step_id UUID PRIMARY KEY,
  operation_id VARCHAR(128) NOT NULL REFERENCES registration_operation(operation_id) ON DELETE RESTRICT,
  step_kind TEXT NOT NULL CHECK (step_kind IN ('PROVISION_CUSTOMER','CANCEL_CUSTOMER_PROVISION')),
  command_id UUID NOT NULL,
  target_service TEXT NOT NULL CHECK (target_service = 'customer-service'),
  request_fingerprint_hmac BYTEA NOT NULL CHECK (octet_length(request_fingerprint_hmac) = 32),
  step_state TEXT NOT NULL CHECK (step_state IN ('READY','OUTCOME_UNKNOWN','CONFIRMED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  last_safe_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT step_once UNIQUE (operation_id,step_kind),
  CONSTRAINT step_command UNIQUE (target_service,command_id)
);
CREATE INDEX registration_step_retry_idx ON registration_step(step_state,next_attempt_at);

CREATE TABLE identity_outbox (
  event_id UUID PRIMARY KEY, aggregate_id UUID NOT NULL,
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version >= 1),
  event_type TEXT NOT NULL CHECK (event_type = 'ACCOUNT_PROVISIONED'),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  payload JSONB NOT NULL, correlation_id TEXT, causation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  publish_state TEXT NOT NULL CHECK (publish_state IN ('PENDING','PUBLISHED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
  CONSTRAINT outbox_fact_unique UNIQUE (aggregate_id,aggregate_version,event_type),
  CHECK ((publish_state = 'PENDING' AND published_at IS NULL) OR
    (publish_state = 'PUBLISHED' AND published_at IS NOT NULL))
);
CREATE INDEX identity_outbox_pending_idx ON identity_outbox(publish_state,next_attempt_at);

CREATE TABLE identity_audit (
  audit_id UUID PRIMARY KEY, account_id UUID, operation_id VARCHAR(128),
  action TEXT NOT NULL CHECK (action IN
    ('REGISTRATION_ACCEPTED','PROVISION_CONFIRMED','REGISTRATION_FINALIZED','COMPENSATION_STARTED',
     'REGISTRATION_FAILED','SESSION_CREATED','SESSION_REVOKED')),
  actor_account_id UUID, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id TEXT, safe_detail JSONB
);
CREATE INDEX identity_audit_account_idx ON identity_audit(account_id,occurred_at);
CREATE INDEX identity_audit_operation_idx ON identity_audit(operation_id,occurred_at);

GRANT SELECT,INSERT,UPDATE,DELETE ON account,registration_operation,contact_claim,session,
  registration_step,identity_outbox,identity_audit TO identity_runtime;
COMMIT;
