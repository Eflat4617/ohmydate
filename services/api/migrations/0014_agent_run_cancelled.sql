-- 0014_agent_run_cancelled.sql — FU-76: an aborted AI run is `cancelled`.
--
-- A run the user cancels (POST /intake-sessions/{id}:manual while the AI call
-- is in flight) or that graceful shutdown aborts is recorded with
-- status = 'cancelled' and the charge its spend reservation settled at. A run
-- left `pending` by a crash is swept to `cancelled` once it is older than the
-- intake AI request bound. Only the status CHECK changes; no column or row is
-- touched. Forward-only with a separate down script.

ALTER TABLE agent_run DROP CONSTRAINT agent_run_status_valid;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_status_valid
  CHECK (status IN ('pending', 'succeeded', 'failed', 'budget_exceeded', 'cancelled'));
