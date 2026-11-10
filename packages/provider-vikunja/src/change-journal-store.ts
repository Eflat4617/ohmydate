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
 */
export interface ChangeJournalStore {
  epoch(): Promise<string>;
  append(entry: JournalAppend): Promise<JournalRecord>;
  readAfter(ownerId: Id, sequence: number): Promise<readonly JournalRecord[]>;
  head(ownerId: Id): Promise<number>;
}

/**
 * In-memory journal for tests and the temporary API wiring. A durable
 * Postgres-backed implementation will preserve the same epoch/sequence contract.
 */
export class InMemoryChangeJournalStore implements ChangeJournalStore {
  readonly #epoch = randomUUID();
  readonly #records = new Map<string, JournalRecord[]>();
  readonly #heads = new Map<string, number>();

  async epoch(): Promise<string> {
    return this.#epoch;
  }

  async append(entry: JournalAppend): Promise<JournalRecord> {
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
}
