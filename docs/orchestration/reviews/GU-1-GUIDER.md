# GU-1-GUIDER (ctx_ec221fe80482, Fable 5.2 xhigh — Sol weekly limit; implementer Opus) — REQUEST_CHANGES (1 required MEDIUM, one-sentence; reviewer allowed the coordinator to apply it at merge)

Coordinator resolution: commit 3209498 on torgal/gu-1-guide applies the required MEDIUM (re-login after API restart), the backup MEDIUM (timestamped tmp+mv, verify every time; command executed once on the live local stack — 212 KB, trailer present, test dump deleted) and the LOWs; known-issues table filled.

REVIEW VERDICT: REQUEST_CHANGES
(Reviewer: Fable 5.2 xhigh in place of Sol. No CRITICAL/HIGH. One MEDIUM marked Required = a one-sentence fix; the coordinator may equally apply it at merge when filling "현재 알려진 이슈". Everything else is non-blocking.)

Findings (most severe first):
  [MEDIUM] Login persistence is misstated: sessions die on every API restart
    Evidence: docs/user/GU-1-사용안내.md:511 says "로그인은 마지막 사용부터 14일 동안 유지돼요". services/api/src/app.ts:677 builds `new InMemorySessionStore({ clock, ttlMs })` unconditionally (config.ts:191 = 14 d sliding TTL), so the session is lost at every `local:stop`/`local:start`, reboot, update and after `--rotate-token` (guide §3 and lines 517-519 tell the user to do exactly these). §3 "재부팅한 뒤"/"새 코드로 업데이트할 때" never mention logging in again; the user will hit a login screen (plus the consent dialog again if not granted) daily and report it as a bug.
    Required change: at line 511 say the 14 days hold only while the API process keeps running and that after each `local:start` (reboot, update, token rotation) you log in again; add the same half-sentence to §3 (재부팅한 뒤 / 업데이트).
  [MEDIUM] Backup step 2 can silently destroy the same day's earlier dump
    Evidence: guide lines 86-88 `... pg_dumpall -U ohmydate > ~/ohmydate-backup/pg-$(date +%F).sql`. The shell truncates the target before sudo/docker runs, so a second run on the same day with a wrong sudo password or the stack down leaves a 0-byte file over a good backup; line 100 asks for a size check only "처음 한 번". Live data is not touched (not HIGH). The command itself is consistent with compose.yaml (service `postgres`, user `ohmydate`, local-socket auth as used by the healthcheck) and with scripts/local/compose.mjs, but nobody has executed it.
    Suggestion (do in the same round): use a time-stamped name (`$(date +%F-%H%M%S)`) or write to `*.tmp` and `mv` on success, and tell the user to check every time that the file is non-empty and ends with "PostgreSQL database cluster dump complete".
  [LOW] Fallback draft is English today, guide hides it
    Evidence: guide line 347 "기본 3단계 초안(준비 → 작업 → 검토)"; services/api/src/application/intake/intake-service.ts:483-512 emits 'Prepare the workspace and inputs' … 'Review against done criteria'. The feedback checklist (line 480) asks the user to report "영어가 섞인 곳".
    Suggestion: unless FU-89 merges first, list it under "현재 알려진 이슈" (coordinator fill-in).
  [LOW] "보내는 것" is slightly under-specified
    Evidence: guide lines 321-323. packages/llm/src/note-context.ts:386 sends `title: <note title>` with each excerpt (redacted); intake-service.ts:273-306 sends saved task templates' name/step title/deliverable/done criteria in type detection. Not a misstatement (allowed notes only; covered loosely by "단계 정보"), redaction list (email/phone/RRN/API key; 계좌번호 NOT masked) is correct per privacy.ts:43-62.
    Suggestion: write "노트 제목과 관련 구간" and mention that saved templates of earlier similar tasks are sent when looking for similar work.
  [LOW] `local:setup` success transcript omits a line that always prints on first run
    Evidence: guide lines 190-199 vs scripts/local/setup.mjs:360-362 ('로컬 앱이 이미 실행 중이라면 local:stop 후 local:start 로 재시작하세요.' whenever a token is issued).
    Suggestion: add the line or mark the block as abridged.
  [LOW] Command inside a table is not copy-pasteable from the raw file
    Evidence: guide line 234 `ss -ltnp \| grep -E ':(3100\|5180)\b'` (pipes escaped for the table; correct only when rendered).
    Suggestion: move it to a fenced block under the table.
  [LOW] Stack-down message variant
    Evidence: guide line 228 quotes the `local:start` form `(postgres=down, vikunja=down)` (start.mjs:214); `local:setup` prints `(PostgreSQL: …)` / `(Vikunja: …)` after a 30 s wait (stack.mjs:47,65).
    Suggestion: mention both endings or cut the suffix.
  [LOW] README vs guide on who runs docker
    Evidence: deploy/local/README.md:14 "workers/users never run docker" while the guide (per packet) has the user run `local:stack up` and a `sudo docker compose exec` backup.
    Suggestion: coordinator reconciles the README sentence later (outside this task's one-link-line allowance).

Verified correct (focus 1-4): changed paths = deploy/local/README.md (one link line, relative link resolves) + docs/user/GU-1-사용안내.md, both inside ALLOWED PATHS. Install order local:secrets → local:stack up → local:setup → local:start matches package.json:18-23 and the preflight order in start.mjs:172-235; ports 55442/3466/3100/5180, key-file default/override/0600 rule, `--rebuild`, `--rotate-token`, 365-day token, 20 s stop, PID-safety, status lines/exit code, error strings all match scripts/local/*.mjs and deploy/local/local.env. All 251 curly-quoted strings exist in ko.ts or the scripts (240 literal, 11 parameterised ones checked by hand). Budgets $0.20/$5 (config.ts:201-202), consent gate (policy-llm.ts:126-137), dialog Esc = manual and reopen-until-granted (LlmConsentDialog.vue, AppShell.vue:30-35), note eligibility llmAllowed + 6,144-byte budget, replan cap 2/day + 24 h suppression + 24 h expiry + 300 s sweep, steps 3-12 / P50 ≤ 240, horizon 14 d default / 366 max, nav groups, shortcuts, `aria-pressed` on BlockLockToggle, login rate limit 5/min all match the code. The 계좌번호 over-claim in the consent copy is stated accurately (lines 332-334, 522). No secret values, no instruction to paste or print a key, no destructive command; `local:stack down` is correctly described as volume-safe (`-v` stripped, confirmed by dry-run); restore/reset deferred to the coordinator. Section anchors resolve; sections 1-7 and the "현재 알려진 이슈" placeholder are present.

Contract / license / security / migration impact: none (docs only; no code, contract, dependency or migration change). Clean merge into torgal/ohmydate (cc037c9).
Missing tests: none applicable (docs). Not covered by any execution: backup block, live `local:setup/start/status` output, Vikunja UI login.
Verification actually executed: yes —
  git diff --name-only torgal/ohmydate...15fc924 → exit 0 (2 paths, both allowed)
  git diff --check torgal/ohmydate...15fc924 → exit 0
  git merge-tree --write-tree torgal/ohmydate 15fc924 → exit 0
  corepack pnpm run lint → exit 0
  corepack pnpm run check:boundaries → exit 0 (559 files, 0 violations)
  python3 quote check of the guide against ko.ts + scripts/local/*.mjs → exit 0 (251 quoted, 11 parameterised, 0 unreal)
  node scripts/local/compose.mjs up --dry-run → exit 0 (same command line as guide §2-2); `down -v --dry-run` → exit 0, `-v` dropped
  OHMYDATE_LOCAL_SECRETS_DIR=<scratch> node scripts/local/secrets.mjs init (twice) → exit 0, output identical to guide §2-1; scratch dir removed
  NOT run: typecheck, full ci/e2e (speed rule), docker/sudo/backup commands, mock dev server (labels/flows checked from source and e2e specs instead), anything under deploy/secrets or *api_key*.
git status --porcelain after review: (empty)
Residual risks:
  - Backup block and all live terminal output are unexecuted by worker and reviewer; coordinator should run the backup once on the live stack before handing over the guide.
  - Vikunja UI login with the `local-…` username and the live "현재 상한" text are unverified.
  - "현재 알려진 이슈" is still a placeholder (FU-89 English fallback draft, FU-91 consent copy, stale "곧 지원" labels belong there).
  - Guide is pinned to 06e686c: when FU-91/FU-89 land, lines 334 and 522-524 become stale.
  - Cost per decomposition and the shared OpenCode Go quota note are coordinator-supplied and not checkable from the repo.
