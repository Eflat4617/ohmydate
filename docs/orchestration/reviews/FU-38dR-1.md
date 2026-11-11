# FU-38dR-1 (ctx_265a8ecf4129, sol gpt-6.1-sol medium) — REQUEST_CHANGES

REVIEW VERDICT: REQUEST_CHANGES
Findings (most severe first):
  [HIGH] ASCII whitespace-fold fast path maps original offsets twice, exposing partial or whole secrets
    Evidence: packages/llm/src/privacy.ts:449 and :455; recordSpan at :1267-1271 first calls sourceAt (compact path already returns an ORIGINAL offset), then charStart/charEnd index compactSource again with that original offset.
    Reproduction actually executed against FU-32 and head: input "x\n\n010-1234-5678": FU-32 span [3,16), output "x\n\n[REDACTED_PHONE]"; head span [4,16), output "x\n\n0[REDACTED_PHONE]". Identical leading-glyph disclosures occur for RRN, email and API key, including CRLF and repeated tabs/spaces.
    Whole-number reproduction: 'intro' + ' '.repeat(30) + '010-1234-5678' + ' following prose '.repeat(5). FU-32 masks [35,48); head masks unrelated prose [64,78), leaving the ENTIRE phone visible.
    Independent 60,000-case whitespace-context A/B, seed 0x128acf21, per class (cases / regressed tokens / regressed core glyphs): single 10000/4526/6834; mixdigit 10000/4401/6541; same2 10000/2101/2800; same3 10000/2822/3580; pairs 10000/1801/2462; perms 10000/1685/2140. These are raw totals with no exemptions; single and mixdigit regressions alone violate the in-scope merge gate. Across the corpus: 13,235 regressed cases, 17,336 tokens, 24,357 glyphs.
    Required change: make compact coordinate conversion consistent (sourceAt has already converted to original coordinates), and add original-span/core-glyph assertions after preceding and internal folded whitespace, with trailing prose and multiple tokens. Rerun both independent A/B and perf gates.
  [MEDIUM] Recall assertions exclude cases beyond ADR-019 (10)-(11)
    Evidence: packages/llm/test/privacy-gate.test.ts:231 excludes 'key pair ghp_aaaaaaaa join=""' under a comment attributing all exclusions to ADR-019 (10). That amendment permits same-kind NUMERIC windows and 3+ glued ASCII cross-kind chains, not API-key pairs. At :469-475 a separate prefix/suffix predicate silently skips every generated glued permutation, even though generated permutations at :458 contain a superscript RRN rather than exclusively ASCII tokens. This is broader than the named-list requirement.
    Reproduction: the 93-character ghp_ glued pair is unmasked by both FU-32 and head (both spans=[]), so including it in the FU-32 no-regression assertion already passes; skipping that assertion is unnecessary. Read ADR-019 including amendments (5)-(11) from the base branch.
    Required change: restrict A/B exemptions to explicitly named, ADR-authorized cases; keep pre-existing unmasked API-key parity covered by the baseline comparison. Separate an oracle must-mask exception from a no-regression exception where needed, and do not blanket-exclude non-ASCII glued permutations.

