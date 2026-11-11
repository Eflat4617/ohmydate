-- 0014_agent_run_cancelled.down.sql — rollback for 0014.
--
-- The pre-0014 CHECK has no 'cancelled'. Cancelled runs are kept (with their
-- cost and tokens) as 'failed', the closest pre-0014 terminal status, before
-- the original CHECK is restored.

UPDATE agent_run
   SET status = 'failed',
       updated_at = now(),
       version = version + 1
 WHERE status = 'cancelled';
ALTER TABLE agent_run DROP CONSTRAINT agent_run_status_valid;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_status_valid
  CHECK (status IN ('pending', 'succeeded', 'failed', 'budget_exceeded'));
