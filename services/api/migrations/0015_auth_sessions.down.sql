-- 0015_auth_sessions.down.sql — rollback for 0015.
--
-- Drops the persisted login sessions (and their indexes). Every signed-in
-- browser has to log in again; no other table references auth_session.

DROP TABLE IF EXISTS auth_session;
