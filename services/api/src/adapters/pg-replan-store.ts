import type {
  Availability,
  AvailabilityPreferencesDto,
  Commitment,
  PlanBlock,
  PlanMetricsDto,
  PlanVersionDto,
  ReplanCandidateDto,
  ReplanCandidateFlag,
  ReplanProposalListQuery,
  ReplanProposalState,
  ReplanReasonCode,
  ReplanTriggerDto,
  ReplanTriggerKind,
  ScheduleBlockDto,
} from '@ohmydate/contracts';
import {
  IdempotencyMismatchError,
  NotFoundError,
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
import type { ApprovedBlock, EstimateRecord } from '../application/planning-ports.js';
import { proposalStateConflict } from '../application/replan-errors.js';
import {
  EARLY_COMPLETION_DAILY_CAP,
  REPLAN_DAILY_CAP,
  type NewReplanProposal,
  type ReplanApprovalRequest,
  type ReplanInsertMode,
  type ReplanInsertResult,
  type ReplanPolicyBlock,
  type ReplanPolicyWindow,
  type ReplanProposalRecord,
  type ReplanStore,
} from '../application/replan-service.js';
import { ensurePlannerTaskIdentity } from './planner-task-identity.js';

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

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function toDate(value: string): Date {
  return new Date(instantToEpochMs(value as Instant));
}

function toDateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isPgError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: string }).code === code;
}

function parsePrefs(value: unknown): AvailabilityPreferencesDto {
  if (!isRecord(value)) return DEFAULT_PREFS;
  return {
    maxDailyFocusMin: numberOr(value['maxDailyFocusMin'], DEFAULT_PREFS.maxDailyFocusMin),
    breakAfterMin: numberOr(value['breakAfterMin'], DEFAULT_PREFS.breakAfterMin),
    breakMin: numberOr(value['breakMin'], DEFAULT_PREFS.breakMin),
    dayStartLocal:
      typeof value['dayStartLocal'] === 'string' ? value['dayStartLocal'] : DEFAULT_PREFS.dayStartLocal,
    dayEndLocal:
      typeof value['dayEndLocal'] === 'string' ? value['dayEndLocal'] : DEFAULT_PREFS.dayEndLocal,
    riskLevel: value['riskLevel'] === 'p90' ? 'p90' : 'p50',
  };
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
    minSlackMin: numberOr(record['minSlackMin'], 0),
    maxDailyLoadMin: numberOr(record['maxDailyLoadMin'], 0),
    avgDailyLoadMin: numberOr(record['avgDailyLoadMin'], 0),
    contextSwitches: numberOr(record['contextSwitches'], 0),
    changedBlocks: numberOr(record['changedBlocks'], 0),
    deficitMin: numberOr(record['deficitMin'], 0),
    capacityDeficitMin: numberOr(record['capacityDeficitMin'], 0),
    p90CoverageRatio: numberOr(record['p90CoverageRatio'], 1),
  };
}

function parseStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

interface StoredPayload {
  readonly trigger: ReplanTriggerDto;
  readonly candidate: ReplanCandidateDto;
  readonly basePlanRevision: number;
  readonly policy: string;
}

function parsePayload(
  value: unknown,
  row: { trigger_kind: string; reason_code: string; detected_at: Date | string },
): StoredPayload {
  const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as unknown;
  const record = isRecord(parsed) ? parsed : {};
  const trigger = isRecord(record['trigger']) ? record['trigger'] : {};
  const candidate = isRecord(record['candidate']) ? record['candidate'] : {};
  return {
    trigger: {
      kind: row.trigger_kind as ReplanTriggerKind,
      reason: row.reason_code as ReplanReasonCode,
      detectedAt: toInstant(row.detected_at),
      affectedTaskIds: parseStrings(trigger['affectedTaskIds']) as Id[],
    },
    candidate: {
      blocks: parseBlocks(candidate['blocks']),
      metrics: parseMetrics(candidate['metrics']),
      changedBlocks: numberOr(candidate['changedBlocks'], 0),
      bound: numberOr(candidate['bound'], 0),
      flags: parseStrings(candidate['flags']) as ReplanCandidateFlag[],
      explanation: parseStrings(candidate['explanation']),
    },
    basePlanRevision: numberOr(record['basePlanRevision'], 1),
    policy: typeof record['policy'] === 'string' ? record['policy'] : 'balanced',
  };
}

