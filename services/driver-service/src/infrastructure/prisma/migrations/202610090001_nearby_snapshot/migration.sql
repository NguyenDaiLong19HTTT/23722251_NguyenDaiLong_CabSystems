-- Driver-owned short public search snapshot. No exact coordinates or user token stored.
BEGIN;
CREATE TABLE nearby_search_snapshot (
  search_id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  params_digest BYTEA NOT NULL CHECK (octet_length(params_digest)=32),
  items JSONB NOT NULL CHECK (jsonb_typeof(items)='array'),
  snapshot_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at>snapshot_at)
);
CREATE TABLE nearby_page_cursor (
  token_digest BYTEA PRIMARY KEY CHECK (octet_length(token_digest)=32),
  search_id UUID NOT NULL REFERENCES nearby_search_snapshot(search_id) ON DELETE RESTRICT,
  page_offset INTEGER NOT NULL CHECK (page_offset>=1)
);
CREATE INDEX nearby_search_expiry ON nearby_search_snapshot(expires_at);
REVOKE ALL ON nearby_search_snapshot,nearby_page_cursor FROM PUBLIC;
GRANT SELECT,INSERT ON nearby_search_snapshot,nearby_page_cursor TO driver_runtime;
COMMIT;
