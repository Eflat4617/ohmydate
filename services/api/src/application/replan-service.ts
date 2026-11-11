import type {
  Availability,
  Commitment,
  Plan,
  PlanBlock,
  PlanVersionDto,
  ReplanCandidateDto,
  ReplanCandidateFlag,
  ReplanProposal,
  ReplanProposalListQuery,
  ReplanProposalPage,
  ReplanProposalState,
  ReplanReasonCode,
  ReplanRequest,
  ReplanTriggerDto,
} from '@ohmydate/contracts';
import {
  NotFoundError,
  ValidationFailedError,
  epochMsToInstant,
  instantToEpochMs,
  type Clock,
  type Id,
  type IdGenerator,
  type Instant,
  type Task,
  type TaskRepository,
} from '@ohmydate/domain';
import {
  generate,
  validate,
  type PlanCandidate as SchedulerCandidate,
} from '@ohmydate/scheduler';
import { Temporal } from 'temporal-polyfill';
import {
  ConstraintViolationError,
  PlanConflictError,
} from './planning-errors.js';
import type {
  ActivePlanRevision,
  ApprovedBlock,
  EstimateRecord,
  PlanningStore,
} from './planning-ports.js';
import {
  assembleScheduleInput,
  deriveSeed,
  fromPlanBlock,
  resolveExtraTasks,
  toContractViolations,
  toPlanBlock,
  type Assembled,
  type ResolvedExtras,
} from './plan-service.js';
import { detectTriggers, type DetectedTrigger } from './replan-detection.js';
import { ReplanSuppressedError, proposalStateConflict } from './replan-errors.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** 05 §11 intervention policy. */
export const REPLAN_DAILY_CAP = 2;
export const EARLY_COMPLETION_DAILY_CAP = 1;
export const REPLAN_SUPPRESSION_MS = DAY_MS;
export const REPLAN_PROPOSAL_TTL_MS = DAY_MS;
const BOUND_PREFIX = 'Replan change bound exceeded';
const MAX_EXPLANATION_LINES = 50;
const MAX_EXPLANATION_LENGTH = 500;

export interface ReplanProposalRecord {
  readonly id: Id;
  readonly ownerId: Id;
  readonly planId: Id;
  readonly basePlanVersionId: Id;
  readonly basePlanRevision: number;
  readonly resultPlanVersionId?: Id | undefined;
  readonly state: ReplanProposalState;
  readonly trigger: ReplanTriggerDto;
  readonly candidate: ReplanCandidateDto;
  readonly policy: string;
  readonly availabilityVersion: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly expiresAt: Instant;
  readonly version: number;
}

export interface NewReplanProposal {
  readonly id: Id;
  readonly ownerId: Id;
  readonly planId: Id;
  readonly basePlanVersionId: Id;
  readonly basePlanRevision: number;
  readonly availabilityVersion: number;
  readonly trigger: ReplanTriggerDto;
  readonly candidate: ReplanCandidateDto;
  readonly policy: string;
  readonly now: Instant;
  readonly expiresAt: Instant;
}

/** Owner-local day used for the daily caps (05 §11 "하루"). */
export interface ReplanPolicyWindow {
  readonly now: Instant;
  readonly dayStart: Instant;
  readonly dayEnd: Instant;
}

/**
 * `detected`: job-created; a pending proposal with the same reason dedupes
 * (skip). `requested`: user-initiated; a pending one with the same reason is
 * superseded by the fresh request.
 */
export type ReplanInsertMode = 'detected' | 'requested';

export type ReplanPolicyBlock =
  | { readonly kind: 'pending' }
  | { readonly kind: 'suppressed'; readonly until: Instant }
  | { readonly kind: 'daily_cap'; readonly until: Instant }
  | { readonly kind: 'early_completion_cap'; readonly until: Instant };

export type ReplanInsertResult =
  | { readonly kind: 'created'; readonly record: ReplanProposalRecord }
  | { readonly kind: 'blocked'; readonly block: ReplanPolicyBlock };

