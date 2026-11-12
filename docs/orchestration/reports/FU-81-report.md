# FU-81 worker report

- taskId: task_2ba2fd0a33ac
- dispatchId: ctx_ac7a425f26fc
- worktree: /home/torgal/orca/workspaces/oh_my_date/fu-81-deleted-dependents
- branch: torgal/fu-81-deleted-dependents (base 88feb4f)
- commit: cd6b0db fix(provider-vikunja): surface dependents of a deleted task once (FU-81)
- git status: clean

## Changed paths (git diff --name-only 88feb4f...HEAD)
- packages/provider-vikunja/src/task-repository.ts (+131/-11)
- packages/provider-vikunja/test/contract.test.ts (+104)
- packages/provider-vikunja/test/unit/task-repository.deleted-dependents.test.ts (new, 678 lines)

## Diff summary
- New `#reconcileDeletedDependents(owner, client, deletedExternalIds)`. It runs one `listByOwner`
  and picks the live task mappings whose content-fingerprint `relations` (the reverse edges)
  name a deleted external id. For each one it re-reads the mapping, then the task (GET), then calls
  `#commitReconciled`. Result: one bump and one journal entry per dependent, FU-73 watermark kept
  through `latestInstant`.
- `softDelete`: after the tombstone is committed and journaled, the rescan runs as a best-effort
  pass scoped to the deleted task. A failure here never fails the delete; the next poll retries.
- `#reconcileRemote`: the deleted-scan loop collects every one of this owner's tasks in
  `/tasks/deleted`, whether tombstoned now or earlier. It then calls the rescan, which makes a
  failed re-read retryable by the next poll.
- New exported constant `DELETED_DEPENDENT_RESCAN_LIMIT = 50` (provider reads per call). Not
  re-exported from index.ts.
- Helpers `recordedRelations(fingerprint)` and `namesAnyOf`. Doc comments updated on the class,
  `softDelete` (FU-14R LOW text) and the new method.

## Live reproduction (before the fix, Vikunja v2.8.0, synthetic user)
Temporary diagnostic, deleted before commit. Scenario: B1 and B2, A1 depends on B1, A2 depends on
B2, and an unrelated U created 2.1 s later so the incremental watermark passes A1 and A2.
```
null feed ["B1:v1","A1:v1","B2:v1","A2:v1","U:v1"]
A1 remote before delete: updated 2026-11-12T01:46:58Z etag "1794448018000000000-2" blocked [84986]
A1 remote after  delete: updated 2026-11-12T01:46:58Z etag "1794448018000000000-2" blocked []
incremental after own delete of B1 ["B1:v2:deleted"]
A2 remote before delete: updated ...46Z etag "...-2"
A2 remote after  delete: updated ...46Z etag "...-2" blocked []
incremental after remote delete of B2 ["B2:v2:deleted"]
incremental again []
get A1: version 1 dependsOn []
get A2: version 1 dependsOn []
```
This confirms the evidence: Vikunja drops the relation synchronously and leaves the dependent's
updated/ETag unchanged. The dependent is never delivered, and the same v1 now has different
content.

After the fix, same diagnostic:
```
incremental after own delete of B1 ["B1:v2:deleted","A1:v2"]
incremental after remote delete of B2 ["B2:v2:deleted","A2:v2"]
incremental again []
get A1: version 2 dependsOn []
get A2: version 2 dependsOn []
```

## Requirement checklist
1. Reproduce live, own delete and remote delete: **met** (output above). The new live contract
   test also failed on the old code: `expected 1 to be 2` at the dependent's version after
   softDelete.
2. Fix:
   - own delete and remote delete (via /tasks/deleted) re-read the dependents found through
     reverse edges and commit the new fingerprint/version: **met**
   - bounded (one listByOwner, at most 50 reads, unrelated tasks never read): **met**
   - owner-scoped: **met**
   - idempotent across repeated polls: **met**
   - no phantom bumps for unrelated tasks, FU-73 watermark preserved (asserted unchanged): **met**
