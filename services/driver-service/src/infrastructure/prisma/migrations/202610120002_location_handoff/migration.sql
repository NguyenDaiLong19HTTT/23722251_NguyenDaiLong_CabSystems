-- Runtime may acknowledge a durably handed-off sample; coordinates remain immutable.
GRANT UPDATE (handoff_state) ON driver_location_sample TO driver_runtime;
