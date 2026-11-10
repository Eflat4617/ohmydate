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
| FU-14 ✅ | M1-05R3 | vikunja feed: remote watermark from reconciliation scan (Vikunja time / max updated seen − overlap), not journal entry time; tests external edit during poll + planner clock ahead | MEDIUM | FU-14 task (now) |
| FU-15 ✅ | M1-05R3 | vikunja feed: fresh-epoch snapshot on first use of an owner (any read/append) or null path always snapshots mappings | MEDIUM | FU-14 task (now) |
| FU-16 ✅ | M1-05R3 | vikunja: content fingerprint on mapping so same-second lost-response updates are detected (ETag is per-second) | MEDIUM | FU-14 task (now) |
| FU-17 ✅ | M1-05R3 | vikunja LOWs: create follow-up spurious bump; lost-response recurring completion status; completedOccurrenceAt semantics = completed occurrence dueAt (coordinator: use dueAtBefore); concurrent null polls | LOW | FU-14 task (now) |
| FU-18 | FU-09R / ADR-018 | Project.kind inbox (contracts, domain, migration 0002, in-memory, vikunja, api user-create, web) | MEDIUM | after M1-06 merges |
| FU-19 | FU-09R | web: overwrite double-click (disable dialog actions while busy; rotate key only when If-Match changed); focus trap via inert/focusin; real-path overwrite test; conflictOpen counter; claim drift fixes | MEDIUM/LOW | with FU-18 web part |
| FU-20 | M1-06R2 | domain port: softDelete returns new Version (remove full change-feed scan in TaskService.remove); x-trace-id/replay traceId semantics; session cookie sliding Max-Age; limiter/session map pruning | LOW | with FU-18 |
| FU-21 | M1-06cR | api: drop numeric trustProxy (Fastify ignores hop counts); declare 503 on listProjects/createProject (contract) ; warn-log 503 provider outages + Retry-After; tests: release-failure warn, 503 on all task routes, 428/412 matrix for :complete/DELETE/deps, replay fidelity PATCH/:complete/DELETE, 24h expiry, session expiry 401, outbox failure rollback; pending idempotency TTL | LOW | with M1-10 |
| FU-22 | FU-14R2 | vikunja: mapping put compare-and-set on localVersion (poll racing create relation window / update / complete reuses a version); 304-as-success only for PATCH; GET 304 negative test; multi-dependency create test | MEDIUM | M1-10 (PG MappingStore precondition) |
| FU-23 | FU-18R | Vikunja adapter adopts ADR-018: set kind (default project -> inbox), implement getInbox; then make domain Project.kind/getInbox required, drop `?? normal` default and Version|void union | MEDIUM | after M1-10 merges |
| FU-24 | M2-01cR | llm redaction: on boundary rejection retry at start+1 (fuzz 324 leaks -> 0); +cc end-side fallback to shorter group count; original-char rule for \b and word lookbehinds; known limits for >320-char runs and >63-char labels; budget allow-list exempts only usd===undefined and validates array — GATES enabling a real LLM provider (GB-1) | MEDIUM | FU-24 task (now) |
