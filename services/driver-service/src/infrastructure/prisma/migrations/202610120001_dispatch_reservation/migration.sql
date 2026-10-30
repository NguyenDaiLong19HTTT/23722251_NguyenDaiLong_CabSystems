-- Driver-owned reservation and late-command fence. No Booking/Trip foreign keys.
BEGIN;
CREATE TABLE driver_reservation_generation (
  driver_id UUID PRIMARY KEY REFERENCES driver_profile(driver_id),
  next_generation BIGINT NOT NULL DEFAULT 1 CHECK(next_generation > 0)
);
CREATE TABLE driver_reservation (
  reservation_id UUID PRIMARY KEY,
  assignment_id UUID NOT NULL UNIQUE,
  booking_id UUID NOT NULL,
  driver_id UUID NOT NULL REFERENCES driver_profile(driver_id),
  vehicle_id UUID NOT NULL REFERENCES vehicle(vehicle_id),
  generation BIGINT NOT NULL CHECK(generation > 0),
  state TEXT NOT NULL CHECK(state IN ('HELD','BOUND','RELEASED')),
  trip_id UUID,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'BOUND') = (trip_id IS NOT NULL)),
  UNIQUE(driver_id,generation)
);
CREATE UNIQUE INDEX driver_one_active_reservation ON driver_reservation(driver_id)
  WHERE state <> 'RELEASED';
CREATE UNIQUE INDEX vehicle_one_active_reservation ON driver_reservation(vehicle_id)
  WHERE state <> 'RELEASED';
CREATE TABLE driver_reservation_cancellation (
  assignment_id UUID PRIMARY KEY,
  booking_id UUID NOT NULL,
  trip_id UUID NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON driver_reservation_generation,driver_reservation,
  driver_reservation_cancellation FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON driver_reservation_generation,driver_reservation,
  driver_reservation_cancellation TO driver_runtime;
COMMIT;
