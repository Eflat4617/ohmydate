# GU-1-PKGR2 (ctx_dadd11087246, Fable 5.2 xhigh — Sol weekly limit; implementer DeepSeek + coordinator e05189e) — APPROVE (round 2)

REVIEW VERDICT: APPROVE
Target: torgal/ohmydate...e05189e (30 files, +3788/-5; fix round d3786f6 + coordinator commit e05189e on f7dcf36). Reviewer: Fable 5.2 xhigh (in place of Sol). All changed paths are inside ALLOWED PATHS (deploy/local/**, scripts/local/**, root package.json scripts, .gitignore, services/api/src/cli/create-user.ts + services/api/test/create-user-args.test.ts). Both commits are Conventional Commits with "Task: task_c689935cb301". No dependency, lockfile, contract or migration change. No test deleted or skipped (24 -> 41 tests).
No HIGH remains. Every round-1 HIGH and MEDIUM is fixed and was re-verified by my own reproduction, not by reading only. The findings below are new, none is a regression of a round-1 item, and none blocks GU-1; they are follow-ups.

Round-1 items, re-verified:
  1 PID identity (HIGH): FIXED. stop.mjs against a set of pid-file variants (round-1 bare PID of a live `setsid sleep`, JSON with wrong marker, wrong marker + correct startTime, no marker, empty marker, pid 0 / -1 / 1, string pid, array, non-JSON, dead PID, right marker + wrong startTime): never signalled, reported "오래된 PID 파일을 지웠습니다 … 신호를 보내지 않음", file removed, foreign process alive every time; positive control (matching marker + startTime) is stopped. start.mjs with a foreign live PID in api.pid/web.pid and with a dead PID: not treated as running, fresh API/web spawned, healthz 200, the foreign sleep still alive after local:stop.
  2 Target isolation (HIGH): FIXED. With DATABASE_URL (dev planner_test) and VIKUNJA_URL exported: status/setup/start resolved 127.0.0.1:55442/planner + :3466 (or my dead local port) and failed with the stack-down message; planner_test got no row; only OHMYDATE_LOCAL_DATABASE_URL / OHMYDATE_LOCAL_VIKUNJA_URL changed the target; the API child's VIKUNJA_URL came from the dedicated override while the ambient one pointed elsewhere. setup, start and status print "대상: PostgreSQL host:port/db · Vikunja url" with no password.
  C1 sudo/HOME (HIGH): FIXED by reading + dry-run (docker not run; the coordinator's live run is the evidence). No ${HOME} and no host bind mount; pgdata and vikunja-files are named volumes; wrapper argv = sudo docker compose -p ohmydate-local --env-file <abs>/deploy/local/local.env -f <abs>/deploy/local/compose.yaml …, identical from cwd /. e05189e: vikunja-files-init reuses the digest-pinned postgres image, runs as 0:0 only for `chown 1000:0 /files && chmod 0750 /files` (non-recursive, idempotent on every up), has no env_file, restart "no"; vikunja waits on service_completed_successfully. No test spawns sudo (tests use --dry-run / the pure composeInvocation), so a password prompt cannot hang them.
  3 Rotation (MEDIUM): FIXED. temp 0600 + fsync + rename + dir fsync; after --rotate-token old token -> 401, new -> 200, no temp file left, files 0600, restart hint printed; token is created only after create-user + owner upsert. A dead retained token is re-issued and the recorded previous id revoked (old 401 / new 200).
  4 Key mode / child exit (MEDIUM): FIXED. Production mode with the key at 644/640/604/660: exit 1 in 0.1 s with "chmod 600 <path>". Child exit during the health wait: invalid push.key -> exit 1 in 1.9 s with the API's last log line; API port taken -> 4.7 s "listen EADDRINUSE"; web port taken -> 4.8 s; in all three the pid files were removed and the other child stopped (no listener left).
  5 Stale build (MEDIUM): FIXED. Stamp written after the whole build; webSources include packages/ui-policy/src and apps/web/public; `start --rebuild` while running -> exit 1 "local:stop 후 다시 local:start"; pid record older than the stamp -> exit 1 "현재 빌드보다 오래되었습니다"; processes untouched in both.
  6 Fixed messages (MEDIUM): FIXED. Marker token in a malformed token file, meta file and postgres.env: absent from status, start and setup-reader output.
  LOW 7-12, C2, C4: done. Stack is checked before any prompt and --email works with an interactive password (driven through a pty: password not echoed, zone prompt shows [Asia/Seoul], typed Asia/Tokyo stored); logs/pid files 0600 in 0700 dirs; NOAUTHLIMIT removed, env split into postgres.env / vikunja.env, ${VIKUNJA_PORT} in PUBLICURL; stop timeout 20 s; effective NODE_ENV/LLM_PROVIDER printed. Child env (names read from /proc/<pid>/environ): API = HOST PORT NODE_ENV PROVIDER DATABASE_URL VIKUNJA_URL VIKUNJA_TOKEN_FILE VIKUNJA_SECRETS_DIR PUSH_KEY_FILE LLM_SESSION_SECRET_FILE LLM_API_KEY_FILE LLM_PROVIDER/BASE_URL/MODEL/REASONING_EFFORT/budgets LOG_LEVEL + PATH/HOME/locale basics; web = OHMYDATE_API_PROXY_TARGET VITE_MOCK + basics; three fake shell secrets (UNRELATED_TOKEN, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY) reached neither child. Production boot with that env and a fake 0600 key: healthz 200, login through the preview proxy 204, status all 정상. New user: time_zone Asia/Seoul, locale ko-KR; re-run with another zone/locale (env, flag and interactive) leaves the row untouched.
  Reversed assertions are requirements, not loosening: args.test.mjs "ambient DATABASE_URL / VIKUNJA_URL never redirect" is GU-1-PKGF requirement 2 verbatim; preflight.test.mjs "warns" -> "refuses" is requirement 6.

Findings (most severe first):

  [MEDIUM] `local:stack … --dry-run <arg>` runs the real `sudo docker compose`; `--` pass-through loses arguments
    Evidence: scripts/local/compose.mjs:88,104 with scripts/local/common.mjs:177-181 (parseFlags gives a flag the next token as its value unless it starts with "--"). Repro with a harmless `sudo` shim on a PATH that contains only the shim (real sudo/docker never ran): `compose.mjs down --dry-run -v`, `up --dry-run -d` and `logs --dry-run vikunja` printed no "(--dry-run: docker를 실행하지 않았습니다)" line and the shim recorded `docker compose … down`, `… up -d`, `… logs --tail 200`. Only `--dry-run` last or directly before `--` is honoured. The documented `[-- extra args]` is also broken: `logs -- vikunja` drops `vikunja`, `up -- --build` drops `--build`. No variant can remove volumes (the `-v` is swallowed or stripped), so the worst case is an unintended up/down of the user's stack.
    Required change (follow-up): treat --dry-run/--help as booleans that never consume a value, split argv at the first `--` and pass the rest through verbatim; add tests for `<action> --dry-run <arg>` and for the pass-through.

  [LOW] `down` volume guard matches only the exact tokens `-v` / `--volumes`
    Evidence: scripts/local/compose.mjs:29-31. `compose.mjs down -vt 5 --dry-run` prints `… down -vt 5`; `down -v=true --dry-run` prints `… down -v=true` (both are valid compose spellings of -v). `--volumes=true` and the packet's `down --dry-run -- -v` are dropped correctly.
    Suggestion: allow-list the extra arguments of `down` (e.g. --remove-orphans, -t N) and reject everything else.

  [LOW] local:status prints the "secrets directory is gone, DB locked out" warning in the normal first-run order
    Evidence: scripts/local/status.mjs:114-128 warns when ANY secret file is missing and stack.state.json exists. Repro: postgres.env, vikunja.env, push.key, llm-session-secret present, state file present, setup not yet run -> "비밀 디렉터리가 없지만 ohmydate-local 스택/볼륨이 존재합니다 … 지금은 DB에 다시 접속할 수 없습니다", although only vikunja-tokens.json is missing.
    Suggestion: warn only when postgres.env (or the directory) is missing.

  [LOW] Ambient env still shapes the run outside the DB/Vikunja target
    Evidence (code read, not reproduced — building with it would leave a mock bundle with a fresh stamp in the worktree): scripts/local/start.mjs:396 builds the web with the full parent env (runPnpm default), apps/web/src/main.ts:12 bakes `import.meta.env.VITE_MOCK` at build time, and start.mjs:296 sets VITE_MOCK=0 only for `vite preview`, which cannot change a built bundle; an exported VITE_MOCK=1 gives the try-out a mock-API bundle. Present since round 1. Likewise ambient LLM_BASE_URL / LLM_MODEL / LLM_REASONING_EFFORT / budgets / LLM_API_KEY_FILE override local.env (start.mjs:282-286, common.mjs:109) and only NODE_ENV and LLM_PROVIDER are printed (start.mjs:362-365).
    Suggestion: pass VITE_MOCK=0 to the build; print the effective LLM base-URL host and model (or move these overrides to OHMYDATE_LOCAL_* names).

  [LOW] local:start can report "준비 완료" when a foreign listener answers on the API port
    Evidence: scripts/local/start.mjs:311-330 returns on the first 200 and does not re-check the child. Repro: a dummy server answering 200 on the API port -> start exit 0 in 1.4 s while our API child had not bound the port and then exits with EADDRINUSE; api.pid points at it. Present since round 1; realistic trigger is an instance left from another checkout or a lost pid file.
    Suggestion: after the 200, confirm the child is still alive after a short settle time.

  [LOW] Token rotation edge cases
    Evidence: (a) scripts/local/setup.mjs:340 — with a meta entry that has no tokenId (round-1 format, or a lost meta file) `--rotate-token` prints "새로 발급 (교체)" and leaves the old token valid without a warning (repro: old 200 / new 200). (b) setup.mjs:321-338 (code read) — if the token file is written and the meta write then fails, the catch revokes the token that is already in the token file while the previous token stays valid but unrecorded; a re-run self-heals.
    Suggestion: warn when the previous id is unknown; revoke on failure only if the token file was not replaced.

  [LOW] Zone validation is laxer in setup than in create-user, and runs after Vikunja registration
    Evidence: scripts/local/prompt.mjs:17-25 accepts anything Intl accepts (`asia/seoul`, `+09:00`, `EST`, `Asia/Kolkata`); create-user uses the exact domain set. Repro: `setup --time-zone asia/seoul` -> "planner 사용자 생성에 실패했습니다: invalid IANA time zone: asia/seoul", exit 1 (re-run with Asia/Seoul recovered). `setup --time-zone Mars/Olympus` is rejected only at setup.mjs:275, after ensureVikunjaUser at :260 (Vikunja login for that email: 403 before, 200 after the rejected run).
    Suggestion: validate flags/env before any side effect with the domain's own check. Not reachable with the default Asia/Seoul.

  [LOW] create-user.ts runs main() on import
    Evidence: services/api/src/cli/create-user.ts:131-136 has no entry-point guard, and the new test imports the module. Verbose run shows "stderr | test/create-user-args.test.ts / usage: create-user <email> …"; a plain import leaves process.exitCode = 1 (vitest still exits 0). With a positional argv and DATABASE_URL set the import would go on to read stdin and open the DB.
    Suggestion: guard the entry point or move parseCreateUserArgs into its own module.

  [LOW] Small items
    scripts/local/smoke.test.mjs:104 `not.toContain('test-password')` is vacuous (the smoke password is `smoke-password-<suffix>`); assert on `password` and the DB password. deploy/local/local.env:2 still names stack.env. scripts/local/status.mjs:135 calls a wide-mode key "chmod 600 권장" and does not count it as a failure although start refuses it. start prints the target only after the preflight passes (start.mjs:361), so its stack-down error does not name what was probed. setup.mjs:363-365 prints "스택이 아직 없다면 …" after a successful first setup.

Contract / license / security / migration impact: no API contract or OpenAPI change, no new dependency, no migration. create-user gains optional --time-zone / --locale; behaviour without them is unchanged (tested). No secret value in any output, argv or log I captured (setup, start, status, api.log, web.log scanned for the account password, the generated Postgres password, the Vikunja token, the dev DB password, the fake key content and the fake shell secrets). The only security-relevant open items are the two local:stack wrapper findings and the ambient-env finding.

Missing tests: CLI-level start tests for a foreign/dead PID (only inspectProcess is unit-tested, start.test.mjs:78-91), for "running + --rebuild / stamp mismatch -> refusal" and for child exit during the health wait with cleanup; compose.mjs `<action> --dry-run <arg>`, `--` pass-through and clustered `-v`; rotation without a recorded tokenId and the write-failure revoke path; status warning when only the token file is missing; the interactive prompt path; the smoke's vacuous password assertion. I verified each of these by hand except the write-failure path.

Verification actually executed: yes
  git diff torgal/ohmydate...e05189e read in full; path check vs ALLOWED PATHS -> ok
  corepack pnpm run typecheck -> exit 0
  corepack pnpm run lint -> exit 0
  corepack pnpm run check:boundaries -> exit 0 (551 files, 0 violations)
  DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run test:local -> exit 0 (11 files, 41 passed, 1 skipped; the skipped one is the by-design placeholder smoke.test.mjs:176; the real smoke ran — 171 s, and it wrote .local/build.stamp.json)
  same env: corepack pnpm --filter @ohmydate/api exec vitest run --globals test/create-user-args.test.ts -> exit 0 (4 passed)
  node scripts/local/compose.mjs up --dry-run -> exit 0 (… -p ohmydate-local --env-file <abs>/deploy/local/local.env -f <abs>/deploy/local/compose.yaml up -d)
  node scripts/local/compose.mjs down --dry-run -- -v -> exit 0 (… down, no -v)
  NOT run: full `pnpm run ci` (host load rule), the full `pnpm --filter @ohmydate/api test`, docker, sudo, the LLM gateway. No file under deploy/secrets/** and no *api_key* file was read.
  Extra probes from scratch scripts outside the worktree, on one temporary planner_test schema (dropped, 0 left) and dev Vikunja with synthetic @example.invalid users: the reproductions quoted above, including setup -> start --fake-llm -> login -> second start -> stop, production-mode starts with a fake key file, and three pty-driven interactive setups.

git status --porcelain after review: empty (HEAD e05189e; only gitignored .local/build.stamp.json and dist/ were generated by the test run)

Residual risks:
  - The docker path was not exercised by me; the evidence is the coordinator's live run of d3786f6 + e05189e.
  - PID identity relies on /proc (Linux only); elsewhere local:stop would treat every record as stale and leave the processes running. The check-then-kill window is inherent without pidfd. Concurrent local:start runs are not locked.
  - Secrets dir and volumes are a pair: if postgres.env is lost, both status ("먼저 local:secrets …") and setup (auto-init) create a new password that cannot open the existing volume. README documents the pair.
  - The build stamp does not notice a dist replaced by another tool or a lockfile-only change; `--rebuild` covers it.
  - Round-1 residuals unchanged: Secure cookies on http://127.0.0.1 rely on the loopback exemption; DATABASE_URL with the password is in the API process env; Vikunja registration stays enabled on loopback; token lives 365 days.
  - My probes left 6 synthetic users (with their API tokens) in dev Vikunja, plus 1 from test:local.
