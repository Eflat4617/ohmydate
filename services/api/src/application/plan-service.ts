import type {
  Availability,
  AvailabilityPut,
  Commitment,
  CommitmentCreate,
  CommitmentListQuery,
  CommitmentPage,
  CommitmentPatch,
  Plan,
  PlanBlock,
  PlanCreate,
  PlanHorizon,
  PlanScope,
  PlanVersionDto,
  ScheduleBlockDto,
  Violation as ContractViolation,
} from '@ohmydate/contracts';
import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  type Clock,
  type Id,
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
import { clipOccurrence, expandOccurrences, MAX_OCCURRENCES, parseRRule } from './rrule.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_HORIZON_DAYS = 366;
const DEFAULT_MIN_SESSION_MIN = 30;
const DEFAULT_MAX_SESSION_MIN = 90;

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

function toPlanBlock(block: SchedulerBlock): PlanBlock {
  return { taskId: block.taskId as Id, startAt: block.start, endAt: block.end };
}

function fromPlanBlock(block: PlanBlock): SchedulerBlock {
  return { taskId: block.taskId, start: block.startAt, end: block.endAt };
}

function toContractViolations(
  violations: readonly SchedulerViolation[],
): ContractViolation[] {
  return violations.map((violation) => ({
    code: violation.code as ContractViolation['code'],
    ...(violation.taskId === undefined ? {} : { taskId: violation.taskId as Id }),
    message: violation.message,
  }));
}

