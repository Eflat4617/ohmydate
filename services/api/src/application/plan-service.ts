import type {
  Availability,
  DiversityNoteItem,
  AvailabilityPut,
  Commitment,
  CommitmentCreate,
  CommitmentListQuery,
  CommitmentPage,
  CommitmentPatch,
  GoalListQuery,
  GoalPage,
  GoalStatusName,
  Plan,
  PlanBlock,
  PlanCreate,
  PlanHorizon,
  PlanScope,
  PlanVersionDto,
  ScheduleBlockDto,
  ScheduleBlockListQuery,
  ScheduleBlockPage,
  Violation as ContractViolation,
} from '@ohmydate/contracts';
import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  type Clock,
  epochMsToInstant,
  isUuidV7,
  type Id,
  type Instant,
  type Task,
  type TaskRepository,
} from '@ohmydate/domain';
import {
  generate,
  validate,
  type Block as SchedulerBlock,
  type PlanCandidate as SchedulerCandidate,
  type ScheduleInput,
  type Violation as SchedulerViolation,
} from '@ohmydate/scheduler';
import { canonicalJson, sha256Hex } from './canonical.js';
import {
  AvailabilityChangedError,
  ConstraintViolationError,
  PlanConflictError,
} from './planning-errors.js';
import type {
  ApprovalSnapshot,
  ApprovedBlock,
  EstimateRecord,
  NewCandidate,
  PlanningStore,
  PreparedApproval,
} from './planning-ports.js';
import {
  clipOccurrence,
  expandOccurrences,
  InvalidRRuleError,
  MAX_OCCURRENCES,
  parseRRule,
} from './rrule.js';
import { schedulingSessionBounds } from './session-bounds.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_HORIZON_DAYS = 366;

interface ResolvedScope {
  readonly goalId?: Id;
  readonly taskIds: readonly Id[];
}

export interface PlanServiceDependencies {
  readonly tasks: TaskRepository;
  readonly store: PlanningStore;
  readonly clock: Clock;
}

function toPathList(prefix: string, index: number): string {
  return `${prefix}/${index}`;
}

function assertMinutePrecision(value: string, path: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ValidationFailedError([{ path, message: 'invalid instant' }]);
  }
  if (ms % MINUTE_MS !== 0) {
    throw new ValidationFailedError([
      { path, message: 'instant must have minute precision (microseconds are not supported)' },
    ]);
  }
  return ms;
}

function validateHorizon(horizon: PlanHorizon): { startMs: number; endMs: number } {
  const startMs = assertMinutePrecision(horizon.start, '/horizon/start');
  const endMs = assertMinutePrecision(horizon.end, '/horizon/end');
  if (endMs <= startMs) {
    throw new ValidationFailedError([
      { path: '/horizon/end', message: 'horizon end must be after horizon start' },
    ]);
  }
  if (endMs - startMs > MAX_HORIZON_DAYS * DAY_MS) {
    throw new ValidationFailedError([
      {
        path: '/horizon/end',
        message: `horizon spans more than ${MAX_HORIZON_DAYS} days`,
      },
    ]);
  }
  return { startMs, endMs };
}

export function toPlanBlock(block: SchedulerBlock): PlanBlock {
  return { taskId: block.taskId as Id, startAt: block.start, endAt: block.end };
}

export function fromPlanBlock(block: PlanBlock): SchedulerBlock {
  return { taskId: block.taskId, start: block.startAt, end: block.endAt };
}

export function toContractViolations(
  violations: readonly SchedulerViolation[],
): ContractViolation[] {
  return violations.map((violation) => ({
    code: violation.code as ContractViolation['code'],
    ...(violation.taskId === undefined ? {} : { taskId: violation.taskId as Id }),
    message: violation.message,
    // FU-62: the stable, renderable form of the same finding.
    messageCode: violation.messageCode,
    params: { ...violation.params },
  }));
}

function mapCandidate(
  candidate: SchedulerCandidate,
  diversityNote?: string | undefined,
  diversityNoteItems?: readonly DiversityNoteItem[] | undefined,
): NewCandidate {
  return {
    policy: candidate.policy,
    blocks: candidate.blocks.map(toPlanBlock),
    metrics: candidate.metrics,
    feasible: candidate.feasible,
    deficitMin: candidate.deficitMin,
    capacityDeficitMin: candidate.capacityDeficitMin,
    explanation: candidate.explanation,
    explanationItems: candidate.explanationItems,
    ...(diversityNote === undefined ? {} : { diversityNote }),
    ...(diversityNoteItems === undefined ? {} : { diversityNoteItems }),
    generatorVersion: candidate.generatorVersion,
    inputHash: candidate.inputHash,
  };
}

/**
 * FU-68: the scheduler's plan-level diversity note belongs to the first
 * candidate (the UI shows it once, above the comparison). The coded items
 * travel with it.
 */
