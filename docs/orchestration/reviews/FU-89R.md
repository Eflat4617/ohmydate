# FU-89R (ctx_8961b11bd9e1, Fable 5.2 xhigh — Sol weekly limit; implementer Opus) — APPROVE

Coordinator: live evals on 96d9bd9 — contract 9/9 valid, language 9/9 match, injection v4 ko-KR 20/20 evaluated, 0 followed (evals/2026-11-12-*-fu89.json). MEDIUM (GU-1 user locale must be ko-KR) is covered by GU-1-PKG setup (create-user --locale ko-KR); the live GU-1 user (gu-1-live) was verified at merge time: 1 user, locale ko-KR, time zone Asia/Seoul.

REVIEW VERDICT: APPROVE
Reviewed: torgal/ohmydate...96d9bd9 (1 commit, Task trailer present). All 27 changed paths are inside ALLOWED PATHS plus the two approved extensions (routes.ts, fake-llm-scenarios.ts). None of the five HIGH triggers applies.

Findings (most severe first):
  [MEDIUM] A default-locale owner is sent outputLanguage "en", so the GU-1 Korean-UI user gets English output on every call until their stored locale is ko-KR
    Evidence: services/api/migrations/0001_init.sql:18 (locale text NOT NULL DEFAULT 'en'); services/api/src/cli/create-user.ts:54-58 passes no locale; apps/web has no locale setting (only mocks and schema.d.ts mention it); services/api/test/intake-output-language.test.ts:327 pins "[undefined, 'en']". The ko-KR fallback never fires for these users because "en" is a valid tag. v3/v4 say "write every user-facing string in that language, whatever language the documents use", so a Korean goal now yields English steps every time (before: mixed), and the manual draft stays English.
    Suggestion (not blocking this merge; the fix is outside this packet's paths and the code matches the packet's REQUIRED wording): before GU-1 store the try-out user as ko-KR (user settings PATCH accepts locale, services/api/src/http/routes.ts:605), or open a follow-up for create-user --locale / the web sending its UI locale.
  [LOW] Script and region subtags are shape-checked only
    Evidence: services/api/src/application/intake/output-language.ts:25,50. Probe: "en-Evil-ZZ" -> "en-Evil-ZZ", "en-Sudo-RM" -> "en-Sudo-RM", "aa-Aaaa-AA" passes. At most 6 owner-chosen letters, from the owner's own setting; not a usable injection channel.
    Suggestion: validate script/region with Intl.DisplayNames (fallback "none") or drop the script subtag.
  [LOW] Some real locale spellings fall back to Korean instead of the user's language
    Evidence: same file; probe: "en_US.UTF-8", "en-GB-oed", "zh-min-nan", "i-klingon" -> "ko-KR". Matches the documented fallback; only matters if a locale is ever written in POSIX or legacy form.
    Suggestion: none required.

Focus results:
  (1) Released prompts: diff shows only additions (decomposition/v3.md, v4.md, type_detection/v2.md); v1/v2 files identical to base and the SHA-256 pin test passes; registry lists all 9 keys. v3 = v1 + the "Output language" section. type_detection@v2 = v1 + that section. v4 = v2 + that section + one edit in the untrusted-documents list that ADDS "change the output language" to the requests not to follow. No injection rule removed or softened; enums/ids/keys and quoted user content are explicitly not translated.
  (2) outputLanguage source: only users.get(ownerId).locale (routes.ts:1798), looked up by the session owner's id, so no cross-owner path; no request field feeds it. Resolver probe (59 hand-picked inputs + 200,000 random strings): never throws, result always matches the tag pattern, length <= 11; "und", invalid, missing, non-string -> ko-KR; extensions, private-use and variants dropped.
  (3) agent_run records type_detection@v2 / decomposition@v3 / decomposition@v4 (asserted in intake-output-language.test.ts:348-351, notes-intake.test.ts:305,456). Injection eval targets v4 with ko-KR; contract smoke has inputs for v2/v3/v4. Prompt limits are keyed by promptId, so the new versions keep the decomposition limits. e2e-6: 3 passed.
  (4) Manual draft: fixed frozen ko/en tables; the only user content is title and deliverable as their own step fields, same as before.
  (5) No weakened test: the only removed assertion lines are 4 version bumps (v1->v3, v2->v4); no skip/only, no deleted test.

Contract / license / security / migration impact: none for contracts, OpenAPI, dependencies and migrations. One new field (the owner's locale tag) is sent to the LLM provider. agent_run.prompt_id_version and llm_spend.purpose now carry the new keys; no source code filters on the old ones.

Missing tests: none blocking. Optional: script/region validity if the LOW item is taken.

Verification actually executed: yes (env DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456)
  corepack pnpm run typecheck -> exit 0
  corepack pnpm run lint -> exit 0
  corepack pnpm run check:boundaries -> exit 0 (538 files, 0 violations)
  corepack pnpm --filter @ohmydate/llm test -> exit 0 (18 files, 683 passed, 2 skipped)
  corepack pnpm --filter @ohmydate/api exec vitest run --globals test/intake-output-language.test.ts test/intake.test.ts test/intake-detection.test.ts test/fake-llm-scenarios.test.ts test/notes-intake.test.ts -> exit 0 (5 files, 78 passed, 0 skipped; the worker's "93 passed" was a different file set)
  extra, the two other modified test files: vitest run --globals test/intake-long-ai-calls.test.ts test/estimation-learning.test.ts -> exit 0 (15 passed)
  extra: corepack pnpm run e2e e2e-6 -> exit 0 (3 passed)
  Not run: full ci, full api test, full e2e (speed rule); live contract and injection evals (coordinator).

git status --porcelain after review: empty (HEAD 96d9bd9)

Residual risks:
  - Whether the live model obeys the language rule, and v4's injection resistance, are unverified here; they depend on the coordinator's live evals.
  - GU-1 user locale must be ko-KR (MEDIUM above).
  - Worker-reported and not checked by me: the web wizard tags LLM detection reasons lang=en.
  - apps/web mocks still show decomposition@v2 (mock data only).
  - One extra user lookup per LLM call and manual draft; a locale change mid-session can mix languages across detection and decomposition.
