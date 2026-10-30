-- Technical probe only, owned and migrated by customer_migration.
-- No cross-service FK or Account/Customer/business entity.
CREATE TABLE probe_business (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  amount NUMERIC(30,12) NOT NULL
);
CREATE TABLE probe_outbox (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES probe_business(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  payload TEXT NOT NULL
);
CREATE TABLE probe_active_right (
  id UUID PRIMARY KEY,
  resource_id UUID NOT NULL,
  active BOOLEAN NOT NULL
);
-- PostgreSQL enforces the active predicate including concurrent inserts.
CREATE UNIQUE INDEX probe_one_active_resource
  ON probe_active_right(resource_id) WHERE active = TRUE;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  probe_business, probe_outbox, probe_active_right TO customer_runtime;
