# FU-38cR-1 (ctx_caf8182e1fbd, opus-fallback after Sol limit) — REQUEST_CHANGES

REVIEW VERDICT: REQUEST_CHANGES reviewer=opus-fallback (FU-38cRR round 1/2, head 05dc09d, merge-base b27e97d = torgal/ohmydate parent)

The ADR-019 redesign does fix every FU-32R/FU-38R-1/FU-38R2 repro. Numeric classes (RRN/phone, every style, mixtures, cross-kind, permutations) have 0 regressions vs FU-32. But the new L_max caps on API-key bodies cause whole-key disclosure regressions vs FU-32, which breaks the ADR-019 zero-regression merge gate.

Findings (most severe first):
  [HIGH] API-key body cap {..,256} rejects (instead of masking) any key whose glued word run passes 256 chars, incl. realistic keys joined by a stripped ZWSP/ZWNJ/U+00AD
    Evidence: packages/llm/src/privacy.ts:525,532,539,554 cap ghp_/github_pat_/sk|tk|pk/xox*/glpat- bodies at 256. Base used {20,}/{8,}/{10,}. When the cap lands mid-run, trimmedWordEnd (:868) returns undefined and the start is rejected; there is no fallback. Normalisation glues tokens across stripped default-ignorables, so the run continues into the next word.
      - k = 'sk-proj-' + 'Ab3'x52 (164 chars, a real OpenAI project-key length).
      - k+'​'+k, k+'­'+k, k+'‌'+k: base '[REDACTED_API_KEY]'; head leaves the FIRST key fully visible + '​[REDACTED_API_KEY]'. A space join is fine on both.
      - k+'​'+120-char word: head leaks the key whole.
      - 3 x 93-char github_pat_ joined by ZWSP: the first leaks whole.
      - Single bodies over 256 ('sk-'/'ghp_'/'xoxb-'/'glpat-' + 257 chars): base masks, head leaks whole. 256 is fine.
      - My A/B: same-kind 3-token key runs give 57 regressed tokens / 6,517 regressed glyphs (40 of 6,000 cases). Targeted: realistic keys (<=164 chars) + stripped joiner (ZWSP/ZWNJ/SHY/WJ/BOM) + tail regress in 4,468/20,000. Single keys with 20..600-char bodies regress in 11,872/20,000, all of them over 256.
      - The repo gate cannot see this. LITERAL_TOKENS (privacy-gate.test.ts:117) are 6 short fixed literals, and same-kind runs are built only from NUMERIC_TOKENS.
    Required change:
      - When a capped body reaches L_max and the original word run continues, accept the span and extend it to the end of the [A-Za-z0-9_-] run in the union stage. A precomputed run-end array keeps this O(n) and needs no new scan per prefix. This is FU-32 semantics.
      - Add same-kind key runs with ZWSP/ZWNJ/U+00AD/WJ/BOM joiners at realistic lengths (164-char sk-proj-, 93-char github_pat_) and >256-char bodies to the gate and the FU-32 A/B.
  [MEDIUM, Required] MAX_SEPARATOR=32 (:75) and Bearer \s{1,32} (:560-562) regress FU-32 recall on long separator runs; nothing pins it
    Evidence: base masks and head leaks whole:
      - 'tel 010'+33 spaces+'1234-5678'
      - '900101'+40 spaces+'-1234567'
      - '주민번호: 900101-\n'+40-space indent+'1234567'
      - '010'+33 x U+3000+'1234'+U+3000+'5678'
      - 'Bearer'+33 spaces+JWT
      - Exactly 32 is fine. Stripped ZWSP runs are not affected.
      - Random runs of 1..80 (space/tab/\n/U+3000/NBSP): 12,047/20,000 regress, every one with a total run over 32.
    Required change: the ADR-019 gate requires 0 regressions, so the coordinator must choose one of:
      (a) Restore recall while keeping L_max constant, e.g. treat a separator run as one normalised unit.
      (b) Record an ADR-019 amendment and pin these as knownLimitations tests. Precedent: 'email local part > 320', 'AIza > 40'.
  [MEDIUM, Required] The perf gate cannot detect quadratic growth
    Evidence: privacy-gate.test.ts:455 fails only when ratio > 4.5 per size doubling. O(n^2) gives 4.0 and passes. There is one sample per size.
      - PERF_SHAPES lacks uniform super/sub runs, separator runs at the cap, prefix-dense words ('sk-' x n), Bearer near-misses and glued ASCII phone chains.
    Required change: assert <= ~3.0 per doubling with best-of-3, or fit the slope, and add those shapes.
  [MEDIUM] Adjacency shortcut relaxes the right digit boundary: benign long ASCII digit runs get a 13-digit chunk masked even when the "continuation" is rejected
    Evidence: :893 'if (startsDigitTokenAt(map, rawEnd)) return rawEnd;'. It uses raw DIGIT_PROBES (:661-676) with no boundary/resolve check, and the RRN probe matches ~80% of 13-digit windows.
      - '301017393922089022553716133087249092' -> '[REDACTED_RRN]89022553716133087249092'. The continuation at 13 is rejected, yet the first chunk stays accepted. Base leaves it unmasked.
      - 'order 0101234567890123456789012' -> '[REDACTED_PHONE]90123456789012'
      - '3.14159265358979323846264338' -> '3.[REDACTED_RRN]'
      - Independent benign corpus, 200k cases (digit runs, dates, IPs, ISBN, UUID/SHA, prices, coords, footnotes, math, versions): 18,937 cases (9.5%) newly masked on head, 0 lose masking.
      - Long digit runs: 31% newly masked; 0-leading runs: 43%.
      - Not a leak, and all listed precision negatives are unchanged. It does contradict the "bounded adjacency" intent.
    Suggestion (recommended in the same round, with the gate re-run): treat a continuation as a right boundary only if it resolves itself (bounded chain). Pin long digit-run negatives.
  [MEDIUM, pre-existing, GB-1] Seoul landline in international format leaks whole on BOTH base and head
    Evidence:
      - Leak whole on both: '+82-2-1234-5678', '+82 2 1234 5678', '+82-2-123-4567' (also '+81 3-1234-5678', '+33 1 23 45 67 89').
      - Masked on both: '(+82) 2-1234-5678', '0082-2-1234-5678', '82-2-1234-5678', '+82-31-123-4567'.
      - Cause: CC_PHONE groups need >= 2 digits, and INTL_82 is blocked by notWordPlusBefore after '+'. It is the largest head-leak bucket in my phone fuzz.
    Suggestion: not a regression and not blocking FU-38c, but fix it or pin it as a knownLimitation before GB-1 external transfer (follow-up packet).
  [LOW] Throughput is linear but 1.2-16x slower than FU-32 on dense digit text
    Evidence (8 MiB, head vs base):
      - uniform super digits: 12.9s vs 2.7s
      - glued ASCII phone chain: 9.3s vs 0.56s
      - alternating super/ASCII: 9.5s vs 1.8s
      - '⁹⁰⁰¹⁰¹1234567' x n: 15.4s
      - Korean prose+contacts: 2.0s vs 1.7s
    Suggestion: cap the input size at the GB-1 call site (no caller of redact() exists yet outside packages/llm).
  [LOW] The oracle comparison checks only digit glyphs
    Evidence: requiredDigit at privacy-gate.test.ts:289 and :298, so email/key letters are asserted only by the snapshot A/B. The oracle shapes mirror the scanner's shape list, so it cannot find gaps both share (e.g. +82-2).
    Suggestion: check all core glyphs of literal tokens.

