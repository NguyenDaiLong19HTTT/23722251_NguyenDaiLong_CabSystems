-- New migration: resolve an ERROR without rewriting applied incident migration.
ALTER TABLE trip ADD COLUMN close_reason TEXT;
ALTER TABLE trip ADD CONSTRAINT trip_error_close_reason_v4_check CHECK (
  (status='ERROR' AND closed_at IS NOT NULL)=(close_reason IS NOT NULL)
);
ALTER TABLE trip_incident DROP CONSTRAINT trip_incident_status_check;
ALTER TABLE trip_incident ADD COLUMN resolution_action TEXT;
ALTER TABLE trip_incident ADD COLUMN resolution_note TEXT;
ALTER TABLE trip_incident ADD COLUMN resolved_by_account_id UUID;
ALTER TABLE trip_incident ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE trip_incident ADD CONSTRAINT trip_incident_resolution_v4_check CHECK (
  (status='OPEN' AND resolution_action IS NULL AND resolution_note IS NULL
    AND resolved_by_account_id IS NULL AND resolved_at IS NULL) OR
  (status='RESOLVED' AND resolution_action IN ('RESTORE_PREVIOUS_STATUS','CLOSE_ABNORMALLY')
    AND length(btrim(resolution_note))>0 AND resolved_by_account_id IS NOT NULL
    AND resolved_at IS NOT NULL)
);
CREATE TABLE trip_resolution_audit (
  resolution_id UUID PRIMARY KEY,trip_id UUID NOT NULL REFERENCES trip(trip_id),
  actor_account_id UUID NOT NULL,action TEXT NOT NULL CHECK(action IN
    ('RESTORE_PREVIOUS_STATUS','CLOSE_ABNORMALLY')),
  note TEXT NOT NULL CHECK(length(btrim(note))>0),
  trip_version BIGINT NOT NULL CHECK(trip_version>0),
  resolved_incident_ids UUID[] NOT NULL CHECK(cardinality(resolved_incident_ids)>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(trip_id,trip_version)
);
REVOKE ALL ON trip_resolution_audit FROM PUBLIC;
GRANT SELECT,INSERT ON trip_resolution_audit TO trip_runtime;
GRANT UPDATE ON trip_incident TO trip_runtime;
