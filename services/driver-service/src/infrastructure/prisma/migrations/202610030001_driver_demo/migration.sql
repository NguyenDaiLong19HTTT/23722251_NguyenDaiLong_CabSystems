-- Driver-owned demo slice. No cross-database FK or migration-time seed.
BEGIN;
CREATE TABLE driver_profile (
  driver_id UUID PRIMARY KEY,
  account_id UUID NOT NULL UNIQUE,
  license_ciphertext BYTEA NOT NULL,
  license_nonce BYTEA NOT NULL CHECK (octet_length(license_nonce)=12),
  license_tag BYTEA NOT NULL CHECK (octet_length(license_tag)=16),
  license_key_version TEXT NOT NULL,
  license_lookup_hmac BYTEA NOT NULL UNIQUE CHECK (octet_length(license_lookup_hmac)=32),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('PENDING_APPROVAL','APPROVED','REJECTED')),
  driver_status TEXT NOT NULL CHECK (driver_status IN ('AVAILABLE','BUSY','OFFLINE')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE vehicle (
  vehicle_id UUID PRIMARY KEY,
  plate_number TEXT NOT NULL CHECK (length(btrim(plate_number))>0),
  plate_key TEXT NOT NULL UNIQUE,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('STANDARD','PREMIUM','MOTORBIKE','VAN')),
  vehicle_status TEXT NOT NULL CHECK (vehicle_status IN ('ACTIVE','INACTIVE')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE vehicle_assignment (
  assignment_id UUID PRIMARY KEY,
  driver_id UUID NOT NULL REFERENCES driver_profile(driver_id) ON DELETE RESTRICT,
  vehicle_id UUID NOT NULL REFERENCES vehicle(vehicle_id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  CHECK (ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX one_current_vehicle_per_driver ON vehicle_assignment(driver_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX one_current_driver_per_vehicle ON vehicle_assignment(vehicle_id) WHERE ended_at IS NULL;
CREATE TABLE availability_receipt (
  receipt_id UUID PRIMARY KEY,
  driver_id UUID NOT NULL REFERENCES driver_profile(driver_id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(128) NOT NULL,
  expected_version BIGINT NOT NULL CHECK (expected_version>=1),
  requested_status TEXT NOT NULL CHECK (requested_status IN ('AVAILABLE','OFFLINE')),
  result_json JSONB NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(driver_id,idempotency_key)
);
CREATE TABLE driver_location (
  driver_id UUID PRIMARY KEY REFERENCES driver_profile(driver_id) ON DELETE RESTRICT,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE driver_location_sample (
  sample_id UUID PRIMARY KEY,
  driver_id UUID NOT NULL REFERENCES driver_profile(driver_id) ON DELETE RESTRICT,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  handoff_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (handoff_state IN ('PENDING','SENT')),
  UNIQUE(driver_id,recorded_at)
);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT,INSERT ON driver_profile,vehicle,vehicle_assignment,availability_receipt,
  driver_location,driver_location_sample TO driver_runtime;
GRANT UPDATE (driver_status,version,updated_at) ON driver_profile TO driver_runtime;
GRANT UPDATE (latitude,longitude,recorded_at,received_at) ON driver_location TO driver_runtime;
COMMIT;
