import type {
  Availability,
  AvailabilityExceptionDto,
  AvailabilityPreferencesDto,
  AvailabilityPut,
  AvailabilityRuleDto,
  Commitment,
  CommitmentCreate,
  CommitmentListQuery,
  CommitmentPage,
  CommitmentPatch,
  Plan,
  PlanBlock,
  PlanCandidateDto,
  PlanMetricsDto,
  PlanScope,
  PlanVersionDto,
  ScheduleBlockDto,
} from '@ohmydate/contracts';
import {
  IdempotencyMismatchError,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
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
import type {
  ActivePlanRevision,
  ApprovalSnapshot,
  ApprovedBlock,
  EstimateRecord,
  GoalTasks,
  NewCandidate,
  NewPlan,
  PlanningStore,
  ScheduleBlockWindowQuery,
} from '../application/planning-ports.js';
import { expandOccurrences, InvalidRRuleError, MAX_OCCURRENCES } from '../application/rrule.js';
import { ensurePlannerTaskIdentity } from './planner-task-identity.js';
import { candidateExplanationJson, parseCandidateExplanation } from './explanation-json.js';

const DEFAULT_PREFS: AvailabilityPreferencesDto = {
  maxDailyFocusMin: 240,
  breakAfterMin: 60,
  breakMin: 15,
  dayStartLocal: '08:00',
  dayEndLocal: '18:00',
  riskLevel: 'p50',
};

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function toDate(value: string): Date {
  return new Date(instantToEpochMs(value as never));
}

function toDateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePrefs(value: unknown): AvailabilityPreferencesDto {
  if (!isRecord(value)) return DEFAULT_PREFS;
  const risk = value['riskLevel'] === 'p90' ? 'p90' : 'p50';
  return {
    maxDailyFocusMin: numberOr(value['maxDailyFocusMin'], DEFAULT_PREFS.maxDailyFocusMin),
    breakAfterMin: numberOr(value['breakAfterMin'], DEFAULT_PREFS.breakAfterMin),
    breakMin: numberOr(value['breakMin'], DEFAULT_PREFS.breakMin),
    dayStartLocal: stringOr(value['dayStartLocal'], DEFAULT_PREFS.dayStartLocal),
    dayEndLocal: stringOr(value['dayEndLocal'], DEFAULT_PREFS.dayEndLocal),
    riskLevel: risk,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function parseBlocks(value: unknown): PlanBlock[] {
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

function parseMetrics(value: unknown): PlanMetricsDto {
  const record = isRecord(value) ? value : {};
  return {
    totalFocusMin: numberOr(record['totalFocusMin'], 0),
    minSlackMin: typeof record['minSlackMin'] === 'number' ? record['minSlackMin'] : 0,
    maxDailyLoadMin: numberOr(record['maxDailyLoadMin'], 0),
    avgDailyLoadMin:
      typeof record['avgDailyLoadMin'] === 'number' ? record['avgDailyLoadMin'] : 0,
    contextSwitches: numberOr(record['contextSwitches'], 0),
    changedBlocks: numberOr(record['changedBlocks'], 0),
    deficitMin: numberOr(record['deficitMin'], 0),
    capacityDeficitMin: numberOr(record['capacityDeficitMin'], 0),
    p90CoverageRatio:
      typeof record['p90CoverageRatio'] === 'number' ? record['p90CoverageRatio'] : 1,
  };
}

function parseScope(value: unknown): PlanScope {
  if (isRecord(value) && typeof value['goalId'] === 'string') {
    return { goalId: value['goalId'] as Id };
  }
  if (isRecord(value) && Array.isArray(value['taskIds'])) {
    return { taskIds: value['taskIds'].filter((id): id is string => typeof id === 'string') as Id[] };
  }
  return { taskIds: [] };
}

function blocksJson(blocks: readonly PlanBlock[]): JsonValue {
  return blocks.map((block) => ({
    taskId: block.taskId,
    startAt: block.startAt,
    endAt: block.endAt,
  })) as unknown as JsonValue;
}

function metricsJson(metrics: PlanMetricsDto): JsonValue {
  return { ...metrics } as unknown as JsonValue;
}

function prefsJson(prefs: AvailabilityPreferencesDto): JsonValue {
  return { ...prefs } as unknown as JsonValue;
}

function isPgError(
  error: unknown,
  code: string,
): error is { readonly code: string; readonly constraint?: string } {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === code
  );
}

export class PgPlanningStore implements PlanningStore {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(options: { db: Db; clock: Clock; ids: IdGenerator }) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  async getCurrent(
    ownerId: Id,
    taskIds: readonly Id[],
  ): Promise<ReadonlyMap<string, EstimateRecord>> {
    if (taskIds.length === 0) return new Map();
    const rows = await this.#db
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

  async getAvailability(ownerId: Id): Promise<Availability> {
    return this.#readAvailability(this.#db, ownerId);
  }

  async putAvailability(
    ownerId: Id,
    input: AvailabilityPut,
    expectedVersion: number,
  ): Promise<Availability> {
    return this.#db.transaction().execute(async (trx) => {
      await this.#ensureAvailabilityRow(trx, ownerId, input.timeZone, input.prefs);
      const row = await trx
        .selectFrom('user_availability_version')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.version !== expectedVersion) {
        throw new AvailabilityChangedError(expectedVersion, row.version);
      }
      const now = new Date(instantToEpochMs(this.#clock.now()));
      const nextVersion = row.version + 1;
      await trx.deleteFrom('availability_rule').where('owner_id', '=', ownerId).execute();
      await trx
        .deleteFrom('availability_exception')
        .where('owner_id', '=', ownerId)
        .execute();
      if (input.rules.length > 0) {
        await trx
          .insertInto('availability_rule')
          .values(
            input.rules.map((rule) => ({
              id: this.#ids.next(),
              owner_id: ownerId,
              weekday: rule.weekday,
              start_local: rule.startLocal,
              end_local: rule.endLocal,
              time_zone: input.timeZone,
              kind: rule.kind,
            })),
          )
          .execute();
      }
      if (input.exceptions.length > 0) {
        await trx
          .insertInto('availability_exception')
          .values(
            input.exceptions.map((exception) => ({
              id: this.#ids.next(),
              owner_id: ownerId,
              date: exception.date,
              kind: exception.kind,
              start_local: exception.startLocal ?? null,
              end_local: exception.endLocal ?? null,
            })),
          )
          .execute();
      }
      await trx
        .updateTable('user_availability_version')
        .set({
          version: nextVersion,
          time_zone: input.timeZone,
          prefs: jsonb(prefsJson(input.prefs)),
          updated_at: now,
        })
        .where('owner_id', '=', ownerId)
        .execute();
      return {
        version: nextVersion,
        timeZone: input.timeZone,
        rules: input.rules.map(copyRule),
        exceptions: input.exceptions.map(copyException),
        prefs: { ...input.prefs },
      };
    });
  }

  async listCommitments(
    ownerId: Id,
    query: CommitmentListQuery,
  ): Promise<CommitmentPage> {
    const fromMs = Date.parse(query.from);
    const toMs = Date.parse(query.to);
    if (toMs - fromMs > MAX_RANGE_MS) {
      throw new ValidationFailedError([
        { path: '/to', message: 'commitment range exceeds 366 days' },
      ]);
    }
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    let builder = this.#commitmentsRangeBuilder(this.#db, ownerId, query.from, query.to)
      .orderBy('id', 'asc')
      .limit(limit);
    if (query.cursor !== undefined) {
      builder = builder.where('id', '>', query.cursor);
    }
    const rows = await builder.execute();
    let occurrences = 0;
    const items = rows.map((row) => {
      const commitment = this.#mapCommitment(row);
      const expanded = this.#expandOrThrow(commitment, query.from, query.to);
      occurrences += expanded.length;
      if (occurrences > MAX_OCCURRENCES) {
        throw new ValidationFailedError([
          { path: '/to', message: `commitments expand to more than ${MAX_OCCURRENCES} occurrences` },
        ]);
      }
      return {
        ...commitment,
        occurrences: expanded.map((occurrence) => ({
          commitmentId: commitment.id,
          startAt: occurrence.startAt,
          endAt: occurrence.endAt,
        })),
      };
    });
    return {
      items,
      nextCursor: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }

  async listCommitmentsInRange(
    ownerId: Id,
    from: string,
    to: string,
  ): Promise<Commitment[]> {
    const rows = await this.#commitmentsRangeBuilder(this.#db, ownerId, from, to)
      .orderBy('start_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => this.#mapCommitment(row));
  }

  async createCommitment(ownerId: Id, input: CommitmentCreate): Promise<Commitment> {
    return this.#db.transaction().execute(async (trx) => {
      const now = new Date(instantToEpochMs(this.#clock.now()));
      const row = await trx
        .insertInto('commitment_event')
        .values({
          id: this.#ids.next(),
          owner_id: ownerId,
          title: input.title,
          start_at: toDate(input.startAt),
          end_at: toDate(input.endAt),
          rrule: input.rrule ?? null,
          time_zone: input.timeZone,
          source: input.source ?? 'manual',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.#bumpAvailability(trx, ownerId, now);
      return this.#mapCommitment(row);
    });
  }

  async updateCommitment(
    ownerId: Id,
    id: Id,
    patch: CommitmentPatch,
    expectedVersion: number,
  ): Promise<Commitment> {
    return this.#db.transaction().execute(async (trx) => {
      const now = new Date(instantToEpochMs(this.#clock.now()));
      const current = await trx
        .selectFrom('commitment_event')
        .selectAll()
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError('commitment', id);
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion as never, current.version as never);
      }
      const mergedStart = patch.startAt ?? toInstant(current.start_at);
      const mergedEnd = patch.endAt ?? toInstant(current.end_at);
      if (Date.parse(mergedEnd) <= Date.parse(mergedStart)) {
        throw new ValidationFailedError([
          { path: '/endAt', message: 'commitment endAt must be after startAt' },
        ]);
      }
      const row = await trx
        .updateTable('commitment_event')
        .set({
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.startAt === undefined ? {} : { start_at: toDate(patch.startAt) }),
          ...(patch.endAt === undefined ? {} : { end_at: toDate(patch.endAt) }),
          ...(patch.timeZone === undefined ? {} : { time_zone: patch.timeZone }),
          ...(patch.rrule === undefined ? {} : { rrule: patch.rrule }),
          ...(patch.source === undefined ? {} : { source: patch.source }),
          version: expectedVersion + 1,
          updated_at: now,
        })
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) {
        throw new VersionConflictError(expectedVersion as never);
      }
      await this.#bumpAvailability(trx, ownerId, now);
      return this.#mapCommitment(row);
    });
  }

  async deleteCommitment(ownerId: Id, id: Id, expectedVersion: number): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const now = new Date(instantToEpochMs(this.#clock.now()));
      const deleted = await trx
        .updateTable('commitment_event')
        .set({ deleted_at: now, version: expectedVersion + 1, updated_at: now })
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .where('deleted_at', 'is', null)
        .where('version', '=', expectedVersion)
        .returning('id')
        .executeTakeFirst();
      if (deleted === undefined) {
        const exists = await trx
          .selectFrom('commitment_event')
          .select('version')
          .where('id', '=', id)
          .where('owner_id', '=', ownerId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (exists === undefined) throw new NotFoundError('commitment', id);
        throw new VersionConflictError(expectedVersion as never, exists.version as never);
      }
      await this.#bumpAvailability(trx, ownerId, now);
    });
  }

  async createPlan(ownerId: Id, input: NewPlan): Promise<Plan> {
    return this.#db.transaction().execute(async (trx) => {
      const now = new Date(instantToEpochMs(this.#clock.now()));
      const planId = this.#ids.next() as Id;
      await trx
        .insertInto('plan')
        .values({
          id: planId,
          owner_id: ownerId,
          scope: jsonb(input.scope as unknown as JsonValue),
          status: 'draft',
          availability_version: input.availabilityVersion,
          horizon_start: toDate(input.horizon.start),
          horizon_end: toDate(input.horizon.end),
          time_zone: input.timeZone,
          created_at: now,
          updated_at: now,
        })
        .execute();
      const candidates = await this.#insertCandidates(trx, ownerId, planId, input.candidates, now);
      return {
        id: planId,
        ownerId,
        scope: input.scope,
        status: 'draft',
        availabilityVersion: input.availabilityVersion,
        horizon: input.horizon,
        timeZone: input.timeZone,
        candidates,
        version: 1,
        createdAt: epochMsToInstant(now.getTime()),
        updatedAt: epochMsToInstant(now.getTime()),
      };
    });
  }

  async getPlan(ownerId: Id, id: Id): Promise<Plan | null> {
    const row = await this.#db
      .selectFrom('plan')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const candidates = await this.#loadCandidates(this.#db, ownerId, id);
    return this.#mapPlan(row, candidates);
  }

  async getCandidate(
    ownerId: Id,
    planId: Id,
    candidateId: Id,
  ): Promise<PlanCandidateDto | null> {
    const row = await this.#db
      .selectFrom('plan_candidate')
      .selectAll()
      .where('id', '=', candidateId)
      .where('plan_id', '=', planId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row === undefined ? null : this.#mapCandidate(row);
  }

  async replaceCandidates(
    ownerId: Id,
    planId: Id,
    expectedVersion: number,
    candidates: readonly NewCandidate[],
    timeZone: string,
    availabilityVersion: number,
  ): Promise<Plan> {
    return this.#db.transaction().execute(async (trx) => {
      const now = new Date(instantToEpochMs(this.#clock.now()));
      const updated = await trx
        .updateTable('plan')
        .set({
          time_zone: timeZone,
          availability_version: availabilityVersion,
          version: expectedVersion + 1,
          updated_at: now,
        })
        .where('id', '=', planId)
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) {
        const current = await trx
          .selectFrom('plan')
          .select('version')
          .where('id', '=', planId)
          .where('owner_id', '=', ownerId)
          .executeTakeFirst();
        if (current === undefined) throw new NotFoundError('plan', planId);
        throw new VersionConflictError(expectedVersion as never, current.version as never);
      }
      await trx
        .deleteFrom('plan_candidate')
        .where('plan_id', '=', planId)
        .where('owner_id', '=', ownerId)
        .execute();
      const inserted = await this.#insertCandidates(trx, ownerId, planId, candidates, now);
      return this.#mapPlan(updated, inserted);
    });
  }

  async resolveGoalTasks(ownerId: Id, goalId: Id): Promise<GoalTasks | null> {
    const goal = await this.#db
      .selectFrom('goal')
      .select('id')
      .where('id', '=', goalId)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (goal === undefined) return null;
    const rows = await this.#db
      .selectFrom('intake_session')
      .innerJoin('intake_approval_step', 'intake_approval_step.session_id', 'intake_session.id')
      .select('intake_approval_step.task_id')
      .where('intake_session.owner_id', '=', ownerId)
      .where('intake_session.goal_id', '=', goalId)
      .where('intake_approval_step.state', '=', 'created')
      .where('intake_approval_step.task_id', 'is not', null)
      .execute();
    return {
      goalExists: true,
      taskIds: [...new Set(rows.map((row) => row.task_id as Id))],
    };
  }

  async listActiveBlocks(ownerId: Id): Promise<readonly ApprovedBlock[]> {
    return this.#listActiveBlocks(this.#db, ownerId);
  }

  async listScheduleBlocks(
    ownerId: Id,
    query: ScheduleBlockWindowQuery,
  ): Promise<readonly ApprovedBlock[]> {
    const from = new Date(instantToEpochMs(query.from));
    const to = new Date(instantToEpochMs(query.to));
    let builder = this.#db
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
      .where('schedule_block.start_at', '<', to)
      .where('schedule_block.end_at', '>', from);
    if (query.cursorStartAt !== undefined && query.cursorId !== undefined) {
      const cursorStart = new Date(instantToEpochMs(query.cursorStartAt));
      builder = builder.where((eb) =>
        eb.or([
          eb('schedule_block.start_at', '>', cursorStart),
          eb.and([
            eb('schedule_block.start_at', '=', cursorStart),
            eb('schedule_block.id', '>', query.cursorId as string),
          ]),
        ]),
      );
    }
    const rows = await builder
      .orderBy('schedule_block.start_at', 'asc')
      .orderBy('schedule_block.id', 'asc')
      .limit(query.limit)
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

  async getActivePlan(ownerId: Id): Promise<ActivePlanRevision | null> {
    const row = await this.#db
      .selectFrom('plan')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('status', '=', 'active')
      .where('current_version_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (row === undefined || row.current_version_id === null) return null;
    return {
      planId: row.id as Id,
      planVersionId: row.current_version_id as Id,
      revision: row.version,
      timeZone: row.time_zone,
      horizon: {
        start: toInstant(row.horizon_start),
        end: toInstant(row.horizon_end),
      },
      scope: parseScope(row.scope),
      availabilityVersion: row.availability_version,
    };
  }

  async approve(
    ownerId: Id,
    planId: Id,
    candidateId: Id,
    request: {
      expectedAvailabilityVersion: number;
      expectedPlanVersion: number;
      idempotencyKey: string;
      now: Instant;
      taskIds: readonly Id[];
      planningTaskIds: readonly Id[];
      identityTasks: readonly import('@ohmydate/domain').Task[];
      releaseVanishedTaskIds?: readonly Id[] | undefined;
      prepare: (snapshot: ApprovalSnapshot) => Promise<import('../application/planning-ports.js').PreparedApproval>;
    },
  ): Promise<PlanVersionDto> {
    try {
      return await this.#db.transaction().execute(async (trx) => {
        const now = new Date(instantToEpochMs(this.#clock.now()));
        // Replay lookup comes before the If-Match lock so a stored approval is
        // returned even after the 24h generic idempotency record expires.
        const approval = await trx
          .selectFrom('schedule_approval')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('idempotency_key', '=', request.idempotencyKey)
          .executeTakeFirst();
        if (approval !== undefined) {
          const version = await this.#loadVersion(trx, ownerId, approval.plan_version_id as Id);
          if (version.planId !== planId || version.candidateId !== candidateId) {
            throw new IdempotencyMismatchError();
          }
          return version;
        }

        await this.#ensureAvailabilityRow(trx, ownerId, 'UTC', DEFAULT_PREFS);
        const availabilityRow = await trx
          .selectFrom('user_availability_version')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (availabilityRow.version !== request.expectedAvailabilityVersion) {
          throw new AvailabilityChangedError(
            request.expectedAvailabilityVersion,
            availabilityRow.version,
          );
        }

        const planRow = await trx
          .selectFrom('plan')
          .selectAll()
          .where('id', '=', planId)
          .where('owner_id', '=', ownerId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (planRow === undefined) throw new NotFoundError('plan', planId);
        if (planRow.version !== request.expectedPlanVersion) {
          throw new PlanConflictError(
            `plan version changed: expected ${request.expectedPlanVersion}, found ${planRow.version}`,
          );
        }
        const candidateRow = await trx
          .selectFrom('plan_candidate')
          .selectAll()
          .where('id', '=', candidateId)
          .where('plan_id', '=', planId)
          .where('owner_id', '=', ownerId)
          .executeTakeFirst();
        if (candidateRow === undefined) throw new NotFoundError('plan candidate', candidateId);

        const availability = await this.#readAvailability(trx, ownerId);
        const commitments = await this.#commitmentsRange(trx, ownerId, planRow.horizon_start, planRow.horizon_end);
        const blocks = await this.#listActiveBlocks(trx, ownerId);
        await this.#assertPlanningTasksLive(trx, ownerId, request.planningTaskIds);
        const estimates = await this.#loadEstimates(trx, ownerId, request.taskIds);
        const candidate = this.#mapCandidate(candidateRow);
        const snapshot: ApprovalSnapshot = {
          plan: this.#mapPlan(planRow, [candidate]),
          candidate,
          availability,
          commitments,
          blocks,
          estimates,
        };
        const prepared = await request.prepare(snapshot);
        if (prepared.violations.length > 0) {
          throw new ConstraintViolationError(prepared.violations);
        }

        const planVersionIds = await trx
          .selectFrom('plan_version')
          .select('id')
          .where('plan_id', '=', planId)
          .where('owner_id', '=', ownerId)
          .execute();
        if (planVersionIds.length > 0) {
          await trx
            .updateTable('schedule_block')
            .set({
              status: 'superseded',
              version: sql<number>`version + 1`,
              updated_at: now,
            })
            .where('owner_id', '=', ownerId)
            .where(
              'plan_version_id',
              'in',
              planVersionIds.map((row) => row.id),
            )
            .where('status', '<>', 'superseded')
            .where('start_at', '>=', now)
            // M5-02R-1 H1: a locked block of a live task is immutable and is
            // carried over as-is (same row, locked=true); only locked blocks
            // of tasks that left the schedulable set (done/vanished) go.
            .where((eb) =>
              request.taskIds.length === 0
                ? eb.val(true)
                : eb.or([eb('locked', '=', false), eb('task_id', 'not in', request.taskIds)]),
            )
            .execute();
        }

        // Probe K: a provider-deleted task can no longer own future blocks.
        // Release them in any approval TX of this owner so planning recovers.
        if (
          request.releaseVanishedTaskIds !== undefined &&
          request.releaseVanishedTaskIds.length > 0
        ) {
          await trx
            .updateTable('schedule_block')
            .set({
              status: 'superseded',
              version: sql<number>`version + 1`,
              updated_at: now,
            })
            .where('owner_id', '=', ownerId)
            .where('task_id', 'in', request.releaseVanishedTaskIds)
            .where('status', '<>', 'superseded')
            .where('start_at', '>=', now)
            .execute();
        }

        await ensurePlannerTaskIdentity(trx, ownerId, request.identityTasks);

        const seqRow = await trx
          .selectFrom('plan_version')
          .select(sql<number>`coalesce(max(seq), 0)`.as('max_seq'))
          .where('plan_id', '=', planId)
          .where('owner_id', '=', ownerId)
          .executeTakeFirst();
        const seq = (seqRow?.max_seq ?? 0) + 1;
        const versionId = this.#ids.next() as Id;
        await trx
          .insertInto('plan_version')
          .values({
            id: versionId,
            owner_id: ownerId,
            plan_id: planId,
            seq,
            candidate_id: candidateId,
            reason: 'approved',
            created_by: 'user',
            availability_version: availabilityRow.version,
            created_at: now,
            updated_at: now,
          })
          .execute();

        const insertedBlocks: ScheduleBlockDto[] = [];
        for (const block of prepared.blocks) {
          const blockId = this.#ids.next() as Id;
          const row = await trx
            .insertInto('schedule_block')
            .values({
              id: blockId,
              owner_id: ownerId,
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
          .where('id', '=', planId)
          .where('owner_id', '=', ownerId)
          .execute();

        await trx
          .insertInto('schedule_approval')
          .values({
            id: this.#ids.next(),
            owner_id: ownerId,
            plan_version_id: versionId,
            approved_at: now,
            idempotency_key: request.idempotencyKey,
            availability_version: availabilityRow.version,
            created_at: now,
            updated_at: now,
          })
          .execute();

        await trx
          .insertInto('outbox_event')
          .values({
            id: this.#ids.next(),
            owner_id: ownerId,
            topic: 'plan.approved',
            payload: jsonb({
              planId,
              planVersionId: versionId,
              version: seq,
            } as unknown as JsonValue),
            created_at: now,
            updated_at: now,
          })
          .execute();

        return {
          id: versionId,
          planId,
          seq,
          candidateId,
          reason: 'approved',
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
        throw new PlanConflictError('approval failed because a referenced task or version vanished');
      }
      if (isPgError(error, '23505')) {
        throw new PlanConflictError('approval idempotency key is already in use');
      }
      throw error;
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

  async #ensureAvailabilityRow(
    trx: Trx,
    ownerId: Id,
    timeZone: string,
    prefs: AvailabilityPreferencesDto,
  ): Promise<void> {
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
        time_zone: timeZone === 'UTC' ? (userRow?.time_zone ?? 'UTC') : timeZone,
        prefs: jsonb(prefsJson(prefs)),
      })
      .onConflict((oc) => oc.column('owner_id').doNothing())
      .execute();
  }

  async #bumpAvailability(trx: Trx, ownerId: Id, now: Date): Promise<void> {
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
        prefs: jsonb(prefsJson(DEFAULT_PREFS)),
      })
      .onConflict((oc) => oc.column('owner_id').doNothing())
      .execute();
    await trx
      .updateTable('user_availability_version')
      .set({ version: sql<number>`version + 1`, updated_at: now })
      .where('owner_id', '=', ownerId)
      .execute();
  }

  #mapCommitment(row: {
    id: string;
    owner_id: string;
    title: string;
    start_at: Date | string;
    end_at: Date | string;
    rrule: string | null;
    time_zone: string;
    source: string;
    version: number;
    created_at: Date | string;
    updated_at: Date | string;
  }): Commitment {
    return {
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
    };
  }

  #commitmentsRangeBuilder(db: Db | Trx, ownerId: Id, from: string, to: string) {
    return db
      .selectFrom('commitment_event')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('rrule', 'is not', null),
          eb.and([
            eb('start_at', '<', new Date(to)),
            eb('end_at', '>', new Date(from)),
          ]),
        ]),
      );
  }

  async #commitmentsRange(
    db: Db | Trx,
    ownerId: Id,
    from: Date | string,
    to: Date | string,
  ): Promise<Commitment[]> {
    const fromIso = toInstant(from);
    const toIso = toInstant(to);
    const rows = await this.#commitmentsRangeBuilder(db, ownerId, fromIso, toIso)
      .orderBy('start_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => this.#mapCommitment(row));
  }

  #expandOrThrow(commitment: Commitment, from: string, to: string) {
    try {
      return expandOccurrences(commitment, from, to);
    } catch (error) {
      if (error instanceof InvalidRRuleError) {
        throw new ValidationFailedError([{ path: '/rrule', message: error.message }]);
      }
      throw error;
    }
  }

  async #assertPlanningTasksLive(
    trx: Trx,
    ownerId: Id,
    taskIds: readonly Id[],
  ): Promise<void> {
    if (taskIds.length === 0) return;
    const rows = await trx
      .selectFrom('task')
      .select(['id', 'status_cache', 'deleted_at'])
      .where('owner_id', '=', ownerId)
      .where('id', 'in', taskIds)
      .execute();
    for (const row of rows) {
      if (row.deleted_at !== null || row.status_cache === 'done') {
        throw new PlanConflictError(`scoped task is no longer schedulable: ${row.id}`);
      }
    }
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

  async #insertCandidates(
    trx: Trx,
    ownerId: Id,
    planId: Id,
    candidates: readonly NewCandidate[],
    now: Date,
  ): Promise<PlanCandidateDto[]> {
    const result: PlanCandidateDto[] = [];
    for (const candidate of candidates) {
      const id = this.#ids.next() as Id;
      const row = await trx
        .insertInto('plan_candidate')
        .values({
          id,
          owner_id: ownerId,
          plan_id: planId,
          policy: candidate.policy,
          blocks: jsonb(blocksJson(candidate.blocks)),
          metrics: jsonb(metricsJson(candidate.metrics)),
          explanation: jsonb(
            candidateExplanationJson(
              candidate.explanation,
              candidate.explanationItems,
              candidate.diversityNoteItems ?? [],
            ) as unknown as JsonValue,
          ),
          diversity_note: candidate.diversityNote ?? null,
          feasible: candidate.feasible,
          deficit_min: candidate.deficitMin,
          input_hash: candidate.inputHash,
          generator_version: candidate.generatorVersion,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      result.push(this.#mapCandidate(row));
    }
    return result;
  }

  async #loadCandidates(db: Db | Trx, ownerId: Id, planId: Id): Promise<PlanCandidateDto[]> {
    const rows = await db
      .selectFrom('plan_candidate')
      .selectAll()
      .where('plan_id', '=', planId)
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => this.#mapCandidate(row));
  }

  #mapCandidate(row: {
    id: string;
    policy: string;
    blocks: unknown;
    metrics: unknown;
    explanation: unknown;
    diversity_note: string | null;
    feasible: boolean;
    deficit_min: number;
    input_hash: string;
    generator_version: string;
  }): PlanCandidateDto {
    const metrics = parseMetrics(row.metrics);
    const explanation = parseCandidateExplanation(row.explanation);
    return {
      id: row.id as Id,
      policy: row.policy as PlanCandidateDto['policy'],
      blocks: parseBlocks(row.blocks),
      metrics,
      feasible: row.feasible,
      deficitMin: row.deficit_min,
      capacityDeficitMin: metrics.capacityDeficitMin,
      explanation: explanation.explanation,
      explanationItems: explanation.explanationItems,
      ...(row.diversity_note === null ? {} : { diversityNote: row.diversity_note }),
      ...(explanation.diversityNoteItems.length === 0
        ? {}
        : { diversityNoteItems: explanation.diversityNoteItems }),
      generatorVersion: row.generator_version,
      inputHash: row.input_hash,
    };
  }

  #mapPlan(
    row: {
      id: string;
      owner_id: string;
      scope: unknown;
      status: string;
      current_version_id: string | null;
      availability_version: number;
      horizon_start: Date | string;
      horizon_end: Date | string;
      time_zone: string;
      version: number;
      created_at: Date | string;
      updated_at: Date | string;
    },
    candidates: PlanCandidateDto[],
  ): Plan {
    return {
      id: row.id as Id,
      ownerId: row.owner_id as Id,
      scope: parseScope(row.scope),
      status: row.status as Plan['status'],
      availabilityVersion: row.availability_version,
      ...(row.current_version_id === null
        ? {}
        : { currentVersionId: row.current_version_id as Id }),
      horizon: {
        start: toInstant(row.horizon_start),
        end: toInstant(row.horizon_end),
      },
      timeZone: row.time_zone,
      candidates,
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

function copyRule(rule: AvailabilityRuleDto): AvailabilityRuleDto {
  return { ...rule };
}

function copyException(exception: AvailabilityExceptionDto): AvailabilityExceptionDto {
  return { ...exception };
}
