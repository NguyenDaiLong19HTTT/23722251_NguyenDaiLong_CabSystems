-- Booking owns create/dispatch/assignment decisions and durable recovery work.
CREATE TABLE booking_operation (
  operation_id UUID PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK(operation_type IN ('CREATE_BOOKING','CANCEL_BOOKING')),
  booking_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  customer_account_id UUID NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PROCESSING','SUCCEEDED','FAILED')),
  guard_disposition TEXT NOT NULL CHECK(guard_disposition IN ('KEEP_BOOKING_GUARD','RELEASE_BOOKING_GUARD')),
  request_snapshot JSONB NOT NULL,
  guard_ref JSONB,
  pricing_snapshot JSONB,
  response_snapshot JSONB,
  error_code TEXT,
  failure_http_status INTEGER,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state='SUCCEEDED')=(response_snapshot IS NOT NULL)),
  CHECK (state<>'FAILED' OR (error_code IS NOT NULL AND failure_http_status IS NOT NULL))
);
CREATE UNIQUE INDEX booking_one_creating_customer ON booking_operation(customer_id)
  WHERE operation_type='CREATE_BOOKING' AND state='PROCESSING';
CREATE UNIQUE INDEX booking_one_create_operation_per_booking ON booking_operation(booking_id)
  WHERE operation_type='CREATE_BOOKING';
CREATE UNIQUE INDEX booking_one_cancel_operation_per_booking ON booking_operation(booking_id)
  WHERE operation_type='CANCEL_BOOKING';
CREATE INDEX booking_operation_owner ON booking_operation(customer_account_id,created_at DESC);
CREATE TABLE booking (
  booking_id UUID PRIMARY KEY,
  create_operation_id UUID NOT NULL UNIQUE REFERENCES booking_operation(operation_id),
  customer_id UUID NOT NULL,
  customer_account_id UUID NOT NULL,
  pickup JSONB NOT NULL,
  destination JSONB NOT NULL,
  vehicle_type TEXT NOT NULL CHECK(vehicle_type='MOTORBIKE'),
  note TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','FINDING_DRIVER','DRIVER_ASSIGNED',
    'NO_DRIVER_FOUND','CANCELLED')),
  pricing_operation_id UUID NOT NULL,
  pricing_snapshot JSONB NOT NULL,
  guard_ref JSONB NOT NULL,
  driver_id UUID,
  driver_account_id UUID,
  trip_id UUID UNIQUE,
  cancellation JSONB,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status='DRIVER_ASSIGNED')=(driver_id IS NOT NULL AND trip_id IS NOT NULL)),
  CHECK ((status='CANCELLED')=(cancellation IS NOT NULL))
);
CREATE UNIQUE INDEX booking_one_unassigned_active_customer ON booking(customer_id)
  WHERE status IN ('PENDING','FINDING_DRIVER');
CREATE INDEX booking_owner_page ON booking(customer_account_id,created_at DESC,booking_id DESC);
CREATE TABLE booking_dispatch (
  booking_id UUID PRIMARY KEY REFERENCES booking(booking_id),
  status TEXT NOT NULL CHECK(status IN ('SEARCHING','DRIVER_FOUND','NO_DRIVER_AVAILABLE','CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  attempted_driver_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(attempted_driver_ids)='array'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL,
  max_offers INTEGER NOT NULL CHECK(max_offers>0),
  offer_timeout_seconds INTEGER NOT NULL CHECK(offer_timeout_seconds>0),
  failure_reason TEXT CHECK(failure_reason IN ('NO_ELIGIBLE_DRIVER','OFFER_LIMIT_REACHED','SEARCH_TIMEOUT')),
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE booking_offer (
  trip_request_id UUID PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES booking(booking_id),
  driver_id UUID NOT NULL,
  driver_account_id UUID NOT NULL,
  vehicle_id UUID NOT NULL,
  expected_driver_version BIGINT NOT NULL CHECK(expected_driver_version>0),
  expected_vehicle_version BIGINT NOT NULL CHECK(expected_vehicle_version>0),
  status TEXT NOT NULL CHECK(status IN ('PENDING','ACCEPTED','REJECTED','EXPIRED','CANCELLED')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  assignment_id UUID UNIQUE,
  trip_id UUID UNIQUE,
  reject_reason TEXT,
  closure_reason TEXT,
  CHECK ((status='PENDING')=(resolved_at IS NULL)),
  CHECK (status<>'ACCEPTED' OR trip_id IS NOT NULL)
);
CREATE UNIQUE INDEX booking_one_pending_offer ON booking_offer(booking_id) WHERE status='PENDING';
CREATE INDEX booking_offer_driver_page ON booking_offer(driver_id,sent_at DESC,trip_request_id DESC);
CREATE TABLE booking_assignment (
  assignment_id UUID PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES booking(booking_id),
  trip_request_id UUID NOT NULL UNIQUE REFERENCES booking_offer(trip_request_id),
  trip_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('CLAIMED','PREPARING','ACTIVATING','ASSIGNED',
    'COMPENSATING','COMPENSATED')),
  customer_id UUID NOT NULL,
  driver_id UUID NOT NULL,
  vehicle_id UUID NOT NULL,
  parties JSONB NOT NULL,
  guard_ref JSONB NOT NULL,
  reservation_ref JSONB,
  pickup JSONB NOT NULL,
  destination JSONB NOT NULL,
  pricing JSONB NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  offer_expires_at TIMESTAMPTZ NOT NULL,
  dispatch_deadline_at TIMESTAMPTZ NOT NULL,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  failure_reason TEXT,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (claimed_at<offer_expires_at AND claimed_at<dispatch_deadline_at)
);
CREATE UNIQUE INDEX booking_one_live_assignment ON booking_assignment(booking_id)
  WHERE state<>'COMPENSATED';
CREATE TABLE booking_outbox (
  event_id UUID PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES booking(booking_id),
  aggregate_version BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  recipient_account_id UUID NOT NULL,
  safe_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_until TIMESTAMPTZ,
  UNIQUE(booking_id,aggregate_version,event_type,recipient_account_id)
);
REVOKE ALL ON booking_operation,booking,booking_dispatch,booking_offer,
  booking_assignment,booking_outbox FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON booking_operation,booking,booking_dispatch,booking_offer,
  booking_assignment,booking_outbox TO booking_runtime;
