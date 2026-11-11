import type { SessionListQuery, WorkSessionPage } from '@ohmydate/contracts';
import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  instantToEpochMs,
  type Id,
  type Instant,
} from '@ohmydate/domain';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import {
  activeSessionExists,
  sessionStateConflict,
} from '../application/daily-errors.js';
import type {
  WorkSessionRecord,
  WorkSessionStore,
  WorkSessionUpdate,
} from '../application/session-service.js';

type Db = Kysely<Database>;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function toDate(value: string): Date {
  return new Date(instantToEpochMs(value as Instant));
}

function isPgError(error: unknown, code: string, constraint?: string): boolean {
  if (!(error instanceof Error)) return false;
  const record = error as { code?: string; constraint?: string };
  return record.code === code && (constraint === undefined || record.constraint === constraint);
}

export class PgWorkSessionStore implements WorkSessionStore {
  readonly #db: Db;

  constructor(options: { db: Db }) {
    this.#db = options.db;
  }

  async create(input: {
    readonly id: Id;
    readonly ownerId: Id;
    readonly taskId: Id;
    readonly blockId?: Id;
    readonly startedAt: Instant;
    readonly clientId: string;
    readonly now: Instant;
  }): Promise<WorkSessionRecord> {
    if (input.blockId !== undefined) {
      const block = await this.#db
        .selectFrom('schedule_block')
        .select('task_id')
        .where('id', '=', input.blockId)
        .where('owner_id', '=', input.ownerId)
        .executeTakeFirst();
      if (block === undefined || block.task_id !== input.taskId) {
        throw new ValidationFailedError([
          { path: '/blockId', message: 'blockId must belong to the session task' },
        ]);
      }
    }
    try {
      const row = await this.#db
        .insertInto('work_session')
        .values({
          id: input.id,
          owner_id: input.ownerId,
          task_id: input.taskId,
          block_id: input.blockId ?? null,
          state: 'active',
          started_at: toDate(input.startedAt),
          client_id: input.clientId,
          created_at: toDate(input.now),
          updated_at: toDate(input.now),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.#map(row);
    } catch (error) {
      if (isPgError(error, '23505', 'work_session_one_active_per_owner')) {
        throw activeSessionExists();
      }
      if (isPgError(error, '23503')) {
        throw new ValidationFailedError([
          { path: '/taskId', message: 'task or block does not belong to this owner' },
        ]);
      }
      throw error;
    }
  }

  async get(ownerId: Id, id: Id): Promise<WorkSessionRecord | null> {
    const row = await this.#db
      .selectFrom('work_session')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row === undefined ? null : this.#map(row);
  }

  async list(ownerId: Id, query: SessionListQuery): Promise<WorkSessionPage> {
    const limit = query.limit ?? 20;
    let builder = this.#db
      .selectFrom('work_session')
      .selectAll()
      .where('owner_id', '=', ownerId);
    if (query.state !== undefined) builder = builder.where('state', '=', query.state);
    if (query.cursor !== undefined) builder = builder.where('id', '<', query.cursor);
    const rows = await builder.orderBy('id', 'desc').limit(limit + 1).execute();
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map((row) => this.#toDto(row)),
      nextCursor: rows.length > limit ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
    };
  }

  async update(
    ownerId: Id,
    id: Id,
    expectedVersion: number,
    update: WorkSessionUpdate,
  ): Promise<WorkSessionRecord> {
    return this.#db.transaction().execute(async (trx) => {
      const now = toDate(update.now);
      const row = await trx
        .updateTable('work_session')
        .set({
          state: update.state,
          ended_at: update.endedAt === undefined ? null : toDate(update.endedAt),
          focused_sec: update.focusedSec,
          paused_sec: update.pausedSec,
          version: sql<number>`version + 1`,
          updated_at: now,
        })
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) {
        const current = await trx
          .selectFrom('work_session')
          .select(['version'])
          .where('id', '=', id)
          .where('owner_id', '=', ownerId)
          .executeTakeFirst();
        if (current === undefined) throw new NotFoundError('work session', id);
        throw new VersionConflictError(expectedVersion as never, current.version as never);
      }
      if (update.state === 'completed' && row.block_id !== null) {
        await trx
          .updateTable('schedule_block')
          .set({
            status: 'done',
            version: sql<number>`version + 1`,
            updated_at: now,
          })
          .where('id', '=', row.block_id)
          .where('owner_id', '=', ownerId)
          .where('status', '<>', 'superseded')
          .execute();
      }
      return this.#map(row);
    });
  }

  async createReview(input: {
    readonly reviewId: Id;
    readonly feedbackId: Id;
    readonly ownerId: Id;
    readonly sessionId: Id;
    readonly taskId: Id;
    readonly outcome: 'done' | 'partial' | 'blocked';
    readonly reasonChips: readonly string[];
    readonly note?: string;
    readonly estimatedP50: number;
    readonly actualFocusMin: number;
    readonly quality: 'ok' | 'outlier' | 'excluded';
    readonly now: Instant;
  }): Promise<void> {
    try {
      await this.#db.transaction().execute(async (trx) => {
        const now = toDate(input.now);
        await trx
          .insertInto('task_completion_review')
          .values({
            id: input.reviewId,
            owner_id: input.ownerId,
            session_id: input.sessionId,
            outcome: input.outcome,
            reason_chips: [...input.reasonChips],
            note: input.note ?? null,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await trx
          .insertInto('estimation_feedback')
          .values({
            id: input.feedbackId,
            owner_id: input.ownerId,
            task_id: input.taskId,
            estimated_p50: input.estimatedP50,
            actual_focus_min: input.actualFocusMin,
            quality: input.quality,
            created_at: now,
            updated_at: now,
          })
          .execute();
      });
    } catch (error) {
      if (isPgError(error, '23505')) {
        throw sessionStateConflict('this session already has a review');
      }
      throw error;
    }
  }

  async getCurrentEstimateP50(ownerId: Id, taskId: Id): Promise<number> {
    const row = await this.#db
      .selectFrom('estimate')
      .select('p50_min')
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', taskId)
      .where('is_current', '=', true)
      .executeTakeFirst();
    return row?.p50_min ?? 0;
  }

  async sumCompletedFocusSec(ownerId: Id, taskId: Id): Promise<number> {
    const row = await this.#db
      .selectFrom('work_session')
      .select(sql<number>`coalesce(sum(focused_sec), 0)`.as('total'))
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', taskId)
      .where('state', '=', 'completed')
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  #toDto(row: {
    id: string;
    task_id: string;
    block_id: string | null;
    state: string;
    started_at: Date | string;
    ended_at: Date | string | null;
    focused_sec: number;
    paused_sec: number;
    client_id: string;
    version: number;
  }) {
    return {
      id: row.id as Id,
      taskId: row.task_id as Id,
      ...(row.block_id === null ? {} : { blockId: row.block_id as Id }),
      state: row.state as WorkSessionRecord['state'],
      startedAt: toInstant(row.started_at),
      ...(row.ended_at === null ? {} : { endedAt: toInstant(row.ended_at) }),
      focusedSec: row.focused_sec,
      pausedSec: row.paused_sec,
      clientId: row.client_id,
      version: row.version,
    };
  }

  #map(row: {
    id: string;
    owner_id: string;
    task_id: string;
    block_id: string | null;
    state: string;
    started_at: Date | string;
    ended_at: Date | string | null;
    focused_sec: number;
    paused_sec: number;
    client_id: string;
    version: number;
  }): WorkSessionRecord {
    return {
      id: row.id as Id,
      ownerId: row.owner_id as Id,
      taskId: row.task_id as Id,
      ...(row.block_id === null ? {} : { blockId: row.block_id as Id }),
      state: row.state as WorkSessionRecord['state'],
      startedAt: toInstant(row.started_at),
      ...(row.ended_at === null ? {} : { endedAt: toInstant(row.ended_at) }),
      focusedSec: row.focused_sec,
      pausedSec: row.paused_sec,
      clientId: row.client_id,
      version: row.version,
    };
  }
}
