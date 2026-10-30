-- Forward-only correction to V1. Fail on contradictory evidence; never rewrite it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM registration_operation WHERE result_snapshot_ciphertext IS NOT NULL
      AND result_snapshot_format_version IS NULL) THEN
    RAISE EXCEPTION 'identity evidence preflight: snapshot format version missing';
  END IF;
  IF EXISTS (SELECT 1 FROM registration_operation WHERE public_status IN ('SUCCEEDED','FAILED')
      AND customer_provision_state IS NULL) THEN
    RAISE EXCEPTION 'identity evidence preflight: terminal provision state missing';
  END IF;
END $$;
BEGIN;

ALTER TABLE registration_operation DROP CONSTRAINT registration_snapshot_bundle;
ALTER TABLE registration_operation ADD CONSTRAINT registration_snapshot_bundle CHECK (
  (result_snapshot_ciphertext IS NULL AND result_snapshot_nonce IS NULL AND result_snapshot_tag IS NULL
    AND result_snapshot_key_version IS NULL AND result_snapshot_format_version IS NULL)
  OR (result_snapshot_ciphertext IS NOT NULL AND result_snapshot_nonce IS NOT NULL
    AND result_snapshot_tag IS NOT NULL AND result_snapshot_key_version IS NOT NULL
    AND result_snapshot_format_version IS NOT NULL AND result_snapshot_format_version > 0));
ALTER TABLE registration_operation DROP CONSTRAINT registration_state_consistency;
ALTER TABLE registration_operation ADD CONSTRAINT registration_state_consistency CHECK (
  (public_status = 'PROCESSING' AND internal_phase IN
    ('PROVISION_PENDING','PROVISION_UNKNOWN','FINALIZING','COMPENSATING')
    AND terminal_at IS NULL AND result_snapshot_ciphertext IS NULL AND terminal_error_code IS NULL)
  OR (public_status = 'SUCCEEDED' AND internal_phase = 'SUCCEEDED'
    AND terminal_at IS NOT NULL AND customer_provision_state IS NOT NULL
    AND customer_provision_state = 'PROVISIONED' AND result_snapshot_ciphertext IS NOT NULL
    AND terminal_error_code IS NULL)
  OR (public_status = 'FAILED' AND internal_phase = 'FAILED'
    AND terminal_at IS NOT NULL AND customer_provision_state IS NOT NULL
    AND customer_provision_state = 'PROVISION_CANCELLED' AND result_snapshot_ciphertext IS NULL
    AND terminal_error_code IS NOT NULL));

CREATE OR REPLACE FUNCTION guard_contact_claim_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'new contact claim cannot be pre-released';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.lookup_hmac IS DISTINCT FROM OLD.lookup_hmac
     OR NEW.lookup_key_version IS DISTINCT FROM OLD.lookup_key_version
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'contact claim binding is immutable';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'released contact claim is immutable';
  END IF;
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM registration_operation ro JOIN account a ON a.account_id = ro.account_id
    WHERE ro.operation_id = NEW.operation_id AND ro.account_id = NEW.account_id
      AND ro.public_status = 'FAILED' AND ro.internal_phase = 'FAILED'
      AND ro.customer_provision_state = 'PROVISION_CANCELLED'
      AND a.registration_access_state = 'FAILED'
  ) THEN
    RAISE EXCEPTION 'contact claim release requires confirmed failed registration';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_claim_insert_guard BEFORE INSERT ON contact_claim
  FOR EACH ROW EXECUTE FUNCTION guard_contact_claim_release();

CREATE OR REPLACE FUNCTION guard_session_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'session identity and absolute expiry are immutable';
  END IF;
  IF NEW.revoked_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM account a WHERE a.account_id = NEW.account_id
      AND a.registration_access_state = 'READY' AND a.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'session account is not eligible';
  END IF;
  RETURN NEW;
END $$;

-- V1 over-granted DML. Runtime may insert evidence, then only change progress fields.
REVOKE UPDATE,DELETE ON account,registration_operation,contact_claim,session,
  registration_step,identity_outbox,identity_audit FROM identity_runtime;
GRANT UPDATE (full_name,email_ciphertext,email_nonce,email_tag,email_key_version,
  phone_ciphertext,phone_nonce,phone_tag,phone_key_version,email_lookup_hmac,phone_lookup_hmac,
  lookup_key_version,password_hash,account_status,registration_access_state,version,
  confirmed_profile_id,profile_confirmed_at,updated_at) ON account TO identity_runtime;
GRANT UPDATE (public_status,internal_phase,customer_provision_state,terminal_error_code,
  result_snapshot_ciphertext,result_snapshot_nonce,result_snapshot_tag,result_snapshot_key_version,
  result_snapshot_format_version,updated_at,terminal_at,public_lookup_until,version)
  ON registration_operation TO identity_runtime;
GRANT UPDATE (released_at) ON contact_claim TO identity_runtime;
GRANT UPDATE (refresh_token_digest,digest_key_version,rotated_at,revoked_at,version)
  ON session TO identity_runtime;
GRANT UPDATE (step_state,attempt_count,next_attempt_at,last_safe_reason,updated_at)
  ON registration_step TO identity_runtime;
GRANT UPDATE (publish_state,attempt_count,next_attempt_at,published_at)
  ON identity_outbox TO identity_runtime;
-- Audit is append-only to runtime. None of these tables permits runtime DELETE.
COMMIT;