function mapCandidates(result: {
  readonly candidates: readonly SchedulerCandidate[];
  readonly diversityNote?: string | undefined;
  readonly diversityNoteItems?: readonly DiversityNoteItem[] | undefined;
}): NewCandidate[] {
  return result.candidates.map((candidate, index) =>
    index === 0
      ? mapCandidate(candidate, result.diversityNote, result.diversityNoteItems)
      : mapCandidate(candidate),
  );
}

/**
 * Deterministic seed for `generate()`. The seed is not user input: it is the
 * first 32 bits of a SHA-256 over the canonical planning key (tenant, scope,
 * horizon, availability version and scope task ids), so the same stored plan
 * regenerates byte-identically while an availability or scope change produces
 * a different (but still reproducible) plan.
 */
export function deriveSeed(key: unknown): number {
  return Number.parseInt(sha256Hex(canonicalJson(key)).slice(0, 8), 16) >>> 0;
}

function riskLevelOf(availability: Availability): 'p50' | 'p90' {
  return availability.prefs.riskLevel;
}

function availabilityRules(
  availability: Availability,
): ScheduleInput['availability'] {
  return availability.rules.map((rule) => ({
    weekday: rule.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7,
    startLocal: rule.startLocal,
    endLocal: rule.endLocal,
    kind: rule.kind,
  }));
}

function availabilityExceptions(
  availability: Availability,
): ScheduleInput['exceptions'] {
  return availability.exceptions.map((exception) => ({
    date: exception.date,
    kind: exception.kind,
    ...(exception.startLocal === undefined ? {} : { startLocal: exception.startLocal }),
    ...(exception.endLocal === undefined ? {} : { endLocal: exception.endLocal }),
  }));
}

function commitmentInstants(
  commitments: readonly Commitment[],
  horizon: PlanHorizon,
): ScheduleInput['commitments'] {
  const result: ScheduleInput['commitments'] = [];
  for (const commitment of commitments) {
    let occurrences;
    try {
      occurrences = expandOccurrences(commitment, horizon.start, horizon.end);
    } catch (error) {
      if (error instanceof InvalidRRuleError) {
        throw new ValidationFailedError([{ path: '/commitments', message: error.message }]);
      }
      throw error;
    }
    for (const occurrence of occurrences) {
      const clipped = clipOccurrence(occurrence, horizon.start, horizon.end);
      if (clipped !== null) result.push({ start: clipped.startAt, end: clipped.endAt });
      if (result.length > MAX_OCCURRENCES) {
        throw new ValidationFailedError([
          {
            path: '/commitments',
            message: `commitments expand to more than ${MAX_OCCURRENCES} occurrences`,
          },
        ]);
      }
    }
  }
  return result;
}

function historyMinutes(blocks: readonly ApprovedBlock[], taskId: Id, now: string): number {
  const nowMs = Date.parse(now);
  let minutes = 0;
  for (const block of blocks) {
    if (block.taskId !== taskId) continue;
    if (Date.parse(block.startAt) >= nowMs) continue;
    minutes += Math.max(0, (Date.parse(block.endAt) - Date.parse(block.startAt)) / MINUTE_MS);
  }
  return minutes;
}

export interface AssemblyInput {
  readonly now: string;
  readonly timeZone: string;
  readonly horizon: PlanHorizon;
  readonly availability: Availability;
  readonly commitments: readonly Commitment[];
  readonly planningTasks: readonly Task[];
  readonly extraTasks: readonly Task[];
  readonly estimates: ReadonlyMap<string, EstimateRecord>;
  readonly activeBlocks: readonly ApprovedBlock[];
  readonly currentPlanId?: Id | undefined;
  readonly seed: number;
}

export interface Assembled {
  readonly input: ScheduleInput;
  readonly historyBlocks: SchedulerBlock[];
  readonly lockedBlocks: SchedulerBlock[];
}

function blockMinutes(blocks: readonly SchedulerBlock[], taskId: Id): number {
  let minutes = 0;
  for (const block of blocks) {
    if (block.taskId !== taskId) continue;
    minutes += Math.max(0, (Date.parse(block.end) - Date.parse(block.start)) / MINUTE_MS);
  }
  return minutes;
}

/**
 * Shared ScheduleInput assembly for plan creation, preview, approval and the
 * M5 replan path (08 §2.4a): availability + commitments + approved blocks
 * (history/existing/locked) + current estimates.
 */
