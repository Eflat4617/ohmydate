# FU-81R (ctx_d8d8e80d71f3, Fable 5.2 xhigh — Sol weekly limit; implementer Opus) — APPROVE

REVIEW VERDICT: APPROVE
Reviewed torgal/ohmydate...cd6b0db (merge-base 88feb4f) read-only; reviewer Fable 5.2 xhigh in place of Sol. No CRITICAL/HIGH/required-MEDIUM. All five focus points hold: (1) reproduced live; (2) owner-scoped, bound defers and never drops while the task is in the trash, idempotent, retries after a failed read; (3) FU-73 watermark kept, no phantom or double bump; (4) tests fail on base; (5) package tests exit 0.

Findings (most severe first):
  [LOW] Unreadable (404/403) dependents are charged to the 50-read budget on every poll and never leave the candidate set
    Evidence: packages/provider-vikunja/src/task-repository.ts:1762-1768 (budget -= 1 before the read; NotFoundError -> continue, fingerprint still names the trashed task). Reviewer scratch test on HEAD with the worker's fake: 1 purged dependent -> zombie reads per poll [1,1,1,1,1]; 50 purged dependents created before 1 real dependent -> 4 incremental polls each "zombieReads=50 realReads=0 realVersion=1", get(real) = v1 with dependsOn=[]; only a null-cursor scan gave [1,2]. So the doc claim "repeated polls skip it / do no reads" (task-repository.ts:1726-1729) is not true for these, and >=50 of them starve later dependents on incremental polls. Such live-but-unreadable mappings are real: measured live, tasks of a trashed project answer 404 (code 3018) and never appear in /tasks/deleted. Impact is small today: production only polls through the 300 s reconciler null sweep, which heals real dependents in the live scan.
    Suggestion: do not let NotFound reads consume the budget real dependents need (separate cap, or handle unreadable candidates last), and add a unit test.
  [LOW] The eager softDelete follow-up is unbounded in time and silent on every error
    Evidence: task-repository.ts:1071-1079 and 1741-1771. Up to 50 sequential GETs run inline before DELETE returns, each with the client's full budget (3 x 10 s + backoff, client.ts:142-158), so a slow-but-answering provider can stretch a delete by minutes (API connection timeout default 300 s). The bare `catch {}` also swallows store/journal errors: if the mapping put in #commitReconciled succeeds and the journal append throws, the dependent is bumped without a journal entry and no longer names the task, so nothing retries (same non-atomicity as elsewhere, but here invisible).
    Suggestion: time-box or shrink the eager pass (the poll already continues it) and swallow only provider errors.
  [LOW] Per-poll cost is permanent once anything is in the trash
    Evidence: task-repository.ts:1707 + 1742. Every poll with a mapped task in /tasks/deleted (and every softDelete) loads all of the owner's mapping rows (PgMappingStore.listByOwner selectAll, including tombstones and projects) and JSON-parses each live task fingerprint. Fine at single-user scale (ADR-016 §3).
    Suggestion: follow-up for a store-level reverse-edge query (needs a MappingStore contract change, outside this packet).