export interface ReplanApprovalSnapshot {
  readonly proposal: ReplanProposalRecord;
  readonly plan: Pick<Plan, 'id' | 'horizon' | 'timeZone'>;
  readonly availability: Availability;
  readonly commitments: readonly Commitment[];
  readonly blocks: readonly ApprovedBlock[];
  readonly estimates: ReadonlyMap<string, EstimateRecord>;
}

export interface ReplanApprovalRequest {
  readonly ownerId: Id;
  readonly proposalId: Id;
  readonly expectedAvailabilityVersion: number;
  readonly idempotencyKey: string;
  readonly now: Instant;
  readonly taskIds: readonly Id[];
  readonly planningTaskIds: readonly Id[];
  readonly identityTasks: readonly Task[];
  readonly releaseVanishedTaskIds: readonly Id[];
  prepare(snapshot: ReplanApprovalSnapshot): Promise<{ readonly blocks: readonly PlanBlock[] }>;
}

export interface ReplanStore {
  listOwnersWithActivePlan(): Promise<readonly Id[]>;
  /**
   * Expire pending proposals past `expires_at` or whose base plan version is no
   * longer the plan's current version (or whose plan was deleted).
   */
  expireStale(now: Instant, ownerId?: Id): Promise<number>;
  /** Fast pre-check without locks; `insert` re-checks under the owner lock. */
  checkPolicy(
    ownerId: Id,
    trigger: Pick<ReplanTriggerDto, 'kind' | 'reason'>,
    window: ReplanPolicyWindow,
    mode: ReplanInsertMode,
  ): Promise<ReplanPolicyBlock | null>;
  insert(
    input: NewReplanProposal,
    window: ReplanPolicyWindow,
    mode: ReplanInsertMode,
  ): Promise<ReplanInsertResult>;
  list(
    ownerId: Id,
    query: ReplanProposalListQuery,
  ): Promise<{ readonly items: readonly ReplanProposalRecord[]; readonly nextCursor: string | null }>;
  get(ownerId: Id, id: Id): Promise<ReplanProposalRecord | null>;
  reject(
    ownerId: Id,
    id: Id,
    expectedVersion: number,
    input: { readonly reason?: string | undefined; readonly now: Instant; readonly suppressUntil: Instant },
  ): Promise<ReplanProposalRecord>;
  approve(request: ReplanApprovalRequest): Promise<PlanVersionDto>;
}

