import type { PlanBlock, PlanVersionDto, ScheduleBlockDto, TodayProposalBlock } from '@ohmydate/contracts';
import {
  IdempotencyMismatchError,
  NotFoundError,
  epochMsToInstant,
  instantToEpochMs,
  type Clock,
  type Id,
  type IdGenerator,
  type Instant,
} from '@ohmydate/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { jsonb, type Database, type JsonValue } from '../db/types.js';
import {
  AvailabilityChangedError,
  ConstraintViolationError,
  PlanConflictError,
} from '../application/planning-errors.js';
import { proposalConflict } from '../application/daily-errors.js';
import type {
  NewTodayProposal,
  TodayProposalRecord,
  TodayStore,
} from '../application/today-service.js';

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePlanBlocks(value: unknown): PlanBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: PlanBlock[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const taskId = entry['taskId'];
    const startAt = entry['startAt'];
    const endAt = entry['endAt'];
    if (typeof taskId !== 'string' || typeof startAt !== 'string' || typeof endAt !== 'string') {
      continue;
    }
    blocks.push({ taskId: taskId as Id, startAt, endAt });
  }
  return blocks;
}

function parseProposalBlocks(value: unknown): TodayProposalBlock[] {
  return parsePlanBlocks(value).map((block, index) => {
    const source = Array.isArray(value) ? value[index] : undefined;
    const blockId = isRecord(source) && typeof source['blockId'] === 'string'
      ? (source['blockId'] as Id)
      : ('' as Id);
    return { blockId, taskId: block.taskId, startAt: block.startAt, endAt: block.endAt };
  });
}

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function toDate(value: string): Date {
  return new Date(instantToEpochMs(value as Instant));
}

function isPgError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: string }).code === code;
}

