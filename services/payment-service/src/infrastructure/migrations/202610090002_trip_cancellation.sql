-- Additive Payment-owned fence. V1 remains byte-for-byte unchanged.
CREATE TABLE payment_trip_cancellation (
  trip_id UUID PRIMARY KEY,
  cancellation_id UUID NOT NULL UNIQUE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON payment_trip_cancellation FROM PUBLIC;
GRANT SELECT,INSERT ON payment_trip_cancellation TO payment_runtime;
