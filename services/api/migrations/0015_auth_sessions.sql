-- 0015_auth_sessions.sql — FU-92: login sessions survive API restarts.
--
-- One row per signed-in browser session (cookie `sid` + double-submit `csrf`).
-- Neither secret is stored: `id_hash` and `csrf_token_hash` are lowercase hex
-- SHA-256 digests of the raw cookie values (both 256-bit random), so a read of
-- this table cannot be replayed as a cookie. The application looks a session
-- up by the digest of the presented `sid` and compares the CSRF digest in
-- constant time.
--
-- Timestamps come from the application clock (Clock port): `expires_at` is the
-- sliding 14-day deadline (SESSION_TTL_MS), refreshed at most once a minute
-- together with `last_seen_at`. No ordering CHECK ties the timestamps together
-- because a restarted process may run with a different clock. Expired rows are
-- rejected on read and swept in batches (expires_at index). Deleting a user
-- deletes their sessions. Forward-only; rollback in the down file.

CREATE TABLE auth_session (
  id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  csrf_token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT auth_session_id_hash_sha256 CHECK (id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_session_csrf_token_hash_sha256 CHECK (csrf_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX auth_session_expires_at_idx ON auth_session (expires_at);
CREATE INDEX auth_session_user_id_idx ON auth_session (user_id);
