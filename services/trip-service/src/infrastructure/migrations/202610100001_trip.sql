-- Trip owns its state, receipts, closure work and outbox. No cross-database FK.
CREATE TABLE trip_preparation (
  assignment_id UUID PRIMARY KEY, trip_id UUID NOT NULL UNIQUE, booking_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','ACTIVE','PREPARATION_CANCELLED')),
  version BIGINT NOT NULL CHECK(version>0), request_digest BYTEA,
  parties JSONB, guard_ref JSONB, reservation_ref JSONB, pickup JSONB,
  destination JSONB, pricing JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state='PREPARATION_CANCELLED' AND request_digest IS NULL) OR
    (request_digest IS NOT NULL AND octet_length(request_digest)=32))
);
CREATE TABLE trip (
  trip_id UUID PRIMARY KEY, assignment_id UUID NOT NULL UNIQUE REFERENCES trip_preparation(assignment_id),
  booking_id UUID NOT NULL UNIQUE, customer_id UUID NOT NULL,customer_account_id UUID NOT NULL,
  driver_id UUID NOT NULL,driver_account_id UUID NOT NULL,vehicle_id UUID NOT NULL,
  guard_ref JSONB NOT NULL,reservation_ref JSONB NOT NULL,pricing JSONB NOT NULL,
  pickup JSONB NOT NULL,destination JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP',
    'IN_PROGRESS','COMPLETED','CANCELLED','ERROR')),
  version BIGINT NOT NULL CHECK(version>0),
  start_check_id UUID, start_check_version BIGINT, start_check_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,picked_up_at TIMESTAMPTZ,started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,
  cancellation JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((status='COMPLETED')=(completed_at IS NOT NULL)),
  CHECK((status IN ('COMPLETED','CANCELLED'))=(closed_at IS NOT NULL)),
  CHECK((status='CANCELLED')=(cancellation IS NOT NULL))
);
CREATE UNIQUE INDEX trip_active_driver_uq ON trip(driver_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX trip_active_customer_uq ON trip(customer_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX trip_active_vehicle_uq ON trip(vehicle_id) WHERE closed_at IS NULL;
CREATE TABLE trip_status_history (
  trip_id UUID NOT NULL REFERENCES trip(trip_id),version BIGINT NOT NULL CHECK(version>0),
  previous_status TEXT,new_status TEXT NOT NULL,actor_type TEXT NOT NULL CHECK(actor_type IN ('USER','SYSTEM')),
  actor_id TEXT NOT NULL,changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),reason TEXT,
  PRIMARY KEY(trip_id,version)
);
CREATE TABLE trip_receipt (
  command_id UUID PRIMARY KEY, trip_id UUID NOT NULL,operation TEXT NOT NULL,
  request_digest BYTEA NOT NULL CHECK(octet_length(request_digest)=32),
  response_snapshot JSONB NOT NULL,committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE trip_closure (
  operation_id UUID PRIMARY KEY,trip_id UUID NOT NULL UNIQUE REFERENCES trip(trip_id),
  driver_release TEXT NOT NULL DEFAULT 'PENDING' CHECK(driver_release IN ('PENDING','CONFIRMED')),
  customer_release TEXT NOT NULL DEFAULT 'PENDING' CHECK(customer_release IN ('PENDING','CONFIRMED')),
  payment_fence TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK(payment_fence IN ('NOT_REQUIRED','PENDING','CONFIRMED')),
  attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE trip_route_point (
  sample_id UUID PRIMARY KEY,trip_id UUID NOT NULL REFERENCES trip(trip_id),driver_id UUID NOT NULL,
  latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  recorded_at TIMESTAMPTZ NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(trip_id,driver_id,recorded_at)
);
CREATE TABLE trip_outbox (
  event_id UUID PRIMARY KEY,trip_id UUID NOT NULL REFERENCES trip(trip_id),aggregate_version BIGINT NOT NULL,
  event_type TEXT NOT NULL,safe_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_until TIMESTAMPTZ,UNIQUE(trip_id,aggregate_version,event_type)
);
REVOKE ALL ON trip_preparation,trip,trip_status_history,trip_receipt,trip_closure,trip_route_point,trip_outbox FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON trip_preparation,trip,trip_receipt,trip_closure,trip_outbox TO trip_runtime;
GRANT SELECT,INSERT ON trip_status_history,trip_route_point TO trip_runtime;
