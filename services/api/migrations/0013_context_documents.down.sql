-- 0013_context_documents.down.sql — rollback for 0013.
--
-- Drops only the M6 notes objects added by 0013 (usage audit first, then links,
-- then documents). agent_run rows referenced by note_ai_usage stay (0005 owns
-- them).

DROP TABLE IF EXISTS note_ai_usage;
DROP TABLE IF EXISTS document_link;
DROP TABLE IF EXISTS context_document;