export class PgTodayStore implements TodayStore {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(options: { db: Db; clock: Clock; ids: IdGenerator }) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  async createProposal(input: NewTodayProposal): Promise<TodayProposalRecord> {
    const now = new Date(instantToEpochMs(input.now));
    const payload = {
      id: input.id,
      planId: input.planId,
      kind: input.kind,
      date: input.date,
      timeZone: input.timeZone,
      blocks: input.blocks,
      candidateBlocks: input.candidateBlocks,
      basePlanVersionId: input.basePlanVersionId,
      basePlanVersion: input.basePlanVersion,
      availabilityVersion: input.availabilityVersion,
      expiresAt: input.expiresAt,
      createdAt: input.now,
    };
    const row = await this.#db
      .insertInto('job')
      .values({
        id: input.id,
        owner_id: input.ownerId,
        kind: 'today_proposal',
        run_at: now,
        unique_key: JSON.stringify(payload),
        status: 'pending',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.#mapProposal(row);
  }

  async getProposal(ownerId: Id, id: Id): Promise<TodayProposalRecord | null> {
    const row = await this.#db
      .selectFrom('job')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('kind', '=', 'today_proposal')
      .executeTakeFirst();
    return row === undefined ? null : this.#mapProposal(row);
  }

  async approveProposal(input: {
    readonly proposal: TodayProposalRecord;
    readonly expectedAvailabilityVersion: number;
    readonly idempotencyKey: string;
    readonly now: Instant;
  }): Promise<PlanVersionDto> {
    try {
      return await this.#db.transaction().execute(async (trx) => {
        const now = new Date(instantToEpochMs(this.#clock.now()));
        const replay = await trx
          .selectFrom('schedule_approval')
          .selectAll()
          .where('owner_id', '=', input.proposal.ownerId)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (replay !== undefined) {
          const version = await this.#loadVersion(trx, input.proposal.ownerId, replay.plan_version_id as Id);
          if (version.planId !== input.proposal.planId) throw new IdempotencyMismatchError();
          return version;
        }

        await this.#ensureAvailabilityRow(trx, input.proposal.ownerId);
        const availabilityRow = await trx
          .selectFrom('user_availability_version')
          .selectAll()
          .where('owner_id', '=', input.proposal.ownerId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (availabilityRow.version !== input.expectedAvailabilityVersion) {
          throw new AvailabilityChangedError(
            input.expectedAvailabilityVersion,
            availabilityRow.version,
          );
        }

        const proposalRow = await trx
          .selectFrom('job')
          .selectAll()
          .where('id', '=', input.proposal.id)
          .where('owner_id', '=', input.proposal.ownerId)
          .where('kind', '=', 'today_proposal')
          .forUpdate()
          .executeTakeFirst();
        if (proposalRow === undefined) {
          throw new NotFoundError('today proposal', input.proposal.id);
        }
        if (proposalRow.status !== 'pending') {
          throw proposalConflict('the proposal is no longer pending');
        }
        const payload = this.#parseJobPayload(proposalRow.unique_key);
        if (payload.expiresAt !== undefined && Date.parse(payload.expiresAt) < now.getTime()) {
          throw proposalConflict('proposal has expired');
        }
        if (payload.availabilityVersion !== availabilityRow.version) {
          throw new AvailabilityChangedError(
            payload.availabilityVersion,
            availabilityRow.version,
          );
        }

        const planRow = await trx
          .selectFrom('plan')
          .selectAll()
          .where('id', '=', input.proposal.planId)
          .where('owner_id', '=', input.proposal.ownerId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (planRow === undefined) throw new NotFoundError('plan', input.proposal.planId);
        if (
          planRow.version !== payload.basePlanVersion ||
          planRow.current_version_id !== payload.basePlanVersionId
        ) {
          throw new PlanConflictError(
            `plan changed since the proposal: expected ${payload.basePlanVersion}, found ${planRow.version}`,
          );
        }

        const candidateBlocks = payload.candidateBlocks;
        const planVersionIds = await trx
          .selectFrom('plan_version')
          .select('id')
          .where('plan_id', '=', input.proposal.planId)
          .where('owner_id', '=', input.proposal.ownerId)
          .execute();
        if (planVersionIds.length > 0) {
          await trx
            .updateTable('schedule_block')
            .set({ status: 'superseded', version: sql<number>`version + 1`, updated_at: now })
            .where('owner_id', '=', input.proposal.ownerId)
            .where(
              'plan_version_id',
              'in',
              planVersionIds.map((row) => row.id),
            )
            .where('status', '<>', 'superseded')
            .where('start_at', '>=', now)
            .execute();
        }

        const seqRow = await trx
          .selectFrom('plan_version')
          .select(sql<number>`coalesce(max(seq), 0)`.as('max_seq'))
          .where('plan_id', '=', input.proposal.planId)
          .where('owner_id', '=', input.proposal.ownerId)
          .executeTakeFirst();
        const seq = (seqRow?.max_seq ?? 0) + 1;
        const versionId = this.#ids.next() as Id;
        await trx
          .insertInto('plan_version')
          .values({
            id: versionId,
            owner_id: input.proposal.ownerId,
            plan_id: input.proposal.planId,
            seq,
            candidate_id: null,
            reason: input.proposal.kind,
            created_by: 'user',
            availability_version: availabilityRow.version,
            created_at: now,
            updated_at: now,
          })
          .execute();

        const insertedBlocks: ScheduleBlockDto[] = [];
        for (const block of candidateBlocks) {
          const row = await trx
            .insertInto('schedule_block')
            .values({
              id: this.#ids.next(),
              owner_id: input.proposal.ownerId,
              plan_version_id: versionId,
              task_id: block.taskId,
              start_at: toDate(block.startAt),
              end_at: toDate(block.endAt),
              locked: false,
              status: 'planned',
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          insertedBlocks.push(this.#mapBlock(row));
        }

        await trx
          .updateTable('plan')
          .set({
            current_version_id: versionId,
            status: 'active',
            version: planRow.version + 1,
            updated_at: now,
          })
          .where('id', '=', input.proposal.planId)
          .where('owner_id', '=', input.proposal.ownerId)
          .execute();

        await trx
          .insertInto('schedule_approval')
          .values({
            id: this.#ids.next(),
            owner_id: input.proposal.ownerId,
            plan_version_id: versionId,
            approved_at: now,
            idempotency_key: input.idempotencyKey,
            availability_version: availabilityRow.version,
            created_at: now,
            updated_at: now,
          })
          .execute();

        await trx
          .updateTable('job')
          .set({ status: 'completed', version: sql<number>`version + 1`, updated_at: now })
          .where('id', '=', input.proposal.id)
          .where('owner_id', '=', input.proposal.ownerId)
          .where('kind', '=', 'today_proposal')
          .execute();

        await trx
          .insertInto('outbox_event')
          .values({
            id: this.#ids.next(),
            owner_id: input.proposal.ownerId,
            topic: 'plan.approved',
            payload: jsonb({
              planId: input.proposal.planId,
              planVersionId: versionId,
              version: seq,
            } as unknown as JsonValue),
            created_at: now,
            updated_at: now,
          })
          .execute();

        return {
          id: versionId,
          planId: input.proposal.planId,
          seq,
          reason: input.proposal.kind,
          createdBy: 'user',
          availabilityVersion: availabilityRow.version,
          blocks: insertedBlocks,
          version: 1,
          createdAt: epochMsToInstant(now.getTime()),
        };
      });
    } catch (error) {
      if (isPgError(error, '23P01')) {
        throw new ConstraintViolationError([
          { code: 'H1', message: 'an approved block overlaps an active schedule block' },
        ]);
      }
      if (isPgError(error, '23503')) {
        throw new PlanConflictError('today approval referenced a vanished task or plan');
      }
      if (isPgError(error, '23505')) {
        throw new PlanConflictError('today approval idempotency key is already in use');
      }
      throw error;
    }
  }

  #parseJobPayload(raw: string): {
    planId: Id;
    kind: 'shrink' | 'reschedule';
    date: string;
    timeZone: string;
    blocks: TodayProposalBlock[];
    candidateBlocks: PlanBlock[];
    basePlanVersionId: Id;
    basePlanVersion: number;
    availabilityVersion: number;
    expiresAt?: string;
    createdAt: string;
  } {
    const parsed = JSON.parse(raw) as {
      planId: string;
      kind: string;
      date: string;
      timeZone: string;
      blocks: unknown;
      candidateBlocks: unknown;
      basePlanVersionId: string;
      basePlanVersion: number;
      availabilityVersion: number;
      expiresAt?: string;
      createdAt: string;
    };
    return {
      planId: parsed.planId as Id,
      kind: parsed.kind === 'shrink' ? 'shrink' : 'reschedule',
      date: parsed.date,
      timeZone: parsed.timeZone,
      blocks: parseProposalBlocks(parsed.blocks),
      candidateBlocks: parsePlanBlocks(parsed.candidateBlocks),
      basePlanVersionId: parsed.basePlanVersionId as Id,
      basePlanVersion: parsed.basePlanVersion,
      availabilityVersion: parsed.availabilityVersion,
      ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
      createdAt: parsed.createdAt,
    };
  }

  #mapProposal(row: {
    id: string;
    owner_id: string;
    unique_key: string;
    status: string;
    version: number;
    created_at: Date | string;
    updated_at: Date | string;
  }): TodayProposalRecord {
    const payload = this.#parseJobPayload(row.unique_key);
    return {
      id: row.id as Id,
      ownerId: row.owner_id as Id,
      planId: payload.planId,
      kind: payload.kind,
      date: payload.date,
      timeZone: payload.timeZone,
      blocks: payload.blocks,
      candidateBlocks: payload.candidateBlocks,
      basePlanVersionId: payload.basePlanVersionId,
      basePlanVersion: payload.basePlanVersion,
      availabilityVersion: payload.availabilityVersion,
      state: row.status === 'completed' ? 'approved' : row.status === 'failed' ? 'expired' : 'pending',
      ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt as Instant }),
      version: row.version,
      createdAt: toInstant(row.created_at),
      updatedAt: toInstant(row.updated_at),
    };
  }

  #mapBlock(row: {
    id: string;
    plan_version_id: string;
    task_id: string;
    start_at: Date | string;
    end_at: Date | string;
    locked: boolean;
    status: string;
    version: number;
  }): ScheduleBlockDto {
    return {
      id: row.id as Id,
      planVersionId: row.plan_version_id as Id,
      taskId: row.task_id as Id,
      startAt: toInstant(row.start_at),
      endAt: toInstant(row.end_at),
      locked: row.locked,
      status: row.status as ScheduleBlockDto['status'],
      version: row.version,
    };
  }

