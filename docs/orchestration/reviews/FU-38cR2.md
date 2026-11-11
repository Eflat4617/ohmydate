# FU-38cR2 (ctx_b83948b99f6d, opus-fallback) — REQUEST_CHANGES (round 2/2 → BLOCKED → FU-38d)

REVIEW VERDICT: REQUEST_CHANGES (FU-38cR2R, round 2/2, head 78ad667, reviewer=Opus 5.5)

Most round-1 findings are fixed: key cap/joiners/>256 bodies, whitespace runs, adjacency over-masking, and the perf gate. But the CC_PHONE rewrite that closes +82-2 introduces whole-number disclosure regressions vs FU-32 on mainstream international formats. That is a HIGH under the round-2 rule.

Findings (most severe first):
  [HIGH] New CC_PHONE pattern leaks common +cc formats that FU-32 masked (whole-number disclosure regression)
    Evidence: packages/llm/src/privacy.ts:539 replaces FU-32's optional-separator groups `(?:SEP(?:(..)|\d{2,4})){2,4}` with an area group followed by REQUIRED_SEPARATOR groups. So a +cc number whose groups after the first one are glued, or joined by a stripped char, no longer matches. INTL_82 is still blocked after '+', and glued E.164 needs no separator at all.
      - Base masks, head leaks EVERY digit: '+82 1012345678', '+82-1012345678', '+82 10 12345678', '+82-10-12345678', '+82 31-12345678', '+82-3112345678', '+1 4155552671', '+1 415-5552671', '+44 2071838750', '+44 20 71838750', '+49 30 12345678', '+81-90-12345678', '+86 13812345678', '+33 612345678', '+61 412345678', '+65 91234567', '+852 91234567', 'tel +82 1012345678.', '전화: +82-1012345678'.
      - Same with stripped joiners: '+82-2<SHY>9007<SHY>2208', '+82 2<ZWSP>1386<ZWSP>3726', '+82-31<ZWSP>020<ZWSP>6052', '+82 10<ZWNJ|WJ>1234..5678'.
      - Partial leak: '+82-10-1234<ZWSP>5678' -> '[REDACTED_PHONE]<ZWSP>5678'.
      - 30 of my 47 +cc probes regress.
      - Re-run of my round-1 216k A/B vs FU-32 (same seed): head 1,506 tokens / 12,654 glyphs regressed, in 30 of 31 groups: single 591 cases, mixdigit 207, every phone pair/perm, same2 52, same3 70. Round-1 head 05dc09d on the same corpus: 57/6,517 (same3 keys only). Reverting ONLY CC_PHONE_SOURCE (+minDigits) in a scratch copy -> 0/0.
      - The repo gate cannot see this. NUMERIC_TOKENS +cc specs (privacy-gate.test.ts:117-118) put no separator between cc and the first group ('+8210-1234-5678'), so no case has cc+sep+glued/stripped groups.
    Required change:
      - Keep the FU-32 CC_PHONE pattern byte-for-byte. Add the 1-digit-area form as a SEPARATE pattern with its own L_max/shorterEnd/exact/minDigits; the union stage covers both.
      - I validated this in a scratch copy (v3):
        - 216k A/B: 0 tokens / 0 glyphs regressed.
        - 47-string +cc probe: 0 regressions, and the 5 +82-2/+81 3/+33 1 fixes are kept.
        - 200k benign corpus: over-mask identical to head (9,880).
        - The repo privacy.test.ts + privacy-gate.test.ts run against v3: 318 passed / 1 skipped.
      - Add gate/A-B specs with a separator after cc and glued or stripped-joined groups: '+82 1012345678', '+82-10-1234<ZWSP>5678', '+1 4155552671', '+44 20 71838750'.
  [MEDIUM, Required] The gate corpus was narrowed to pass, and ADR-019 (7) was implemented more strictly than written
    Evidence: privacy-gate.test.ts:213-214 adds NUMERIC_RUN_SEPARATORS, which has no ''. It replaces JOIN_SEPARATORS in the same-kind pair loop (:245) and the rrn/phone/rrn triple loop (:255). privacy.ts acceptsGluedContinuation skips `pattern.kind === currentKind` and calls resolveEnd(..., allowContinuation=false).
      - I ran the round-1 gate file (05dc09d, imports repointed) against head 78ad667. It FAILS 'scanner masks every core glyph the independent oracle finds' on exactly the 5 dropped cases:
        - '900101-1234567900101-1234567' -> '900101-[REDACTED_RRN]-1234567' (birth date and back half visible)
        - glued 010/02/070 pairs: fully visible
      - Glued ASCII cross-kind chains of 3+ tokens also leak whole on head; round 1 masked them. Examples: '9001011234567010123456789001011234567' (37 digits), '01012345678900101123456701012345678', and the dashed R+P+R glued form.
      - FU-32 leaks all of these identically, so this is not a FU-32 regression and not HIGH.
      - ADR-019 (7) says only "the continuation must itself be accepted". "Different kind" and "no further relaxation" are not in it, and no knownLimitations test pins these cases. Packet rule 2 forbids editing tests to make them pass.
    Required change, either of:
      (a) Restore '' in those loops and accept bounded chains: a continuation counts if it resolves itself, recursively, via a memoised right-to-left pass (O(n)). Same-kind precision can stay as is if the coordinator accepts it.
      (b) Have the coordinator amend ADR-019 (7) to scope out same-kind glued windows and 3+ glued chains, and pin the strings above as knownLimitations tests instead of silently dropping corpus cases.
  [MEDIUM] Non-whitespace separator runs over 32 units still regress vs FU-32; ADR (6) claims length-independent recall; not pinned
    Evidence: privacy.ts:79-81. MAX_SEPARATOR=32 still caps dash/dot/mixed runs.
      - Base masks, head leaks whole: '010'+33x'-'+'1234-5678', '900101'+' -'x17+'1234567', '010'+40x'.'+'1234.5678'.
      - These inputs are contrived. The worker disclosed this in prose, but no test or ADR records it.
    Required change: either fold any SEPARATOR-class run to one unit, or pin these as knownLimitations and correct the ADR-019 (6) wording.
  [LOW] The 1-digit-area CC form over-masks short benign '+' numerics
    Evidence:
      - Base unmasked, head masked: '+1 2 2026', '+1 2 2026-11-11', '+1 2-12-2026', '+5 1 23 45', '+1 2 34 56', '+1 2 3456', '+12 3 4567', '+44 1 234', '+9 9 99 99'.
      - Unchanged: versions/IPs/diffs/scores ('v+1.2.3', '+1.2.3.4', '+10.0.0.1/24', 'diff +12 -3 lines', 'score +3 2-1', '+3 2 1 0', '+1 1 2 3 5 8 13', '+33 1 2 3 4 5').
    Suggestion: raise minDigits for the area form to about 8; real 1-digit-area numbers have 9 or more digits.
  [LOW] extendWordRun fires whenever the trim fails and the next char is [A-Za-z0-9_-], not only at L_max
    Evidence: privacy.ts resolveEnd extension branch. 'ghp_'+30a+'_tail' and 'xoxb-'+20a+'_x' are now masked; base leaves them unmasked. This is over-mask only, on secret-like strings.
    Suggestion: gate it on rawEnd-start reaching the cap, or document it.
  [LOW] The whitespace-fold check disables the ASCII fast path for ordinary text
    Evidence: privacy.ts:264 `!MULTI_WHITESPACE.test(text)`. About 1 MiB of ASCII prose takes 17ms base / 28ms r1 / 203ms head with '\n\n' paragraphs, and 183ms head with CRLF. Linear, perf only.
    Suggestion: fold inside the ASCII path, or build the map lazily.
  [LOW] Heavy perf test runtime is close to its timeout
    Evidence: it took 405s under machine load against a 600s timeout (privacy-gate.test.ts perf test). Flaky risk.

