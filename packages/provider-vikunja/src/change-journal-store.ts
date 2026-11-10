import { randomUUID } from 'node:crypto';
import type { Id, Instant, Version } from '@ohmydate/domain';

/**
 * One committed planner-visible change. The store owns the monotonically
 * increasing sequence so cursors stay valid across repository instances that
 * share the same store (ADR-016 §3).
 */
export interface JournalRecord {
  readonly sequence: number;
  readonly ownerId: Id;
  readonly taskId: Id;
  readonly externalId: string;
  readonly version: Version;
  readonly at: Instant;
  readonly deletedAt?: Instant;
  readonly completedOccurrenceAt?: Instant;
}

export type JournalAppend = Omit<JournalRecord, 'sequence'>;

/**
 * Restart safety contract:
 * - `epoch()` identifies the journal generation. A cursor carrying a different
 *   epoch is unrecoverable and must trigger a full resync.
 * - `append`/`readAfter`/`head` are scoped per owner and must survive repository
 *   reconstruction when the same store instance is reused.
 * - `hasSnapshot`/`appendSnapshotOnce` make the first-use snapshot of an owner
 *   idempotent within an epoch. A fresh journal (new epoch) must emit a
 *   complete snapshot before the first read or append is observed, and two
 *   concurrent first uses must emit it exactly once (FU-15/FU-17).
 */
export interface ChangeJournalStore {
  epoch(): Promise<string>;
  append(entry: JournalAppend): Promise<JournalRecord>;
  readAfter(ownerId: Id, sequence: number): Promise<readonly JournalRecord[]>;
  head(ownerId: Id): Promise<number>;
  hasSnapshot(ownerId: Id): Promise<boolean>;
  /**
   * Append the owner's full snapshot exactly once per epoch. Returns the
   * appended records, or an empty array when another call already emitted it.
   * Implementations must make the check-and-append atomic.
   */
  appendSnapshotOnce(
    ownerId: Id,
    entries: readonly JournalAppend[],
  ): Promise<readonly JournalRecord[]>;
}

/**
 * In-memory journal for tests and the temporary API wiring. A durable
 * Postgres-backed implementation will preserve the same epoch/sequence contract.
 */
export class InMemoryChangeJournalStore implements ChangeJournalStore {
  readonly #epoch = randomUUID();
  readonly #records = new Map<string, JournalRecord[]>();
  readonly #heads = new Map<string, number>();
  readonly #snapshots = new Set<string>();

  async epoch(): Promise<string> {
    return this.#epoch;
  }

  async append(entry: JournalAppend): Promise<JournalRecord> {
    return this.#append(entry);
  }

  #append(entry: JournalAppend): JournalRecord {
    const key = String(entry.ownerId);
    const next = (this.#heads.get(key) ?? 0) + 1;
    this.#heads.set(key, next);
    const record: JournalRecord = { ...entry, sequence: next };
    const existing = this.#records.get(key);
    if (existing === undefined) {
      this.#records.set(key, [record]);
    } else {
      existing.push(record);
    }
    return record;
  }

  async readAfter(ownerId: Id, sequence: number): Promise<readonly JournalRecord[]> {
    return (this.#records.get(String(ownerId)) ?? []).filter(
      (record) => record.sequence > sequence,
    );
  }

  async head(ownerId: Id): Promise<number> {
    return this.#heads.get(String(ownerId)) ?? 0;
  }

  async hasSnapshot(ownerId: Id): Promise<boolean> {
    return this.#snapshots.has(String(ownerId));
  }

  async appendSnapshotOnce(
    ownerId: Id,
    entries: readonly JournalAppend[],
  ): Promise<readonly JournalRecord[]> {
    const key = String(ownerId);
    // No await between the check, the mark and the appends, so concurrent first
    // uses on the same store see the snapshot exactly once and atomically.
    if (this.#snapshots.has(key)) return [];
    this.#snapshots.add(key);
    return entries.map((entry) => this.#append(entry));
  }
}
