import type {
  Availability,
  AvailabilityPut,
  Commitment,
  CommitmentCreate,
  CommitmentListQuery,
  CommitmentPage,
  CommitmentPatch,
  ExplanationItem,
  Plan,
  PlanBlock,
  PlanCandidateDto,
  PlanHorizon,
  PlanScope,
  PlanVersionDto,
  Violation,
} from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';

export interface EstimateRecord {
  readonly taskId: Id;
  readonly p50Min: number;
  readonly p90Min: number;
}

export interface EstimateRepository {
  getCurrent(ownerId: Id, taskIds: readonly Id[]): Promise<ReadonlyMap<string, EstimateRecord>>;
}

export interface ApprovedBlock {
  readonly id: Id;
  readonly planId: Id;
  readonly planVersionId: Id;
  readonly taskId: Id;
  readonly startAt: Instant;
  readonly endAt: Instant;
  readonly status: string;
  readonly locked: boolean;
  readonly version: number;
}

/**
 * FU-53: one page of active blocks overlapping `[from, to)`, ordered by
 * `(startAt, id)` ascending. Cursor and range are pushed into SQL so the
 * database never returns the owner's whole block history.
 */
export interface ScheduleBlockWindowQuery {
  readonly from: Instant;
  readonly to: Instant;
  readonly cursorStartAt?: Instant;
  readonly cursorId?: Id;
  /** Maximum rows to return; callers ask for `pageSize + 1` to detect more. */
  readonly limit: number;
}

export interface ActivePlanRevision {
  readonly planId: Id;
  readonly planVersionId: Id;
  /** Plan resource version, also the `Today.version` / If-Match value. */
  readonly revision: number;
  readonly timeZone: string;
  readonly horizon: PlanHorizon;
  readonly scope: PlanScope;
  readonly availabilityVersion: number;
}

export interface NewPlan {
  readonly scope: PlanScope;
  readonly horizon: PlanHorizon;
  readonly timeZone: string;
  readonly availabilityVersion: number;
  readonly candidates: readonly NewCandidate[];
}

export interface NewCandidate {
  readonly policy: PlanCandidateDto['policy'];
  readonly blocks: readonly PlanBlock[];
  readonly metrics: PlanCandidateDto['metrics'];
  readonly feasible: boolean;
  readonly deficitMin: number;
  readonly capacityDeficitMin: number;
  readonly explanation: readonly string[];
  /** FU-62: `explanationItems[i]` codes `explanation[i]`. */
  readonly explanationItems: readonly ExplanationItem[];
  readonly diversityNote?: string | undefined;
  readonly generatorVersion: string;
  readonly inputHash: string;
}

export interface GoalTasks {
  readonly goalExists: boolean;
  readonly taskIds: readonly Id[];
}

export interface ApprovalSnapshot {
  readonly plan: Plan;
  readonly candidate: PlanCandidateDto;
  readonly availability: Availability;
  readonly commitments: readonly Commitment[];
  readonly blocks: readonly ApprovedBlock[];
  readonly estimates: ReadonlyMap<string, EstimateRecord>;
}

export interface PreparedApproval {
  readonly blocks: readonly PlanBlock[];
  readonly violations: readonly Violation[];
}

export interface ApprovalRequest {
  readonly expectedAvailabilityVersion: number;
  readonly expectedPlanVersion: number;
  readonly idempotencyKey: string;
  readonly now: Instant;
  readonly editedBlocks?: readonly PlanBlock[] | undefined;
  /** Scope task ids (plus locked-block tasks) whose current estimates to load. */
  readonly taskIds: readonly Id[];
  /** Planning task set (scope + dependency closure minus done tasks). */
  readonly planningTaskIds: readonly Id[];
  /** Provider tasks whose planner identity rows must exist before block insert. */
  readonly identityTasks: readonly import('@ohmydate/domain').Task[];
  /**
   * Provider-deleted tasks: supersede their future approved blocks in this TX
   * so a stranded block never locks the owner out of planning (probe K).
   */
  readonly releaseVanishedTaskIds?: readonly Id[] | undefined;
  prepare(snapshot: ApprovalSnapshot): Promise<PreparedApproval>;
}

export interface PlanningStore extends EstimateRepository {
  getAvailability(ownerId: Id): Promise<Availability>;
  putAvailability(
    ownerId: Id,
    input: AvailabilityPut,
    expectedVersion: number,
  ): Promise<Availability>;
  listCommitments(ownerId: Id, query: CommitmentListQuery): Promise<CommitmentPage>;
  /** Unpaged, owner-scoped, range-prefiltered rows for planning assembly. */
  listCommitmentsInRange(ownerId: Id, from: string, to: string): Promise<Commitment[]>;
  createCommitment(ownerId: Id, input: CommitmentCreate): Promise<Commitment>;
  updateCommitment(
    ownerId: Id,
    id: Id,
    patch: CommitmentPatch,
    expectedVersion: number,
  ): Promise<Commitment>;
  deleteCommitment(ownerId: Id, id: Id, expectedVersion: number): Promise<void>;
  createPlan(ownerId: Id, input: NewPlan): Promise<Plan>;
  getPlan(ownerId: Id, id: Id): Promise<Plan | null>;
  getCandidate(
    ownerId: Id,
    planId: Id,
    candidateId: Id,
  ): Promise<PlanCandidateDto | null>;
  replaceCandidates(
    ownerId: Id,
    planId: Id,
    expectedVersion: number,
    candidates: readonly NewCandidate[],
    timeZone: string,
    availabilityVersion: number,
  ): Promise<Plan>;
  resolveGoalTasks(ownerId: Id, goalId: Id): Promise<GoalTasks | null>;
  listActiveBlocks(ownerId: Id): Promise<readonly ApprovedBlock[]>;
  /** FU-53: SQL-side range + cursor page of active blocks. */
  listScheduleBlocks(
    ownerId: Id,
    query: ScheduleBlockWindowQuery,
  ): Promise<readonly ApprovedBlock[]>;
  /** The owner's active approved plan (most recently updated), if any. */
  getActivePlan(ownerId: Id): Promise<ActivePlanRevision | null>;
  approve(
    ownerId: Id,
    planId: Id,
    candidateId: Id,
    request: ApprovalRequest,
  ): Promise<PlanVersionDto>;
}