  async #ensureAvailabilityRow(trx: Trx, ownerId: Id): Promise<void> {
    const userRow = await trx
      .selectFrom('user')
      .select('time_zone')
      .where('id', '=', ownerId)
      .executeTakeFirst();
    await trx
      .insertInto('user_availability_version')
      .values({
        owner_id: ownerId,
        version: 1,
        time_zone: userRow?.time_zone ?? 'UTC',
        prefs: jsonb({
          maxDailyFocusMin: 240,
          breakAfterMin: 60,
          breakMin: 15,
          dayStartLocal: '08:00',
          dayEndLocal: '18:00',
          riskLevel: 'p50',
        } as unknown as JsonValue),
      })
      .onConflict((oc) => oc.column('owner_id').doNothing())
      .execute();
  }

  async #loadVersion(db: Db | Trx, ownerId: Id, versionId: Id): Promise<PlanVersionDto> {
    const row = await db
      .selectFrom('plan_version')
      .selectAll()
      .where('id', '=', versionId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('plan version', versionId);
    const blocks = await db
      .selectFrom('schedule_block')
      .selectAll()
      .where('plan_version_id', '=', versionId)
      .where('owner_id', '=', ownerId)
      .orderBy('start_at', 'asc')
      .execute();
    return {
      id: row.id as Id,
      planId: row.plan_id as Id,
      seq: row.seq,
      ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id as Id }),
      ...(row.reason === null ? {} : { reason: row.reason }),
      createdBy: row.created_by as PlanVersionDto['createdBy'],
      availabilityVersion: row.availability_version,
      blocks: blocks.map((block) => this.#mapBlock(block)),
      version: row.version,
      createdAt: toInstant(row.created_at),
    };
  }
}