export interface ReplanLogger {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface ReplanServiceDependencies {
  readonly tasks: TaskRepository;
  readonly planning: PlanningStore;
  readonly store: ReplanStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: ReplanLogger;
}

interface PlanningSet {
  readonly ids: ReadonlySet<string>;
  readonly tasks: readonly Task[];
  /** Scope + dependency closure including done tasks (detection needs them). */
  readonly known: ReadonlyMap<string, Task>;
}

interface ReplanContext {
  readonly now: Instant;
  readonly plan: Plan;
  readonly active: ActivePlanRevision;
  readonly availability: Availability;
  readonly commitments: readonly Commitment[];
  readonly planning: PlanningSet;
  readonly extras: ResolvedExtras;
  readonly estimates: ReadonlyMap<string, EstimateRecord>;
  /** Non-superseded blocks of the active plan (raw, incl. done tasks). */
  readonly planBlocks: readonly ApprovedBlock[];
}

interface BuiltCandidate {
  readonly candidate: ReplanCandidateDto;
  readonly policy: string;
  readonly noop: boolean;
}

function blockKey(block: PlanBlock): string {
  return `${block.taskId}|${Date.parse(block.startAt)}|${Date.parse(block.endAt)}`;
}

function blockMultiset(blocks: readonly PlanBlock[], taskId?: string): string[] {
  return blocks
    .filter((block) => taskId === undefined || block.taskId === taskId)
    .map(blockKey)
    .sort();
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

export function toReplanProposalDto(record: ReplanProposalRecord): ReplanProposal {
  return {
    id: record.id,
    state: record.state,
    trigger: {
      kind: record.trigger.kind,
      reason: record.trigger.reason,
      detectedAt: record.trigger.detectedAt,
      affectedTaskIds: [...record.trigger.affectedTaskIds],
    },
    basePlanVersionId: record.basePlanVersionId,
    availabilityVersion: record.availabilityVersion,
    candidate: record.candidate,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    version: record.version,
  };
}

/** Owner-local calendar day containing `now`. */
export function policyWindow(now: Instant, timeZone: string): ReplanPolicyWindow {
  const zoned = Temporal.Instant.from(now).toZonedDateTimeISO(timeZone);
  const start = zoned.toPlainDate().toZonedDateTime(timeZone);
  const end = start.add({ days: 1 });
  return {
    now,
    dayStart: start.toInstant().toString() as Instant,
    dayEnd: end.toInstant().toString() as Instant,
  };
}

function retryAfterSec(until: Instant, now: Instant): number {
  return (instantToEpochMs(until) - instantToEpochMs(now)) / 1000;
}

const POLICY_ORDER = ['front_loaded', 'balanced', 'focus_blocked'] as const;

/** Feasible first, then fewest changes, smallest deficit, published order. */
function chooseCandidate(candidates: readonly SchedulerCandidate[]): SchedulerCandidate | undefined {
  return [...candidates].sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    if (a.metrics.changedBlocks !== b.metrics.changedBlocks) {
      return a.metrics.changedBlocks - b.metrics.changedBlocks;
    }
    if (a.deficitMin !== b.deficitMin) return a.deficitMin - b.deficitMin;
    return POLICY_ORDER.indexOf(a.policy) - POLICY_ORDER.indexOf(b.policy);
  })[0];
}

function successors(tasks: readonly Task[], seeds: Iterable<string>): Set<string> {
  const affected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (affected.has(task.id)) continue;
      if (task.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(task.id);
        changed = true;
      }
    }
  }
  return affected;
}

export class ReplanService {
  readonly #tasks: TaskRepository;
  readonly #planning: PlanningStore;
  readonly #store: ReplanStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #logger: ReplanLogger | undefined;

  constructor(deps: ReplanServiceDependencies) {
    this.#tasks = deps.tasks;
    this.#planning = deps.planning;
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#logger = deps.logger;
  }

  async list(ownerId: Id, query: ReplanProposalListQuery): Promise<ReplanProposalPage> {
    await this.#store.expireStale(this.#clock.now(), ownerId);
    const page = await this.#store.list(ownerId, query);
    return { items: page.items.map(toReplanProposalDto), nextCursor: page.nextCursor };
  }

  async get(ownerId: Id, id: Id): Promise<ReplanProposal> {
    await this.#store.expireStale(this.#clock.now(), ownerId);
    const record = await this.#store.get(ownerId, id);
    if (record === null) throw new NotFoundError('replan proposal', id);
    return toReplanProposalDto(record);
  }

