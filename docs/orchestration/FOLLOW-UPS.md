# Follow-ups (non-blocking residual items from accepted reviews)

| ID | From | Item | Severity | Target |
|---|---|---|---|---|
| FU-01 ✅ | M1-01R3 | boundary checker: `file:` URL specifiers classified external (normalize via fileURLToPath or forbid) | MEDIUM | before M2 |
| FU-02 ✅ | M1-01R3 | boundary checker: `__fixtures__` exclusion applies repo-wide; scope to scripts/__fixtures__/boundaries | MEDIUM | before M2 |
| FU-03 ✅ | M1-01R3 | checker tests: d.ts web/service+upstream, inline type re-exports, effective pnpm config assertions | LOW | before M2 |
| FU-04 | FU-01R | boundary checker: `FILE:` uppercase/mixed-case scheme bypass (case-insensitive scheme check + regressions) | MEDIUM | with next checker touch |
| FU-05 | M1-03R3 | testkit: two race tests prescribe the winner (L534/L585); allow either serializable winner in shared suite, keep InMemory-specific delayed-lookup regression | MEDIUM | before Native adapter (M7) or next testkit touch |
| FU-06 | M1-03R3 | provider-native validation.ts offset normalization uses Date arithmetic; move to shared time utility | LOW | next domain time utility work |
| FU-07 | M1-03R3 | commit pending-create failure/cleanup/retry coverage | LOW | next testkit touch |
| FU-08 | Sol fallback | Sol 복귀 후 사후 리뷰: M1-05(동시성/변경피드), M3-01b(스케줄러 하드 제약) — Opus fallback 승인분 | HIGH-risk area recheck | Sol 사용 가능 시 |
| FU-09 | M1-07R2 | web: ConflictDialog focus trap, Escape=Keep editing, suppress global shortcuts while open; editor inert under dialog (overwrite must not discard newer draft) | MEDIUM | M1-08 or before M2 UI |
| FU-10 | M1-07R2 | web: mint fresh Idempotency-Key when If-Match changes (overwrite/re-save) | MEDIUM | with FU-09 |
| FU-11 | M1-07R2 | web: remove dead IdempotencyKeyStore export; Cancel offline claim; Inbox lists all tasks (filter by Inbox project); reload() errors surfaced; keys UUIDv7 per 07 §6 | LOW | with FU-09 |
| FU-12 | M3-01bR | scheduler: validator date labels derived by a different method (toPlainDate at segment start) to make ADR-017 implementations truly independent; fix "independently" wording | MEDIUM | M3-02 |
| FU-13 | M3-01bR | scheduler tests: exact slot-interval equality vs minute walk with varied windows; multi-block H6 on revisited date; St_Johns/Santiago-April/Apia/Troll/Lord_Howe edge fixtures; runaway-guard test or documented throw | LOW | M3-02 |
