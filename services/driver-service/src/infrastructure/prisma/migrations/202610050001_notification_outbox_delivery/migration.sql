BEGIN;
ALTER TABLE driver_application_outbox
  ADD COLUMN published_at TIMESTAMPTZ,
  ADD COLUMN claim_until TIMESTAMPTZ,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX driver_application_outbox_pending_idx
  ON driver_application_outbox(next_attempt_at,created_at,event_id)
  WHERE published_at IS NULL;
GRANT UPDATE (published_at,claim_until,attempts,next_attempt_at)
  ON driver_application_outbox TO driver_runtime;
COMMIT;
