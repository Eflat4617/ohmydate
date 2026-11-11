import type {
  Commitment,
  PlanBlock,
  PlanVersionDto,
  Today,
  TodayBlock,
  TodayProposal,
  TodayProposalBlock,
  TodayRescheduleRequest,
  TodayShrinkRequest,
} from '@ohmydate/contracts';
import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
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
  computeAvailableSlots,
  validate,
  type Block as SchedulerBlock,
  type ScheduleInput,
  type Violation as SchedulerViolation,
} from '@ohmydate/scheduler';
import { Temporal } from 'temporal-polyfill';
import {
  clipOccurrence,
  expandOccurrences,
  InvalidRRuleError,
  MAX_OCCURRENCES,
} from './rrule.js';
import {
  AvailabilityChangedError,
  ConstraintViolationError,
} from './planning-errors.js';
import type {
  ActivePlanRevision,
  ApprovedBlock,
  EstimateRecord,
  PlanningStore,
} from './planning-ports.js';
import { proposalConflict } from './daily-errors.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_MIN_SESSION_MIN = 30;
const DEFAULT_MAX_SESSION_MIN = 90;
const PROPOSAL_TTL_MS = DAY_MS;
const DUE_SOON_DAYS = 7;

export interface TodayProposalRecord {
  readonly id: Id;
  readonly ownerId: Id;
  readonly planId: Id;
  readonly kind: 'shrink' | 'reschedule';
  readonly date: string;
  readonly timeZone: string;
  readonly blocks: readonly TodayProposalBlock[];
  readonly candidateBlocks: readonly PlanBlock[];
  readonly basePlanVersionId: Id;
  readonly basePlanVersion: number;
  readonly availabilityVersion: number;
  readonly state: 'pending' | 'approved' | 'expired';
  readonly expiresAt?: Instant;
  readonly version: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface NewTodayProposal {
  readonly id: Id;
  readonly ownerId: Id;
  readonly planId: Id;
  readonly kind: 'shrink' | 'reschedule';
  readonly date: string;
  readonly timeZone: string;
  readonly blocks: readonly TodayProposalBlock[];
  readonly candidateBlocks: readonly PlanBlock[];
  readonly basePlanVersionId: Id;
  readonly basePlanVersion: number;
  readonly availabilityVersion: number;
  readonly expiresAt: Instant;
  readonly now: Instant;
}

export interface TodayStore {
  createProposal(input: NewTodayProposal): Promise<TodayProposalRecord>;
  getProposal(ownerId: Id, id: Id): Promise<TodayProposalRecord | null>;
  approveProposal(input: {
    readonly proposal: TodayProposalRecord;
    readonly expectedAvailabilityVersion: number;
    readonly idempotencyKey: string;
    readonly now: Instant;
  }): Promise<PlanVersionDto>;
}

export interface TodayServiceDependencies {
  readonly tasks: TaskRepository;
  readonly planning: PlanningStore;
  readonly today: TodayStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

interface Snapshot {
  readonly active: ActivePlanRevision;
  readonly availability: Awaited<ReturnType<PlanningStore['getAvailability']>>;
  readonly commitments: readonly Commitment[];
  readonly planBlocks: readonly ApprovedBlock[];
  readonly otherBlocks: readonly ApprovedBlock[];
  readonly tasks: ReadonlyMap<string, Task>;
  readonly estimates: ReadonlyMap<string, EstimateRecord>;
}

function localDateOf(instant: string, timeZone: string): string {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function localDayRange(date: string, timeZone: string): { start: Instant; end: Instant } {
  const start = Temporal.PlainDate.from(date).toZonedDateTime(timeZone);
  const end = start.add({ days: 1 });
  return {
    start: start.toInstant().toString() as Instant,
    end: end.toInstant().toString() as Instant,
  };
}

function minutesBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / MINUTE_MS);
}

function toSchedulerBlock(block: Pick<ApprovedBlock, 'taskId' | 'startAt' | 'endAt'>): SchedulerBlock {
  return { taskId: block.taskId, start: block.startAt, end: block.endAt };
}

function historyMinutes(blocks: readonly ApprovedBlock[], taskId: Id, nowMs: number): number {
  let total = 0;
  for (const block of blocks) {
    if (block.taskId !== taskId) continue;
    if (Date.parse(block.startAt) >= nowMs) continue;
    total += Math.max(0, minutesBetween(block.startAt, block.endAt));
  }
  return total;
}

function blockMinutes(blocks: readonly SchedulerBlock[], taskId: Id): number {
  return blocks
    .filter((block) => block.taskId === taskId)
    .reduce((sum, block) => sum + minutesBetween(block.start, block.end), 0);
}

function alignUpToGrid(ms: number): number {
  return Math.ceil(ms / (5 * MINUTE_MS)) * 5 * MINUTE_MS;
}

function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function toPublicProposal(record: TodayProposalRecord): TodayProposal {
  return {
    id: record.id,
    kind: record.kind,
    date: record.date,
    timeZone: record.timeZone,
    basePlanVersionId: record.basePlanVersionId,
    availabilityVersion: record.availabilityVersion,
    blocks: record.blocks.map((block) => ({ ...block })),
    version: record.version,
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

export class TodayService {
  readonly #tasks: TaskRepository;
  readonly #planning: PlanningStore;
  readonly #today: TodayStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(deps: TodayServiceDependencies) {
    this.#tasks = deps.tasks;
    this.#planning = deps.planning;
    this.#today = deps.today;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
  }

  /**
   * Deterministic risk rules (M4-02):
   * - `high`: a remaining task is overdue (`dueAt < now`), or the smallest
   *   deadline slack is negative.
   * - `medium`: today's planned focus exceeds `prefs.maxDailyFocusMin`.
   * - `low`: otherwise.
   * Slack for a task is `dueAt - max(lastBlockEnd, now)` in whole minutes over
   * tasks due within the next 7 days.
   */
  async getToday(ownerId: Id, date: string): Promise<Today> {
    const now = this.#clock.now();
    const active = await this.#planning.getActivePlan(ownerId);
    const availability = await this.#planning.getAvailability(ownerId);
    const timeZone = active?.timeZone ?? availability.timeZone;
    if (active === null) {
      return {
        date,
        timeZone,
        blocks: [],
        slackMin: 0,
        risk: { level: 'low', reasons: [] },
        version: 1,
      };
    }
    const allBlocks = await this.#planning.listActiveBlocks(ownerId);
    const planBlocks = allBlocks.filter((block) => block.planId === active.planId);
    const dayBlocks = planBlocks
      .filter((block) => localDateOf(block.startAt, timeZone) === date)
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
      .slice(0, 3);

    const scopeTaskIds: readonly Id[] = 'taskIds' in active.scope
      ? (active.scope.taskIds as unknown as readonly Id[])
      : ((await this.#planning.resolveGoalTasks(ownerId, active.scope.goalId as Id))?.taskIds ?? []);
    const taskIds = [...new Set<string>([...planBlocks.map((block) => block.taskId), ...scopeTaskIds])];
    const tasks = new Map<string, Task>();
    for (const taskId of taskIds) {
      const task = await this.#tasks.get(ownerId, taskId as Id);
      if (task !== null) tasks.set(taskId, task);
    }

    const nowMs = instantToEpochMs(now);
    const dueHorizonMs = nowMs + DUE_SOON_DAYS * DAY_MS;
    const lastEnd = new Map<string, string>();
    for (const block of planBlocks) {
      if (block.status === 'superseded') continue;
      const current = lastEnd.get(block.taskId);
      lastEnd.set(block.taskId, current === undefined ? block.endAt : later(current, block.endAt));
    }

    let slackMin: number | null = null;
    const reasons: string[] = [];
    let overdue = false;
    for (const [taskId, task] of tasks) {
      if (task.status === 'done' || task.dueAt === undefined) continue;
      const dueMs = Date.parse(task.dueAt);
      if (dueMs > dueHorizonMs) continue;
      if (dueMs < nowMs) {
        overdue = true;
        reasons.push(`task_overdue:${taskId}`);
      }
      const end = lastEnd.get(taskId);
      const reference = end === undefined ? nowMs : Math.max(Date.parse(end), nowMs);
      const slack = Math.floor((dueMs - reference) / MINUTE_MS);
      slackMin = slackMin === null ? slack : Math.min(slackMin, slack);
    }
    if (slackMin !== null && slackMin < 0) reasons.push(`negative_slack:${slackMin}`);

    const dayStartMs = Date.parse(localDayRange(date, timeZone).start);
    const dayEndMs = Date.parse(localDayRange(date, timeZone).end);
    const todayLoad = planBlocks
      .filter((block) => {
        const start = Date.parse(block.startAt);
        return start >= Math.max(dayStartMs, nowMs) && start < dayEndMs;
      })
      .reduce((sum, block) => sum + minutesBetween(block.startAt, block.endAt), 0);
    const overDailyCap = todayLoad > availability.prefs.maxDailyFocusMin;
    if (overDailyCap) reasons.push(`daily_focus_cap_exceeded:${todayLoad}`);

    const level = overdue || (slackMin !== null && slackMin < 0)
      ? 'high'
      : overDailyCap
        ? 'medium'
        : 'low';

    return {
      date,
      timeZone,
      blocks: dayBlocks.map((block) => this.#toTodayBlock(block, tasks)),
      slackMin: slackMin ?? 0,
      risk: { level, reasons: reasons.slice(0, 20) },
      version: active.revision,
    };
  }

  async accept(
    ownerId: Id,
    date: string,
    expectedPlanVersion: number,
  ): Promise<Today> {
    const today = await this.getToday(ownerId, date);
    if (today.version !== expectedPlanVersion) {
      throw new VersionConflictError(expectedPlanVersion as never, today.version as never);
    }
    return today;
  }

  async shrink(
    ownerId: Id,
    input: TodayShrinkRequest,
    expectedPlanVersion: number,
  ): Promise<TodayProposal> {
    const now = this.#clock.now();
    const snapshot = await this.#snapshot(ownerId, now);
    this.#assertPlanVersion(snapshot.active, expectedPlanVersion);
    const target = snapshot.planBlocks.find(
      (block) => block.id === input.blockId && block.planId === snapshot.active.planId,
    );
    if (target === undefined) {
      throw new ValidationFailedError([
        { path: '/blockId', message: `block ${input.blockId} is not in the active plan` },
      ]);
    }
    if (Date.parse(target.startAt) < instantToEpochMs(now)) {
      throw new ValidationFailedError([
        { path: '/blockId', message: 'only unstarted blocks can be shortened' },
      ]);
    }
    const duration = minutesBetween(target.startAt, target.endAt);
    if (input.targetMin > duration) {
      throw new ValidationFailedError([
        { path: '/targetMin', message: `targetMin must be <= the current ${duration} minutes` },
      ]);
    }
    const replacement: PlanBlock = {
      taskId: target.taskId,
      startAt: target.startAt,
      endAt: epochMsToInstant(Date.parse(target.startAt) + input.targetMin * MINUTE_MS),
    };
    const candidate = this.#futureCandidate(snapshot, new Set([target.id]), [replacement]);
    this.#validateCandidate(snapshot, candidate, now);
    return this.#persistProposal(ownerId, {
      kind: 'shrink',
      date: input.date,
      timeZone: snapshot.active.timeZone,
      blocks: [this.#toProposalBlock(target.id, replacement)],
      candidateBlocks: candidate,
      snapshot,
      now,
    });
  }

  async reschedule(
    ownerId: Id,
    input: TodayRescheduleRequest,
    expectedPlanVersion: number,
  ): Promise<TodayProposal> {
    const now = this.#clock.now();
    const snapshot = await this.#snapshot(ownerId, now);
    this.#assertPlanVersion(snapshot.active, expectedPlanVersion);
    const selected = new Set(input.blockIds);
    const original = snapshot.planBlocks.filter(
      (block) => selected.has(block.id) && block.planId === snapshot.active.planId,
    );
    if (original.length !== selected.size) {
      throw new ValidationFailedError([
        { path: '/blockIds', message: 'every blockId must name an active-plan block' },
      ]);
    }
    if (original.some((block) => Date.parse(block.startAt) < instantToEpochMs(now))) {
      throw new ValidationFailedError([
        { path: '/blockIds', message: 'only unstarted blocks can be rescheduled' },
      ]);
    }

    const slotsInput = this.#scheduleInput(
      snapshot,
      [],
      now,
      snapshot.otherBlocks
        .filter((block) => Date.parse(block.startAt) >= instantToEpochMs(now))
        .concat(
          snapshot.planBlocks.filter(
            (block) =>
              !selected.has(block.id) && Date.parse(block.startAt) >= instantToEpochMs(now),
          ),
        )
        .map(toSchedulerBlock),
    );
    if (input.toDate !== undefined) {
      const range = localDayRange(input.toDate, snapshot.active.timeZone);
      if (
        Date.parse(range.end) > Date.parse(snapshot.active.horizon.end) ||
        Date.parse(range.start) < Date.parse(snapshot.active.horizon.start)
      ) {
        throw new ValidationFailedError([
          { path: '/toDate', message: 'toDate must lie inside the active plan horizon' },
        ]);
      }
    }
    const slots = computeAvailableSlots(slotsInput);
    const replacements: PlanBlock[] = [];
    const replacedIds = new Set<string>();
    const occupied: SchedulerBlock[] = [];
    for (const block of [...original].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))) {
      const duration = minutesBetween(block.startAt, block.endAt);
      const searchFrom = input.toDate === undefined
        ? Math.max(instantToEpochMs(now), Date.parse(block.startAt) + 5 * MINUTE_MS)
        : Math.max(instantToEpochMs(now), Date.parse(localDayRange(input.toDate, snapshot.active.timeZone).start));
      const slot = slots.find((entry) => {
        const start = Math.max(Date.parse(entry.start), searchFrom);
        const aligned = alignUpToGrid(start);
        if (aligned + duration * MINUTE_MS > Date.parse(entry.end)) return false;
        return !occupied.some((placed) =>
          aligned < Date.parse(placed.end) && aligned + duration * MINUTE_MS > Date.parse(placed.start),
        );
      });
      if (slot === undefined) {
        throw new ValidationFailedError([
          { path: '/blockIds', message: `no later slot fits block ${block.id}` },
        ]);
      }
      const startMs = alignUpToGrid(Math.max(Date.parse(slot.start), searchFrom));
      const replacement: PlanBlock = {
        taskId: block.taskId,
        startAt: epochMsToInstant(startMs),
        endAt: epochMsToInstant(startMs + duration * MINUTE_MS),
      };
      replacements.push(replacement);
      replacedIds.add(block.id);
      occupied.push({
        taskId: block.taskId,
        start: replacement.startAt,
        end: replacement.endAt,
      });
    }

    const candidate = this.#futureCandidate(snapshot, replacedIds, replacements);
    this.#validateCandidate(snapshot, candidate, now);
    return this.#persistProposal(ownerId, {
      kind: 'reschedule',
      date: input.date,
      timeZone: snapshot.active.timeZone,
      blocks: [...original]
        .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
        .map((block, index) =>
          this.#toProposalBlock(block.id, replacements[index] as PlanBlock),
        ),
      candidateBlocks: candidate,
      snapshot,
      now,
    });
  }

  async approveProposal(
    ownerId: Id,
    proposalId: Id,
    expectedAvailabilityVersion: number,
    idempotencyKey: string,
  ): Promise<PlanVersionDto> {
    const now = this.#clock.now();
    const proposal = await this.#today.getProposal(ownerId, proposalId);
    if (proposal === null) throw new NotFoundError('today proposal', proposalId);
    if (proposal.state === 'approved') {
      throw proposalConflict('the proposal was already approved');
    }
    if (
      proposal.state === 'expired' ||
      (proposal.expiresAt !== undefined && Date.parse(proposal.expiresAt) < instantToEpochMs(now))
    ) {
      throw proposalConflict('the proposal has expired');
    }
    if (expectedAvailabilityVersion !== proposal.availabilityVersion) {
      // Store re-checks the locked user-wide version; this early check mirrors
      // the plan approval 412 semantics for a proposal built on another version.
      throw new AvailabilityChangedError(
        expectedAvailabilityVersion,
        proposal.availabilityVersion,
      );
    }
    const snapshot = await this.#snapshot(ownerId, now);
    if (snapshot.active.planId !== proposal.planId) {
      throw proposalConflict('the active plan changed since the proposal was created');
    }
    if (snapshot.active.planVersionId !== proposal.basePlanVersionId) {
      throw proposalConflict('the plan version changed since the proposal was created');
    }
    this.#assertPlanVersion(snapshot.active, proposal.basePlanVersion);
    if (snapshot.active.availabilityVersion !== proposal.availabilityVersion) {
      throw new AvailabilityChangedError(
        proposal.availabilityVersion,
        snapshot.active.availabilityVersion,
      );
    }
    this.#validateCandidate(snapshot, proposal.candidateBlocks, now);
    return this.#today.approveProposal({
      proposal,
      expectedAvailabilityVersion,
      idempotencyKey,
      now,
    });
  }

  async #persistProposal(
    ownerId: Id,
    input: {
      kind: 'shrink' | 'reschedule';
      date: string;
      timeZone: string;
      blocks: readonly TodayProposalBlock[];
      candidateBlocks: readonly PlanBlock[];
      snapshot: Snapshot;
      now: Instant;
    },
  ): Promise<TodayProposal> {
    const record = await this.#today.createProposal({
      id: this.#ids.next(),
      ownerId,
      planId: input.snapshot.active.planId,
      kind: input.kind,
      date: input.date,
      timeZone: input.timeZone,
      blocks: input.blocks,
      candidateBlocks: input.candidateBlocks,
      basePlanVersionId: input.snapshot.active.planVersionId,
      basePlanVersion: input.snapshot.active.revision,
      availabilityVersion: input.snapshot.active.availabilityVersion,
      expiresAt: epochMsToInstant(instantToEpochMs(input.now) + PROPOSAL_TTL_MS),
      now: input.now,
    });
    return toPublicProposal(record);
  }

  async #snapshot(ownerId: Id, now: Instant): Promise<Snapshot> {
    const active = await this.#planning.getActivePlan(ownerId);
    if (active === null) throw new NotFoundError('active plan', ownerId);
    const availability = await this.#planning.getAvailability(ownerId);
    const commitments = await this.#planning.listCommitmentsInRange(
      ownerId,
      active.horizon.start,
      active.horizon.end,
    );
    const allBlocks = await this.#planning.listActiveBlocks(ownerId);
    const planBlocks = allBlocks.filter((block) => block.planId === active.planId);
    const otherBlocks = allBlocks.filter((block) => block.planId !== active.planId);
    const taskIds = [...new Set(allBlocks.map((block) => block.taskId))];
    const tasks = new Map<string, Task>();
    for (const taskId of taskIds) {
      const task = await this.#tasks.get(ownerId, taskId);
      if (task !== null) tasks.set(taskId, task);
    }
    const estimates = await this.#planning.getCurrent(ownerId, taskIds);
    if (Date.parse(now) < Date.parse(active.horizon.start)) {
      // The clock is authoritative; no error is needed. Kept as a guard for
      // readability because scheduler inputs require now inside the horizon.
    }
    return { active, availability, commitments, planBlocks, otherBlocks, tasks, estimates };
  }

  #futureCandidate(
    snapshot: Snapshot,
    replaced: ReadonlySet<string>,
    replacements: readonly PlanBlock[],
  ): PlanBlock[] {
    const nowMs = instantToEpochMs(this.#clock.now());
    const kept = snapshot.planBlocks
      .filter((block) => !replaced.has(block.id) && Date.parse(block.startAt) >= nowMs)
      .map((block) => ({
        taskId: block.taskId,
        startAt: block.startAt,
        endAt: block.endAt,
      }));
    return [...kept, ...replacements].sort(
      (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt),
    );
  }

  #validateCandidate(snapshot: Snapshot, candidate: readonly PlanBlock[], now: Instant): void {
    const nowMs = instantToEpochMs(now);
    const input = this.#scheduleInput(
      snapshot,
      candidate.map((block) => ({
        taskId: block.taskId as string,
        start: block.startAt,
        end: block.endAt,
      })),
      now,
      snapshot.otherBlocks
        .filter((block) => Date.parse(block.startAt) >= nowMs)
        .map(toSchedulerBlock),
    );
    const historyBlocks = [...snapshot.planBlocks, ...snapshot.otherBlocks]
      .filter((block) => Date.parse(block.startAt) < nowMs)
      .map(toSchedulerBlock);
    const findings = validate(
      input,
      candidate.map((block) => ({
        taskId: block.taskId,
        start: block.startAt,
        end: block.endAt,
      })),
      {
        riskLevel: snapshot.availability.prefs.riskLevel,
        historyBlocks,
      },
    );
    // A shrink intentionally leaves work unplaced. H7 deficits are reported by
    // planning/replanning, not treated as a today-action conflict; every other
    // H1-H8 finding rejects the proposal (or approval).
    const blocking = findings.filter(
      (finding) => !(finding.code === 'H7' && finding.message.includes('short by')),
    );
    if (blocking.length > 0) {
      throw new ConstraintViolationError(blocking.map(toContractViolation));
    }
  }

  #scheduleInput(
    snapshot: Snapshot,
    audited: readonly SchedulerBlock[],
    now: Instant,
    lockedBlocks: readonly SchedulerBlock[],
  ): ScheduleInput {
    const nowMs = instantToEpochMs(now);
    const allBlocks = [...snapshot.planBlocks, ...snapshot.otherBlocks];
    const taskIds = [...new Set([...allBlocks.map((b) => b.taskId), ...audited.map((b) => b.taskId)])];
    const riskLevel = snapshot.availability.prefs.riskLevel;
    const tasks: ScheduleInput['tasks'] = taskIds.map((taskId) => {
      const task = snapshot.tasks.get(taskId);
      const estimate = snapshot.estimates.get(taskId);
      const required = riskLevel === 'p90' ? (estimate?.p90Min ?? 0) : (estimate?.p50Min ?? 0);
      const history = historyMinutes(allBlocks, taskId as Id, nowMs);
      const remainingMin = Math.max(0, required - history);
      const splittable = task?.splittable ?? true;
      const minSessionMin = !splittable
        ? Math.max(1, remainingMin)
        : (task?.session?.minMinutes ?? DEFAULT_MIN_SESSION_MIN);
      const maxSessionMin = !splittable
        ? Math.max(1, remainingMin)
        : (task?.session?.maxMinutes ?? DEFAULT_MAX_SESSION_MIN);
      return {
        id: taskId,
        ...(task?.dueAt === undefined ? {} : { dueAt: task.dueAt }),
        estimate: { p50Min: estimate?.p50Min ?? 0, p90Min: estimate?.p90Min ?? 0 },
        remainingMin,
        splittable,
        minSessionMin,
        maxSessionMin,
        priority: task?.priority ?? 2,
        dependsOn: (task?.dependsOn ?? []).filter((dependency) => taskIds.includes(dependency)),
      };
    });
    for (const task of tasks) {
      const blockedMinutes = blockMinutes(lockedBlocks, task.id as Id);
      if (blockedMinutes > 0 && !snapshot.planBlocks.some((block) => block.taskId === task.id)) {
        // Locked blocks from other plans are not part of this proposal's H7
        // accounting; their own plan already covers them.
        task.remainingMin = blockedMinutes;
        task.minSessionMin = 1;
        task.maxSessionMin = 100_000;
        task.splittable = true;
      }
    }
    return {
      now,
      timeZone: snapshot.active.timeZone,
      horizon: snapshot.active.horizon,
      tasks,
      availability: snapshot.availability.rules.map((rule) => ({
        weekday: rule.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        startLocal: rule.startLocal,
        endLocal: rule.endLocal,
        kind: rule.kind,
      })),
      exceptions: snapshot.availability.exceptions.map((exception) => ({
        date: exception.date,
        kind: exception.kind,
        ...(exception.startLocal === undefined ? {} : { startLocal: exception.startLocal }),
        ...(exception.endLocal === undefined ? {} : { endLocal: exception.endLocal }),
      })),
      commitments: this.#commitmentInstants(snapshot.commitments, snapshot),
      lockedBlocks: [...lockedBlocks],
      prefs: snapshot.availability.prefs,
      seed: 0,
    };
  }

  #commitmentInstants(
    commitments: readonly Commitment[],
    snapshot: Snapshot,
  ): ScheduleInput['commitments'] {
    const result: ScheduleInput['commitments'] = [];
    for (const commitment of commitments) {
      let occurrences;
      try {
        occurrences = expandOccurrences(
          commitment,
          snapshot.active.horizon.start,
          snapshot.active.horizon.end,
        );
      } catch (error) {
        if (error instanceof InvalidRRuleError) {
          throw new ValidationFailedError([{ path: '/commitments', message: error.message }]);
        }
        throw error;
      }
      for (const occurrence of occurrences) {
        const clipped = clipOccurrence(
          occurrence,
          snapshot.active.horizon.start,
          snapshot.active.horizon.end,
        );
        if (clipped === null) continue;
        result.push({ start: clipped.startAt, end: clipped.endAt });
        if (result.length > MAX_OCCURRENCES) {
          throw new ValidationFailedError([
            { path: '/commitments', message: `commitments expand to more than ${MAX_OCCURRENCES}` },
          ]);
        }
      }
    }
    return result;
  }

  #toTodayBlock(block: ApprovedBlock, tasks: ReadonlyMap<string, Task>): TodayBlock {
    const task = tasks.get(block.taskId);
    return {
      id: block.id,
      taskId: block.taskId,
      title: task?.title ?? 'Task',
      startAt: block.startAt,
      endAt: block.endAt,
      status: block.status as TodayBlock['status'],
    };
  }

  #toProposalBlock(blockId: Id, block: PlanBlock): TodayProposalBlock {
    return {
      blockId,
      taskId: block.taskId,
      startAt: block.startAt,
      endAt: block.endAt,
    };
  }

  #assertPlanVersion(active: ActivePlanRevision, expected: number): void {
    if (active.revision !== expected) {
      throw new VersionConflictError(expected as never, active.revision as never);
    }
  }
}

function toContractViolation(violation: SchedulerViolation) {
  return {
    code: violation.code as 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8',
    ...(violation.taskId === undefined ? {} : { taskId: violation.taskId as Id }),
    message: violation.message,
  };
}
