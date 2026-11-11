-- 0011_llm_spend.sql — FU-52R owner-scoped reservation ledger for paid LLM calls.
--
-- Every provider attempt reserves a conservative cost bound before any network
-- call, then settles with actual usage (or the reservation on timeout/unpriced
-- responses). A settled row keeps its charge even when the call failed or
-- overran the owner's day/month cap. Forward-only; rollback in the down file.

CREATE TABLE llm_spend (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "user" (id),
  agent_run_id uuid,
  purpose text NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  reserved_usd numeric NOT NULL,
  actual_usd numeric,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cached_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  settle_reason text,
  CONSTRAINT llm_spend_state_valid CHECK (state IN ('reserved', 'settled', 'released')),
  CONSTRAINT llm_spend_settle_reason_valid CHECK (
    settle_reason IS NULL
    OR settle_reason IN ('actual', 'reserved_fallback', 'recovered')
  ),
  CONSTRAINT llm_spend_purpose_present CHECK (char_length(purpose) BETWEEN 1 AND 200),
  CONSTRAINT llm_spend_reserved_non_negative CHECK (reserved_usd >= 0),
  CONSTRAINT llm_spend_actual_non_negative CHECK (actual_usd IS NULL OR actual_usd >= 0),
  CONSTRAINT llm_spend_tokens_non_negative CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND cached_tokens >= 0
  ),
  CONSTRAINT llm_spend_cached_le_input CHECK (cached_tokens <= input_tokens),
  CONSTRAINT llm_spend_settled_consistent CHECK (
    (state = 'settled') = (settled_at IS NOT NULL)
  ),
  CONSTRAINT llm_spend_settled_reason_consistent CHECK (
    (state = 'settled') = (settle_reason IS NOT NULL)
  )
);

CREATE INDEX llm_spend_owner_created_idx ON llm_spend (owner_id, created_at);
CREATE INDEX llm_spend_owner_state_idx ON llm_spend (owner_id, state);
