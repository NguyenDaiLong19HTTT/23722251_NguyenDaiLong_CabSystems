-- Additive Trip-owned journey evidence. Fare remains Payment-owned and fixed before travel.
CREATE TABLE journey_metrics (
  trip_id UUID PRIMARY KEY REFERENCES trip(trip_id),
  metrics_version BIGINT NOT NULL DEFAULT 1 CHECK(metrics_version>0),
  status TEXT NOT NULL CHECK(status IN ('PENDING','CONFIRMED','REVIEW_REQUIRED')),
  distance_km NUMERIC(18,6) CHECK(distance_km>=0),
  duration_minutes NUMERIC(18,6) CHECK(duration_minutes>=0),
  calculation_method_version TEXT,
  confirmed_at TIMESTAMPTZ,
  review_reason TEXT,
  CHECK ((status='CONFIRMED')=(distance_km IS NOT NULL AND duration_minutes IS NOT NULL
    AND confirmed_at IS NOT NULL)),
  CHECK (status='CONFIRMED' OR (distance_km IS NULL AND duration_minutes IS NULL
    AND confirmed_at IS NULL))
);
INSERT INTO journey_metrics(trip_id,status)
SELECT trip_id,'PENDING' FROM trip WHERE status='COMPLETED';
REVOKE ALL ON journey_metrics FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON journey_metrics TO trip_runtime;
