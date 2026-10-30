CREATE TABLE rating (
  rating_id UUID PRIMARY KEY,
  trip_id UUID NOT NULL UNIQUE,
  customer_id UUID NOT NULL,
  driver_id UUID NOT NULL,
  score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR (length(comment) BETWEEN 1 AND 1000 AND comment=btrim(comment))),
  trip_version BIGINT NOT NULL CHECK (trip_version>0),
  trip_verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rating_driver_page ON rating(driver_id,created_at DESC,rating_id DESC);
CREATE INDEX rating_operations_page ON rating(created_at DESC,rating_id DESC);
CREATE TABLE rating_receipt (
  command_id UUID PRIMARY KEY,
  trip_id UUID NOT NULL REFERENCES rating(trip_id),
  request_digest BYTEA NOT NULL CHECK (octet_length(request_digest)=32),
  rating_id UUID NOT NULL REFERENCES rating(rating_id),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE rating_audit (
  audit_id UUID PRIMARY KEY,
  rating_id UUID NOT NULL UNIQUE REFERENCES rating(rating_id),
  trip_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  trip_version BIGINT NOT NULL,
  trip_verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT ON rating,rating_receipt,rating_audit TO rating_runtime;
