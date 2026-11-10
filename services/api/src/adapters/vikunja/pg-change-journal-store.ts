import { randomUUID } from 'node:crypto';
import { epochMsToInstant, type Clock, type Id, type Instant, type Version } from '@ohmydate/domain';
import type {
  ChangeJournalStore,
  JournalAppend,
  JournalRecord,
} from '@ohmydate/provider-vikunja';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/types.js';

/**
 * Reserved owner id for the database-wide journal epoch marker row.
 * `ChangeJournalStore.epoch()` is owner-independent, so one marker row owns the
 * generation while every owner row repeats the same epoch string.
 */
export const GLOBAL_JOURNAL_EPOCH_OWNER = '00000000-0000-0000-0000-000000000000';

function toInstant(value: Date): Instant {
  return epochMsToInstant(value.getTime());
}

type JournalRow = {
  readonly owner_id: string;
  readonly epoch: string;
  readonly seq: number;
  readonly task_id: string;
  readonly external_id: string;
  readonly version: number;
  readonly deleted_at: Date | null;
  readonly completed_occurrence_at: Date | null;
  readonly at: Date;
};

function toRecord(row: JournalRow): JournalRecord {
  return {
    sequence: row.seq,
    ownerId: row.owner_id as Id,
    taskId: row.task_id as Id,
    externalId: row.external_id,
    version: row.version as Version,
    at: toInstant(row.at),
    ...(row.deleted_at === null ? {} : { deletedAt: toInstant(row.deleted_at) }),
    ...(row.completed_occurrence_at === null
      ? {}
      : { completedOccurrenceAt: toInstant(row.completed_occurrence_at) }),
  };
}

/**
 * PostgreSQL-backed `ChangeJournalStore` (ADR-016 §3).
 *
 * - `epoch()` is a stable database-wide generation stored in the reserved
 *   `vikunja_journal_epoch` row, so cursors survive a process restart against
 *   the same database.
 * - Appends take a row lock on the owner's epoch row, which serializes
 *   `seq` allocation per (owner, epoch).
 * - `appendSnapshotOnce` is a single transaction: it locks the owner row,
 *   checks `snapshot_done`, inserts the snapshot and flips the flag. Concurrent
 *   first uses therefore emit the snapshot exactly once.
 */
export class PgChangeJournalStore implements ChangeJournalStore {
  readonly #db: Kysely<Database>;
  readonly #clock: Clock;
  #epoch: string | undefined;
  #epochPromise: Promise<string> | undefined;

