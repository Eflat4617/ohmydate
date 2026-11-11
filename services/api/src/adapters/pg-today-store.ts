import type {
  Availability,
  AvailabilityPreferencesDto,
  Commitment,
  PlanBlock,
  PlanVersionDto,
  ScheduleBlockDto,
  TodayProposalBlock,
} from '@ohmydate/contracts';
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
  PreparedTodayApproval,
  TodayApprovalSnapshot,
  TodayProposalRecord,
  TodayStore,
} from '../application/today-service.js';
import type { ApprovedBlock, EstimateRecord } from '../application/planning-ports.js';

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

const DEFAULT_PREFS: AvailabilityPreferencesDto = {
  maxDailyFocusMin: 240,
  breakAfterMin: 60,
  breakMin: 15,
  dayStartLocal: '08:00',
  dayEndLocal: '18:00',
  riskLevel: 'p50',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function parsePrefs(value: unknown): AvailabilityPreferencesDto {
  if (!isRecord(value)) return DEFAULT_PREFS;
  return {
    maxDailyFocusMin: numberOr(value['maxDailyFocusMin'], DEFAULT_PREFS.maxDailyFocusMin),
    breakAfterMin: numberOr(value['breakAfterMin'], DEFAULT_PREFS.breakAfterMin),
    breakMin: numberOr(value['breakMin'], DEFAULT_PREFS.breakMin),
    dayStartLocal: stringOr(value['dayStartLocal'], DEFAULT_PREFS.dayStartLocal),
    dayEndLocal: stringOr(value['dayEndLocal'], DEFAULT_PREFS.dayEndLocal),
    riskLevel: value['riskLevel'] === 'p90' ? 'p90' : 'p50',
  };
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

function parsePayload(value: unknown): {
  planId: Id;
  kind: 'shrink' | 'reschedule';
  date: string;
  timeZone: string;
  blocks: TodayProposalBlock[];
  candidateBlocks: PlanBlock[];
  basePlanVersion: number;
  createdAt: string;
} {
  const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as {
    planId: string;
    kind: string;
    date: string;
    timeZone: string;
    blocks: unknown;
    candidateBlocks: unknown;
    basePlanVersion: number;
    createdAt: string;
  };
  return {
    planId: parsed.planId as Id,
    kind: parsed.kind === 'shrink' ? 'shrink' : 'reschedule',
    date: parsed.date,
    timeZone: parsed.timeZone,
    blocks: parseProposalBlocks(parsed.blocks),
    candidateBlocks: parsePlanBlocks(parsed.candidateBlocks),
    basePlanVersion: parsed.basePlanVersion,
    createdAt: parsed.createdAt,
  };
}

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function toDate(value: string): Date {
  return new Date(instantToEpochMs(value as Instant));
}

function toDateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
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
      planId: input.planId,
      kind: input.kind,
      date: input.date,
      timeZone: input.timeZone,
      blocks: input.blocks,
      candidateBlocks: input.candidateBlocks,
      basePlanVersion: input.basePlanVersion,
      createdAt: input.now,
    };
    const row = await this.#db
      .insertInto('today_proposal')
      .values({
        id: input.id,
        owner_id: input.ownerId,
        base_plan_version_id: input.basePlanVersionId,
        availability_version: input.availabilityVersion,
        payload: jsonb(payload as unknown as JsonValue),
        state: 'pending',
        expires_at: toDate(input.expiresAt),
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.#mapProposal(row);
  }

  async getProposal(ownerId: Id, id: Id): Promise<TodayProposalRecord | null> {
    const row = await this.#db
      .selectFrom('today_proposal')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row === undefined ? null : this.#mapProposal(row);
  }

  async approveProposal(input: {
    readonly proposal: TodayProposalRecord;
    readonly expectedAvailabilityVersion: number;
    readonly idempotencyKey: string;
    readonly now: Instant;
    prepare(snapshot: TodayApprovalSnapshot): Promise<PreparedTodayApproval>;
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
          .selectFrom('today_proposal')
          .selectAll()
          .where('id', '=', input.proposal.id)
          .where('owner_id', '=', input.proposal.ownerId)
          .forUpdate()
          .executeTakeFirst();
        if (proposalRow === undefined) {
          throw new NotFoundError('today proposal', input.proposal.id);
        }
        if (proposalRow.state !== 'pending') {
          throw proposalConflict('the proposal is no longer pending');
        }
        if (proposalRow.expires_at.getTime() < now.getTime()) {
          throw proposalConflict('proposal has expired');
        }
        if (proposalRow.availability_version !== availabilityRow.version) {
          throw new AvailabilityChangedError(
            proposalRow.availability_version,
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
        const payload = parsePayload(proposalRow.payload);
        if (
          planRow.version !== payload.basePlanVersion ||
          planRow.current_version_id !== proposalRow.base_plan_version_id
        ) {
          throw new PlanConflictError(
            `plan changed since the proposal: expected ${payload.basePlanVersion}, found ${planRow.version}`,
          );
        }

        const availability = await this.#readAvailability(trx, input.proposal.ownerId);
        const commitments = await this.#commitmentsRange(
          trx,
          input.proposal.ownerId,
          planRow.horizon_start,
          planRow.horizon_end,
        );
        const blocks = await this.#listActiveBlocks(trx, input.proposal.ownerId);
        const candidateBlocks = payload.candidateBlocks;
        const taskIds = [...new Set(candidateBlocks.map((block) => block.taskId))] as Id[];
        await this.#assertTasksLive(trx, input.proposal.ownerId, taskIds);
        const estimates = await this.#loadEstimates(trx, input.proposal.ownerId, [
          ...new Set([
            ...taskIds,
            ...blocks.filter((block) => block.planId === input.proposal.planId).map((block) => block.taskId),
          ]),
        ]);
        const prepared = await input.prepare({
          planId: input.proposal.planId,
          basePlanVersionId: proposalRow.base_plan_version_id as Id,
          basePlanVersion: payload.basePlanVersion,
          timeZone: planRow.time_zone,
          horizon: {
            start: toInstant(planRow.horizon_start),
            end: toInstant(planRow.horizon_end),
          },
          availability,
          commitments,
          blocks,
          estimates,
          candidateBlocks,
        });

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
            // M5-02R-1 H1: locked blocks are carried over unchanged (same row,
            // locked=true); Today candidates never contain them.
            .where('locked', '=', false)
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
        for (const block of prepared.blocks) {
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
          .updateTable('today_proposal')
          .set({ state: 'approved' })
          .where('id', '=', input.proposal.id)
          .where('owner_id', '=', input.proposal.ownerId)
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
          {
            code: 'H1',
            message: 'an approved block overlaps an active schedule block',
            messageCode: 'h1_active_block_overlap',
            params: {},
          },
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

  async #assertTasksLive(trx: Trx, ownerId: Id, taskIds: readonly Id[]): Promise<void> {
    if (taskIds.length === 0) return;
    const rows = await trx
      .selectFrom('task')
      .select(['id', 'status_cache', 'deleted_at'])
      .where('owner_id', '=', ownerId)
      .where('id', 'in', taskIds)
      .execute();
    const found = new Map(rows.map((row) => [row.id, row]));
    for (const taskId of taskIds) {
      const row = found.get(taskId);
      if (row === undefined || row.deleted_at !== null || row.status_cache === 'done') {
        throw new PlanConflictError(`scoped task is no longer schedulable: ${taskId}`);
      }
    }
  }

  async #readAvailability(db: Db | Trx, ownerId: Id): Promise<Availability> {
    const versionRow = await db
      .selectFrom('user_availability_version')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    const userRow = await db
      .selectFrom('user')
      .select('time_zone')
      .where('id', '=', ownerId)
      .executeTakeFirst();
    const rules = await db
      .selectFrom('availability_rule')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('weekday', 'asc')
      .orderBy('start_local', 'asc')
      .execute();
    const exceptions = await db
      .selectFrom('availability_exception')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('date', 'asc')
      .execute();
    return {
      version: versionRow?.version ?? 1,
      timeZone: versionRow?.time_zone ?? userRow?.time_zone ?? 'UTC',
      rules: rules.map((row) => ({
        weekday: row.weekday,
        startLocal: row.start_local,
        endLocal: row.end_local,
        kind: row.kind === 'focus' ? 'focus' : 'work',
      })),
      exceptions: exceptions.map((row) => ({
        date: toDateString(row.date),
        kind: row.kind === 'extra' ? 'extra' : 'off',
        ...(row.start_local === null ? {} : { startLocal: row.start_local }),
        ...(row.end_local === null ? {} : { endLocal: row.end_local }),
      })),
      prefs: parsePrefs(versionRow?.prefs),
    };
  }

  async #commitmentsRange(
    db: Db | Trx,
    ownerId: Id,
    from: Date | string,
    to: Date | string,
  ): Promise<Commitment[]> {
    const fromIso = toInstant(from);
    const toIso = toInstant(to);
    const rows = await db
      .selectFrom('commitment_event')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('rrule', 'is not', null),
          eb.and([eb('start_at', '<', new Date(toIso)), eb('end_at', '>', new Date(fromIso))]),
        ]),
      )
      .orderBy('start_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id as Id,
      ownerId: row.owner_id as Id,
      title: row.title,
      startAt: toInstant(row.start_at),
      endAt: toInstant(row.end_at),
      timeZone: row.time_zone,
      ...(row.rrule === null ? {} : { rrule: row.rrule }),
      source: row.source as Commitment['source'],
      version: row.version,
      createdAt: toInstant(row.created_at),
      updatedAt: toInstant(row.updated_at),
    }));
  }

  async #listActiveBlocks(db: Db | Trx, ownerId: Id): Promise<ApprovedBlock[]> {
    const rows = await db
      .selectFrom('schedule_block')
      .innerJoin('plan_version', 'plan_version.id', 'schedule_block.plan_version_id')
      .innerJoin('plan', 'plan.id', 'plan_version.plan_id')
      .select([
        'schedule_block.id',
        'schedule_block.plan_version_id',
        'schedule_block.task_id',
        'schedule_block.start_at',
        'schedule_block.end_at',
        'schedule_block.status',
        'schedule_block.locked',
        'schedule_block.version',
        'plan.id as plan_id',
      ])
      .where('schedule_block.owner_id', '=', ownerId)
      .where('schedule_block.status', '<>', 'superseded')
      .where('plan.deleted_at', 'is', null)
      .execute();
    return rows.map((row) => ({
      id: row.id as Id,
      planId: row.plan_id as Id,
      planVersionId: row.plan_version_id as Id,
      taskId: row.task_id as Id,
      startAt: toInstant(row.start_at),
      endAt: toInstant(row.end_at),
      status: row.status,
      locked: row.locked,
      version: row.version,
    }));
  }

  async #loadEstimates(
    db: Db | Trx,
    ownerId: Id,
    taskIds: readonly Id[],
  ): Promise<ReadonlyMap<string, EstimateRecord>> {
    if (taskIds.length === 0) return new Map();
    const rows = await db
      .selectFrom('estimate')
      .select(['task_id', 'p50_min', 'p90_min'])
      .where('owner_id', '=', ownerId)
      .where('is_current', '=', true)
      .where('task_id', 'in', taskIds)
      .execute();
    const result = new Map<string, EstimateRecord>();
    for (const row of rows) {
      result.set(row.task_id, {
        taskId: row.task_id as Id,
        p50Min: row.p50_min,
        p90Min: row.p90_min,
      });
    }
    return result;
  }

  #mapProposal(row: {
    id: string;
    owner_id: string;
    base_plan_version_id: string;
    availability_version: number;
    payload: unknown;
    state: string;
    expires_at: Date | string;
    created_at: Date | string;
  }): TodayProposalRecord {
    const payload = parsePayload(row.payload);
    return {
      id: row.id as Id,
      ownerId: row.owner_id as Id,
      planId: payload.planId,
      kind: payload.kind,
      date: payload.date,
      timeZone: payload.timeZone,
      blocks: payload.blocks,
      candidateBlocks: payload.candidateBlocks,
      basePlanVersionId: row.base_plan_version_id as Id,
      basePlanVersion: payload.basePlanVersion,
      availabilityVersion: row.availability_version,
      state: row.state === 'approved' ? 'approved' : row.state === 'expired' ? 'expired' : 'pending',
      expiresAt: toInstant(row.expires_at),
      version: 1,
      createdAt: toInstant(row.created_at),
      updatedAt: toInstant(row.created_at),
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
        prefs: jsonb(DEFAULT_PREFS as unknown as JsonValue),
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