function mapCandidate(candidate: SchedulerCandidate): NewCandidate {
  return {
    policy: candidate.policy,
    blocks: candidate.blocks.map(toPlanBlock),
    metrics: candidate.metrics,
    feasible: candidate.feasible,
    deficitMin: candidate.deficitMin,
    capacityDeficitMin: candidate.capacityDeficitMin,
    explanation: candidate.explanation,
    generatorVersion: candidate.generatorVersion,
    inputHash: candidate.inputHash,
  };
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
    const occurrences = expandOccurrences(commitment, horizon.start, horizon.end);
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

interface AssemblyInput {
  readonly now: string;
  readonly timeZone: string;
  readonly horizon: PlanHorizon;
  readonly availability: Availability;
  readonly commitments: readonly Commitment[];
  readonly tasks: readonly Task[];
  readonly estimates: ReadonlyMap<string, EstimateRecord>;
  readonly activeBlocks: readonly ApprovedBlock[];
  readonly currentPlanId?: Id | undefined;
  readonly seed: number;
}

interface Assembled {
  readonly input: ScheduleInput;
  readonly historyBlocks: SchedulerBlock[];
  readonly lockedBlocks: SchedulerBlock[];
}

function assembleScheduleInput(source: AssemblyInput): Assembled {
  const { horizon, availability } = source;
  const lockedBlocks: SchedulerBlock[] = [];
  const existingBlocks: SchedulerBlock[] = [];
  const historyBlocks: SchedulerBlock[] = [];
  const nowMs = Date.parse(source.now);

  for (const block of source.activeBlocks) {
    const schedulerBlock: SchedulerBlock = {
      taskId: block.taskId,
      start: block.startAt,
      end: block.endAt,
    };
    if (Date.parse(block.startAt) < nowMs) {
      historyBlocks.push(schedulerBlock);
    } else if (source.currentPlanId !== undefined && block.planId === source.currentPlanId) {
      existingBlocks.push(schedulerBlock);
    } else {
      lockedBlocks.push(schedulerBlock);
    }
  }

  const riskLevel = riskLevelOf(availability);
  const tasks: ScheduleInput['tasks'] = source.tasks.map((task) => {
    const estimate = source.estimates.get(task.id);
    if (estimate === undefined) {
      throw new ValidationFailedError([
        { path: `/scope/${task.id}`, message: `missing_estimate for task ${task.id}` },
      ]);
    }
    const required = riskLevel === 'p90' ? estimate.p90Min : estimate.p50Min;
    const remainingMin = Math.max(
      0,
      required - historyMinutes(source.activeBlocks, task.id, source.now),
    );
    return {
      id: task.id,
      ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
      estimate: { p50Min: estimate.p50Min, p90Min: estimate.p90Min },
      remainingMin,
      splittable: task.splittable,
      minSessionMin: task.session?.minMinutes ?? DEFAULT_MIN_SESSION_MIN,
      maxSessionMin: task.session?.maxMinutes ?? DEFAULT_MAX_SESSION_MIN,
      priority: task.priority,
      dependsOn: task.dependsOn.filter((dependency) =>
        source.tasks.some((candidate) => candidate.id === dependency),
      ),
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
    validateCommitment(input);
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
    const scope = await this.#resolveScope(ownerId, request.scope, 'create');
    const taskIds = await this.#taskClosureIds(ownerId, scope.taskIds);
    const activeBlocks = await this.#store.listActiveBlocks(ownerId);
    const lockedTaskIds = activeBlocks
      .filter((block) => Date.parse(block.startAt) >= Date.parse(now))
      .map((block) => block.taskId);
    const allTaskIds = [...new Set([...taskIds, ...lockedTaskIds])];
    const tasks = await this.#loadTasks(ownerId, allTaskIds, 'create');
    const estimates = await this.#store.getCurrent(ownerId, allTaskIds);
    const commitments = await this.#commitmentsInRange(ownerId, horizon);
    const seed = deriveSeed({
      kind: 'create',
      ownerId,
      scope: request.scope,
      horizon,
      timeZone: availability.timeZone,
      availabilityVersion: availability.version,
      taskIds: [...allTaskIds].sort(),
    });
    const assembled = assembleScheduleInput({
      now,
      timeZone: availability.timeZone,
      horizon,
      availability,
      commitments,
      tasks,
      estimates,
      activeBlocks,
      seed,
    });
    const policies = request.policies;
    const result = generate(assembled.input, policies === undefined ? {} : { policies });
    const plan = await this.#store.createPlan(ownerId, {
      scope: request.scope,
      horizon,
      timeZone: availability.timeZone,
      availabilityVersion: availability.version,
      candidates: result.candidates.map(mapCandidate),
    });
    return plan;
  }

  async getPlan(ownerId: Id, id: Id): Promise<Plan> {
    const plan = await this.#store.getPlan(ownerId, id);
    if (plan === null) throw new NotFoundError('plan', id);
    return plan;
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
    const scope = await this.#resolvePlanScope(ownerId, plan);
    const scopeIds = new Set(scope.taskIds);
    blocks.forEach((block, index) => {
      this.#preflightBlock(block, index, plan.horizon, scopeIds, '/blocks');
    });
    const activeBlocks = await this.#store.listActiveBlocks(ownerId);
    const lockedTaskIds = activeBlocks
      .filter((block) => Date.parse(block.startAt) >= Date.parse(now))
      .map((block) => block.taskId);
    const allTaskIds = [...new Set([...scope.taskIds, ...lockedTaskIds])];
    const tasks = await this.#loadTasks(ownerId, allTaskIds, 'create');
    const estimates = await this.#store.getCurrent(ownerId, allTaskIds);
    const commitments = await this.#commitmentsInRange(ownerId, plan.horizon);
    const seed = deriveSeed({ kind: 'preview', planId, horizon: plan.horizon });
    const assembled = assembleScheduleInput({
      now,
      timeZone: availability.timeZone,
      horizon: plan.horizon,
      availability,
      commitments,
      tasks,
      estimates,
      activeBlocks,
      currentPlanId: planId,
      seed,
    });
    const schedulerBlocks = blocks.map(fromPlanBlock);
    const findings = validate(assembled.input, schedulerBlocks, {
      riskLevel: riskLevelOf(availability),
      historyBlocks: assembled.historyBlocks,
    });
    const publicFindings = findings.filter(
      (finding) => !finding.code.startsWith('H0_'),
    );
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
   * M3 performs no provider writes: task/provider state is not synced during
   * approval, so this operation never returns `503 provider_unavailable` in
   * practice even though the public contract keeps the status for a future
   * provider-sync phase.
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
    const scope = await this.#resolvePlanScope(ownerId, plan);
    const blocks = editedBlocks ?? candidate.blocks;
    if (editedBlocks !== undefined) {
      const scopeIds = new Set(scope.taskIds);
      blocks.forEach((block, index) => {
        this.#preflightBlock(block, index, plan.horizon, scopeIds, '/editedBlocks');
      });
    }
    const activeBlocks = await this.#store.listActiveBlocks(ownerId);
    const lockedTaskIds = activeBlocks
      .filter((block) => Date.parse(block.startAt) >= Date.parse(now))
      .map((block) => block.taskId);
    const taskIds = [...new Set([...scope.taskIds, ...lockedTaskIds])];
    await this.#loadTasks(ownerId, taskIds, 'conflict');

    return this.#store.approve(ownerId, planId, candidateId, {
      expectedAvailabilityVersion,
      expectedPlanVersion: plan.version,
      idempotencyKey,
      now,
      ...(editedBlocks === undefined ? {} : { editedBlocks }),
      taskIds,
      prepare: async (snapshot) => {
        const freshTasks = await this.#reloadTasksOrConflict(ownerId, taskIds);
        return this.#prepareApproval(snapshot, {
          now,
          tasks: freshTasks,
          chosenBlocks: blocks,
          scopeIds: new Set(scope.taskIds),
          prefix: '/editedBlocks',
        });
      },
    });
  }

  async regenerate(ownerId: Id, planId: Id, expectedVersion: number): Promise<Plan> {
    const plan = await this.getPlan(ownerId, planId);
    if (plan.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion as never, plan.version as never);
    }
    const now = this.#clock.now();
    const availability = await this.#store.getAvailability(ownerId);
    const scope = await this.#resolvePlanScope(ownerId, plan);
    const requestedTaskIds = await this.#taskClosureIds(ownerId, scope.taskIds);
    const activeBlocks = await this.#store.listActiveBlocks(ownerId);
    const lockedTaskIds = activeBlocks
      .filter((block) => Date.parse(block.startAt) >= Date.parse(now))
      .map((block) => block.taskId);
    const taskIds = [...new Set([...requestedTaskIds, ...lockedTaskIds])];
    const tasks = await this.#loadTasks(ownerId, taskIds, 'conflict');
    const estimates = await this.#store.getCurrent(ownerId, taskIds);
    const commitments = await this.#commitmentsInRange(ownerId, plan.horizon);
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
      tasks,
      estimates,
      activeBlocks,
      currentPlanId: planId,
      seed,
    });
    const policies = [
      ...new Set(plan.candidates.map((candidate) => candidate.policy)),
    ];
    const result = generate(
      assembled.input,
      policies.length === 0 ? {} : { policies },
    );
    return this.#store.replaceCandidates(
      ownerId,
      planId,
      expectedVersion,
      result.candidates.map(mapCandidate),
      availability.timeZone,
      availability.version,
    );
  }

  async #prepareApproval(
    snapshot: ApprovalSnapshot,
    context: {
      now: string;
      tasks: readonly Task[];
      chosenBlocks: readonly PlanBlock[];
      scopeIds: ReadonlySet<string>;
      prefix: string;
    },
  ): Promise<PreparedApproval> {
    context.chosenBlocks.forEach((block, index) => {
      this.#preflightBlock(
        block,
        index,
        snapshot.plan.horizon,
        context.scopeIds,
        context.prefix,
      );
    });
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
      tasks: context.tasks,
      estimates: snapshot.estimates,
      activeBlocks: snapshot.blocks,
      currentPlanId: snapshot.plan.id as Id,
      seed,
    });
    const schedulerBlocks = context.chosenBlocks.map(fromPlanBlock);
    const findings = validate(assembled.input, schedulerBlocks, {
      riskLevel: riskLevelOf(snapshot.availability),
      historyBlocks: assembled.historyBlocks,
    });
    const preflight = findings.filter((finding) => finding.code.startsWith('H0_'));
    if (preflight.length > 0) {
      throw new ValidationFailedError(
        preflight.map((finding) => ({
          path: context.prefix,
          message: finding.message,
        })),
      );
    }
    return {
      blocks: context.chosenBlocks,
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

  async #resolvePlanScope(ownerId: Id, plan: Plan): Promise<ResolvedScope> {
    return this.#resolveScope(ownerId, plan.scope, 'conflict');
  }

  async #taskClosureIds(ownerId: Id, seedIds: readonly Id[]): Promise<Id[]> {
    const seen = new Set<string>();
    const queue = [...seedIds];
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
      for (const dependency of task.dependsOn) {
        if (!seen.has(dependency)) queue.push(dependency);
      }
    }
    if (missing.length > 0) {
      throw new ValidationFailedError(
        missing.map((id) => ({ path: `/scope/${id}`, message: `unknown task ${id}` })),
      );
    }
    return [...seen] as Id[];
  }

  async #loadTasks(ownerId: Id, ids: readonly Id[], mode: 'create' | 'conflict'): Promise<Task[]> {
    const tasks: Task[] = [];
    const missing: Id[] = [];
    for (const id of ids) {
      const task = await this.#tasks.get(ownerId, id);
      if (task === null) missing.push(id);
      else tasks.push(task);
    }
    if (missing.length > 0) {
      if (mode === 'create') {
        throw new ValidationFailedError(
          missing.map((id) => ({ path: `/scope/${id}`, message: `unknown task ${id}` })),
        );
      }
      throw new PlanConflictError(`scoped task vanished: ${missing.join(', ')}`);
    }
    return tasks;
  }

  async #reloadTasksOrConflict(ownerId: Id, ids: readonly Id[]): Promise<Task[]> {
    return this.#loadTasks(ownerId, ids, 'conflict');
  }

  async #commitmentsInRange(ownerId: Id, horizon: PlanHorizon): Promise<Commitment[]> {
    const page = await this.#store.listCommitments(ownerId, {
      from: horizon.start,
      to: horizon.end,
      limit: 100,
    });
    return page.items;
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

export function validateRRule(rrule: string): void {
  try {
    // Parsing without expansion rejects unsupported FREQ/INTERVAL/UNTIL forms
    // before they are persisted.
    parseRRule(rrule);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ValidationFailedError([{ path: '/rrule', message: error.message }]);
    }
    throw error;
  }
}

function validateCommitment(input: CommitmentCreate): void {
  assertInterval(input.startAt, input.endAt);
  if (input.rrule !== undefined) validateRRule(input.rrule);
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