Focus asks:
  1) Own A/B harness (fresh xorshift128, no repo test code), 216,000 cases. Per-core-glyph span coverage vs torgal/ohmydate (FU-32).
     Corpus:
       - single 120,000: RRN/phone in plain, 8 Nd styles (fullwidth, math x5, segmented, outlined), Nd-mix, super, sub, all-style per-digit mixes; 8 phone shapes; email; 8 key families
       - same-kind 2-token 6,000 + 3-token 6,000
       - cross-kind pairs, 10 orders x 3,000 (RRN/phone/email/key, both orders)
       - 3-token permutations, 16 x 1,500
       - per-digit mixtures 30,000
     Joins: none/space/ZWSP/ZWNJ/U+00AD/WJ/BOM/', '/U+3000. Neighbours include circled/super/sub markers.
     Result: 0 token and 0 glyph regressions in every class except same-kind 3-token API keys (57 tokens / 6,517 glyphs, the HIGH). Improvements:
       - RRN all-style mix: fully masked 4,522 -> 6,269 of 6,295
       - phone all-style mix: 4,845 -> 6,011 of 6,200
       - mixdigit RRN: 10,043 -> 14,987 of 15,047
     Remaining head leaks are pre-existing: the +82-2 class, word-glued keys, and a 1-glyph leading super/sub marker in ambiguous marker+token runs.
  2) 43 repros run, incl. all five named strings and their ZWSP/ZWNJ/U+00AD/space/glued variants, the FU-32R-1 LOWs and the item-6 mixed tokens.
     Head exposes 0 digits in every case except 3 deliberately pinned attached-suffix markers (⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷², ⁰¹⁰-¹²³⁴-⁵⁶⁷⁸², ²𝟥𝟤…»), identical on base. 0 regressions.
  3) Oracle and snapshot:
     - The oracle imports nothing and shares no code or regex objects. Its regexes are rewritten (unbounded key bodies, single optional separators), so it is code-independent but spec-derived.
     - The snapshot is byte-identical: cmp exit 0; sha256 9820a8fe…8388 equals torgal/ohmydate:packages/llm/src/privacy.ts.
  4) No new false negatives from adjacency: all pair/permutation classes show 0 regressions. It does over-mask (MEDIUM above).
     26 precision negatives are unchanged on both refs: E=mc², x₁…x₁₀, 결과¹²³, ²⁰²⁶, H₂O, 10⁻¹²³⁴, 1010-1234-5678, dates, IPs, ISBN, cards, 16-20-digit runs, and others.
  5) No super-linear growth. 20 adversarial shapes at 1/2/4/8 MiB; max per-doubling ratio 2.47 (single run), most around 2.0-2.1.
     Shapes: overlapping super RRNs, uniform super/sub, alternating super/ASCII and super/astral Nd, ZWSP chains, many +cc retries, separators exactly at and just over MAX_SEPARATOR, the ⑳ shorter-end walk at the cap, glued RRN/phone chains, prefix-dense 'sk-', body-255, Bearer near-miss, long email local, mixed super+ASCII, circled markers.
  6) GB-1 readiness: NOT acceptable at this head. MUST before external transfer:
     (i) fix the HIGH key-cap regression;
     (ii) resolve or ADR-pin the separator cap;
     (iii) fix or explicitly scope-exclude '+82-2-…' (pre-existing, but a very common Korean format);
     (iv) finalize the 05 §12 best-effort scope and consent notice, naming the uncovered classes: obfuscated/IDN/spaced email, opaque bearer, bare JWT, AIza > 40, names, addresses, account numbers, Hangul/tilde digits;
     (v) cap input size at the call site.