export function assembleScheduleInput(source: AssemblyInput): Assembled {
  const { horizon, availability } = source;
  const lockedBlocks: SchedulerBlock[] = [];
  const existingBlocks: SchedulerBlock[] = [];
  const historyBlocks: SchedulerBlock[] = [];
  const nowMs = Date.parse(source.now);
  const allTasks = new Map<string, Task>();
  for (const task of [...source.planningTasks, ...source.extraTasks]) {
    allTasks.set(task.id, task);
  }
  const planningIds = new Set(source.planningTasks.map((task) => task.id));

  for (const block of source.activeBlocks) {
    const schedulerBlock: SchedulerBlock = {
      taskId: block.taskId,
      start: block.startAt,
      end: block.endAt,
    };
    const task = allTasks.get(block.taskId);
    const inPlanningSet = planningIds.has(block.taskId);
    if (Date.parse(block.startAt) < nowMs) {
      // 06 §7.1: history is a fact. The scheduler consumes it through
      // existingBlocks (its documented history channel), not lockedBlocks.
      historyBlocks.push(schedulerBlock);
      existingBlocks.push(schedulerBlock);
    } else if (!inPlanningSet && (task === undefined || task.status === 'done')) {
      // Done/vanished work must not spend capacity on re-approval. Dropping
      // the future block releases its time; the approval TX supersedes the
      // stored row (probes H/H2/K).
      continue;
    } else if (
      inPlanningSet &&
      source.currentPlanId !== undefined &&
      block.planId === source.currentPlanId &&
      !block.locked
    ) {
      existingBlocks.push(schedulerBlock);
    } else {
      // Blocks of other live (non-planning-set) tasks, and every future
      // locked block (06 §7 "locked 고정", M5-02R-1 H1), are immutable
      // lockedBlocks: audited and credited, never moved or re-emitted. A
      // locked block that already started is history above (06 §7.1).
      lockedBlocks.push(schedulerBlock);
    }
  }

  const riskLevel = riskLevelOf(availability);
  const tasks: ScheduleInput['tasks'] = [...allTasks.values()].map((task) => {
    const estimate = source.estimates.get(task.id);
    const inPlanningSet = planningIds.has(task.id);
    if (estimate === undefined && inPlanningSet) {
      throw new ValidationFailedError([
        { path: `/scope/${task.id}`, message: `missing_estimate for task ${task.id}` },
      ]);
    }
    const effective = estimate ?? { p50Min: 0, p90Min: 0 };
    const required = riskLevel === 'p90' ? effective.p90Min : effective.p50Min;
    const remainingMin = inPlanningSet
      ? Math.max(0, required - historyMinutes(source.activeBlocks, task.id, source.now))
      : blockMinutes(lockedBlocks, task.id);
    // Planning-set bounds come from the one shared mapping (FU-96): a
    // non-splittable task is one block equal to the remaining requirement,
    // unless that is longer than one H6-legal block, in which case it is
    // auto-split for scheduling only. Out-of-scope locked/history tasks are
    // not re-placed; keep their bounds permissive so auditing the
    // already-approved blocks cannot invent an H5.
    const bounds = inPlanningSet
      ? schedulingSessionBounds(task, remainingMin, availability.prefs)
      : { splittable: true, minSessionMin: 1, maxSessionMin: 100_000 };
    return {
      id: task.id,
      ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
      estimate: { p50Min: effective.p50Min, p90Min: effective.p90Min },
      remainingMin,
      splittable: bounds.splittable,
      minSessionMin: bounds.minSessionMin,
      maxSessionMin: bounds.maxSessionMin,
      ...(bounds.autoSplit === undefined ? {} : { autoSplit: bounds.autoSplit }),
      priority: task.priority,
      dependsOn: task.dependsOn.filter((dependency) => allTasks.has(dependency)),
    };
  });

  return {
    input: {
      now: source.now,
      timeZone: source.timeZone,
      horizon,
      tasks,
      availability: availabilityRules(availability),
      exceptions: availabilityExceptions(availability),
      commitments: commitmentInstants(source.commitments, horizon),
      lockedBlocks,
      ...(existingBlocks.length === 0 ? {} : { existingBlocks }),
      prefs: availability.prefs,
      seed: source.seed,
    },
    historyBlocks,
    lockedBlocks,
  };
}

function scopeTaskIds(scope: PlanScope): readonly Id[] | null {
  return 'taskIds' in scope ? (scope.taskIds as Id[]) : null;
}

export class PlanService {
  readonly #tasks: TaskRepository;
  readonly #store: PlanningStore;
  readonly #clock: Clock;

  constructor(deps: PlanServiceDependencies) {
    this.#tasks = deps.tasks;
    this.#store = deps.store;
    this.#clock = deps.clock;
  }

  async getAvailability(ownerId: Id): Promise<Availability> {
    return this.#store.getAvailability(ownerId);
  }

  async putAvailability(
    ownerId: Id,
    input: AvailabilityPut,
    expectedVersion: number,
  ): Promise<Availability> {
    return this.#store.putAvailability(ownerId, input, expectedVersion);
  }

  async listCommitments(ownerId: Id, query: CommitmentListQuery): Promise<CommitmentPage> {
    assertMinutePrecision(query.from, '/from');
    assertMinutePrecision(query.to, '/to');
    return this.#store.listCommitments(ownerId, query);
  }

