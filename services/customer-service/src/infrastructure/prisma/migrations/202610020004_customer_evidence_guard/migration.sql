-- Forward-only Customer evidence protection. V1 remains immutable.
BEGIN;
CREATE FUNCTION guard_customer_provision_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer provision tombstone cannot be deleted';
  END IF;
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer provision binding is immutable';
  END IF;
  IF OLD.state = 'PROVISION_CANCELLED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'cancelled customer provision is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_provision_evidence_guard BEFORE UPDATE OR DELETE ON customer_provision
  FOR EACH ROW EXECUTE FUNCTION guard_customer_provision_evidence();

REVOKE UPDATE,DELETE ON customer_provision,customer,customer_rpc_receipt,customer_audit
  FROM customer_runtime;
GRANT UPDATE (updated_at,version) ON customer TO customer_runtime;
GRANT DELETE ON customer TO customer_runtime; -- only a non-completed profile may be cancelled by protocol
GRANT UPDATE (state,updated_at,cancelled_at,version) ON customer_provision TO customer_runtime;
-- Receipt and audit are append-only. Provision/tombstone has no runtime DELETE.
COMMIT;
