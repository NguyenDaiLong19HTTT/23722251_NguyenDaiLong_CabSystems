-- PostgreSQL SELECT ... FOR UPDATE requires UPDATE privilege on locked tables.
-- Keep Driver V1 immutable; grant only columns owned by later Driver workflows.
BEGIN;
GRANT UPDATE (ended_at) ON vehicle_assignment TO driver_runtime;
GRANT UPDATE (vehicle_status,version,updated_at) ON vehicle TO driver_runtime;
COMMIT;
