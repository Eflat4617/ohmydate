import type {
  DecompositionDraftDto,
  IntakeAnswer,
  IntakeDetectedType,
  IntakeError,
  IntakeInput,
  TaskTemplate,
} from '@ohmydate/contracts';
import type { Id, Instant, IntakeState } from '@ohmydate/domain';
import type { JsonValue } from '../../db/types.js';

export interface IntakeSessionRecord {
  readonly id: Id;
  readonly ownerId: Id;
  readonly goalId?: Id;
  readonly state: IntakeState;
  readonly input: IntakeInput;
  readonly detectedType?: IntakeDetectedType;
  readonly templateId?: Id;
  readonly round: number;
  readonly manual: boolean;
  readonly error?: IntakeError;
  readonly version: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface IntakeSessionUpdate {
  readonly state?: IntakeState;
  readonly input?: IntakeInput;
  readonly detectedType?: IntakeDetectedType | null;
  readonly templateId?: Id | null;
  readonly round?: number;
  readonly manual?: boolean;
  readonly error?: IntakeError | null;
}

export interface IntakeAnswerRecord {
  readonly field: string;
  readonly action: IntakeAnswer['action'];
  readonly value?: unknown;
  readonly questionText: string;
  readonly skipped: boolean;
  readonly createdAt: Instant;
}

export interface IntakeSessionRepository {
  create(record: IntakeSessionRecord): Promise<IntakeSessionRecord>;
  /** FU-40: sessions without a goal get one named from the intake title. */
  createGoal(ownerId: Id, goalId: Id, title: string): Promise<void>;
  get(ownerId: Id, id: Id): Promise<IntakeSessionRecord | null>;
  update(
    ownerId: Id,
    id: Id,
    patch: IntakeSessionUpdate,
    expectedVersion: number,
  ): Promise<IntakeSessionRecord>;
  listAnswers(ownerId: Id, sessionId: Id): Promise<readonly IntakeAnswerRecord[]>;
  appendAnswers(
    ownerId: Id,
    sessionId: Id,
    answers: readonly IntakeAnswerRecord[],
  ): Promise<void>;
  /** H2: answers + input/state/round + version CAS in one transaction. */
  appendAnswersAndUpdate(
    ownerId: Id,
    sessionId: Id,
    answers: readonly IntakeAnswerRecord[],
    patch: IntakeSessionUpdate,
    expectedVersion: number,
  ): Promise<IntakeSessionRecord>;
  /** H2: draft proposal write + session version bump in one transaction. */
  patchDraftAndUpdate(
    ownerId: Id,
    sessionId: Id,
    input: {
      readonly draft: DecompositionDraftDto;
      readonly schemaOk: boolean;
      readonly policyOk: boolean;
      readonly constraintOk: boolean;
      readonly issues: readonly { readonly code: string; readonly message: string }[];
    },
    expectedVersion: number,
  ): Promise<IntakeSessionRecord>;
}

export interface TemplatePage {
  readonly items: readonly TaskTemplate[];
  readonly nextCursor: string | null;
}

export interface TaskTemplateRepository {
  list(
    ownerId: Id,
    query: { readonly query?: string; readonly cursor?: string; readonly limit?: number },
  ): Promise<TemplatePage>;
  get(ownerId: Id, id: Id): Promise<TaskTemplate | null>;
  /** 05 §3: a rejected similar proposal increments `false_positive_count`. */
  incrementFalsePositive(ownerId: Id, templateId: Id): Promise<void>;
  /** 05 §3: penalty term input keyed by template id. */
  falsePositiveCounts(ownerId: Id): Promise<ReadonlyMap<string, number>>;
}

export type AgentRunStatus = 'pending' | 'succeeded' | 'failed' | 'budget_exceeded';

export interface AgentRunInput {
  readonly id: Id;
  readonly ownerId: Id;
  readonly purpose: string;
  readonly promptIdVersion: string;
  readonly model: string;
  readonly provider: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly status: AgentRunStatus;
  readonly redactionReport: Readonly<Record<string, number>>;
}

export interface AgentProposalInput {
  readonly id: Id;
  readonly ownerId: Id;
  readonly runId: Id;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly schemaOk: boolean;
  readonly policyOk: boolean;
  readonly constraintOk: boolean;
  readonly decision: 'pending' | 'approved' | 'rejected' | 'expired';
}

export interface StoredDraft {
  readonly draft: DecompositionDraftDto;
  readonly proposalId: Id;
  readonly runId: Id;
  readonly version: number;
  readonly constraintOk: boolean;
  readonly policyOk: boolean;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

export interface AgentRunRepository {
  recordRun(input: AgentRunInput): Promise<void>;
  saveDraft(input: AgentProposalInput): Promise<void>;
  updateDraft(
    ownerId: Id,
    sessionId: Id,
    input: {
      readonly draft: DecompositionDraftDto;
      readonly schemaOk: boolean;
      readonly policyOk: boolean;
      readonly constraintOk: boolean;
      readonly issues: readonly { readonly code: string; readonly message: string }[];
    },
  ): Promise<void>;
  loadDraft(ownerId: Id, sessionId: Id): Promise<StoredDraft | null>;
  markDraftDecision(
    ownerId: Id,
    sessionId: Id,
    decision: 'approved' | 'rejected' | 'expired',
  ): Promise<void>;
}

export function draftKind(sessionId: Id): string {
  return `intake.decomposition:${sessionId}`;
}


export interface ApprovalStepRecord {
  readonly stepKey: string;
  readonly plannedTaskId: Id;
  readonly state: 'pending' | 'created' | 'unknown';
  readonly taskId?: Id;
  readonly dependencyState?: string;
}

export interface IntakeApprovalRecord {
  readonly sessionId: Id;
  readonly ownerId: Id;
  readonly draftVersion: number;
  readonly state: 'in_progress' | 'completed' | 'failed';
  readonly leaseExpiresAt: Instant;
  readonly idempotencyKey: string;
  readonly steps: readonly ApprovalStepRecord[];
}

export type BeginApprovalResult =
  | { readonly kind: 'started'; readonly approval: IntakeApprovalRecord }
  | { readonly kind: 'completed'; readonly session: IntakeSessionRecord }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'illegal_state'; readonly state: IntakeState }
  | { readonly kind: 'version_conflict'; readonly actualVersion: number }
  | { readonly kind: 'in_progress' };

export interface IntakeApprovalStore {
  begin(input: {
    readonly ownerId: Id;
    readonly sessionId: Id;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly leaseMs: number;
    readonly steps: readonly { readonly stepKey: string; readonly plannedTaskId: Id }[];
  }): Promise<BeginApprovalResult>;
  load(ownerId: Id, sessionId: Id): Promise<IntakeApprovalRecord | null>;
  markStep(
    ownerId: Id,
    sessionId: Id,
    stepKey: string,
    patch: {
      readonly state: 'pending' | 'created' | 'unknown';
      readonly taskId?: Id;
      readonly dependencyState?: string;
    },
  ): Promise<void>;
  fail(ownerId: Id, sessionId: Id): Promise<void>;
  complete(input: {
    readonly ownerId: Id;
    readonly sessionId: Id;
    readonly expectedSessionVersion: number;
    readonly outboxId: Id;
  }): Promise<IntakeSessionRecord>;
  hasActive(ownerId: Id, sessionId: Id): Promise<boolean>;
}
