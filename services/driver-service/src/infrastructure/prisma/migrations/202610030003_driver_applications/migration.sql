-- DriverApplication is Driver-owned; demo seeded approved Drivers remain unchanged.
BEGIN;
ALTER TABLE driver_profile ADD COLUMN rejection_reason TEXT;
ALTER TABLE driver_profile ADD CONSTRAINT driver_rejection_pair CHECK
  ((approval_status='REJECTED')=(rejection_reason IS NOT NULL));
CREATE TABLE driver_application (
  application_id UUID PRIMARY KEY,
  account_id UUID NOT NULL UNIQUE,
  driver_id UUID NOT NULL UNIQUE REFERENCES driver_profile(driver_id) ON DELETE RESTRICT,
  operation_id UUID NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  snapshot_ciphertext BYTEA NOT NULL, snapshot_nonce BYTEA NOT NULL,
  snapshot_tag BYTEA NOT NULL, snapshot_key_version TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version>=1),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by_account_id UUID,
  rejection_reason TEXT,
  approved_vehicle_id UUID REFERENCES vehicle(vehicle_id) ON DELETE RESTRICT,
  CHECK ((status='SUBMITTED' AND reviewed_at IS NULL AND reviewed_by_account_id IS NULL
      AND rejection_reason IS NULL AND approved_vehicle_id IS NULL)
    OR (status='APPROVED' AND reviewed_at IS NOT NULL AND reviewed_by_account_id IS NOT NULL
      AND rejection_reason IS NULL AND approved_vehicle_id IS NOT NULL)
    OR (status='REJECTED' AND reviewed_at IS NOT NULL AND reviewed_by_account_id IS NOT NULL
      AND rejection_reason IS NOT NULL AND approved_vehicle_id IS NULL))
);
CREATE INDEX driver_application_page ON driver_application(status,submitted_at DESC,application_id DESC);
CREATE TABLE driver_provision_receipt (
  operation_id UUID PRIMARY KEY,
  command_id UUID NOT NULL UNIQUE,
  account_id UUID NOT NULL UNIQUE,
  driver_id UUID NOT NULL UNIQUE,
  application_id UUID NOT NULL UNIQUE,
  payload_digest BYTEA NOT NULL CHECK (octet_length(payload_digest)=32),
  state TEXT NOT NULL CHECK (state IN ('DRIVER_PROVISIONED','DRIVER_PROVISION_CANCELLED')),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE driver_review_receipt (
  receipt_id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES driver_application(application_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest BYTEA NOT NULL CHECK (octet_length(request_digest)=32),
  result_ciphertext BYTEA NOT NULL, result_nonce BYTEA NOT NULL,
  result_tag BYTEA NOT NULL, result_key_version TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(application_id,idempotency_key)
);
CREATE TABLE driver_application_outbox (
  event_id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES driver_application(application_id) ON DELETE RESTRICT,
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version>=1),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('DRIVER_APPLICATION_SUBMITTED','DRIVER_APPLICATION_APPROVED','DRIVER_APPLICATION_REJECTED')),
  safe_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(application_id,aggregate_version,event_type)
);
CREATE TABLE driver_application_audit (
  audit_id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES driver_application(application_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('SUBMITTED','APPROVED','REJECTED')),
  actor_account_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON driver_application,driver_provision_receipt,driver_review_receipt,
  driver_application_outbox,driver_application_audit FROM PUBLIC;
GRANT SELECT,INSERT ON driver_application,driver_provision_receipt,driver_review_receipt,
  driver_application_outbox,driver_application_audit TO driver_runtime;
GRANT UPDATE (status,version,updated_at,reviewed_at,reviewed_by_account_id,rejection_reason,approved_vehicle_id)
  ON driver_application TO driver_runtime;
GRANT UPDATE (rejection_reason,approval_status,version,updated_at) ON driver_profile TO driver_runtime;
COMMIT;