Focus answers:
  1) A/B and repros: see the HIGH for the A/B numbers.
     - Fixed: 0 regressions on the round-1 repros:
       - single keys with 20..600-char bodies: 0/20,000
       - realistic keys + stripped joiner + tail: 0/20,000
       - whitespace separator runs 1..80: 0/20,000
       - all 5 separator repros and the Bearer 33/40-space forms
       - sk 257/300, ghp/xoxb 257
     - The 43 FU-38 repros: 0 regressions vs base. There is one new head leak vs round 1: '9001011234567010123456789001011234567' (FU-32 leaks it too).
     - The three adjacency pins ('3010…', 'order 0101…', '3.1415…') are unmasked again, as on base.
     - Benign 200k corpus: 9,880 (4.9%) newly masked vs base, 0 lose masking. Round 1 was 18,937 (9.5%).
       - Long ASCII digit runs: 1.5%; zero-leading runs: 2.7% (round 1: 31% / 43%). What remains are exact RRN + phone/INTL82 tilings.
       - The rest is mostly supRunLong (5,642) and mixed super+ASCII (1,702), which are pre-existing design choices.
  2) Whitespace folding: no new FP or FN vs FU-32, because FU-32's SEPARATOR was already unbounded `*`.
     - '010\n\n1234-5678', '900101\n1234567', '번호\n900101\n\n2345678', '2026 11 11\n010 1234 5678' and 'id 123456\n<50sp>1234567': masked on base too (pre-existing cross-line merge); the last was unmasked only in r1.
     - Table pipes block merging ('| 010 |\n| 1234-5678 |' stays unmasked). 'score 12 34\n56 78' stays unmasked.
     - New recall: 'tel (  02  ) 123-4567'.
     - The 26 precision negatives are unchanged.
  3) CC over-masking: see the LOW. Plus the HIGH recall regressions.
  4) Perf (best-of-3 at 1/2/4/8 MiB, 27 shapes, own script): No super-linear growth found.
     - First run (machine load average 6-10): max per-doubling ratio 3.75, from a single noisy step of 'alt super/astral Nd' at 2->4 MiB. That shape grew only 5.7x from 1 to 8 MiB, and an idle re-run (best-of-5) gave max 2.55.
     - 'whitespace run 1000 between digits': 3.34 at 1->2 MiB, max 2.74 on the best-of-5 re-run (11.4x over 1->8 MiB). The cause is GC from per-char objects on the forced slow path (see the LOW).
     - Every other shape was <= 2.63, most 1.9-2.2. Examples: dense sk- extension 2.09, capped sk- words 2.12, ghp_+_ 2.12, cc-area retries 2.16, benign digit runs 2.03, mixed whitespace runs 2.43, Bearer ws-folded 2.41.
     - 8 MiB absolute times: uniform super 13.8s, uniform sub 13.4s, mixed super+ASCII 14.7s.
  5) GB-1 readiness: NOT ready at 78ad667.
     MUST before external transfer:
       (i) fix the CC HIGH (FU-32 pattern kept + area pattern added) and gate +cc glued/stripped forms;
       (ii) resolve or pin the same-kind/3-chain glued gate exclusion and the non-whitespace separator cap;
       (iii) wire assertRedactInputSize at the GB-1 call site (it counts UTF-16 units; the doc says 1 MiB);
       (iv) finalize the 05 §12 best-effort scope and consent notice, naming the uncovered classes.