  constructor(db: Kysely<Database>, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  async epoch(): Promise<string> {
    if (this.#epoch !== undefined) return this.#epoch;
    this.#epochPromise ??= this.#loadEpoch().then(
      (epoch) => {
        this.#epoch = epoch;
        return epoch;
      },
      (error: unknown) => {
        // A transient first failure (e.g. migration not applied yet) must not
        // poison the instance forever; the next call retries the load.
        this.#epochPromise = undefined;
        throw error;
      },
    );
    return this.#epochPromise;
  }

  async append(entry: JournalAppend): Promise<JournalRecord> {
    const records = await this.#appendMany([entry]);
    const record = records[0];
    if (record === undefined) throw new Error('journal append produced no record');
    return record;
  }

  async readAfter(ownerId: Id, sequence: number): Promise<readonly JournalRecord[]> {
    const epoch = await this.epoch();
    const rows = await this.#db
      .selectFrom('vikunja_change_journal')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('epoch', '=', epoch)
      .where('seq', '>', sequence)
      .orderBy('seq', 'asc')
      .execute();
    return rows.map(toRecord);
  }

  async head(ownerId: Id): Promise<number> {
    const epoch = await this.epoch();
    const row = await this.#db
      .selectFrom('vikunja_change_journal')
      .select((expression) => expression.fn.max<number>('seq').as('max'))
      .where('owner_id', '=', ownerId)
      .where('epoch', '=', epoch)
      .executeTakeFirst();
    const max = row?.max;
    return max === null || max === undefined ? 0 : Number(max);
  }

  async hasSnapshot(ownerId: Id): Promise<boolean> {
    const epoch = await this.epoch();
    const row = await this.#db
      .selectFrom('vikunja_journal_epoch')
      .select(['epoch', 'snapshot_done'])
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row !== undefined && row.epoch === epoch && row.snapshot_done;
  }

  async appendSnapshotOnce(
    ownerId: Id,
    entries: readonly JournalAppend[],
  ): Promise<readonly JournalRecord[]> {
    const epoch = await this.epoch();
    return this.#db.transaction().execute(async (trx) => {
      await this.#lockOwnerEpoch(trx, ownerId, epoch);
      const row = await trx
        .selectFrom('vikunja_journal_epoch')
        .select(['snapshot_done'])
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      if (row.snapshot_done) return [];
      const records = await this.#insertMany(trx, ownerId, epoch, entries);
      await trx
        .updateTable('vikunja_journal_epoch')
        .set({ snapshot_done: true, updated_at: this.#now() })
        .where('owner_id', '=', ownerId)
        .execute();
      return records;
    });
  }

  #now(): Date {
    return new Date(Date.parse(this.#clock.now()));
  }

  async #loadEpoch(): Promise<string> {
    const marker = await this.#db
      .insertInto('vikunja_journal_epoch')
      .values({
        owner_id: GLOBAL_JOURNAL_EPOCH_OWNER,
        epoch: randomUUID(),
        snapshot_done: true,
      })
      .onConflict((conflict) => conflict.column('owner_id').doNothing())
      .executeTakeFirst();
    void marker;
    const row = await this.#db
      .selectFrom('vikunja_journal_epoch')
      .select('epoch')
      .where('owner_id', '=', GLOBAL_JOURNAL_EPOCH_OWNER)
      .executeTakeFirstOrThrow();
    return row.epoch;
  }

  async #appendMany(entries: readonly JournalAppend[]): Promise<readonly JournalRecord[]> {
    const epoch = await this.epoch();
    const ownerId = entries[0]?.ownerId;
    if (ownerId === undefined) return [];
    return this.#db.transaction().execute(async (trx) => {
      await this.#lockOwnerEpoch(trx, ownerId, epoch);
      return this.#insertMany(trx, ownerId, epoch, entries);
    });
  }

  /**
   * Ensures the owner epoch row exists, locks it for the rest of the
   * transaction, and resets its journal if the database-wide epoch changed.
   */
  async #lockOwnerEpoch(
    trx: Transaction<Database>,
    ownerId: Id,
    epoch: string,
  ): Promise<void> {
    await trx
      .insertInto('vikunja_journal_epoch')
      .values({ owner_id: ownerId, epoch, snapshot_done: false })
      .onConflict((conflict) => conflict.column('owner_id').doNothing())
      .execute();
    const row = await trx
      .selectFrom('vikunja_journal_epoch')
      .select(['epoch', 'snapshot_done'])
      .where('owner_id', '=', ownerId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.epoch === epoch) return;
    await trx
      .deleteFrom('vikunja_change_journal')
      .where('owner_id', '=', ownerId)
      .execute();
    await trx
      .updateTable('vikunja_journal_epoch')
      .set({ epoch, snapshot_done: false, updated_at: this.#now() })
      .where('owner_id', '=', ownerId)
      .execute();
  }

  async #insertMany(
    trx: Transaction<Database>,
    ownerId: Id,
    epoch: string,
    entries: readonly JournalAppend[],
  ): Promise<readonly JournalRecord[]> {
    if (entries.length === 0) return [];
    const head = await trx
      .selectFrom('vikunja_change_journal')
      .select((expression) => expression.fn.max<number>('seq').as('max'))
      .where('owner_id', '=', ownerId)
      .where('epoch', '=', epoch)
      .executeTakeFirst();
    const base = head?.max === null || head?.max === undefined ? 0 : Number(head.max);
    const rows = await trx
      .insertInto('vikunja_change_journal')
      .values(
        entries.map((entry, index) => ({
          owner_id: ownerId,
          epoch,
          seq: base + index + 1,
          task_id: entry.taskId,
          external_id: entry.externalId,
          version: entry.version,
          deleted_at:
            entry.deletedAt === undefined ? null : new Date(Date.parse(entry.deletedAt)),
          completed_occurrence_at:
            entry.completedOccurrenceAt === undefined
              ? null
              : new Date(Date.parse(entry.completedOccurrenceAt)),
          at: new Date(Date.parse(entry.at)),
        })),
      )
      .returningAll()
      .execute();
    return rows.sort((left, right) => left.seq - right.seq).map(toRecord);
  }
}
