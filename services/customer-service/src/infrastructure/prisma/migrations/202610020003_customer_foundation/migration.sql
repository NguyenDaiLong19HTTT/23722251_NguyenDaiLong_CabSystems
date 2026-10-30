-- Production Customer V1. Tombstone uniqueness is unconditional and permanent for MVP.
BEGIN;
CREATE TABLE customer_provision (
  operation_id VARCHAR(128) PRIMARY KEY CHECK (length(btrim(operation_id)) > 0),
  account_id UUID NOT NULL UNIQUE,
  customer_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PROVISIONED','PROVISION_CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT provision_cancel_time CHECK ((state = 'PROVISION_CANCELLED') = (cancelled_at IS NOT NULL)),
  CONSTRAINT provision_binding UNIQUE (operation_id,account_id,customer_id)
);
CREATE TABLE customer (
  customer_id UUID PRIMARY KEY,
  account_id UUID NOT NULL UNIQUE,
  provision_operation_id VARCHAR(128) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT customer_binding UNIQUE (provision_operation_id,account_id,customer_id),
  CONSTRAINT customer_provision_binding FOREIGN KEY (provision_operation_id,account_id,customer_id)
    REFERENCES customer_provision(operation_id,account_id,customer_id) ON DELETE RESTRICT
);
CREATE TABLE customer_rpc_receipt (
  receipt_id UUID PRIMARY KEY,
  caller_service TEXT NOT NULL CHECK (length(btrim(caller_service)) > 0),
  full_method TEXT NOT NULL CHECK (full_method IN
    ('/cab.internal.v1.CustomerInternalService/ProvisionCustomer',
     '/cab.internal.v1.CustomerInternalService/CancelCustomerProvision')),
  command_id UUID NOT NULL,
  operation_id VARCHAR(128) NOT NULL,
  fingerprint_hmac BYTEA NOT NULL CHECK (octet_length(fingerprint_hmac) = 32),
  fingerprint_key_version TEXT NOT NULL CHECK (length(fingerprint_key_version) > 0),
  result_operation_id VARCHAR(128) NOT NULL,
  result_account_id UUID NOT NULL,
  result_customer_id UUID NOT NULL,
  result_state TEXT NOT NULL CHECK (result_state IN ('PROVISIONED','PROVISION_CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT receipt_command UNIQUE (caller_service,full_method,command_id),
  CONSTRAINT receipt_result_operation CHECK (result_operation_id = operation_id),
  CONSTRAINT receipt_method_state CHECK (
    (full_method = '/cab.internal.v1.CustomerInternalService/ProvisionCustomer' AND result_state = 'PROVISIONED')
    OR (full_method = '/cab.internal.v1.CustomerInternalService/CancelCustomerProvision' AND result_state = 'PROVISION_CANCELLED')),
  CONSTRAINT receipt_provision_binding FOREIGN KEY (operation_id,result_account_id,result_customer_id)
    REFERENCES customer_provision(operation_id,account_id,customer_id) ON DELETE RESTRICT
);
CREATE INDEX customer_receipt_operation_idx ON customer_rpc_receipt(operation_id,created_at);
CREATE TABLE customer_audit (
  audit_id UUID PRIMARY KEY,
  operation_id VARCHAR(128), customer_id UUID,
  action TEXT NOT NULL CHECK (action IN ('PROVISIONED','PROVISION_CANCELLED')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id TEXT, safe_detail JSONB
);
CREATE INDEX customer_audit_operation_idx ON customer_audit(operation_id,occurred_at);
CREATE INDEX customer_audit_customer_idx ON customer_audit(customer_id,occurred_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON customer_provision,customer,customer_rpc_receipt,
  customer_audit TO customer_runtime;
COMMIT;
