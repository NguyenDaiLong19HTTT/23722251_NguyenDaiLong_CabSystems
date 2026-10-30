-- Probe upgrade V2 only. Keep V1 byte-for-byte unchanged.
BEGIN;
ALTER TABLE probe_business ADD COLUMN probe_note TEXT NOT NULL DEFAULT 'v2';
CREATE TABLE probe_upgrade_audit (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES probe_business(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  marker TEXT NOT NULL CHECK (length(marker) > 0)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON probe_upgrade_audit TO identity_runtime;
COMMIT;