type ProposalRow = {
  id: string;
  owner_id: string;
  plan_id: string;
  base_plan_version_id: string;
  result_plan_version_id: string | null;
  trigger_kind: string;
  reason_code: string;
  detected_at: Date | string;
  availability_version: number;
  payload: unknown;
  state: string;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
  version: number;
};

function mapProposal(row: ProposalRow): ReplanProposalRecord {
  const payload = parsePayload(row.payload, row);
  return {
    id: row.id as Id,
    ownerId: row.owner_id as Id,
    planId: row.plan_id as Id,
    basePlanVersionId: row.base_plan_version_id as Id,
    basePlanRevision: payload.basePlanRevision,
    ...(row.result_plan_version_id === null
      ? {}
      : { resultPlanVersionId: row.result_plan_version_id as Id }),
    state: row.state as ReplanProposalState,
    trigger: payload.trigger,
    candidate: payload.candidate,
    policy: payload.policy,
    availabilityVersion: row.availability_version,
    createdAt: toInstant(row.created_at),
    updatedAt: toInstant(row.updated_at),
    expiresAt: toInstant(row.expires_at),
    version: row.version,
  };
}

function payloadJson(input: NewReplanProposal): JsonValue {
  return {
    trigger: { affectedTaskIds: [...input.trigger.affectedTaskIds] },
    candidate: {
      blocks: input.candidate.blocks.map((block) => ({
        taskId: block.taskId,
        startAt: block.startAt,
        endAt: block.endAt,
      })),
      metrics: { ...input.candidate.metrics },
      changedBlocks: input.candidate.changedBlocks,
      bound: input.candidate.bound,
      flags: [...input.candidate.flags],
      explanation: [...input.candidate.explanation],
    },
    basePlanRevision: input.basePlanRevision,
    policy: input.policy,
  } as unknown as JsonValue;
}

/**
 * Owner policy lock (M5-02R-1 H2). Every write that reads or changes the
 * 05 §11 policy state (proposal insert/supersede, rejection + suppression)
 * takes it FIRST, before any proposal row lock, so a request can never commit
 * from a policy read made before a concurrent rejection committed.
 */
