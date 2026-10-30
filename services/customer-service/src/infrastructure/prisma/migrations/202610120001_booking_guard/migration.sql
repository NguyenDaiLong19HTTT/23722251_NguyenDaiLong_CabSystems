-- Customer owns one activity guard per active customer. Keep released rows and fences.
BEGIN;
CREATE TABLE customer_guard_generation (
  customer_id UUID PRIMARY KEY REFERENCES customer(customer_id),
  next_generation BIGINT NOT NULL DEFAULT 1 CHECK(next_generation > 0)
);
CREATE TABLE customer_activity_guard (
  guard_id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customer(customer_id),
  booking_id UUID NOT NULL UNIQUE,
  operation_id UUID NOT NULL UNIQUE,
  generation BIGINT NOT NULL CHECK(generation > 0),
  state TEXT NOT NULL CHECK(state IN ('BOOKING_HELD','TRIP_BOUND','GUARD_RELEASED')),
  trip_id UUID,
  assignment_id UUID,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'TRIP_BOUND') = (trip_id IS NOT NULL AND assignment_id IS NOT NULL)),
  UNIQUE(customer_id,generation)
);
CREATE UNIQUE INDEX customer_one_active_guard ON customer_activity_guard(customer_id)
  WHERE state <> 'GUARD_RELEASED';
CREATE TABLE customer_guard_cancellation (
  booking_id UUID PRIMARY KEY,
  customer_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON customer_guard_generation,customer_activity_guard,
  customer_guard_cancellation FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON customer_guard_generation,customer_activity_guard,
  customer_guard_cancellation TO customer_runtime;
COMMIT;