  async createCommitment(ownerId: Id, input: CommitmentCreate): Promise<Commitment> {
    validateCommitment(input, this.#clock.now());
    return this.#store.createCommitment(ownerId, input);
  }

  async updateCommitment(
    ownerId: Id,
    id: Id,
    patch: CommitmentPatch,
    expectedVersion: number,
  ): Promise<Commitment> {
    if (patch.rrule !== undefined && patch.rrule !== null) {
      validateRRule(patch.rrule);
    }
    if (patch.startAt !== undefined) {
      assertStartNotTooOld(patch.startAt, this.#clock.now());
    }
    if (patch.startAt !== undefined && patch.endAt !== undefined) {
      assertInterval(patch.startAt, patch.endAt);
    }
    return this.#store.updateCommitment(ownerId, id, patch, expectedVersion);
  }

  async deleteCommitment(ownerId: Id, id: Id, expectedVersion: number): Promise<void> {
    await this.#store.deleteCommitment(ownerId, id, expectedVersion);
  }

  async createPlan(ownerId: Id, request: PlanCreate): Promise<Plan> {
    const horizon = request.horizon;
    validateHorizon(horizon);
    const now = this.#clock.now();
    const availability = await this.#store.getAvailability(ownerId);
    const planning = await this.#planningTaskSet(ownerId, request.scope, 'create');
    const activeBlocks = await this.#store.listActiveBlocks(ownerId);
    const extras = await this.#resolveExtras(ownerId, activeBlocks, planning.ids);
    const allTasks = [...planning.tasks, ...extras.tasks];
    const taskIds = allTasks.map((task) => task.id);
    const estimates = await this.#store.getCurrent(ownerId, taskIds);
    const commitments = await this.#store.listCommitmentsInRange(
      ownerId,
      horizon.start,
      horizon.end,
    );
    const seed = deriveSeed({
      kind: 'create',
      ownerId,
      scope: request.scope,
      horizon,
      timeZone: availability.timeZone,
      availabilityVersion: availability.version,
      taskIds: [...taskIds].sort(),
    });
    const assembled = assembleScheduleInput({
      now,
      timeZone: availability.timeZone,
      horizon,
      availability,
      commitments,
      planningTasks: planning.tasks,
      extraTasks: extras.tasks,
      estimates,
      activeBlocks: extras.blocks,
      seed,
    });
    const policies = request.policies;
    const result = generate(assembled.input, policies === undefined ? {} : { policies });
    return this.#store.createPlan(ownerId, {
      scope: request.scope,
      horizon,
      timeZone: availability.timeZone,
      availabilityVersion: availability.version,
      candidates: mapCandidates(result),
    });
  }

  /**
   * FU-71: lock (`locked=true`) or unlock one approved block. Locking never
   * changes its times; the scheduler keeps a locked block as an immutable
   * lockedBlock, and an unlocked one is movable by the next replan (06 §7).
   */
  async setBlockLock(
    ownerId: Id,
    blockId: Id,
    locked: boolean,
    expectedVersion: number,
  ): Promise<ScheduleBlockDto> {
    return this.#store.setBlockLock(ownerId, {
      blockId,
      locked,
      expectedVersion,
      now: this.#clock.now(),
    });
  }

  async getPlan(ownerId: Id, id: Id): Promise<Plan> {
    const plan = await this.#store.getPlan(ownerId, id);
    if (plan === null) throw new NotFoundError('plan', id);
    return plan;
  }

  /**
   * FU-51: active approved blocks overlapping `[from, to)`. The cursor is
   * `startAt|id`, matching the ascending `(startAt, id)` order. Ranges longer
   * than 366 days are rejected before reading any rows.
   */
  async listScheduleBlocks(
    ownerId: Id,
    query: ScheduleBlockListQuery,
  ): Promise<ScheduleBlockPage> {
    const fromMs = Date.parse(query.from);
    const toMs = Date.parse(query.to);
    if (!Number.isFinite(fromMs)) {
      throw new ValidationFailedError([{ path: '/from', message: 'invalid instant' }]);
    }
    if (!Number.isFinite(toMs)) {
      throw new ValidationFailedError([{ path: '/to', message: 'invalid instant' }]);
    }
    if (toMs <= fromMs) {
      throw new ValidationFailedError([
        { path: '/to', message: 'to must be after from' },
      ]);
    }
    if (toMs - fromMs > MAX_HORIZON_DAYS * DAY_MS) {
      throw new ValidationFailedError([
        { path: '/to', message: `range spans more than ${MAX_HORIZON_DAYS} days` },
      ]);
    }
    const limit = query.limit ?? 100;
    let cursor: { startMs: number; id: string } | undefined;
    if (query.cursor !== undefined) {
      const split = query.cursor.indexOf('|');
      if (split <= 0) {
        throw new ValidationFailedError([
          { path: '/cursor', message: 'invalid schedule-block cursor' },
        ]);
      }
      const startMs = Date.parse(query.cursor.slice(0, split));
      const id = query.cursor.slice(split + 1);
      if (!Number.isFinite(startMs) || !isUuidV7(id)) {
        throw new ValidationFailedError([
          { path: '/cursor', message: 'invalid schedule-block cursor' },
        ]);
      }
      cursor = { startMs, id };
    }
    // FU-53: the range and cursor are pushed into SQL; only one page (plus
    // one lookahead row) is ever read from the database.
    const blocks = await this.#store.listScheduleBlocks(ownerId, {
      from: query.from as Instant,
      to: query.to as Instant,
      ...(cursor === undefined
        ? {}
        : {
            cursorStartAt: epochMsToInstant(cursor.startMs),
            cursorId: cursor.id as Id,
          }),
      limit: limit + 1,
    });
    const page = blocks.slice(0, limit);
    return {
      items: page.map((block) => ({
        id: block.id,
        planVersionId: block.planVersionId,
        taskId: block.taskId,
        startAt: block.startAt,
        endAt: block.endAt,
        locked: block.locked,
        status: block.status as ScheduleBlockDto['status'],
        version: block.version,
      })),
      nextCursor:
        blocks.length > limit
          ? `${page[page.length - 1]?.startAt ?? ''}|${page[page.length - 1]?.id ?? ''}`
          : null,
    };
  }

  /**
   * FU-98: the owner's planning goals, newest first, each with the tasks its
   * approval created (the `{ goalId }` scope's task set). The cursor is
   * `createdAt|id` of the last goal of the previous page; limit defaults to 50.
   */
  async listGoals(ownerId: Id, query: GoalListQuery): Promise<GoalPage> {
    const limit = query.limit ?? 50;
    let cursor: { createdMs: number; id: string } | undefined;
    if (query.cursor !== undefined) {
      const split = query.cursor.indexOf('|');
      const createdMs = split <= 0 ? Number.NaN : Date.parse(query.cursor.slice(0, split));
      const id = split <= 0 ? '' : query.cursor.slice(split + 1);
      if (!Number.isFinite(createdMs) || !isUuidV7(id)) {
        throw new ValidationFailedError([{ path: '/cursor', message: 'invalid goal cursor' }]);
      }
      cursor = { createdMs, id };
    }
    const goals = await this.#store.listGoals(ownerId, {
      ...(cursor === undefined
        ? {}
        : { cursorCreatedAt: epochMsToInstant(cursor.createdMs), cursorId: cursor.id as Id }),
      limit: limit + 1,
    });
    const page = goals.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((goal) => ({
        id: goal.id,
        title: goal.title,
        status: goal.status as GoalStatusName,
        createdAt: goal.createdAt,
        taskIds: [...goal.taskIds],
      })),
      nextCursor: goals.length > limit && last !== undefined ? `${last.createdAt}|${last.id}` : null,
    };
  }

  async previewEdit(
    ownerId: Id,
    planId: Id,
    candidateId: Id,
    blocks: readonly PlanBlock[],
    expectedPlanVersion: number,
  ): Promise<{ feasible: boolean; violations: ContractViolation[]; deficitMin: number }> {
    const plan = await this.getPlan(ownerId, planId);
    if (plan.version !== expectedPlanVersion) {
      throw new VersionConflictError(expectedPlanVersion as never, plan.version as never);
    }
    const candidate = await this.#store.getCandidate(ownerId, planId, candidateId);
    if (candidate === null) throw new NotFoundError('plan candidate', candidateId);
    const now = this.#clock.now();
    const availability = await this.#store.getAvailability(ownerId);
    const planning = await this.#planningTaskSet(ownerId, plan.scope, 'conflict');
    blocks.forEach((block, index) => {
      this.#preflightBlock(block, index, plan.horizon, planning.ids, '/blocks');
    });
    const activeBlocks = await this.#store.listActiveBlocks(ownerId);
    const extras = await this.#resolveExtras(ownerId, activeBlocks, planning.ids);
    const taskIds = [...planning.tasks, ...extras.tasks].map((task) => task.id);
    const estimates = await this.#store.getCurrent(ownerId, taskIds);
    const commitments = await this.#store.listCommitmentsInRange(
      ownerId,
      plan.horizon.start,
      plan.horizon.end,
    );
    const seed = deriveSeed({ kind: 'preview', planId, horizon: plan.horizon });
    const assembled = assembleScheduleInput({
      now,
      timeZone: availability.timeZone,
      horizon: plan.horizon,
      availability,
      commitments,
      planningTasks: planning.tasks,
      extraTasks: extras.tasks,
      estimates,
      activeBlocks: extras.blocks,
      currentPlanId: planId,
      seed,
    });
    const schedulerBlocks = withoutLockedEchoes(blocks, extras.blocks, now).map(fromPlanBlock);
    const findings = validate(assembled.input, schedulerBlocks, {
      riskLevel: riskLevelOf(availability),
      historyBlocks: assembled.historyBlocks,
    });
    const publicFindings = findings.filter((finding) => !finding.code.startsWith('H0_'));
    if (publicFindings.length !== findings.length) {
      throw new ValidationFailedError([
        {
          path: '/blocks',
          message: 'edited blocks reference tasks or times outside the persisted plan',
        },
      ]);
    }
    return {
      feasible: publicFindings.length === 0,
      violations: toContractViolations(publicFindings),
      deficitMin: candidate.deficitMin,
    };
  }

  /**
   * Approve a candidate in one PostgreSQL transaction (08 §2.4 steps 1-6).
   *
   * No provider HTTP runs inside the transaction. Scope, provider tasks and
   * estimates are read before the TX; inside it only PostgreSQL state is
   * re-checked. M3 performs no provider writes, so approval never returns
   * `503 provider_unavailable` in practice.
   */
  async approve(
    ownerId: Id,
    planId: Id,
    candidateId: Id,
    editedBlocks: readonly PlanBlock[] | undefined,
    expectedAvailabilityVersion: number,
    idempotencyKey: string,
  ): Promise<PlanVersionDto> {
    const plan = await this.getPlan(ownerId, planId);
    const candidate = await this.#store.getCandidate(ownerId, planId, candidateId);
    if (candidate === null) throw new NotFoundError('plan candidate', candidateId);
    const now = this.#clock.now();
    const planning = await this.#planningTaskSet(ownerId, plan.scope, 'conflict');
    const blocks = editedBlocks ?? candidate.blocks;
    if (editedBlocks !== undefined) {
      blocks.forEach((block, index) => {
        this.#preflightBlock(block, index, plan.horizon, planning.ids, '/editedBlocks');
      });
    }
    const activeBlocks = await this.#store.listActiveBlocks(ownerId);
    const extras = await this.#resolveExtras(ownerId, activeBlocks, planning.ids);
    const allTasks = [...planning.tasks, ...extras.tasks];
    const taskIds = allTasks.map((task) => task.id);

    return this.#store.approve(ownerId, planId, candidateId, {
      expectedAvailabilityVersion,
      expectedPlanVersion: plan.version,
      idempotencyKey,
      now,
      ...(editedBlocks === undefined ? {} : { editedBlocks }),
      taskIds,
      planningTaskIds: [...planning.ids] as Id[],
      identityTasks: allTasks,
      releaseVanishedTaskIds: extras.vanishedTaskIds,
      prepare: async (snapshot) =>
        this.#prepareApproval(snapshot, {
          now,
          planningTasks: planning.tasks,
          extraTasks: extras.tasks,
          chosenBlocks: blocks,
          planningIds: planning.ids,
          preflight: editedBlocks !== undefined,
          preflightPrefix: '/editedBlocks',
        }),
    });
  }

  async regenerate(ownerId: Id, planId: Id, expectedVersion: number): Promise<Plan> {
    const plan = await this.getPlan(ownerId, planId);
    if (plan.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion as never, plan.version as never);
    }
    const now = this.#clock.now();
    const availability = await this.#store.getAvailability(ownerId);
    const planning = await this.#planningTaskSet(ownerId, plan.scope, 'conflict');
    const activeBlocks = await this.#store.listActiveBlocks(ownerId);
    const extras = await this.#resolveExtras(ownerId, activeBlocks, planning.ids);
    const taskIds = [...planning.tasks, ...extras.tasks].map((task) => task.id);
    const estimates = await this.#store.getCurrent(ownerId, taskIds);
    const commitments = await this.#store.listCommitmentsInRange(
      ownerId,
      plan.horizon.start,
      plan.horizon.end,
    );
    const seed = deriveSeed({
      kind: 'regenerate',
      ownerId,
      planId,
      horizon: plan.horizon,
      availabilityVersion: availability.version,
      timeZone: availability.timeZone,
      taskIds: [...taskIds].sort(),
    });
    const assembled = assembleScheduleInput({
      now,
      timeZone: availability.timeZone,
      horizon: plan.horizon,
      availability,
      commitments,
      planningTasks: planning.tasks,
      extraTasks: extras.tasks,
      estimates,
      activeBlocks: extras.blocks,
      currentPlanId: planId,
      seed,
    });
    const policies = [...new Set(plan.candidates.map((candidate) => candidate.policy))];
    const result = generate(assembled.input, policies.length === 0 ? {} : { policies });
    return this.#store.replaceCandidates(
      ownerId,
      planId,
      expectedVersion,
      mapCandidates(result),
      availability.timeZone,
      availability.version,
    );
  }

  async #prepareApproval(
    snapshot: ApprovalSnapshot,
    context: {
      now: string;
      planningTasks: readonly Task[];
      extraTasks: readonly Task[];
      chosenBlocks: readonly PlanBlock[];
      planningIds: ReadonlySet<string>;
      preflight: boolean;
      preflightPrefix: string;
    },
  ): Promise<PreparedApproval> {
    if (context.preflight) {
      context.chosenBlocks.forEach((block, index) => {
        this.#preflightBlock(
          block,
          index,
          snapshot.plan.horizon,
          context.planningIds,
          context.preflightPrefix,
        );
      });
    }
    const seed = deriveSeed({
      kind: 'approve',
      planId: snapshot.plan.id,
      candidateId: snapshot.candidate.id,
      horizon: snapshot.plan.horizon,
    });
    const assembled = assembleScheduleInput({
      now: context.now,
      timeZone: snapshot.availability.timeZone,
      horizon: snapshot.plan.horizon,
      availability: snapshot.availability,
      commitments: snapshot.commitments,
      planningTasks: context.planningTasks,
      extraTasks: context.extraTasks,
      estimates: snapshot.estimates,
      activeBlocks: snapshot.blocks,
      currentPlanId: snapshot.plan.id as Id,
      seed,
    });
    const chosen = withoutLockedEchoes(context.chosenBlocks, snapshot.blocks, context.now);
    const schedulerBlocks = chosen.map(fromPlanBlock);
    const findings = validate(assembled.input, schedulerBlocks, {
      riskLevel: riskLevelOf(snapshot.availability),
      historyBlocks: assembled.historyBlocks,
    });
    const preflightFindings = findings.filter((finding) => finding.code.startsWith('H0_'));
    if (preflightFindings.length > 0) {
      if (!context.preflight) {
        throw new PlanConflictError(
          'the approved candidate references a task that is no longer schedulable',
        );
      }
      throw new ValidationFailedError(
        preflightFindings.map((finding) => ({
          path: context.preflightPrefix,
          message: finding.message,
        })),
      );
    }
    return {
      blocks: chosen,
      violations: toContractViolations(findings),
    };
  }

  async #resolveScope(
    ownerId: Id,
    scope: PlanScope,
    mode: 'create' | 'conflict',
  ): Promise<ResolvedScope> {
    const ids = scopeTaskIds(scope);
    if (ids !== null) {
      return { taskIds: ids as Id[] };
    }
    const goalId = (scope as { goalId: Id }).goalId;
    const resolved = await this.#store.resolveGoalTasks(ownerId, goalId);
    if (resolved === null || !resolved.goalExists) {
      throw new NotFoundError('goal', goalId);
    }
    if (resolved.taskIds.length === 0) {
      if (mode === 'create') {
        throw new ValidationFailedError([
          { path: '/scope/goalId', message: 'goal has no tasks to plan' },
        ]);
      }
      throw new PlanConflictError(`goal ${goalId} no longer has tasks in scope`);
    }
    return { goalId, taskIds: resolved.taskIds as Id[] };
  }

  /**
   * One planning task set for generation, preflight and approval:
   * scope seeds + dependency closure, minus done/deleted tasks. It is
   * recomputed deterministically from the persisted scope on every call.
   */
  async #planningTaskSet(
    ownerId: Id,
    scope: PlanScope,
    mode: 'create' | 'conflict',
  ): Promise<{ ids: ReadonlySet<string>; tasks: readonly Task[] }> {
    const resolved = await this.#resolveScope(ownerId, scope, mode);
    const seen = new Set<string>();
    const tasks = new Map<string, Task>();
    const queue = [...resolved.taskIds];
    const missing: Id[] = [];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const task = await this.#tasks.get(ownerId, id);
      if (task === null) {
        missing.push(id);
        continue;
      }
      if (task.status === 'done') continue;
      tasks.set(task.id, task);
      for (const dependency of task.dependsOn) {
        if (!seen.has(dependency)) queue.push(dependency);
      }
    }
    if (missing.length > 0) {
      if (mode === 'create') {
        throw new ValidationFailedError(
          missing.map((id) => ({ path: `/scope/${id}`, message: `unknown task ${id}` })),
        );
      }
      throw new PlanConflictError(`scoped task vanished: ${missing.join(', ')}`);
    }
    return { ids: new Set(tasks.keys()), tasks: [...tasks.values()] };
  }

  async #resolveExtras(
    ownerId: Id,
    activeBlocks: readonly ApprovedBlock[],
    planningIds: ReadonlySet<string>,
  ): Promise<ResolvedExtras> {
    return resolveExtraTasks(this.#tasks, ownerId, activeBlocks, planningIds);
  }

  #preflightBlock(
    block: PlanBlock,
    index: number,
    horizon: PlanHorizon,
    scopeIds: ReadonlySet<string>,
    prefix: string,
  ): void {
    const startMs = Date.parse(block.startAt);
    const endMs = Date.parse(block.endAt);
    const issues: { path: string; message: string }[] = [];
    const horizonStartMs = Date.parse(horizon.start);
    const horizonEndMs = Date.parse(horizon.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      issues.push({ path: toPathList(prefix, index), message: 'invalid block instant' });
    } else if (endMs <= startMs) {
      issues.push({ path: toPathList(prefix, index), message: 'block ends before it starts' });
    } else if (startMs < horizonStartMs || endMs > horizonEndMs) {
      issues.push({
        path: toPathList(prefix, index),
        message: 'block lies outside the persisted plan horizon',
      });
    } else if (startMs % MINUTE_MS !== 0 || endMs % MINUTE_MS !== 0) {
      issues.push({
        path: toPathList(prefix, index),
        message: 'block instant must have minute precision',
      });
    }
    if (!scopeIds.has(block.taskId)) {
      issues.push({
        path: toPathList(prefix, index),
        message: `task ${block.taskId} is not in the plan scope`,
      });
    }
    if (issues.length > 0) throw new ValidationFailedError(issues);
  }
}

