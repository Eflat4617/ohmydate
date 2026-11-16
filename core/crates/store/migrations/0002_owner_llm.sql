-- 0002_owner_llm.sql — the owner's AI consent and budget (05 §12, ADR-022).
--
-- 0001 reserved a JSON `settings` column for these. They are five plain
-- values, so they become columns the schema can check, and the JSON column,
-- which nothing ever wrote, goes away.
--
-- Money is INTEGER micro-dollars and instants are INTEGER milliseconds
-- (docs/blueprint/15-DESKTOP-RUST-CORE.md §3.1, §3.2). The upper bound of an
-- amount is domain::MicroUsd::MAX.

ALTER TABLE owner ADD COLUMN llm_consent_granted INTEGER
  CHECK (llm_consent_granted IN (0, 1));
ALTER TABLE owner ADD COLUMN llm_consent_at INTEGER
  CHECK (llm_consent_at BETWEEN 0 AND 253402300799999);
-- A consent record is stored whole or not at all.
ALTER TABLE owner ADD COLUMN llm_consent_provider TEXT
  CHECK (length(llm_consent_provider) BETWEEN 1 AND 64)
  CHECK ((llm_consent_granted IS NULL) = (llm_consent_at IS NULL)
     AND (llm_consent_granted IS NULL) = (llm_consent_provider IS NULL));

ALTER TABLE owner ADD COLUMN llm_budget_daily_micro_usd INTEGER
  CHECK (llm_budget_daily_micro_usd BETWEEN 0 AND 1000000000000000);
-- A budget has both limits or none.
ALTER TABLE owner ADD COLUMN llm_budget_monthly_micro_usd INTEGER
  CHECK (llm_budget_monthly_micro_usd BETWEEN 0 AND 1000000000000000)
  CHECK ((llm_budget_daily_micro_usd IS NULL) = (llm_budget_monthly_micro_usd IS NULL));

ALTER TABLE owner DROP COLUMN settings;
