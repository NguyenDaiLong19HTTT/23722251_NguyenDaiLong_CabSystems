-- Additive incident evidence. Preserve applied V1/V2 history and existing Trip data.
ALTER TABLE trip ADD COLUMN status_before_error TEXT;
ALTER TABLE trip ADD CONSTRAINT trip_before_error_v3_check CHECK (
  (status='ERROR' AND status_before_error IN
    ('DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS')) OR
  (status<>'ERROR' AND status_before_error IS NULL)
);
DO $$
DECLARE old_name TEXT;
BEGIN
  SELECT conname INTO old_name FROM pg_constraint
  WHERE conrelid='trip'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%closed_at%'
    AND pg_get_constraintdef(oid) LIKE '%status%';
  IF old_name IS NULL THEN RAISE EXCEPTION 'Trip closed-state constraint not found'; END IF;
  EXECUTE format('ALTER TABLE trip DROP CONSTRAINT %I',old_name);
END $$;
ALTER TABLE trip ADD CONSTRAINT trip_closed_status_v3_check CHECK (
  (status IN ('COMPLETED','CANCELLED') AND closed_at IS NOT NULL) OR
  status='ERROR' OR
  (status NOT IN ('COMPLETED','CANCELLED','ERROR') AND closed_at IS NULL)
);
CREATE TABLE trip_incident (
  incident_id UUID PRIMARY KEY,trip_id UUID NOT NULL REFERENCES trip(trip_id),
  command_id UUID NOT NULL UNIQUE,issue_type TEXT NOT NULL CHECK(issue_type IN
    ('VEHICLE_BREAKDOWN','ACCIDENT','PASSENGER_ISSUE','OTHER')),
  description TEXT NOT NULL CHECK(length(btrim(description))>0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status='OPEN'),
  reported_by_account_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trip_incident_trip_created_idx ON trip_incident(trip_id,created_at);
REVOKE ALL ON trip_incident FROM PUBLIC;
GRANT SELECT,INSERT ON trip_incident TO trip_runtime;