/**
 * M5-02R-1 H1: locked future blocks are immutable and never part of a
 * candidate. An edited block that echoes one exactly (same task and instants)
 * is the unchanged locked block, not a new block, so it is dropped before
 * validation; any other edit of that task is validated normally (moving the
 * locked minutes elsewhere overallocates the task -> H7 constraint_violation).
 */
export function withoutLockedEchoes(
  blocks: readonly PlanBlock[],
  activeBlocks: readonly ApprovedBlock[],
  now: string,
): PlanBlock[] {
  const nowMs = Date.parse(now);
  const locked = new Set(
    activeBlocks
      .filter((block) => block.locked && Date.parse(block.startAt) >= nowMs)
      .map((block) => `${block.taskId}|${Date.parse(block.startAt)}|${Date.parse(block.endAt)}`),
  );
  if (locked.size === 0) return [...blocks];
  return blocks.filter(
    (block) => !locked.has(`${block.taskId}|${Date.parse(block.startAt)}|${Date.parse(block.endAt)}`),
  );
}

export interface ResolvedExtras {
  readonly tasks: readonly Task[];
  readonly blocks: readonly ApprovedBlock[];
  readonly vanishedTaskIds: readonly Id[];
}

/**
 * Tasks owning active blocks outside the planning set. Done/vanished work is
 * not schedulable state: its blocks are dropped rather than failing or
 * locking every future plan for the owner (probes H/H2/K). The approval TX
 * supersedes vanished tasks' stored future blocks.
 */
