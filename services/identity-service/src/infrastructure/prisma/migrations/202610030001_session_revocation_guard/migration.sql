-- Forward-only Session correction; V1 and V2 remain immutable.
BEGIN;
CREATE OR REPLACE FUNCTION guard_session_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'session identity and absolute expiry are immutable';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND (
      NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.refresh_token_digest IS DISTINCT FROM OLD.refresh_token_digest
      OR NEW.digest_key_version IS DISTINCT FROM OLD.digest_key_version
      OR NEW.rotated_at IS DISTINCT FROM OLD.rotated_at
    ) THEN
      RAISE EXCEPTION 'revoked session credentials are immutable';
    END IF;
  END IF;
  IF NEW.revoked_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM account a WHERE a.account_id = NEW.account_id
      AND a.registration_access_state = 'READY' AND a.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'session account is not eligible';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