async function lockOwnerPolicy(trx: Trx, ownerId: Id): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`ohmydate.replan:${ownerId}`}, 0))`.execute(
    trx,
  );
}

/**
 * PostgreSQL replan proposals (0012). Policy writes run under a per-owner
 * transaction advisory lock so two detection leaders (or a leader and a user
 * request) serialize; the partial unique index on pending (owner, reason) is
 * the backstop.
 */
export class PgReplanStore implements ReplanStore {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(options: { db: Db; clock: Clock; ids: IdGenerator }) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  async listOwnersWithActivePlan(): Promise<readonly Id[]> {
    const rows = await this.#db
      .selectFrom('plan')
      .select('owner_id')
      .distinct()
      .where('status', '=', 'active')
      .where('current_version_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .orderBy('owner_id', 'asc')
      .execute();
    return rows.map((row) => row.owner_id as Id);
  }

  async expireStale(now: Instant, ownerId?: Id): Promise<number> {
    const nowDate = toDate(now);
    let builder = this.#db
      .updateTable('replan_proposal')
      .set({ state: 'expired', version: sql<number>`version + 1`, updated_at: nowDate })
      .where('state', '=', 'pending')
      .where((eb) =>
        eb.or([
          eb('expires_at', '<=', nowDate),
          eb.not(
            eb.exists(
              eb
                .selectFrom('plan')
                .select('plan.id')
                .whereRef('plan.id', '=', 'replan_proposal.plan_id')
                .whereRef('plan.owner_id', '=', 'replan_proposal.owner_id')
                .whereRef('plan.current_version_id', '=', 'replan_proposal.base_plan_version_id')
                .where('plan.deleted_at', 'is', null),
            ),
          ),
        ]),
      );
    if (ownerId !== undefined) builder = builder.where('owner_id', '=', ownerId);
    const result = await builder.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async checkPolicy(
    ownerId: Id,
    trigger: Pick<ReplanTriggerDto, 'kind' | 'reason'>,
    window: ReplanPolicyWindow,
    mode: ReplanInsertMode,
  ): Promise<ReplanPolicyBlock | null> {
    return this.#policy(this.#db, ownerId, trigger, window, mode);
  }

  async insert(
    input: NewReplanProposal,
    window: ReplanPolicyWindow,
    mode: ReplanInsertMode,
  ): Promise<ReplanInsertResult> {
    try {
      return await this.#db.transaction().execute(async (trx) => {
        await lockOwnerPolicy(trx, input.ownerId);
        const blocked = await this.#policy(trx, input.ownerId, input.trigger, window, mode);
        if (blocked !== null) return { kind: 'blocked', block: blocked } as const;
        const now = toDate(input.now);
        if (mode === 'requested') {
          await trx
            .updateTable('replan_proposal')
            .set({ state: 'superseded', version: sql<number>`version + 1`, updated_at: now })
            .where('owner_id', '=', input.ownerId)
            .where('reason_code', '=', input.trigger.reason)
            .where('state', '=', 'pending')
            .execute();
        }
        const row = await trx
          .insertInto('replan_proposal')
          .values({
            id: input.id,
            owner_id: input.ownerId,
            plan_id: input.planId,
            base_plan_version_id: input.basePlanVersionId,
            trigger_kind: input.trigger.kind,
            reason_code: input.trigger.reason,
            detected_at: toDate(input.trigger.detectedAt),
            availability_version: input.availabilityVersion,
            payload: jsonb(payloadJson(input)),
            state: 'pending',
            created_at: now,
            updated_at: now,
            expires_at: toDate(input.expiresAt),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('outbox_event')
          .values({
            id: this.#ids.next(),
            owner_id: input.ownerId,
            topic: 'replan.proposed',
            payload: jsonb({ proposalId: input.id, version: 1 } as unknown as JsonValue),
            created_at: now,
            updated_at: now,
          })
          .execute();
        if (mode === 'detected') {
          // In-app notice for a proposal the user did not ask for (05 §11).
          await trx
            .insertInto('notification')
            .values({
              id: this.#ids.next(),
              owner_id: input.ownerId,
              kind: 'replan_proposal',
              dedupe_key: `replan_proposal:${input.id}`,
              scheduled_at: now,
              sent_at: now,
              channel: 'in_app',
              state: 'sent',
              created_at: now,
              updated_at: now,
            })
            .onConflict((oc) => oc.columns(['owner_id', 'dedupe_key']).doNothing())
            .execute();
        }
        return { kind: 'created', record: mapProposal(row) } as const;
      });
    } catch (error) {
      if (isPgError(error, '23505')) {
        // Unique pending (owner, reason) backstop: a concurrent writer won.
        return { kind: 'blocked', block: { kind: 'pending' } };
      }
      throw error;
    }
  }

  async list(
    ownerId: Id,
    query: ReplanProposalListQuery,
  ): Promise<{ items: ReplanProposalRecord[]; nextCursor: string | null }> {
    const limit = query.limit ?? 20;
    let builder = this.#db
      .selectFrom('replan_proposal')
      .selectAll()
      .where('owner_id', '=', ownerId);
    if (query.state !== undefined) builder = builder.where('state', '=', query.state);
    if (query.cursor !== undefined) builder = builder.where('id', '<', query.cursor as Id);
    const rows = await builder.orderBy('id', 'desc').limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    return {
      items: page.map(mapProposal),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async get(ownerId: Id, id: Id): Promise<ReplanProposalRecord | null> {
    const row = await this.#db
      .selectFrom('replan_proposal')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row === undefined ? null : mapProposal(row);
  }

  async reject(
    ownerId: Id,
    id: Id,
    expectedVersion: number,
    input: { readonly reason?: string | undefined; readonly now: Instant; readonly suppressUntil: Instant },
  ): Promise<ReplanProposalRecord> {
    return this.#db.transaction().execute(async (trx) => {
      const now = toDate(input.now);
      // Lock order: owner policy lock, then the proposal row (same as insert).
      await lockOwnerPolicy(trx, ownerId);
      const current = await trx
        .selectFrom('replan_proposal')
        .selectAll()
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError('replan proposal', id);
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion as never, current.version as never);
      }
      if (current.state !== 'pending') {
        throw proposalStateConflict(`the proposal is ${current.state}, not pending`);
      }
      const payload = isRecord(current.payload) ? current.payload : {};
      const row = await trx
        .updateTable('replan_proposal')
        .set({
          state: 'rejected',
          // The optional reason is personal text: stored for the owner only,
          // never logged or returned in the public proposal DTO.
          payload: jsonb({
            ...payload,
            ...(input.reason === undefined ? {} : { rejectReason: input.reason }),
            rejectedAt: input.now,
          } as unknown as JsonValue),
          version: expectedVersion + 1,
          updated_at: now,
        })
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('replan_suppression')
        .values({
          owner_id: ownerId,
          reason_code: current.reason_code,
          until: toDate(input.suppressUntil),
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['owner_id', 'reason_code']).doUpdateSet({
            until: sql<Date>`greatest(replan_suppression.until, excluded.until)`,
            updated_at: now,
            version: sql<number>`replan_suppression.version + 1`,
          }),
        )
        .execute();
      return mapProposal(row);
    });
  }

  async approve(request: ReplanApprovalRequest): Promise<PlanVersionDto> {
    const { ownerId } = request;
    try {
      return await this.#db.transaction().execute(async (trx) => {
        const now = new Date(instantToEpochMs(this.#clock.now()));
        // Replay before the If-Match lock (same rule as plan approval).
        const replay = await trx
          .selectFrom('schedule_approval')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('idempotency_key', '=', request.idempotencyKey)
          .executeTakeFirst();
        if (replay !== undefined) {
          const owner = await trx
            .selectFrom('replan_proposal')
            .select('id')
            .where('owner_id', '=', ownerId)
            .where('id', '=', request.proposalId)
            .where('result_plan_version_id', '=', replay.plan_version_id)
            .executeTakeFirst();
          if (owner === undefined) throw new IdempotencyMismatchError();
          return this.#loadVersion(trx, ownerId, replay.plan_version_id as Id);
        }

        await this.#ensureAvailabilityRow(trx, ownerId);
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

        const proposalRow = await trx
          .selectFrom('replan_proposal')
          .selectAll()
          .where('id', '=', request.proposalId)
          .where('owner_id', '=', ownerId)
          .forUpdate()
          .executeTakeFirst();
        if (proposalRow === undefined) {
          throw new NotFoundError('replan proposal', request.proposalId);
        }
        if (proposalRow.state !== 'pending') {
          throw proposalStateConflict(`the proposal is ${proposalRow.state}, not pending`);
        }
        if (proposalRow.expires_at.getTime() <= now.getTime()) {
          throw proposalStateConflict('the proposal has expired');
        }
        if (proposalRow.availability_version !== availabilityRow.version) {
          // The proposal was computed against another availability snapshot.
          throw new AvailabilityChangedError(proposalRow.availability_version, availabilityRow.version);
        }

        const planRow = await trx
          .selectFrom('plan')
          .selectAll()
          .where('id', '=', proposalRow.plan_id)
          .where('owner_id', '=', ownerId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (planRow === undefined) throw new NotFoundError('plan', proposalRow.plan_id);
        if (planRow.current_version_id !== proposalRow.base_plan_version_id) {
          throw proposalStateConflict('the plan version changed since the proposal was created');
        }

        const proposal = mapProposal(proposalRow);
        const availability = await this.#readAvailability(trx, ownerId);
        const commitments = await this.#commitmentsRange(
          trx,
          ownerId,
          planRow.horizon_start,
          planRow.horizon_end,
        );
        const blocks = await this.#listActiveBlocks(trx, ownerId);
        await this.#assertTasksLive(trx, ownerId, request.planningTaskIds);
        const estimates = await this.#loadEstimates(trx, ownerId, request.taskIds);
        const prepared = await request.prepare({
          proposal,
          plan: {
            id: planRow.id as Id,
            horizon: {
              start: toInstant(planRow.horizon_start),
              end: toInstant(planRow.horizon_end),
            },
            timeZone: planRow.time_zone,
          },
          availability,
          commitments,
          blocks,
          estimates,
        });

        // 08 §2.4 step 3: supersede only future blocks; history stays.
        const planVersionIds = await trx
          .selectFrom('plan_version')
          .select('id')
          .where('plan_id', '=', planRow.id)
          .where('owner_id', '=', ownerId)
          .execute();
        if (planVersionIds.length > 0) {
          await trx
            .updateTable('schedule_block')
            .set({ status: 'superseded', version: sql<number>`version + 1`, updated_at: now })
            .where('owner_id', '=', ownerId)
            .where(
              'plan_version_id',
              'in',
              planVersionIds.map((row) => row.id),
            )
            .where('status', '<>', 'superseded')
            .where('start_at', '>=', now)
            // M5-02R-1 H1: live tasks' locked blocks are immutable and stay
            // (same row, locked=true); the candidate never contains them.
            .where((eb) =>
              request.taskIds.length === 0
                ? eb.val(true)
                : eb.or([eb('locked', '=', false), eb('task_id', 'not in', request.taskIds)]),
            )
            .execute();
        }
        if (request.releaseVanishedTaskIds.length > 0) {
          await trx
            .updateTable('schedule_block')
            .set({ status: 'superseded', version: sql<number>`version + 1`, updated_at: now })
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
          .where('plan_id', '=', planRow.id)
          .where('owner_id', '=', ownerId)
          .executeTakeFirst();
        const seq = (seqRow?.max_seq ?? 0) + 1;
        const versionId = this.#ids.next() as Id;
        const reason = `replan:${proposal.trigger.reason}`;
        await trx
          .insertInto('plan_version')
          .values({
            id: versionId,
            owner_id: ownerId,
            plan_id: planRow.id,
            seq,
            candidate_id: null,
            reason,
            created_by: 'replan',
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
          .where('id', '=', planRow.id)
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
          .updateTable('replan_proposal')
          .set({
            state: 'approved',
            result_plan_version_id: versionId,
            version: sql<number>`version + 1`,
            updated_at: now,
          })
          .where('id', '=', proposalRow.id)
          .where('owner_id', '=', ownerId)
          .execute();

        await trx
          .insertInto('outbox_event')
          .values({
            id: this.#ids.next(),
            owner_id: ownerId,
            topic: 'plan.approved',
            payload: jsonb({
              planId: planRow.id,
              planVersionId: versionId,
              version: seq,
            } as unknown as JsonValue),
            created_at: now,
            updated_at: now,
          })
          .execute();

        return {
          id: versionId,
          planId: planRow.id as Id,
          seq,
          reason,
          createdBy: 'replan',
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
        throw new PlanConflictError('replan approval referenced a vanished task or plan version');
      }
      if (isPgError(error, '23505')) {
        throw new PlanConflictError('replan approval idempotency key is already in use');
      }
      throw error;
    }
  }

  async #policy(
    db: Db | Trx,
    ownerId: Id,
    trigger: Pick<ReplanTriggerDto, 'kind' | 'reason'>,
    window: ReplanPolicyWindow,
    mode: ReplanInsertMode,
  ): Promise<ReplanPolicyBlock | null> {
    const now = toDate(window.now);
    const suppression = await db
      .selectFrom('replan_suppression')
      .select('until')
      .where('owner_id', '=', ownerId)
      .where('reason_code', '=', trigger.reason)
      .where('until', '>', now)
      .executeTakeFirst();
    if (suppression !== undefined) {
      return { kind: 'suppressed', until: toInstant(suppression.until) };
    }
    if (mode === 'detected') {
      const pending = await db
        .selectFrom('replan_proposal')
        .select('id')
        .where('owner_id', '=', ownerId)
        .where('reason_code', '=', trigger.reason)
        .where('state', '=', 'pending')
        .executeTakeFirst();
      if (pending !== undefined) return { kind: 'pending' };
    }
    const today = await db
      .selectFrom('replan_proposal')
      .select([
        sql<number>`count(*)`.as('total'),
        sql<number>`count(*) filter (where trigger_kind = 'early_completion')`.as('early'),
      ])
      .where('owner_id', '=', ownerId)
      .where('created_at', '>=', toDate(window.dayStart))
      .where('created_at', '<', toDate(window.dayEnd))
      .executeTakeFirst();
    if (Number(today?.total ?? 0) >= REPLAN_DAILY_CAP) {
      return { kind: 'daily_cap', until: window.dayEnd };
    }
    if (
      trigger.kind === 'early_completion' &&
      Number(today?.early ?? 0) >= EARLY_COMPLETION_DAILY_CAP
    ) {
      return { kind: 'early_completion_cap', until: window.dayEnd };
    }
    return null;
  }

  async #assertTasksLive(trx: Trx, ownerId: Id, taskIds: readonly Id[]): Promise<void> {
    if (taskIds.length === 0) return;
    const rows = await trx
      .selectFrom('task')
      .select(['id', 'status_cache', 'deleted_at'])
      .where('owner_id', '=', ownerId)
      .where('id', 'in', taskIds)
      .execute();
    for (const row of rows) {
      if (row.deleted_at !== null || row.status_cache === 'done') {
        throw proposalStateConflict(`scoped task is no longer schedulable: ${row.id}`);
      }
    }
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
    const fromDate = new Date(toInstant(from));
    const toDateValue = new Date(toInstant(to));
    const rows = await db
      .selectFrom('commitment_event')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('rrule', 'is not', null),
          eb.and([eb('start_at', '<', toDateValue), eb('end_at', '>', fromDate)]),
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
    return new Map(
      rows.map((row) => [
        row.task_id,
        { taskId: row.task_id as Id, p50Min: row.p50_min, p90Min: row.p90_min },
      ]),
    );
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