export async function resolveExtraTasks(
  tasks: TaskRepository,
  ownerId: Id,
  activeBlocks: readonly ApprovedBlock[],
  planningIds: ReadonlySet<string>,
): Promise<ResolvedExtras> {
  const ids = [
    ...new Set(
      activeBlocks
        .map((block) => block.taskId)
        .filter((id) => !planningIds.has(id)),
    ),
  ];
  const resolved: Task[] = [];
  const vanished = new Set<string>();
  const done = new Set<string>();
  for (const id of ids) {
    const task = await tasks.get(ownerId, id);
    if (task === null) {
      vanished.add(id);
      continue;
    }
    if (task.status === 'done') {
      done.add(id);
      continue;
    }
    resolved.push(task);
  }
  return {
    tasks: resolved,
    blocks: activeBlocks.filter((block) => !vanished.has(block.taskId) && !done.has(block.taskId)),
    vanishedTaskIds: [...vanished] as Id[],
  };
}

const MAX_WRITE_RRULE_COUNT = 1_000;

export function validateRRule(rrule: string): void {
  try {
    // Parsing without expansion rejects unsupported FREQ/INTERVAL/UNTIL forms
    // before they are persisted. The adapter still accepts up to 2,000 COUNT
    // for legacy stored rows, but new writes are capped so COUNT expansion
    // stays cheap (M3-04cR-1).
    const rule = parseRRule(rrule);
    if (rule.count !== undefined && rule.count > MAX_WRITE_RRULE_COUNT) {
      throw new InvalidRRuleError(
        `RRULE COUNT must be at most ${MAX_WRITE_RRULE_COUNT}`,
      );
    }
  } catch (error) {
    if (error instanceof InvalidRRuleError) {
      throw new ValidationFailedError([{ path: '/rrule', message: error.message }]);
    }
    throw error;
  }
}