Contract / license / security / migration impact: none. Changed paths are all inside packages/provider-vikunja/** (src/task-repository.ts, test/contract.test.ts, test/unit/task-repository.deleted-dependents.test.ts). No contracts/OpenAPI, schema, migration, MappingStore interface or dependency change; one new constant exported from task-repository.ts only (not from index.ts). Owner scope verified in code (listByOwner + ownerId re-check + owner's client; trashed set built only from the owner's mappings) and by test, including a cross-owner relation: 0 reads with the other owner's token. No logging added. Intended behaviour change: deleting a task now bumps each dependent's version once, so a client holding the dependent's old version gets a conflict (FU-14R LOW). ADR-016 FU-73 amendment is consistent with the fix. Commit is Conventional with a Task trailer; no test deleted, skipped or weakened (the contract §2.4 grep has no match).

Missing tests (all non-blocking; the first four pass in reviewer scratch runs):
  - own delete with more than 50 dependents (eager 50, next poll takes the rest, each [1,2])
  - softDelete racing a poll, and two concurrent polls, on the new path (one bump, one journal entry)
  - FU-73: the dependent's own relation touch landing after the eager reconcile is absorbed (no v3); a touch after the watermark bumps once
  - unreadable (404/403) dependent: per-poll read cost and budget starvation (finding 1)
  - a PgMappingStore-backed regression in services/api (reverse edges are only exercised with the in-memory store)
  - live: assert no delayed touch of the dependent some seconds after the delete (reviewer measured manually: none after 4 s)

Verification actually executed: yes (env DATABASE_URL=postgres://ohmydate:...@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456)
  - git diff --name-only torgal/ohmydate...cd6b0db -> 3 files, all in allowed paths; git diff --check -> exit 0; git merge-tree --write-tree torgal/ohmydate cd6b0db -> exit 0 (clean merge; base moved 4 docs-only commits)
  - corepack pnpm --filter @ohmydate/provider-vikunja test -> exit 0 (15 files; 145 passed | 9 skipped)
  - vitest run --globals test/contract.test.ts -t "FU-81" -> exit 0 (the live FU-81 test ran, 1 passed, 4.7 s; not skipped)
  - corepack pnpm run ci -> run 1 exit 1: one failure in apps/web test/m6-03r-findings.spec.ts "unlink 412 after a link-only remote change rebases silently" (expected length 1, got 0). The file is untouched by this diff and the run overlapped my own live/scratch test load. That spec alone: 3 runs, exit 0 each (15 passed). Run 2 with nothing else running -> exit 0: root 173 files, 2142 passed | 29 skipped; web 53 files/499 passed and 6 files/156 passed; boundary check 526 files 0 violations; build-smoke /healthz 200.
  - Base spot-check: the new unit file against torgal/ohmydate source (scratch copy, only the missing constant appended) -> exit 1, 8 failed | 4 passed (the 3 negatives and the null-scan backstop pass by design). Matches the worker claim.
  - Reviewer live reproduction (scratch vitest, synthetic user, Vikunja v2.8.0) -> exit 0. Own delete of B1: A1 and M (depends on K + B1) at v2 right after softDelete, feed [B1:v2:deleted, A1:v2, M:v2], M keeps K; A1 updated/ETag identical before, right after and 4 s after the delete, next poll empty. Remote delete of B2: feed [B2:v2:deleted, A2:v2]. Deleting a dependent C: its dependency D not touched and not bumped. Three more incremental polls empty; null scans: A1/A2/M [1,2], U/K/D [1]; stale v1 write conflicts, v2 write -> v3.
  - Reviewer adversarial scratch tests on HEAD -> exit 0 (20 passed incl. the worker's 12): results in findings and missing tests above.
  - Raw API probe (synthetic user) -> exit 0: see residual risks.

git status --porcelain after review: empty (HEAD cd6b0db; no repository file created, modified or committed; scratch only under the session temp dir)

Residual risks:
  - Remote project delete has the same defect and is not covered (outside this packet's task-delete scope; suggest a follow-up). Measured live: deleting a project drops the blocked relation of dependents in other projects without touching their updated/ETag; the project's tasks answer 404 (code 3018) and are not in /tasks/deleted, so they are never tombstoned and the dependents are not rescanned on incremental polls (a null scan fixes the dependents).
  - Restore is not handled (pre-existing). Measured live: POST /tasks/{id}/restore re-attaches the relation without touching the dependent; the restored task's mapping stays tombstoned.
  - Permanent delete that skips the trash, or a trash emptied before a poll or before a failed follow-up is retried: only the null-cursor scan fixes the dependents (documented by the worker; unit-tested for the failed-follow-up case).
  - Until the follow-up reaches a dependent (remote delete before the next poll, beyond the 50 bound, or a failed read), get() serves dependsOn=[] under the old version. In production the next poll is the 300 s reconciler sweep.
  - A mapping with no content fingerprint (legacy row) is never versioned for a lost dependency, not even by a null scan (pre-existing FU-17 semantics; confirmed in scratch: stays v1).
  - apps/web m6-03r-findings spec is timing-sensitive under host load (unrelated to this change) and can fail a CI run.
  - Still open for the coordinator: the ADR-016 note under the FU-73 amendment and the FU-81 status in FOLLOW-UPS (outside the worker's allowed paths).
