-- New Payment-owned database only. Run as payment_migration, never at app boot.
CREATE TABLE pricing_config (
  pricing_version_id UUID PRIMARY KEY,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type='MOTORBIKE'),
  currency TEXT NOT NULL CHECK (currency='VND'),
  base_fare NUMERIC(18,6) NOT NULL CHECK (base_fare=0),
  price_per_km NUMERIC(18,6) NOT NULL CHECK (price_per_km=5300),
  price_per_minute NUMERIC(18,6) NOT NULL CHECK (price_per_minute=0),
  effective_from TIMESTAMPTZ NOT NULL,
  UNIQUE(vehicle_type,effective_from)
);
CREATE TABLE demo_route (
  route_id UUID PRIMARY KEY,
  route_version BIGINT NOT NULL CHECK(route_version>0),
  pickup_latitude DOUBLE PRECISION NOT NULL CHECK(pickup_latitude BETWEEN -90 AND 90),
  pickup_longitude DOUBLE PRECISION NOT NULL CHECK(pickup_longitude BETWEEN -180 AND 180),
  destination_latitude DOUBLE PRECISION NOT NULL CHECK(destination_latitude BETWEEN -90 AND 90),
  destination_longitude DOUBLE PRECISION NOT NULL CHECK(destination_longitude BETWEEN -180 AND 180),
  distance_meters BIGINT NOT NULL CHECK(distance_meters>0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(pickup_latitude,pickup_longitude,destination_latitude,destination_longitude,route_version)
);
CREATE TABLE pricing_capture (
  operation_id UUID PRIMARY KEY,
  request_digest BYTEA NOT NULL CHECK(octet_length(request_digest)=32),
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  accepted_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE fare (
  fare_id UUID PRIMARY KEY,
  trip_id UUID NOT NULL UNIQUE,
  booking_id UUID NOT NULL UNIQUE,
  customer_id UUID NOT NULL,
  driver_id UUID NOT NULL,
  customer_account_id UUID NOT NULL,
  driver_account_id UUID NOT NULL,
  pricing_version_id UUID NOT NULL,
  route_id UUID NOT NULL,
  route_version BIGINT NOT NULL CHECK(route_version>0),
  distance_meters BIGINT NOT NULL CHECK(distance_meters>0),
  amount_vnd BIGINT NOT NULL CHECK(amount_vnd>=0),
  pricing_snapshot JSONB NOT NULL CHECK(jsonb_typeof(pricing_snapshot)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE payment (
  payment_id UUID PRIMARY KEY,
  fare_id UUID NOT NULL UNIQUE REFERENCES fare(fare_id),
  trip_id UUID NOT NULL UNIQUE,
  customer_id UUID NOT NULL,
  driver_id UUID NOT NULL,
  customer_account_id UUID NOT NULL,
  driver_account_id UUID NOT NULL,
  amount_vnd BIGINT NOT NULL CHECK(amount_vnd>=0),
  currency TEXT NOT NULL CHECK(currency='VND'),
  method TEXT NOT NULL CHECK(method IN ('CASH','DEMO_TRANSFER')),
  status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','SUCCESS','FAILED','UNKNOWN')),
  version BIGINT NOT NULL CHECK(version>0),
  current_attempt_id UUID NOT NULL,
  requires_review BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at TIMESTAMPTZ,
  confirmed_by_account_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status='SUCCESS')=(paid_at IS NOT NULL))
);
CREATE TABLE payment_attempt (
  attempt_id UUID PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES payment(payment_id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
  method TEXT NOT NULL CHECK(method IN ('CASH','DEMO_TRANSFER')),
  status TEXT NOT NULL CHECK(status IN ('PENDING','SUCCESS','FAILED','UNKNOWN')),
  amount_vnd BIGINT NOT NULL CHECK(amount_vnd>=0),
  merchant_reference UUID UNIQUE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(payment_id,attempt_number)
);
ALTER TABLE payment ADD CONSTRAINT payment_current_attempt_fk
  FOREIGN KEY (current_attempt_id) REFERENCES payment_attempt(attempt_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE payment_receipt (
  receipt_id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  operation TEXT NOT NULL,
  resource_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  request_digest BYTEA NOT NULL CHECK(octet_length(request_digest)=32),
  http_status INTEGER NOT NULL,
  response_snapshot JSONB NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id,operation,resource_id,idempotency_key)
);
CREATE TABLE payment_outbox (
  event_id UUID PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES payment(payment_id),
  aggregate_version BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  safe_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_until TIMESTAMPTZ,
  UNIQUE(payment_id,aggregate_version,event_type)
);
INSERT INTO pricing_config(pricing_version_id,vehicle_type,currency,base_fare,price_per_km,price_per_minute,effective_from)
VALUES('9b0e6744-86bf-4a63-8e13-23e8e35f78e0','MOTORBIKE','VND',0,5300,0,'2026-01-01T00:00:00Z');
-- Server-owned demo route, not a map distance: 1250 m -> 6625 VND.
INSERT INTO demo_route(route_id,route_version,pickup_latitude,pickup_longitude,destination_latitude,destination_longitude,distance_meters)
VALUES('57240a8d-9114-4d1d-986f-90814e0eec8b',1,10.7769,106.7009,10.7869,106.7109,1250);
REVOKE ALL ON pricing_config,demo_route,pricing_capture,fare,payment,payment_attempt,payment_receipt,payment_outbox FROM PUBLIC;
GRANT SELECT ON pricing_config,demo_route TO payment_runtime;
GRANT SELECT,INSERT ON pricing_capture TO payment_runtime;
GRANT SELECT,INSERT ON fare,payment,payment_attempt,payment_receipt,payment_outbox TO payment_runtime;
GRANT UPDATE ON payment,payment_attempt,payment_outbox TO payment_runtime;