  /** 05 §11: rejection suppresses the same reason for 24 h. */
  async reject(
    ownerId: Id,
    id: Id,
    expectedVersion: number,
    reason: string | undefined,
  ): Promise<ReplanProposal> {
    const now = this.#clock.now();
    await this.#store.expireStale(now, ownerId);
    const record = await this.#store.reject(ownerId, id, expectedVersion, {
      reason,
      now,
      suppressUntil: epochMsToInstant(instantToEpochMs(now) + REPLAN_SUPPRESSION_MS),
    });
    return toReplanProposalDto(record);
  }

  /** User-initiated replan (`POST /replan-proposals:request`). */
  async request(ownerId: Id, body: ReplanRequest): Promise<ReplanProposal> {
    const now = this.#clock.now();
    const plan = await this.#planning.getPlan(ownerId, body.planId as Id);
    if (plan === null) throw new NotFoundError('plan', body.planId);
    const active = await this.#activeRevision(ownerId, plan);
    if (active === null) {
      throw proposalStateConflict('the plan has no approved version to replan');
    }
    const context = await this.#context(ownerId, plan, active, now);
    let affected: Id[];
    if (body.affectedTaskIds === undefined) {
      affected = [...context.planning.ids].sort() as Id[];
    } else {
      const unknown = body.affectedTaskIds
        .map((taskId, index) => ({ taskId, index }))
        .filter((entry) => !context.planning.ids.has(entry.taskId));
      if (unknown.length > 0) {
        throw new ValidationFailedError(
          unknown.map((entry) => ({
            path: `/affectedTaskIds/${entry.index}`,
            message: `task ${entry.taskId} is not an open task of this plan`,
          })),
        );
      }
      affected = [...new Set(body.affectedTaskIds)].sort() as Id[];
    }
    const trigger: ReplanTriggerDto = {
      kind: 'user_request',
      reason: body.reason ?? 'user_request',
      detectedAt: now,
      affectedTaskIds: affected,
    };
    const window = policyWindow(now, context.availability.timeZone);
    const blocked = await this.#store.checkPolicy(ownerId, trigger, window, 'requested');
    if (blocked !== null) this.#throwBlocked(blocked, now);
    const built = this.#buildCandidate(context, affected, trigger.reason);
    const result = await this.#store.insert(
      this.#newProposal(ownerId, context, trigger, built, now),
      window,
      'requested',
    );
    if (result.kind === 'blocked') this.#throwBlocked(result.block, now);
    return toReplanProposalDto((result as { record: ReplanProposalRecord }).record);
  }

  /**
   * Approve with the plan-approval TX semantics (08 §2.4): If-Match is the
   * user-wide availability version, the store locks it, re-reads the
   * snapshot, re-validates, supersedes only future blocks and records the
   * version with createdBy = "replan".
   */
  async approve(
    ownerId: Id,
    proposalId: Id,
    expectedAvailabilityVersion: number,
    idempotencyKey: string,
    editedBlocks: readonly PlanBlock[] | undefined,
  ): Promise<PlanVersionDto> {
    const now = this.#clock.now();
    const proposal = await this.#store.get(ownerId, proposalId);
    if (proposal === null) throw new NotFoundError('replan proposal', proposalId);
    const plan = await this.#planning.getPlan(ownerId, proposal.planId);
    if (plan === null) throw new NotFoundError('plan', proposal.planId);
    const active = await this.#activeRevision(ownerId, plan);
    const context =
      active === null ? null : await this.#context(ownerId, plan, active, now);
    const planningIds = context?.planning.ids ?? new Set<string>();
    if (editedBlocks !== undefined) {
      editedBlocks.forEach((block, index) => {
        preflightBlock(block, index, plan, planningIds, now);
      });
    }
    const chosen = editedBlocks ?? proposal.candidate.blocks;
    const planningTasks = context?.planning.tasks ?? [];
    const extraTasks = context?.extras.tasks ?? [];
    const allTasks = [...planningTasks, ...extraTasks];
    return this.#store.approve({
      ownerId,
      proposalId,
      expectedAvailabilityVersion,
      idempotencyKey,
      now,
      taskIds: allTasks.map((task) => task.id),
      planningTaskIds: [...planningIds] as Id[],
      identityTasks: allTasks,
      releaseVanishedTaskIds: context?.extras.vanishedTaskIds ?? [],
      prepare: async (snapshot) => {
        if (context === null) {
          throw proposalStateConflict('the plan has no approved version to replan');
        }
        return this.#prepareApproval(snapshot, {
          now,
          planningTasks,
          extraTasks,
          planningIds,
          chosen,
          edited: editedBlocks !== undefined,
        });
      },
    });
  }

  /**
   * Leader-only detection sweep (05 §11). Expires stale proposals, then
   * evaluates every owner with an active plan. One owner's failure never stops
   * the sweep; only ids are logged.
   */
  async runDetection(now: Instant = this.#clock.now()): Promise<number> {
    await this.#store.expireStale(now);
    let created = 0;
    for (const ownerId of await this.#store.listOwnersWithActivePlan()) {
      try {
        created += await this.detectForOwner(ownerId, now);
      } catch (error) {
        this.#logger?.warn('replan detection failed for owner', {
          ownerId,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    return created;
  }

  async detectForOwner(ownerId: Id, now: Instant = this.#clock.now()): Promise<number> {
    const active = await this.#planning.getActivePlan(ownerId);
    if (active === null) return 0;
    const plan = await this.#planning.getPlan(ownerId, active.planId);
    if (plan === null) return 0;
    if (instantToEpochMs(now) >= Date.parse(plan.horizon.end)) return 0;
    const context = await this.#context(ownerId, plan, active, now);
    const assembled = this.#assemble(context, 0);
    const triggers = detectTriggers({
      now,
      riskLevel: context.availability.prefs.riskLevel,
      tasks: [...context.planning.known.values()].map((task) => ({
        id: task.id,
        dueAt: task.dueAt,
        status: task.status,
      })),
      blocks: context.planBlocks,
      estimates: context.estimates,
      commitments: assembled.input.commitments,
    });
    const window = policyWindow(now, context.availability.timeZone);
    let created = 0;
    for (const detected of triggers) {
      const trigger = this.#triggerDto(detected, now);
      const blocked = await this.#store.checkPolicy(ownerId, trigger, window, 'detected');
      if (blocked?.kind === 'daily_cap') break;
      if (blocked !== null) continue;
      const built = this.#buildCandidate(context, [...detected.affectedTaskIds], detected.reason);
      if (built.noop) continue;
      const result = await this.#store.insert(
        this.#newProposal(ownerId, context, trigger, built, now),
        window,
        'detected',
      );
      if (result.kind === 'created') created += 1;
      else if (result.block.kind === 'daily_cap') break;
    }
    return created;
  }

  #triggerDto(detected: DetectedTrigger, now: Instant): ReplanTriggerDto {
    return {
      kind: detected.kind,
      reason: detected.reason,
      detectedAt: now,
      affectedTaskIds: [...detected.affectedTaskIds],
    };
  }

  #throwBlocked(block: ReplanPolicyBlock, now: Instant): never {
    switch (block.kind) {
      case 'suppressed':
        throw new ReplanSuppressedError('suppressed', retryAfterSec(block.until, now));
      case 'daily_cap':
      case 'early_completion_cap':
        throw new ReplanSuppressedError('daily_cap', retryAfterSec(block.until, now));
      case 'pending':
        throw proposalStateConflict('a pending proposal with this reason already exists');
    }
  }

  #newProposal(
    ownerId: Id,
    context: ReplanContext,
    trigger: ReplanTriggerDto,
    built: BuiltCandidate,
    now: Instant,
  ): NewReplanProposal {
    return {
      id: this.#ids.next(),
      ownerId,
      planId: context.plan.id as Id,
      basePlanVersionId: context.active.planVersionId,
      basePlanRevision: context.plan.version,
      availabilityVersion: context.availability.version,
      trigger,
      candidate: built.candidate,
      policy: built.policy,
      now,
      expiresAt: epochMsToInstant(instantToEpochMs(now) + REPLAN_PROPOSAL_TTL_MS),
    };
  }

  async #activeRevision(ownerId: Id, plan: Plan): Promise<ActivePlanRevision | null> {
    if (plan.status !== 'active' || plan.currentVersionId === undefined) return null;
    const active = await this.#planning.getActivePlan(ownerId);
    if (active !== null && active.planId === plan.id) return active;
    return {
      planId: plan.id as Id,
      planVersionId: plan.currentVersionId as Id,
      revision: plan.version,
      timeZone: plan.timeZone,
      horizon: plan.horizon,
      scope: plan.scope,
      availabilityVersion: plan.availabilityVersion,
    };
  }

  async #context(
    ownerId: Id,
    plan: Plan,
    active: ActivePlanRevision,
    now: Instant,
  ): Promise<ReplanContext> {
    const availability = await this.#planning.getAvailability(ownerId);
    const planning = await this.#planningSet(ownerId, plan);
    const activeBlocks = await this.#planning.listActiveBlocks(ownerId);
    const extras = await resolveExtraTasks(this.#tasks, ownerId, activeBlocks, planning.ids);
    const taskIds = [...new Set([...planning.known.keys(), ...extras.tasks.map((task) => task.id)])] as Id[];
    const estimates = await this.#planning.getCurrent(ownerId, taskIds);
    const commitments = await this.#planning.listCommitmentsInRange(
      ownerId,
      plan.horizon.start,
      plan.horizon.end,
    );
    return {
      now,
      plan,
      active,
      availability,
      commitments,
      planning,
      extras,
      estimates,
      planBlocks: activeBlocks.filter((block) => block.planId === plan.id),
    };
  }

  /**
   * Scope seeds + dependency closure. Unlike plan approval this tolerates a
   * vanished task (it simply leaves the replan scope) so one provider-side
   * deletion cannot block every future replan of the plan.
   */
  async #planningSet(ownerId: Id, plan: Plan): Promise<PlanningSet> {
    const seeds =
      'taskIds' in plan.scope
        ? (plan.scope.taskIds as Id[])
        : ((await this.#planning.resolveGoalTasks(ownerId, plan.scope.goalId as Id))?.taskIds ?? []);
    const known = new Map<string, Task>();
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const task = await this.#tasks.get(ownerId, id as Id);
      if (task === null) continue;
      known.set(task.id, task);
      if (task.status === 'done') continue;
      for (const dependency of task.dependsOn) {
        if (!seen.has(dependency)) queue.push(dependency);
      }
    }
    const tasks = [...known.values()].filter((task) => task.status !== 'done');
    return { ids: new Set(tasks.map((task) => task.id)), tasks, known };
  }

  #assemble(context: ReplanContext, seed: number): Assembled {
    return assembleScheduleInput({
      now: context.now,
      timeZone: context.availability.timeZone,
      horizon: context.plan.horizon,
      availability: context.availability,
      commitments: context.commitments,
      planningTasks: context.planning.tasks,
      extraTasks: context.extras.tasks,
      estimates: context.estimates,
      activeBlocks: context.extras.blocks,
      currentPlanId: context.plan.id as Id,
      seed,
    });
  }

  #buildCandidate(
    context: ReplanContext,
    affected: readonly Id[],
    reason: ReplanReasonCode,
  ): BuiltCandidate {
    const seed = deriveSeed({
      kind: 'replan',
      planId: context.plan.id as Id,
      basePlanVersionId: context.active.planVersionId,
      availabilityVersion: context.availability.version,
      reason,
      affected: [...affected].sort(),
    });
    const assembled = this.#assemble(context, seed);
    const scoped = affected.filter((taskId) => context.planning.ids.has(taskId));
    const input = { ...assembled.input, affectedTaskIds: [...scoped] };
    const result = generate(input);
    const chosen = chooseCandidate(result.candidates);
    if (chosen === undefined) {
      throw new PlanConflictError('the scheduler returned no replan candidate');
    }
    const nowMs = instantToEpochMs(context.now);
    const blocks = chosen.blocks.map(toPlanBlock);
    // Current future work of the plan (including blocks of tasks that are done
    // now): the candidate replaces exactly this set on approval.
    const currentFuture = context.planBlocks
      .filter((block) => block.status !== 'done' && Date.parse(block.startAt) >= nowMs)
      .map((block) => ({ taskId: block.taskId, startAt: block.startAt, endAt: block.endAt }));
    const existingFuture = (input.existingBlocks ?? [])
      .filter((block) => Date.parse(block.start) >= nowMs)
      .map((block) => ({ taskId: block.taskId as Id, startAt: block.start, endAt: block.end }));

    const scope = successors(context.planning.tasks, scoped);
    const changedTasks = new Set<string>();
    for (const taskId of new Set([...blocks, ...existingFuture].map((block) => block.taskId))) {
      if (!sameKeys(blockMultiset(blocks, taskId), blockMultiset(existingFuture, taskId))) {
        changedTasks.add(taskId);
      }
    }
    const affectedSet = new Set([...scope, ...changedTasks]);
    const affectedExisting = existingFuture.filter((block) => affectedSet.has(block.taskId)).length;
    const bound = 2 * affectedExisting + 2;
    const flags: ReplanCandidateFlag[] = [];
    if (!chosen.feasible) flags.push('infeasible');
    if (
      chosen.metrics.changedBlocks > bound ||
      chosen.explanation.some((line) => line.startsWith(BOUND_PREFIX))
    ) {
      flags.push('bound_exceeded');
    }
    if ([...changedTasks].some((taskId) => !scope.has(taskId))) flags.push('scope_extended');
    if (chosen.capacityDeficitMin > 0) flags.push('capacity_deficit');

    const candidate: ReplanCandidateDto = {
      blocks,
      metrics: chosen.metrics,
      changedBlocks: chosen.metrics.changedBlocks,
      bound,
      flags,
      explanation: chosen.explanation
        .slice(0, MAX_EXPLANATION_LINES)
        .map((line) => line.slice(0, MAX_EXPLANATION_LENGTH)),
    };
    return {
      candidate,
      policy: chosen.policy,
      noop: sameKeys(blockMultiset(blocks), blockMultiset(currentFuture)),
    };
  }

  async #prepareApproval(
    snapshot: ReplanApprovalSnapshot,
    context: {
      readonly now: Instant;
      readonly planningTasks: readonly Task[];
      readonly extraTasks: readonly Task[];
      readonly planningIds: ReadonlySet<string>;
      readonly chosen: readonly PlanBlock[];
      readonly edited: boolean;
    },
  ): Promise<{ blocks: readonly PlanBlock[] }> {
    const nowMs = instantToEpochMs(context.now);
    if (!context.edited && context.chosen.some((block) => Date.parse(block.startAt) < nowMs)) {
      // The proposal was computed earlier; a block that has already started
      // cannot be inserted without rewriting history (06 §7.1).
      throw proposalStateConflict('the proposal is stale: a proposed block has already started');
    }
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
      seed: 0,
    });
    const findings = validate(assembled.input, context.chosen.map(fromPlanBlock), {
      riskLevel: snapshot.availability.prefs.riskLevel,
      historyBlocks: assembled.historyBlocks,
    });
    const preflight = findings.filter((finding) => finding.code.startsWith('H0_'));
    if (preflight.length > 0) {
      if (context.edited) {
        throw new ValidationFailedError(
          preflight.map((finding) => ({ path: '/editedBlocks', message: finding.message })),
        );
      }
      throw proposalStateConflict('the proposal references a task that is no longer schedulable');
    }
    if (findings.length > 0) {
      throw new ConstraintViolationError(toContractViolations(findings));
    }
    return { blocks: context.chosen };
  }
}

function preflightBlock(
  block: PlanBlock,
  index: number,
  plan: Plan,
  planningIds: ReadonlySet<string>,
  now: Instant,
): void {
  const path = `/editedBlocks/${index}`;
  const startMs = Date.parse(block.startAt);
  const endMs = Date.parse(block.endAt);
  const issues: { path: string; message: string }[] = [];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    issues.push({ path, message: 'invalid block instant' });
  } else if (endMs <= startMs) {
    issues.push({ path, message: 'block ends before it starts' });
  } else if (
    startMs < Date.parse(plan.horizon.start) ||
    endMs > Date.parse(plan.horizon.end)
  ) {
    issues.push({ path, message: 'block lies outside the persisted plan horizon' });
  } else if (startMs < instantToEpochMs(now)) {
    issues.push({ path, message: 'edited blocks must start in the future' });
  } else if (startMs % MINUTE_MS !== 0 || endMs % MINUTE_MS !== 0) {
    issues.push({ path, message: 'block instant must have minute precision' });
  }
  if (!planningIds.has(block.taskId)) {
    issues.push({ path, message: `task ${block.taskId} is not in the plan scope` });
  }
  if (issues.length > 0) throw new ValidationFailedError(issues);
}
