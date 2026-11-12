# TASK PACKET: GU-1-PKGF — fix round 1/2 for GU-1-PKG (review GU-1-PKGR: REQUEST_CHANGES, 2 HIGH + 4 MEDIUM; plus coordinator live-verification findings C1–C4)
Role: worker (DeepSeek 4.1 Flash high). Worktree/branch: torgal/gu-1-pkg (HEAD f7dcf36) — continue on it, do NOT rebase.
Read first: docs/orchestration/reviews/GU-1-PKGR.md (`git show torgal/ohmydate:docs/orchestration/reviews/GU-1-PKGR.md` — reviewer findings 1–12 with reproductions AND the coordinator's live docker/LLM findings C1–C5 at the end), packets/GU-1-PKG.md (original scope and rules; all its rules still apply).

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, docker (not even `docker compose config`), global installs (npm -g, corepack enable), git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree (temp dirs from os.tmpdir() for tests are fine),
   printing or storing secrets, calling paid external APIs other than your own model.
   SECRETS: never read, print, copy or commit `*api_key*.txt`, `*.key.txt` or anything under deploy/secrets/ — your tests use a temporary secrets dir (env override), never the repo's deploy/secrets. Never call the real LLM gateway: all your runs use LLM_PROVIDER=fake.
3. Commit your work on your branch with Conventional Commits; include "Task: <taskId>" in the body.
4. Run every command in "Exact tests" and paste the real exit codes and tail output. Never claim a test passed
   that you did not run. If you could not run something, say SKIPPED + reason.
5. Send heartbeat if Orca's preamble asks for it.
6. Finish with EXACTLY ONE:
   orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> \
     --outcome succeeded|failed --files-modified "<csv>" --body "<report>" --json
   (if your Orca preamble gives a different exact worker_done form, the preamble wins)
REPORT (body)
- taskId, dispatchId, worktree path, branch, commit SHA(s)
- changed paths (git diff --name-only <base>...HEAD) and 3–8 line diff summary
- requirement checklist: each acceptance item -> met / not met
- tests: command -> exit code -> key output lines
- risks, unverified items (docker/real LLM are coordinator-only), rollback method

HOST LOAD RULE: before the full `pnpm run ci`, send `orca orchestration ask` ("ready for full ci") and wait for the go.

ALLOWED PATHS: the original GU-1-PKG allowed paths (deploy/local/**, scripts/local/**, root package.json scripts, .gitignore) PLUS services/api/src/cli/create-user.ts + its test under services/api/test/** (optional --time-zone / --locale flags only).
REQUIRED (each with a test that fails on f7dcf36 where testable without docker)
1) [HIGH, review 1] PID identity: store an identity with each PID (e.g. /proc/<pid>/stat start time + expected cmdline, or a random marker passed to the child as an env var/arg) and verify it in stop.mjs AND start.mjs before signalling or treating the process as running; on mismatch the file is stale: delete it, never signal. Never signal the process group unless the group leader identity matches. Remove pid files when start fails. Negative tests: a foreign live PID (e.g. a `sleep` you spawn) in the pid file is neither signalled nor reported as running; a dead PID is cleaned up.
2) [HIGH, review 2] Target isolation: setup/start/status/stop ignore the generic DATABASE_URL / VIKUNJA_URL; only dedicated overrides (OHMYDATE_LOCAL_DATABASE_URL / OHMYDATE_LOCAL_VIKUNJA_URL) change the target (the smoke sets these from DATABASE_URL/VIKUNJA_URL). Print the resolved target host:port/db (never the password) in setup, start and status. Test: ambient DATABASE_URL/VIKUNJA_URL do not change the target (replace the assertion in args.test.mjs that says the opposite — this is a requirement change, not test weakening; say so in the report).
3) [HIGH, coordinator C1] Compose under `sudo`: no `${HOME}` and no host bind mount for Vikunja files — use a named volume (`vikunja-files`) like pgdata, so ownership comes from the image and sudo's HOME does not matter. Add `scripts/local/stack.mjs`-style wrapper `pnpm local:stack <up|down|ps|logs>` that prints and runs `sudo docker compose -p ohmydate-local --env-file deploy/local/local.env -f deploy/local/compose.yaml ...` with absolute paths resolved from the repo root (so cwd does not matter); `down` never passes -v; `--dry-run` prints the command without running it (this is what your tests use — you must not run docker). README: first-time order uses local:stack.
4) [MEDIUM, coordinator C2] Setup sets the new planner user's timeZone from the system (Intl.DateTimeFormat().resolvedOptions().timeZone, validated as IANA; Korean prompt shows it as the default and lets the user change it) and locale ko-KR — via new optional create-user flags `--time-zone` / `--locale` (validated; existing behaviour unchanged without them; unit test). Existing users are not modified on re-run.
5) [MEDIUM, review 3] --rotate-token: write both token and meta files atomically (0600 temp file in the same dir, fsync, rename); record the Vikunja token id in the meta file and delete the previous token on Vikunja after the new file is in place; create the token only after create-user/owner upsert succeeded (or revoke it on failure); print "local:stop 후 local:start 로 재시작하세요". Test with the smoke (--rotate-token: old token -> 401, new -> 200, file replaced atomically).
6) [MEDIUM, review 4] Key file mode: in non-fake mode the preflight refuses when mode & 077 != 0 (Korean message with the exact `chmod 600 <path>`); during the health wait detect that a child exited and print the last API log line instead of waiting 60 s; on failure stop the other child and remove pid files. Update the preflight unit test accordingly + a CLI-level negative (fake key file 0644 in a temp dir, production mode, no LLM call).
7) [MEDIUM, review 5] Stale build: if a rebuild happened (or the running process started before the build output) restart it, or exit non-zero telling the user to run local:stop first; add packages/ui-policy/src and apps/web/public to webSources (and any other workspace dep the web bundles from source); write a build stamp after the whole build succeeds and compare against it. Tests for needsBuild.
8) [MEDIUM, review 6] status/setup/start never print parser/error text that can contain file content: fixed messages for malformed token/meta/secret files; test with a malformed file containing a marker token (marker absent from stdout/stderr).
9) [LOW, do it] review 7 (check stack health before prompting; README step 1 = `node scripts/local/secrets.mjs init` via a `local:secrets` script), review 8 (--email interactive), review 9 (validate a retained token with GET /user; re-issue if dead), review 10 (log files 0600; size-capped rotation also while running is optional — at least cap at start), review 11 (drop VIKUNJA_RATELIMIT_NOAUTHLIMIT; give postgres only the vars it needs — split stack.env into postgres.env / vikunja.env if simple; use ${VIKUNJA_PORT} consistently in PUBLICURL), review 12 (stop timeout 20 s; print effective NODE_ENV/LLM_PROVIDER), coordinator C4 (children get an allowlisted env, not the whole parent env).
10) Secrets/state location: keep deploy/secrets/local/ (AGENTS.md secret path) but make README state clearly that this directory and the `ohmydate-local` volumes are a pair (losing the dir locks out the DB) and must be backed up together; status warns if the secrets dir is missing while the stack volume exists.
Exact tests (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 — the smoke maps them to the OHMYDATE_LOCAL_* overrides): pnpm run lint ; pnpm run test:local ; pnpm --filter @ohmydate/api test ; pnpm run check:boundaries ; then (after the coordinator's go) pnpm run ci. Commit (Task trailer), clean git status, worker_done.
Retry limit: this is round 1 of 2 (a HIGH after round 2 -> BLOCKED -> Fable breakthrough). Rollback: revert the fix commit(s).