Contract / license / security / migration impact:
  - Changed paths (git diff --name-only torgal/ohmydate...05dc09d): packages/llm/src/privacy.ts, test/privacy.test.ts, test/privacy-gate.test.ts, test/fixtures/privacy-oracle.ts, test/fixtures/privacy-fu32-snapshot.ts. All within ALLOWED PATHS.
  - index.ts, package.json and the lockfile are unchanged (diff --exit-code 0), and the exported symbols are the same set. No deps, no logging of values, no migrations.
  - Commit: Conventional, with Task: task_14e53c0c5bf9.
  - The removed-assertion grep shows only the added env-gated 'test.skip' alias. The removed knownLimitation '⁰¹⁰-¹²³⁴-⁵⁶⁷𝟖' is replaced by a stronger positive test.
  - Security impact: the HIGH whole-secret disclosure regression above.
  - Rollback: discard the branch or revert 05dc09d.

Missing tests:
  - Same-kind API-key runs joined by stripped joiners at realistic lengths, and key bodies > 256.
  - knownLimitations (or positive tests) for separator runs > 32 and Bearer whitespace > 32.
  - A linearity bound that rejects O(n^2), plus the perf shapes listed above.
  - Long benign digit-run precision negatives (>= 26 digits).
  - Oracle checks for letter glyphs in emails/keys.
  - '+82-2-…' pinned as a limitation or tested.

Verification actually executed: yes
  - corepack pnpm --filter @ohmydate/llm test -> exit 0 (8 files, 339 passed, 1 skipped)
  - PRIVACY_HEAVY=1 PRIVACY_PERF_ASSERT=1 corepack pnpm --filter @ohmydate/llm test -> exit 0 (8 files, 340 passed, 41.97s)
  - DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci -> exit 0, first attempt
    - typecheck+lint ok; root 91 files, 1074 passed / 28 skipped; web 13 files, 69 passed; check:api-client clean; boundaries 239 files, 0 violations
  - git diff --check torgal/ohmydate...05dc09d -> 0
  - git diff --exit-code (index.ts, package.json, pnpm-lock.yaml) -> 0
  - cmp snapshot vs base -> 0
  - Node 24.21 scripts in the session scratchpad, base/head loaded via type-stripping, all exit 0: ab.mjs (A/B), repro.mjs + caps.mjs (cap repros/quantification), repros2.mjs (43 repros + 26 negatives), kr.mjs (+82 forms), precision.mjs (200k benign), perf.mjs + perfcmp.mjs + perfmix.mjs (scaling).

git status --porcelain after review: (empty)

Residual risks:
  - Synthetic corpora cannot prove complete PII coverage.
  - Perf samples are single-run, not a complexity proof.
  - Attached super/sub markers next to digit tokens are inherently ambiguous; there is a 1-glyph leading-marker leak in ambiguous runs (pre-existing class).
  - Over-masking of long digit runs affects LLM utility.
  - No real provider and no GB-1 payload wiring were exercised.
