# FU-90R (ctx_d56ec359ae73, Fable 5.2 xhigh — Sol weekly limit; implementer DeepSeek) — REQUEST_CHANGES (round 1)

REVIEW VERDICT: REQUEST_CHANGES
Target: torgal/ohmydate...e8b9ad9 (1 commit, 16 files, +788/-67). Reviewer: Fable 5.2 xhigh in place of Sol. Round 1 of 2.
All 16 changed paths are inside ALLOWED PATHS (scripts/local/**, deploy/local/local.env, services/api/src/cli/create-user.ts, services/api/test/create-user-args.test.ts). Conventional Commit with "Task: task_874c67a41605". No dependency, lockfile, contract or migration change. No HIGH: no path removes volumes, exposes a secret or writes to a wrong target. One acceptance item is not met (finding 1), so this goes back for a small fix.

Verified fixed by my own reproduction (not by reading only):
  1 dry-run / pass-through: with a PATH holding only a fake sudo shim, up/down/logs/ps with args before and after --dry-run (15 variants with node, 9 more via `corepack pnpm local:stack ...`) never reached the shim; `logs --dry-run -- vikunja` -> "logs --tail 200 vikunja", `up --dry-run -- --build` -> "up -d --build". A --dry-run placed after `--` is forwarded verbatim, as specified (`logs -- vikunja --dry-run` reached the shim).
  2 down allow-list: 25 spellings refused with exit 1 and the Korean message, shim never called, WITHOUT --dry-run: -v, --volumes, -vt 5, -tv 5, -v=true, --volumes=true/false, -t 5 -v, --remove-orphans -v, -- -v, -- --volumes, -t -v, "-t '5 -v'", "--timeout=5 --volumes", newline-embedded, --rmi all, -V, a service name. Allowed --remove-orphans / -t N / --timeout=N reach the shim unchanged.
  3 status: only vikunja-tokens.json missing + state file -> no warning; postgres.env gone or whole secrets dir gone + state file -> warning; no state file -> none; legacy stack.env -> none.
  4a VITE_MOCK: real `start --rebuild` with ambient VITE_MOCK=1 produced a bundle with no mock chunk (0 MSW strings; a control build with VITE_MOCK=1 into a scratch outDir has a browser-* chunk and MSW strings).
  4b LLM line: "실행 모드: NODE_ENV=production, LLM_PROVIDER=deepseek, LLM_BASE_URL=ambient-host.example.invalid:8443, LLM_MODEL=ambient-model-x"; URL path, query and userinfo never printed; healthz 200, login via the web proxy 204.
  5 rotation: unknown previous id -> the new warning is printed; token-file write failure (injected) -> the new token is revoked (Vikunja token ids unchanged, file unchanged, no temp file); meta failure after replace -> the token now in the file is NOT revoked.
  6 zone/locale: --time-zone Mars/Olympus, asia/seoul, =EST, env +09:00, --locale "not a locale", env locale x -> exit 1, secrets dir not created, Vikunja login for that email 403 before and after.
  7 create-user: main() runs for tsx relative / absolute / non-normalised / symlinked path, `pnpm run create-user` and `node --import tsx`; an import with a positional argv and DATABASE_URL set does not run it (exitCode undefined). test/cli.test.ts passes.
  8 small items: wide key modes 644/640/604/660 are a failure naming "chmod 600 <path>" (600/400 healthy); target line precedes the preflight; smoke asserts the real passwords; local.env names postgres.env/vikunja.env; setup hint removed.
  The two removed assertions (compose "down never passes -v", smoke 'test-password') were replaced by stronger ones; no test deleted, skipped or loosened.

Findings (most severe first):

  [MEDIUM] local:start still reports "준비 완료" with a foreign listener on the API port (packet item 4 not met)
    Evidence: scripts/local/start.mjs:335-365 (HEALTH_SETTLE_MS = 1000). Repro: a dummy HTTP server answering 200 on the API port, then `start.mjs --fake-llm` (temp dirs, free ports, planner_test temp schema): 13 runs -> 9 printed "OhMyDate 로컬 실행 준비 완료" and exited 0 in 2.1-2.3 s, 4 refused in 1.2 s ("프로세스가 응답 직후 종료되었습니다 ... listen EADDRINUSE"). In the 9 runs api.pid pointed at a dead pid, api.log held "listen EADDRINUSE", and the web preview was up and proxying to the foreign listener. Our API child needs about 1.0-1.3 s to reach listen(), which is the settle length, and nothing re-checks it during the web wait. The web port is not affected (6/6 refused). The new test (start.test.mjs "a child that exits after the first 200 ...") uses a child that dies at 150 ms with a 400 ms settle, so it cannot fail on this race. The worker listed the heuristic as a risk; the reproduction shows it loses most of the time on this host.
    Required change: make it deterministic. Before spawning a service that has no live pid record of ours, refuse when something already accepts connections on its port (Korean message naming the port); re-check both children right before printing "준비 완료". Add a test with a real listener on the API port and a child that outlives the settle (CLI-level, or the helper with a child exiting after > settleMs).

  [MEDIUM] `--dry-run=<value>` and `--help=<value>` are not treated as the wrapper's flags and reach sudo
    Evidence: scripts/local/compose.mjs:40-44 matches only the exact tokens. Fake sudo shim: `up --dry-run=true` and `up --dry-run=1` -> no dry-run line, shim recorded "docker compose ... up -d --dry-run=true" and stack.state.json was written; `logs --dry-run=true`, `ps --dry-run=true`, `up --help=1` likewise reach the shim. `down --dry-run=true` is refused by the allow-list. Not a regression: on the base the same spellings ran a plain `up -d` / `down`. I rate it MEDIUM and not HIGH because the spelling is undocumented, it is safer than the base, and docker compose would read the forwarded flag as its own dry-run (not verified, docker not run). Read literally, your HIGH rule ("any path that runs real docker in dry-run") matches this one path; it is cheap to close in the same round.
    Required change: refuse any `--dry-run=` / `--help=` token before `--` with a Korean message (or accept true/1 as the boolean); add a test with the shim.

  [LOW] After a meta-write failure the token state does not heal, and the next rotation orphans a valid token
    Evidence: scripts/local/setup.mjs:252-280, 358, 389. Repro with an injected rename failure on vikunja-tokens.meta.json: rotation exits 1 with token C in the file and meta still holding B's id; a plain re-run prints "기존 토큰 유지" and leaves the meta unchanged (B still 200); the next --rotate-token revokes B and leaves C valid (200) and unrecorded, with no warning. Also (code read) writeJsonAtomic can throw after its rename (chmod / dir fsync, vikunja-token.mjs:42-49); tokenFileReplaced then stays false and the token already in the file is revoked (a re-run heals that one).
    Suggestion: record a fingerprint of the token (e.g. a sha256 prefix) next to tokenId; when it does not match the file, treat the previous id as unknown, rewrite the meta and print the existing warning.

  [LOW] Small items
    deploy/local/README.md:39 still says "`-v` is ignored"; it is now refused with exit 1. A bare `--time-zone` / `--locale` without a value is silently ignored (parseFlags makes it a flag; the run continued to the stack check with the default zone). A zone typed at the interactive prompt is still validated after Vikunja registration (setup.mjs:325 then :340, code read). scripts/local/time-zone.mjs has no parity test against the domain set. `logs --follow` is not stripped (only `-f`). The commit body contains literal "\n" sequences.

Contract / license / security / migration impact: none. No API contract or OpenAPI change, no new dependency, no migration. No secret value in any output I captured (account password, dev DB password, Vikunja tokens, fake key content, LLM URL path/query/userinfo, a marker in malformed secret files). Behaviour change to note: `local:stack down -v` now exits 1 instead of silently dropping the flag.

Missing tests: a real foreign listener on the API port (the settle test does not model it); `--dry-run=<value>`; the stale-meta path after a meta-write failure (re-run and next rotation); parity of time-zone.mjs with the domain set; bare `--time-zone` without a value.

Verification actually executed: yes
  git diff torgal/ohmydate...e8b9ad9 read in full; path check vs ALLOWED PATHS -> ok
  corepack pnpm run typecheck -> exit 0
  corepack pnpm run lint -> exit 0
  corepack pnpm run check:boundaries -> exit 0 (562 files, 0 violations)
  DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run test:local -> exit 0 (13 files, 69 passed, 1 skipped = the by-design placeholder; a --reporter=verbose rerun, exit 0, shows the real smoke passing in 5.7 s on an already fresh build stamp)
  same env: corepack pnpm --filter @ohmydate/api exec vitest run --globals test/create-user-args.test.ts -> exit 0 (5 passed)
  extra, same env: ... vitest run --globals test/cli.test.ts -> exit 0 (2 passed)
  NOT run: full `pnpm run ci` and e2e (speed rule), docker, real sudo, the LLM gateway. No file under deploy/secrets/** and no *api_key* file was read. Ports 55442/3466/3100/5180 were never contacted.
  Probes from scratch scripts outside the worktree (fake sudo shim PATH, temp dirs, free ports, one temporary planner_test schema, dropped, 0 left; dev Vikunja with one synthetic @example.invalid user): the reproductions quoted above.

git status --porcelain after review: empty (HEAD e8b9ad9). Only gitignored output changed: my `start --rebuild` regenerated dist/ and .local/build.stamp.json (non-mock bundle, verified).

Residual risks:
  - The docker path was not exercised; how docker compose treats a forwarded --dry-run is from memory, not from a run.
  - Only `down` is allow-listed; up/ps/logs forward any argument.
  - time-zone.mjs mirrors the domain set by hand. That set rejects current link names such as Asia/Kolkata and Europe/Kyiv (Intl lists Asia/Calcutta, Europe/Kiev); the system default resolves to the listed spelling, so only an explicit flag is affected.
  - A web dist built earlier under ambient VITE_MOCK=1 with a fresh stamp is not detected (the stamp does not record the env); `--rebuild` covers it.
  - My probes left 1 synthetic user with 3 valid API tokens in dev Vikunja, plus 2 users from the two test:local runs.