function validateCommitment(input: CommitmentCreate, now: string): void {
  assertStartNotTooOld(input.startAt, now);
  assertInterval(input.startAt, input.endAt);
  if (input.rrule !== undefined) validateRRule(input.rrule);
}

const MAX_RRULE_LOOKBACK_MS = 10 * 366 * DAY_MS;

function assertStartNotTooOld(startAt: string, now: string): void {
  const startMs = Date.parse(startAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(startMs)) {
    throw new ValidationFailedError([{ path: '/startAt', message: 'invalid instant' }]);
  }
  if (nowMs - startMs > MAX_RRULE_LOOKBACK_MS) {
    throw new ValidationFailedError([
      {
        path: '/startAt',
        message: 'commitment starts more than ten years before now',
      },
    ]);
  }
}

function assertInterval(startAt: string, endAt: string): void {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new ValidationFailedError([
      { path: '/endAt', message: 'commitment endAt must be after startAt' },
    ]);
  }
}

export function scheduleBlockDto(
  block: {
    id: string;
    planVersionId: string;
    taskId: string;
    startAt: string;
    endAt: string;
    locked: boolean;
    status: string;
    version: number;
  },
): ScheduleBlockDto {
  return {
    id: block.id as Id,
    planVersionId: block.planVersionId as Id,
    taskId: block.taskId as Id,
    startAt: block.startAt,
    endAt: block.endAt,
    locked: block.locked,
    status: block.status as ScheduleBlockDto['status'],
    version: block.version,
  };
}

export { AvailabilityChangedError, ConstraintViolationError, PlanConflictError };