Contract / license / security / migration impact:
  - Changed paths (git diff --name-only torgal/ohmydate...78ad667): packages/llm/src/privacy.ts, test/privacy.test.ts, test/privacy-gate.test.ts, test/fixtures/privacy-oracle.ts, test/fixtures/privacy-fu32-snapshot.ts. All within ALLOWED PATHS. This round touched only privacy.ts and privacy-gate.test.ts.
  - index.ts, package.json and pnpm-lock.yaml are unchanged (diff --exit-code 0). New exports MAX_REDACT_INPUT and assertRedactInputSize live in privacy.ts only.
  - No dependencies, no logging of values, no migrations. Commit is Conventional with 'Task: task_aa9c08f300bf'.
  - Security impact: the HIGH whole-phone disclosure regression.
  - Rollback: revert 78ad667.

Missing tests:
  - +cc with a separator after cc and glued/stripped groups ('+82 1012345678', '+1 4155552671', '+82-10-1234<ZWSP>5678', '+44 20 71838750') in the gate specs and the FU-32 A/B.
  - Glued '' same-kind pairs and the rrn/phone/rrn triple restored, or pinned as knownLimitations.
  - ASCII glued 3+ cross-kind chains.
  - Non-whitespace separator runs over 32 pinned.
  - Benign short '+' numerics ('+1 2 2026') as precision pins.

Verification actually executed: yes
  - corepack pnpm --filter @ohmydate/llm test -> exit 0 (8 files, 377 passed, 1 skipped)
  - PRIVACY_HEAVY=1 PRIVACY_PERF_ASSERT=1 corepack pnpm --filter @ohmydate/llm test -> exit 0 (8 files, 378 passed, 405.09s)
  - DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci -> exit 0
    - typecheck+lint ok; root 91 files, 1112 passed / 28 skipped; web 13 files, 69 passed; check:api-client clean; boundaries 239 files, 0 violations
  - git diff --check torgal/ohmydate...78ad667 -> 0
  - git diff --exit-code (index.ts, package.json, lockfile) -> 0
  - Round-1 gate file vs head (scratch vitest) -> exit 1 (1 failed / 28 passed)
  - Repo privacy suites vs fix variant v3 (scratch) -> exit 0 (318 passed / 1 skipped)
  - Scratch scripts, all exit 0: ab.mjs/abv.mjs (216k A/B for head, r1, v1/v2/v12/v3 attribution variants), cc.mjs, ccprec.mjs, caps.mjs, repro.mjs, repros2.mjs, kr.mjs, glued.mjs, chain.mjs, ws.mjs, ext.mjs, precv.mjs (200k benign), perf3b.mjs (best-of-3 scaling), plus an ASCII fast-path timing

git status --porcelain after review: (empty)

Residual risks:
  - Synthetic corpora cannot prove complete PII coverage.
  - Perf timings were taken under shared machine load (load average 6-10).
  - Attached super/sub markers remain ambiguous.
  - No real provider and no GB-1 payload wiring were exercised.
