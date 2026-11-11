# FU-38dR2 (ctx_56a43299d88f, sol gpt-6.1-sol medium) — APPROVE (GB-1 scanner gate)

REVIEW VERDICT: APPROVE
Findings (most severe first):
  [LOW] One unnecessary non-ASCII cross-kind triple remains in the A/B exemption set
    Evidence: packages/llm/test/privacy-gate.test.ts:229 exempts 'triple rrn/phone/rrn join=""', but its construction at :292-294 uses superscript RRNs and an ASCII phone. ADR-019 (10) authorizes same-kind glued numeric windows and 3+ glued ASCII cross-kind chains, so this mixed-script cross-kind triple does not fit that exception. Independently executed reproduction '⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷010-1234-5678⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷': FU-32 masks only [14,27); head masks [0,14), [14,27), [27,41), producing '[REDACTED_RRN][REDACTED_PHONE][REDACTED_RRN]'.
    Suggestion: remove this entry from ADR_OUT_OF_SCOPE_CASES and consequently from the oracle exceptions; keep its already-passing coverage asserted. Nonblocking in this final round because no disclosure regression or super-linear behavior was found.

Contract / license / security / migration impact:
  Reviewed full git diff torgal/ohmydate...8f2db58 at HEAD 8f2db58e7a9bb269beda311943d38b3b3a7ba32f. All five paths are within FU-38d ALLOWED PATHS (packages/llm/src/privacy.ts and packages/llm/test/**): privacy.ts, privacy.test.ts, privacy-gate.test.ts, fixtures/privacy-oracle.ts, fixtures/privacy-fu32-snapshot.ts.
  Previous HIGH is repaired: charStart/charEnd at privacy.ts:452-459 now consume the original offsets returned by sourceAt exactly once. Direct reproductions equal FU-32, including reports/spans: "x\n\n010-1234-5678" masks [3,16); "intro" + 30 spaces + phone + trailing prose masks [35,48).
  Frozen snapshot is byte-identical to actual torgal/ohmydate:packages/llm/src/privacy.ts, loaded independently using git show. CC_PHONE_SOURCE declaration is byte-identical; original CC minDigits absence, shorterEnd and exact behavior remain, subject to ADR-authorized separator caps. Separate one-digit-area pattern retains minDigits=8; required supported and negative examples pass.
  The ghp_ pair is now included in A/B comparison and excluded only from oracle must-mask assertions; independently confirmed both versions return spans=[] for the realistic glued pair. Generated permutations are no longer blanket-exempted; the same2/same3 glued predicate is confined to same-kind numeric classes. One extra named exception remains as the LOW above. Non-whitespace separator limitations are explicitly pinned.
  Independent regenerated A/B versus actual FU-32, same prior seeds and class counts (prior inline harness source was not persisted):
    seed 0x51acd201, 62,000 cases: single 12,000; mixdigit 10,000; same2 8,000; same3 8,000; pairs 12,000; perms 12,000.
    seed 0x128acf21, whitespace contexts, 60,000 cases: 10,000 each of single/mixdigit/same2/same3/pairs/perms.
    EVERY class in BOTH corpora: 0 regressed tokens / 0 regressed non-whitespace core glyphs, including RAW totals before exemptions. Styles include ASCII/fullwidth/five math Nd sets/segmented/outlined/super/sub/per-digit mixtures; numeric groups, 20-600-character key bodies, email, glued/space/ZWSP/ZWNJ/SHY/WJ/BOM joins, folded whitespace and trailing prose. A further independent 12,000-case supplemental +cc and numeric cross-kind pair corpus has 0 lost FU-32-covered code units.
  Independent best-of-3 performance: 1 MiB ASCII prose with paragraphs FU-32 15.409 ms, head 41.782 ms, ratio 2.712 (<3). Dense key-prefix adversarial shape at 1/2/4/8 MiB: 198.078 / 389.311 / 825.103 / 1884.354 ms; doubling ratios 1.965 / 2.119 / 2.284 (<3). Heavy repository gate also passes every adversarial shape through 8 MiB.
  Contract §4 applied: correctness/ADR and negative tests reviewed; no new domain/upstream boundary violations, dependencies/licenses, API contracts/OpenAPI, migrations, I/O or sensitive logging. Authentication/owner scope, mutation concurrency, time zones and problem+json are unaffected. Existing mixed-digit limitation assertion was replaced with stronger positive coverage; no deleted/skipped existing behavioral tests or weakened assertions. Two new perf cases are explicitly environment gated. Public barrel/package/lockfile are unchanged; commits are Conventional Commits with Task trailers. Rollback is to decline/revert the candidate before integration.

Missing tests:
  Remove the unnecessary mixed-script triple exemption and assert its present successful masking directly.
  No remaining test gap blocks this round's scanner gate; the prior whitespace-context missing tests are now present.

Verification actually executed: yes — Node v24.21.0, corepack pnpm 12.18.0.
  - corepack pnpm --filter @ohmydate/llm test -> exit 0; 8 files, 436 passed / 2 env-gated skipped, 2.90 s.
  - PRIVACY_HEAVY=1 PRIVACY_PERF_ASSERT=1 corepack pnpm --filter @ohmydate/llm test -> exit 0; 8 files, 438 passed, 377.66 s.
  - DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci -> exit 0; typecheck and lint passed; root 91 files, 1171 passed / 29 skipped; web 13 files, 69 passed; check:api-client clean; boundaries 239 files / 0 violations.
  - git diff --check torgal/ohmydate...8f2db58 -> exit 0.
  - git diff --exit-code torgal/ohmydate...8f2db58 -- packages/llm/src/index.ts packages/llm/package.json pnpm-lock.yaml -> exit 0.
  - node --input-type=module <<'JS' (inline, no files: actual FU-32/head loader, snapshot and CC declaration equality, direct reproductions, 16 precision probes, independent 62k + 60k A/B) -> exit 0; per-class results above.
  - node --input-type=module <<'JS' (inline, no files: best-of-3 prose and dense-key-prefix 1/2/4/8 MiB performance assertions) -> exit 0; timings above.
  - node --input-type=module <<'JS' (inline, no files: named exception and ghp_ parity reproductions, supplemental 12k +cc / phone-RRN A/B) -> exit 0.
  - git status --porcelain; git diff --exit-code; git diff --cached --exit-code -> each exit 0, no output.
git status --porcelain after review: empty (exit 0); no reviewer edits, files, commits, or report artifact.
Residual risks:
  Scanner-only GB-1 readiness: APPROVED at 8f2db58 on the executed recall and performance evidence. Actual provider wiring/external transfer still depends on the separate user decision finalizing the best-effort scope and consent notice; this review does not make that decision or validate an outbound payload.
  MAX_REDACT_INPUT/assertRedactInputSize remain unused by callers; enforce the guard when wiring real provider calls.
  Synthetic corpora cannot prove complete PII recall. Prior 62k/60k scripts were inline and unavailable, so this review regenerated equivalent class/seed/size coverage rather than claiming byte-identical corpus replay.
  Pre-existing glued realistic ghp_ pairs remain unmasked; ADR-authorized glued numeric windows/ASCII chains and >32 non-whitespace separator runs remain limited. Names, addresses, account numbers, obfuscated/IDN email and other unsupported formats are outside scanner guarantees; attached super/sub markers remain ambiguous.
  Shared-machine timings are sanity evidence, not a mathematical complexity proof.