Contract / license / security / migration impact:
  Reviewed git diff torgal/ohmydate...e7feb7e at HEAD e7feb7eb8ea3d740f03f7d9d8d1706e96623d688 (merge base b27e97d). All five changed paths are allowed: packages/llm/src/privacy.ts; packages/llm/test/privacy.test.ts; packages/llm/test/privacy-gate.test.ts; packages/llm/test/fixtures/privacy-oracle.ts; packages/llm/test/fixtures/privacy-fu32-snapshot.ts.
  Security: confirmed disclosure regression above blocks ADR-019 zero-regression acceptance. CC_PHONE_SOURCE declaration is byte-identical to FU-32; its old no-minDigits behavior, shorterEnd and exact shape are preserved, with separator caps subject to ADR (11). The separate area pattern uses minDigits=8 and the required five examples pass. The snapshot is byte-identical to torgal/ohmydate:packages/llm/src/privacy.ts.
  Section 4 checklist applied: correctness and ADR gate fail as described; no new domain/upstream boundary violations, dependencies/licenses, contracts/OpenAPI, migrations, I/O, logging or auth/owner changes. Mutation concurrency, time zones and problem+json are unaffected. Public barrel/package/lockfile have no triple-dot changes; commits are Conventional with Task trailers. Removed mixed-digit known-limitation assertion is replaced by a stronger positive test; the two performance tests are env-gated. Rollback: do not merge this candidate.
  Independent first A/B used a fresh xorshift generator (seed 0x51acd201), actual FU-32 loaded via git show, and 62,000 cases: single 12000, mixdigit 10000, same2 8000, same3 8000, pairs 12000, perms 12000. Each class had 0 regressed tokens / 0 core glyphs without exclusions. It covered ASCII/fullwidth/five math Nd styles/segmented/outlined/super/sub/per-digit mixtures, +cc separated/glued/stripped groups, multiple key families and 20-600-character bodies, and glued/space/ZWSP/ZWNJ/SHY/WJ/BOM joins. Adding ordinary folded whitespace contexts in the second independently generated corpus exposed the HIGH.
  Precision probes '+1 2 2026', '+44 1 234', '+1 2 2026-11-11', v1.2.3, 192.168.1.1, 2026-11-11, E=mc², H₂O, 10⁻¹²³⁴ and the long pi-like negative were unchanged versus FU-32.
Missing tests:
  - Core-glyph coverage and exact original spans for every token kind following ASCII paragraph breaks, CRLF, repeated spaces/tabs, including long whitespace before secrets and enough following prose to expose whole-token displacement.
  - Multiple tokens with folding before/inside/between them; parity checks for pre-existing key limitations and non-ASCII permutations currently excluded.

Verification actually executed: yes — Node v24.21.0, corepack pnpm 12.18.0.
  - corepack pnpm --filter @ohmydate/llm test -> exit 0; 8 files, 425 passed / 2 skipped.
  - PRIVACY_HEAVY=1 PRIVACY_PERF_ASSERT=1 corepack pnpm --filter @ohmydate/llm test -> exit 0; 8 files, 427 passed, 319.26 seconds.
  - DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci -> exit 0; typecheck/lint pass; root 91 files, 1160 passed / 29 skipped; web 13 files, 69 passed; generated API client unchanged; boundaries 239 files, 0 violations.
  - git diff --check torgal/ohmydate...e7feb7e -> exit 0.
  - git diff --exit-code torgal/ohmydate...e7feb7e -- packages/llm/src/index.ts packages/llm/package.json pnpm-lock.yaml -> exit 0.
  - node --input-type=module <<'JS' (inline, no files: 62k fresh-generator FU-32/head A/B, source/snapshot equality, precision probes) -> exit 0.
  - node --input-type=module <<'JS' (inline, no files: 60k fresh-generator whitespace-context A/B with per-token/core-glyph coverage) -> exit 0; regression counts above (diagnostic script reports rather than asserting).
  - node --input-type=module <<'JS' (inline targeted partial/whole-disclosure reproductions and ghp_ parity) -> exit 0.
  - node --input-type=module <<'JS' (inline independent best-of-3 1/2/4/8 MiB performance harness) -> exit 0. Results in milliseconds:
      dense-key-prefix: 341.73 / 684.99 / 1470.16 / 3112.01 (doubling ratios 2.004/2.146/2.117)
      cc-retries: 74.78 / 160.95 / 316.36 / 689.31 (2.152/1.966/2.179)
      glued-rrn-phone: 139.52 / 283.73 / 589.43 / 1239.74 (2.034/2.077/2.103)
      separator-cap near-miss: 26.95 / 52.03 / 104.12 / 206.56 (1.931/2.001/1.984)
    No super-linear growth observed; shared-machine timings are sanity evidence, not a complexity proof.
git status --porcelain after review: empty (exit 0); no reviewer edits, commits, or report files.
Residual risks:
  GB-1 readiness: NOT ready for external transfer at e7feb7e. The whitespace mapping HIGH violates the zero-regression gate despite all repository checks passing; repair it and rerun expanded independent coverage before approval. The existing future-call-site input guard remains unwired, and GB-1 still requires the finalized best-effort scope/consent notice; names, addresses, account numbers, obfuscated/IDN email, and documented unsupported formats remain outside scanner guarantees. No real provider or outbound-payload wiring was exercised.
  Synthetic corpora cannot prove complete PII recall; attached super/sub markers remain ambiguous.