3. Tests:
   - deterministic fake-client unit tests for own delete and remote delete: **met**
   - negatives: unrelated task not bumped/read, and a dependent already reconciled (by the live
     scan, or by a conflicting write) not bumped twice: **met**
   - live contract test: **met**
   - "Reverse edges in the mapping store": the store has no reverse-edge index. I derived the
     edges from the existing `contentFingerprint.relations` through the existing `listByOwner`,
     so there is no MappingStore interface, Postgres or migration change.

Unit tests (12, in task-repository.deleted-dependents.test.ts):
- own delete: the dependent gets one new version without the dependency. Checks: 1 read, 0 reads
  of other tasks, FU-73 watermark unchanged, stale v1 write conflicts, v2 write succeeds.
- remote delete: the poll surfaces it; repeated polls do no reads.
- two dependencies deleted before one poll give one bump.
- one remaining dependency is kept.
- negative: already reconciled by the live scan, so no second bump (1 read).
- negative: reconciled by a conflicting write, so the poll does not bump again.
- negative: deleting a task with no dependents reads and bumps nothing else (with the
  server-side inverse `blocking` relation present).
- durability: an own-delete follow-up read fails (503), the delete still returns v2, and the next
  poll bumps once.
- durability: a remote-delete follow-up fails the poll, and the retry with the same cursor
  delivers one tombstone and one bump.
- durability: trash emptied before the retry, so the null-cursor scan bumps once.
- bound: limit+2 dependents are handled as 50 on the first poll and 2 on the next, each [1,2].
- owner scope: shared fake server and per-owner tokens. One owner's polls and deletes never read
  or bump another owner's stale dependent.

Negative control: against the original task-repository.ts, 8 of 11 failed (the 3 negatives
pass on both, by design). The 12th test was added afterwards and targets the null-scan backstop.

## Tests (DATABASE_URL=postgres://ohmydate:...@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456)
- `corepack pnpm --filter @ohmydate/provider-vikunja test` -> exit 0
  - `Test Files  15 passed (15)`
  - `Tests  145 passed | 9 skipped (154)`
  - The 9 skips are the existing strictConcurrency=false / idempotentCreate=false capability
    gates.
- `corepack pnpm run ci` -> exit 0
  - root vitest: `Test Files 173 passed`, `Tests 2142 passed | 29 skipped`
  - web: `53 passed / 499 passed` and `6 passed / 156 passed`
  - eslint clean
  - `Boundary check passed: 526 file(s), 0 violations`
  - build-smoke `/healthz 200`

## Risks / unverified
- Cost: every poll whose owner has a mapped task in `/tasks/deleted` makes one extra `listByOwner`
  DB query and parses each live mapping's fingerprint. Provider reads happen only for stale
  dependents. The poll already lists the whole trash over HTTP, so this is the same order of cost.
- Trash emptied before a failed follow-up is retried: the incremental poll no longer sees the
  edge. The dependent is fixed by the next null-cursor scan (the API reconciler, 300 s); this is
  unit-tested.
- A permanent delete that skips the trash is never tombstoned. That is a pre-existing gap and
  out of scope.
- If a relation to a tombstoned task re-appears upstream (task restored from trash, then
  re-linked), each poll spends one GET on that dependent while the task stays out of the trash.
  This is hypothetical: a restored task is not in `/tasks/deleted`, so it is not in the rescan
  set.
- softDelete swallows every error from the follow-up because the delete is already committed.
  The poll is the retry path.
- No services/api test was added. The API reconciler uses null scans, which already reconciled
  dependents. The fix matters for incremental cursors, and the adapter tests cover that.

## New contracts for dependents
None. No change to the MappingStore interface, Postgres schema, migration, contracts or domain.
The behaviour is new: after a delete, the feed carries one extra entry per dependent, ordered
right after the tombstone.

## Suggested coordinator follow-ups (outside my allowed paths)
- Add an ADR-016 note under the FU-73 amendment: delete → dependents rescan via the fingerprint
  reverse edges.
- Mark FU-81 done in docs/orchestration/FOLLOW-UPS.md.

## Rollback
Delete the branch (`git branch -D torgal/fu-81-deleted-dependents`) or revert cd6b0db.
