import { IntakeInputSchema } from '@ohmydate/contracts';
import type {
  DecompositionDraftDto,
  DecompositionDraftPatch,
  DecompositionEvidenceDto,
  IntakeAnswer,
  IntakeAnswersRequest,
  IntakeAssumptionDto,
  IntakeDetectedType,
  IntakeError as IntakeErrorDto,
  IntakeFieldName,
  IntakeInput,
  IntakeSessionCreate,
  IntakeSessionDto,
  IntakeTypeConfirmation,
  PlannedQuestion as PlannedQuestionDto,
  TaskTemplate,
  TaskTemplateListQuery,
} from '@ohmydate/contracts';
import {
  MAX_QUESTION_ROUNDS,
  MAX_QUESTIONS_PER_ROUND,
  QUESTION_PROMPTS,
  REQUIRED_INTAKE_FIELDS,
  VersionConflictError,
  ValidationFailedError,
  isFieldKnown,
  planQuestions,
  transition,
  validateDecomposition,
  type Clock,
  type DecompositionDraft,
  type DecompositionStep,
  type Id,
  type IdGenerator,
  type Instant,
  type IntakeAnswer as DomainIntakeAnswer,
  type IntakeField,
  type PlannedQuestion as DomainPlannedQuestion,
  type IntakeState,
  type Task,
  type TaskCreate,
  type TaskPriority,
  type TaskRepository,
  type Version,
} from '@ohmydate/domain';
import {
  BudgetExceeded,
  GatewayError,
  LlmError,
  LlmUnavailable,
  SchemaViolation,
  buildNoteContext,
  buildUntrustedBlock,
  groundingIndexOf,
  redact,
  runStructured,
  sanitizeGroundedDecomposition,
  DEFAULT_NOTE_CONTEXT_LIMITS,
  type RunStructuredResult,
  type BudgetGuard,
  type GroundedDecompositionOutput,
  type LlmPort,
  type NoteContextLimits,
  type NoteContextResult,
  type PromptLimitOverrides,
  type RedactionKind,
} from '@ohmydate/llm';
import { NotFoundError, coldStartEstimate, epochMsToInstant, isInstant } from '@ohmydate/domain';
import {
  currentAbortSignal,
  runWithAbortSignal,
  runWithProviderRequestGuard,
} from '@ohmydate/provider-vikunja';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { INTAKE_AGENT_CONFIG, type IntakeAgentConfig } from './config.js';
import {
  AI_CANCELLED_ERROR,
  AI_INTERRUPTED_CODE,
  AI_INTERRUPTED_ERROR,
  IntakeAiRunRegistry,
  aiCallTotalTimeoutMs,
  intakeAiRequestBoundMs,
  type AiRunHandle,
} from './ai-runs.js';
import { detectTypeDeterministic } from './detection.js';
import { IntakeApprovalOwnershipLostError, IntakeError } from './intake-error.js';
import type { NoteContextSource } from '../notes/ports.js';
import {
  draftKind,
  type AgentRunCompletion,
  type AgentRunRepository,
  type AgentRunStatus,
  type IntakeAnswerRecord,
  type IntakeApprovalLock,
  type IntakeApprovalStore,
  type IntakeSessionRecord,
  type IntakeSessionRepository,
  type IntakeSessionUpdate,
  type TaskTemplateRepository,
} from './ports.js';

function isPgForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === '23503';
}

const TYPE_DETECTION_PROMPT = { promptId: 'type_detection', version: 'v1' } as const;
const DECOMPOSITION_PROMPT = { promptId: 'decomposition', version: 'v1' } as const;
/** M6-01: note-grounded decomposition, used only when note sections are sent. */
const GROUNDED_DECOMPOSITION_PROMPT = { promptId: 'decomposition', version: 'v2' } as const;
const TYPE_DETECTION_SCHEMA = 'llm.type_detection.v1';
const DECOMPOSITION_SCHEMA = 'llm.decomposition.v1';
const GROUNDED_DECOMPOSITION_SCHEMA = 'llm.decomposition.v2';

const DRAFT_STATES: ReadonlySet<IntakeState> = new Set([
  'decomposition',
  'feasibility_check',
  'plan_proposals',
  'awaiting_approval',
  'scheduled',
]);

export interface IntakeServiceOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sessions: IntakeSessionRepository;
  readonly templates: TaskTemplateRepository;
  readonly agentRuns: AgentRunRepository;
  readonly tasks: TaskRepository;
  readonly approvals: IntakeApprovalStore;
  /** ADR-020 §1: session-level lock held for the whole approval. */
  readonly approvalLock: IntakeApprovalLock;
  /** ADR-020 §7/§10: succession wait; must cover one HTTP request budget. */
  readonly providerMaxCallMs: number;
  /** `null` means no provider is configured: LLM-dependent steps notify manual mode. */
  readonly llm: LlmPort | null;
  /** Configured provider id for agent_run metadata when a call fails. */
  readonly llmProvider?: string;
  readonly budgetGuard: BudgetGuard;
  readonly config?: IntakeAgentConfig;
  /**
   * M6-01 note grounding: live, llm_allowed notes linked to the session goal
   * are fenced into the decomposition prompt. Omitted -> no note context.
   */
  readonly notes?: NoteContextSource;
  readonly noteLimits?: Partial<NoteContextLimits>;
  /** Per-prompt token/timeout limits (config); default: llm DEFAULT_PROMPT_LIMIT_OVERRIDES. */
  readonly promptLimits?: PromptLimitOverrides;
  /** FU-76: in-process registry of in-flight AI runs (tests may share one). */
  readonly aiRuns?: IntakeAiRunRegistry;
}

/** FU-76: the in-flight AI run of one intake request. */
interface AiRunContext {
  readonly handle: AiRunHandle;
  /** Set once the run's LLM call ended because of an abort (agent_run `cancelled`). */
  cancelled: boolean;
}

export interface LlmInputBundle {
  readonly input: unknown;
  readonly redactionReport: Readonly<Record<string, number>>;
}

export interface ApprovalResult {
  readonly session: IntakeSessionDto;
  readonly tasks: readonly { readonly id: Id; readonly version: Version }[];
}

export interface DraftResult {
  readonly draft: DecompositionDraftDto;
  readonly version: number;
}

function mergeRedaction(
  target: Record<string, number>,
  report: readonly { readonly kind: RedactionKind; readonly count: number }[],
): void {
  for (const entry of report) {
    target[entry.kind] = (target[entry.kind] ?? 0) + entry.count;
  }
}

function redactValue(value: unknown, report: Record<string, number>): unknown {
  if (typeof value === 'string') {
    const result = redact(value);
    mergeRedaction(report, result.report);
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, report));
  }
  if (value !== null && typeof value === 'object') {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      record[key] = redactValue(entry, report);
    }
    return record;
  }
  return value;
}

/**
 * H? / M untrusted: only non-free-text fields stay in the structured LLM
 * object. Every user-authored string goes through an escaped
 * `<untrusted_document>` block. Template text follows the same rule.
 */
function untrustedBlock(
  id: string,
  value: unknown,
  report: Record<string, number>,
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const redacted = redact(value);
  mergeRedaction(report, redacted.report);
  return buildUntrustedBlock(id, redacted.text);
}

function redactedStructuredTask(input: IntakeInput, report: Record<string, number>): unknown {
  const structured: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      key === 'title' ||
      key === 'description' ||
      key === 'deliverable' ||
      key === 'currentProgress' ||
      key === 'prerequisites'
    ) {
      continue;
    }
    structured[key] = value;
  }
  if (typeof input.prerequisites !== 'string' && !Array.isArray(input.prerequisites)) {
    structured['prerequisites'] = input.prerequisites;
  }
  return redactValue(structured, report);
}

function taskDocuments(input: IntakeInput, report: Record<string, number>): string[] {
  const documents: string[] = [];
  const push = (id: string, value: unknown): void => {
    const block = untrustedBlock(id, value, report);
    if (block !== undefined) documents.push(block);
  };
  push('intake-title', input.title);
  push('intake-description', input.description);
  push('intake-deliverable', input.deliverable);
  if (typeof input.currentProgress === 'string') {
    push('intake-current-progress', input.currentProgress);
  }
  if (typeof input.prerequisites === 'string') {
    push('intake-prerequisites', input.prerequisites);
  } else if (Array.isArray(input.prerequisites)) {
    input.prerequisites.forEach((entry, index) => {
      push(`intake-prerequisites-${index}`, entry);
    });
  }
  return documents;
}

function templateStructured(template: TaskTemplate): unknown {
  return {
    id: template.id,
    source: template.source,
    confidence: template.confidence,
    stats: template.stats,
    stepKeys: template.steps.map((step) => ({ key: step.key, kind: step.kind })),
  };
}

function templateDocuments(
  template: TaskTemplate,
  report: Record<string, number>,
): string[] {
  const documents: string[] = [];
  const push = (id: string, value: unknown): void => {
    const block = untrustedBlock(id, value, report);
    if (block !== undefined) documents.push(block);
  };
  push(`template-${template.id}-name`, template.name);
  template.steps.forEach((step, index) => {
    push(`template-${template.id}-s${index}-title`, step.title);
    push(`template-${template.id}-s${index}-deliverable`, step.deliverable);
    push(`template-${template.id}-s${index}-done`, step.doneCriteria);
  });
  return documents;
}

/** Exported so tests can register the exact FakeLlm fixture input. */
export function buildDetectionLlmInput(
  input: IntakeInput,
  templates: readonly TaskTemplate[],
): LlmInputBundle {
  const report: Record<string, number> = {};
  const documents = [
    ...taskDocuments(input, report),
    ...templates.flatMap((template) => templateDocuments(template, report)),
  ];
  return {
    input: {
      configVersion: INTAKE_AGENT_CONFIG.version,
      knownFields: Object.keys(input).sort(),
      task: redactedStructuredTask(input, report),
      candidates: templates.map((template) => templateStructured(template)),
      documents,
    },
    redactionReport: report,
  };
}

/**
 * Exported so tests can register the exact FakeLlm fixture input. `notes` (the
 * fenced, redacted note sections) is present only for note-grounded calls, so
 * the v1 input stays byte-identical when no note is linked.
 */
export function buildDecompositionLlmInput(
  input: IntakeInput,
  template: TaskTemplate | undefined,
  notes?: NoteContextResult,
): LlmInputBundle {
  const report: Record<string, number> = {};
  const documents = [
    ...taskDocuments(input, report),
    ...(template === undefined ? [] : templateDocuments(template, report)),
  ];
  if (notes !== undefined) {
    for (const [kind, count] of Object.entries(notes.redactionReport)) {
      if (count !== undefined) report[kind] = (report[kind] ?? 0) + count;
    }
  }
  return {
    input: {
      configVersion: INTAKE_AGENT_CONFIG.version,
      task: redactedStructuredTask(input, report),
      template: template === undefined ? null : templateStructured(template),
      documents,
      ...(notes === undefined ? {} : { notes: [...notes.blocks] }),
    },
    redactionReport: report,
  };
}

/** Ranking text for note sections (never sent): the user's own intake text. */
export function intakeQueryText(input: IntakeInput): string {
  const parts: string[] = [input.title];
  for (const value of [input.description, input.deliverable, input.currentProgress]) {
    if (typeof value === 'string') parts.push(value);
  }
  if (typeof input.prerequisites === 'string') parts.push(input.prerequisites);
  else if (Array.isArray(input.prerequisites)) {
    for (const entry of input.prerequisites) if (typeof entry === 'string') parts.push(entry);
  }
  return parts.join('\n');
}

/**
 * Keep evidence whose step keys still exist after an edit; an item whose steps
 * were all removed stays as context with an empty list.
 */
function evidenceForSteps(
  evidence: readonly DecompositionEvidenceDto[] | undefined,
  steps: readonly { readonly key: string }[],
): DecompositionEvidenceDto[] | undefined {
  if (evidence === undefined) return undefined;
  const keys = new Set(steps.map((step) => step.key));
  return evidence.map((item) => ({ ...item, stepKeys: item.stepKeys.filter((key) => keys.has(key)) }));
}

interface DetectionLlmOutput {
  readonly classification: 'new' | 'similar';
  readonly templateId?: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly missingRequired?: readonly IntakeFieldName[];
}

interface DecompositionLlmOutput {
  readonly steps: readonly DecompositionStep[];
  readonly assumptions: readonly string[];
  readonly questionsRemaining: readonly string[];
}

function requiredMissing(
  input: IntakeInput,
  answers: readonly IntakeAnswerRecord[],
): IntakeFieldName[] {
  const resolved = new Set<string>();
  for (const answer of answers) {
    if (isFieldKnown(answer.field as IntakeField, answer.value)) resolved.add(answer.field);
    else if (answer.action !== 'answer') resolved.add(answer.field);
  }
  return REQUIRED_INTAKE_FIELDS.filter(
    (field) => !isFieldKnown(field, input[field]) && !resolved.has(field),
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function toDomainAnswers(records: readonly IntakeAnswerRecord[]): DomainIntakeAnswer[] {
  return records.map((record) => ({
    field: record.field as IntakeField,
    action: record.action,
    ...(record.value === undefined ? {} : { value: record.value }),
  }));
}

function assumptionDto(assumption: {
  readonly field: IntakeField;
  readonly reason: 'skip' | 'idk' | 'unanswered';
  readonly value: string;
}): IntakeAssumptionDto {
  return {
    field: assumption.field,
    reason: assumption.reason,
    value: assumption.value,
  };
}

function answerDto(record: IntakeAnswerRecord): IntakeAnswer {
  return {
    questionKey: record.field as IntakeFieldName,
    questionText: record.questionText,
    action: record.action,
    ...(record.value === undefined ? {} : { value: record.value as never }),
    skipped: record.skipped,
  };
}

function questionDto(question: DomainPlannedQuestion): PlannedQuestionDto {
  return {
    field: question.field,
    prompt: question.prompt,
    required: question.required,
    choices: [question.choices[0], question.choices[1], question.choices[2]],
  };
}

/**
 * FU-48: step keys whose estimate differs from the previously stored draft
 * (or that are new), unioned with earlier edits. Keys that no longer exist are
 * dropped so a removed step cannot mark a later step with the same key.
 */
export function editedEstimateKeys(
  previous: readonly { readonly key: string; readonly estimate: { readonly p50Minutes: number; readonly p90Minutes: number } }[],
  next: readonly { readonly key: string; readonly estimate: { readonly p50Minutes: number; readonly p90Minutes: number } }[],
  alreadyEdited: readonly string[],
): string[] {
  const before = new Map(previous.map((step) => [step.key, step.estimate]));
  const prior = new Set(alreadyEdited);
  const edited = new Set<string>();
  for (const step of next) {
    const old = before.get(step.key);
    if (
      prior.has(step.key) ||
      old === undefined ||
      old.p50Minutes !== step.estimate.p50Minutes ||
      old.p90Minutes !== step.estimate.p90Minutes
    ) {
      edited.add(step.key);
    }
  }
  return [...edited].sort();
}

function estimateForScope(scope: IntakeInput['estimatedScope']): {
  p50Minutes: number;
  p90Minutes: number;
} {
  switch (scope) {
    case 'small':
      return { p50Minutes: 90, p90Minutes: 150 };
    case 'large':
      return { p50Minutes: 240, p90Minutes: 480 };
    case 'medium':
    default:
      return { p50Minutes: 180, p90Minutes: 300 };
  }
}

function manualDraft(input: IntakeInput, assumptions: readonly string[]): DecompositionDraftDto {
  const work = estimateForScope(input.estimatedScope);
  return {
    steps: [
      {
        key: 's1',
        title: 'Prepare the workspace and inputs',
        deliverable: 'Inputs collected and the workspace is ready',
        doneCriteria: 'Every prerequisite is available',
        kind: 'prep',
        estimate: { p50Minutes: 30, p90Minutes: 60 },
        dependsOn: [],
        splittable: false,
      },
      {
        key: 's2',
        title: truncate(input.title, 120),
        deliverable: truncate(input.deliverable ?? input.title, 300),
        doneCriteria: 'Deliverable reviewed against the stated requirements',
        kind: 'work',
        estimate: work,
        dependsOn: ['s1'],
        splittable: (input.estimatedScope ?? 'medium') !== 'small',
      },
      {
        key: 's3',
        title: 'Review against done criteria',
        deliverable: 'Reviewed deliverable',
        doneCriteria: 'Review notes resolved or recorded',
        kind: 'review',
        estimate: { p50Minutes: 30, p90Minutes: 60 },
        dependsOn: ['s2'],
        splittable: false,
      },
    ],
    assumptions: [...assumptions],
    questionsRemaining: [],
  };
}

function topoSortSteps(steps: readonly DecompositionStep[]): DecompositionStep[] {
  const remaining = [...steps];
  const known = new Set<string>();
  const ordered: DecompositionStep[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((step) => step.dependsOn.every((ref) => known.has(ref)));
    if (index < 0) throw new ValidationFailedError([{ path: '/steps', message: 'dependency cycle' }]);
    const [step] = remaining.splice(index, 1);
    if (step === undefined) break;
    known.add(step.key);
    ordered.push(step);
  }
  return ordered;
}

export class IntakeService {
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #sessions: IntakeSessionRepository;
  readonly #templates: TaskTemplateRepository;
  readonly #agentRuns: AgentRunRepository;
  readonly #tasks: TaskRepository;
  readonly #approvals: IntakeApprovalStore;
  readonly #approvalLock: IntakeApprovalLock;
  readonly #providerMaxCallMs: number;
  readonly #llm: LlmPort | null;
  readonly #llmProvider: string;
  readonly #budgetGuard: BudgetGuard;
  readonly #config: IntakeAgentConfig;
  readonly #notes: NoteContextSource | undefined;
  readonly #noteLimits: NoteContextLimits;
  readonly #promptLimits: PromptLimitOverrides | undefined;
  readonly #aiRuns: IntakeAiRunRegistry;
  readonly #aiRequestBoundMs: number;

  constructor(options: IntakeServiceOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#sessions = options.sessions;
    this.#templates = options.templates;
    this.#agentRuns = options.agentRuns;
    this.#tasks = options.tasks;
    this.#approvals = options.approvals;
    this.#approvalLock = options.approvalLock;
    this.#providerMaxCallMs = options.providerMaxCallMs;
    this.#llm = options.llm;
    this.#llmProvider = options.llmProvider ?? 'fake';
    this.#budgetGuard = options.budgetGuard;
    this.#config = options.config ?? INTAKE_AGENT_CONFIG;
    this.#notes = options.notes;
    this.#noteLimits = { ...DEFAULT_NOTE_CONTEXT_LIMITS, ...(options.noteLimits ?? {}) };
    this.#promptLimits = options.promptLimits;
    this.#aiRuns = options.aiRuns ?? new IntakeAiRunRegistry();
    this.#aiRequestBoundMs = intakeAiRequestBoundMs(this.#promptLimits);
  }

  /** FU-76: effective server bound of one intake AI request (orphan threshold). */
  get aiRequestBoundMs(): number {
    return this.#aiRequestBoundMs;
  }

  #runOptions(
    promptId: string,
    signal: AbortSignal,
  ): {
    budgetGuard: BudgetGuard;
    estimatedCostUsd: number;
    promptLimits?: PromptLimitOverrides;
    signal: AbortSignal;
    totalTimeoutMs: number;
  } {
    return {
      budgetGuard: this.#budgetGuard,
      estimatedCostUsd: 0,
      ...(this.#promptLimits === undefined ? {} : { promptLimits: this.#promptLimits }),
      // FU-76: explicit cancel (:manual) and graceful shutdown abort the call;
      // a client disconnect does not.
      signal,
      totalTimeoutMs: aiCallTotalTimeoutMs(promptId, this.#promptLimits),
    };
  }

  /**
   * FU-76: register the request's AI run before its first state change so a
   * concurrent POST :manual always finds it, and release it however the
   * request ends.
   */
  async #withAiRun<T>(
    ownerId: Id,
    sessionId: Id,
    body: (run: AiRunContext) => Promise<T>,
  ): Promise<T> {
    const run: AiRunContext = {
      handle: this.#aiRuns.start(ownerId, sessionId, currentAbortSignal()),
      cancelled: false,
    };
    try {
      return await body(run);
    } finally {
      run.handle.finish(run.cancelled ? 'cancelled' : 'completed');
    }
  }

  async listTemplates(
    ownerId: Id,
    query: TaskTemplateListQuery,
  ): Promise<{ items: readonly TaskTemplate[]; nextCursor: string | null }> {
    return this.#templates.list(ownerId, {
      ...(query.query === undefined ? {} : { query: query.query }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  async getTemplate(ownerId: Id, id: Id): Promise<TaskTemplate> {
    const template = await this.#templates.get(ownerId, id);
    if (template === null) throw new NotFoundError('task template', id);
    return template;
  }

  async create(ownerId: Id, body: IntakeSessionCreate): Promise<IntakeSessionDto> {
    const now = this.#clock.now();
    const accepted = transition('created', { type: 'input_accepted' });
    const goalId = body.goalId === undefined ? this.#ids.next() : (body.goalId as Id);
    if (body.goalId === undefined) {
      await this.#sessions.createGoal(ownerId, goalId, body.input.title);
    } else if (!(await this.#sessions.goalExists(ownerId, goalId))) {
      throw new ValidationFailedError([
        { path: '/goalId', message: 'goal not found for this owner' },
      ]);
    }
    let session = await this.#sessions.create({
      id: this.#ids.next(),
      ownerId,
      goalId,
      state: accepted.state,
      input: body.input,
      round: 1,
      manual: false,
      version: 1 as Version,
      createdAt: now,
      updatedAt: now,
    });

    const templates = await this.#templates.list(ownerId, { limit: 100 });
    const falsePositiveCounts = await this.#templates.falsePositiveCounts(ownerId);
    const missing = requiredMissing(body.input, []);
    let detection = detectTypeDeterministic(
      body.input,
      templates.items,
      missing,
      this.#config,
      falsePositiveCounts,
    );

    let manual = false;
    let error: IntakeErrorDto | undefined;

    if (this.#llm === null) {
      manual = true;
      error = { code: 'llm_unavailable', message: 'no LLM provider configured; manual mode' };
    } else {
      const run: AiRunContext = {
        handle: this.#aiRuns.start(ownerId, session.id, currentAbortSignal()),
        cancelled: false,
      };
      try {
        const output = await this.#runDetectionLlm(
          ownerId,
          session.id,
          body.input,
          templates.items,
          run,
        );
        detection = {
          ...detection,
          detected: {
            ...detection.detected,
            reasons: [
              ...detection.detected.reasons,
              ...output.reasons.map((reason) => truncate(reason, 200)),
            ].slice(0, 10),
          },
        };
      } catch (caught) {
        manual = true;
        if (run.cancelled) {
          // FU-76: shutdown (or a cancel) aborted the detection call. The
          // deterministic detection still stands; continue in manual mode.
          error = { ...AI_INTERRUPTED_ERROR };
        } else if (caught instanceof BudgetExceeded) {
          error = { code: 'budget_exceeded', message: truncate(caught.message, 500) };
        } else if (caught instanceof SchemaViolation || caught instanceof LlmUnavailable) {
          const message =
            caught instanceof SchemaViolation
              ? 'LLM type detection did not match the schema after one repair; manual mode'
              : caught instanceof GatewayError
                ? `LLM unavailable (${caught.classification}); manual mode`
                : 'LLM unavailable; manual mode';
          error = { code: 'llm_unavailable', message };
        } else {
          throw caught;
        }
      } finally {
        run.handle.finish(run.cancelled ? 'cancelled' : 'completed');
      }
    }

    let state = session.state;
    if (detection.detected.classification === 'new') {
      state = transition(session.state, {
        type: 'type_detected',
        classification: 'new',
        missingRequired: missing,
      }).state;
    }

    session = await this.#sessions.update(
      ownerId,
      session.id,
      {
        state,
        detectedType: detection.detected,
        manual,
        error: error ?? null,
      },
      session.version,
    );

    return this.#toDto(session);
  }

  async get(ownerId: Id, id: Id): Promise<IntakeSessionDto> {
    let session = await this.#requireSession(ownerId, id);
    if (await this.#isOrphanedAiRun(session)) {
      // FU-76: no run in this process and older than the request bound: the
      // run died with a previous process (crash). Make it recoverable now
      // instead of leaving the client polling until the next restart.
      try {
        session = await this.#sessions.update(
          ownerId,
          id,
          {
            error: { ...AI_INTERRUPTED_ERROR },
            ...(session.state === 'type_detection' ? { manual: true } : {}),
          },
          session.version,
        );
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        session = await this.#requireSession(ownerId, id);
      }
    }
    return this.#toDto(session);
  }

  /** FU-76 in-progress rule (08 §2.7): the session waits for an AI result. */
  async #looksInFlight(session: IntakeSessionRecord): Promise<boolean> {
    if (session.error !== undefined) return false;
    if (session.state === 'type_detection') return session.detectedType === undefined;
    if (session.state !== 'decomposition' || session.manual) return false;
    return (await this.#agentRuns.loadDraft(session.ownerId, session.id)) === null;
  }

  async #isOrphanedAiRun(session: IntakeSessionRecord): Promise<boolean> {
    if (this.#aiRuns.isRunning(session.ownerId, session.id)) return false;
    const age = Date.parse(this.#clock.now()) - Date.parse(session.updatedAt);
    if (!(age > this.#aiRequestBoundMs)) return false;
    return this.#looksInFlight(session);
  }

  /**
   * FU-76 startup sweep: pending agent runs and in-flight-looking sessions older
   * than the AI request bound belong to a process that no longer exists.
   */
  async sweepOrphanedAiRuns(): Promise<{ readonly runs: number; readonly sessions: number }> {
    const cutoff = epochMsToInstant(Date.parse(this.#clock.now()) - this.#aiRequestBoundMs);
    const runs = await this.#agentRuns.cancelStalePending(this.#aiRequestBoundMs);
    const sessions = await this.#sessions.markStaleAiRuns(cutoff, { ...AI_INTERRUPTED_ERROR });
    return { runs, sessions };
  }

  async submitAnswers(
    ownerId: Id,
    id: Id,
    request: IntakeAnswersRequest,
    expectedVersion: number,
  ): Promise<IntakeSessionDto> {
    return this.#withAiRun(ownerId, id, (run) =>
      this.#submitAnswers(ownerId, id, request, expectedVersion, run),
    );
  }

  async #submitAnswers(
    ownerId: Id,
    id: Id,
    request: IntakeAnswersRequest,
    expectedVersion: number,
    run: AiRunContext,
  ): Promise<IntakeSessionDto> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state !== 'clarification') {
      throw IntakeError.illegalTransition(session.state, 'user_answered');
    }

    const input: Record<string, unknown> = { ...session.input };
    const answerRecords: IntakeAnswerRecord[] = [];
    const issues: { path: string; message: string }[] = [];
    const now = this.#clock.now();
    const properties = (
      IntakeInputSchema as unknown as { properties: Record<string, TSchema> }
    ).properties;

    request.answers.forEach((answer, index) => {
      const field = answer.questionKey as IntakeField;
      if (answer.action !== 'answer') {
        answerRecords.push({
          field,
          action: answer.action,
          questionText: truncate(QUESTION_PROMPTS[field], 300),
          skipped: true,
          createdAt: now,
        });
        return;
      }
      const schema = properties[field];
      // TypeBox's `date-time` format is not registered in this process (Fastify
      // registers it only on its AJV instance), so validate instants with the
      // domain guard, exactly like the merged-input pass below.
      const valid =
        field === 'dueAt'
          ? typeof answer.value === 'string' && isInstant(answer.value)
          : schema !== undefined && Value.Check(schema, answer.value);
      if (!valid) {
        issues.push({
          path: `/answers/${index}/value`,
          message: `invalid value for ${field}`,
        });
        return;
      }
      input[field] = answer.value;
      answerRecords.push({
        field,
        action: 'answer',
        value: answer.value,
        questionText: truncate(QUESTION_PROMPTS[field], 300),
        skipped: false,
        createdAt: now,
      });
    });

    const nextInput = input as IntakeInput;
    for (const [key, value] of Object.entries(nextInput)) {
      const schema = properties[key];
      if (schema === undefined) {
        issues.push({ path: `/input/${key}`, message: `unknown intake field ${key}` });
        continue;
      }
      const valid =
        key === 'dueAt'
          ? typeof value === 'string' && isInstant(value)
          : Value.Check(schema, value);
      if (!valid) {
        issues.push({ path: `/input/${key}`, message: `invalid value for ${key}` });
      }
    }
    if (issues.length > 0) throw new ValidationFailedError(issues);

    const previous = [...(await this.#sessions.listAnswers(ownerId, id)), ...answerRecords];
    const plan = planQuestions({
      known: nextInput,
      previousAnswers: toDomainAnswers(previous),
      askedFields: previous.map((answer) => answer.field as IntakeField),
      round: session.round,
      maxPerRound: this.#config.questions.maxPerRound,
    });

    const proceed = requiredMissing(nextInput, previous).length === 0 || plan.exhausted;
    let next: IntakeSessionUpdate;
    try {
      if (proceed) {
        const result = transition(session.state, { type: 'proceed_with_defaults' });
        next = { state: result.state, input: nextInput };
      } else {
        // The domain machine has no clarification->clarification event; a
        // partial round stays in the same legal state and advances the round.
        next = {
          state: session.state,
          input: nextInput,
          round: Math.min(session.round + 1, MAX_QUESTION_ROUNDS),
        };
      }
    } catch {
      throw IntakeError.illegalTransition(session.state, 'user_answered');
    }

    let updated = await this.#sessions.appendAnswersAndUpdate(
      ownerId,
      id,
      answerRecords,
      next,
      session.version,
    );
    if (updated.state === 'decomposition') {
      updated = await this.#generateDraft(updated, previous, run);
    }
    return this.#toDto(updated);
  }

  async confirmType(
    ownerId: Id,
    id: Id,
    confirmation: IntakeTypeConfirmation,
    expectedVersion: number,
  ): Promise<IntakeSessionDto> {
    return this.#withAiRun(ownerId, id, (run) =>
      this.#confirmType(ownerId, id, confirmation, expectedVersion, run),
    );
  }

  async #confirmType(
    ownerId: Id,
    id: Id,
    confirmation: IntakeTypeConfirmation,
    expectedVersion: number,
    run: AiRunContext,
  ): Promise<IntakeSessionDto> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state !== 'type_detection') {
      throw IntakeError.illegalTransition(session.state, 'type_confirmation');
    }
    const answers = await this.#sessions.listAnswers(ownerId, id);
    const missing = requiredMissing(session.input, answers);

    if (confirmation.similar) {
      const template = await this.#templates.get(ownerId, confirmation.templateId as Id);
      if (template === null) throw new NotFoundError('task template', confirmation.templateId);
      const result = transition(session.state, {
        type: 'type_detected',
        classification: 'similar',
        similarConfirmed: true,
        missingRequired: missing,
      });
      let updated = await this.#sessions.update(
        ownerId,
        id,
        { state: result.state, templateId: template.id as Id },
        session.version,
      );
      if (updated.state === 'decomposition') {
        updated = await this.#generateDraft(updated, answers, run);
      }
      return this.#toDto(updated);
    }

    const previousTemplateId = session.detectedType?.templateId;
    if (previousTemplateId !== undefined) {
      await this.#templates.incrementFalsePositive(ownerId, previousTemplateId as Id);
    }
    const result = transition(session.state, {
      type: 'type_detected',
      classification: 'similar',
      similarConfirmed: false,
      missingRequired: missing,
    });
    const detected: IntakeDetectedType = {
      classification: 'new',
      confidence: 1,
      reasons: [
        ...(session.detectedType?.reasons ?? []),
        'user_rejected_similarity',
      ].slice(0, 10),
      missingRequired: missing,
    };
    const updated = await this.#sessions.update(
      ownerId,
      id,
      { state: result.state, detectedType: detected, templateId: null },
      session.version,
    );
    return this.#toDto(updated);
  }

  async getDraft(ownerId: Id, id: Id): Promise<DraftResult> {
    const session = await this.#requireSession(ownerId, id);
    const stored = await this.#agentRuns.loadDraft(ownerId, id);
    if (stored === null) throw new NotFoundError('decomposition draft', id);
    return { draft: stored.draft, version: session.version };
  }

  async patchDraft(
    ownerId: Id,
    id: Id,
    patch: DecompositionDraftPatch,
    expectedVersion: number,
  ): Promise<DraftResult> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state !== 'decomposition') {
      throw IntakeError.illegalTransition(session.state, 'draft_edited');
    }
    const stored = await this.#agentRuns.loadDraft(ownerId, id);
    if (stored === null) throw new NotFoundError('decomposition draft', id);

    const candidate: DecompositionDraft = {
      steps: (patch.steps ?? stored.draft.steps) as readonly DecompositionStep[],
      assumptions: patch.assumptions ?? stored.draft.assumptions,
      questionsRemaining: patch.questionsRemaining ?? stored.draft.questionsRemaining,
    };
    const validation = validateDecomposition(candidate);
    const blocking = validation.issues.filter((issue) => issue.code !== 'hallucinated_ref');
    if (blocking.length > 0) {
      throw new ValidationFailedError(
        blocking.map((issue) => ({ path: issue.stepKey ?? '/steps', message: issue.message })),
      );
    }

    const evidence = evidenceForSteps(stored.draft.evidence, validation.draft.steps);
    const draft: DecompositionDraftDto = {
      ...(validation.draft as DecompositionDraftDto),
      ...(evidence === undefined ? {} : { evidence }),
    };
    const updated = await this.#sessions.patchDraftAndUpdate(
      ownerId,
      id,
      {
        draft,
        schemaOk: true,
        policyOk: !validation.splitRequested,
        constraintOk: validation.issues.length === 0,
        issues: validation.issues.map((issue) => ({ code: issue.code, message: issue.message })),
        editedEstimateKeys: editedEstimateKeys(
          stored.draft.steps,
          (validation.draft as DecompositionDraftDto).steps,
          stored.editedEstimateKeys,
        ),
      },
      expectedVersion,
    );
    return { draft, version: updated.version };
  }

  async approveDraft(
    ownerId: Id,
    id: Id,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ApprovalResult> {
    // Ownership/404 before locking so one owner cannot contend on another's
    // session. The lock is acquired before re-reading the version: whichever
    // of approval and a session mutation reaches the lock first wins.
    const initial = await this.#requireSession(ownerId, id);
    this.#assertVersion(initial, expectedVersion);
    if (initial.state !== 'decomposition') {
      throw IntakeError.illegalTransition(initial.state, 'draft_approved');
    }

    const lock = await this.#approvalLock.tryAcquire(ownerId, id);
    if (lock === null) {
      throw new IntakeError(
        409,
        'approval_in_progress',
        'Approval in progress',
        'another approval for this intake session is in progress',
      );
    }

    // ADR-020 §6: the lock connection is the approval's ownership fence. Every
    // provider call and ledger write checks it first and aborts on loss.
    const assertOwned = (): void => {
      if (lock.signal.aborted) throw new IntakeApprovalOwnershipLostError();
    };

    // ADR-020 §9: fence every provider request with the lock-loss signal plus
    // the ambient request/shutdown signal, and renew the holder CAS (touch)
    // immediately before each HTTP request (ADR-020 §10).
    const ambientSignal = currentAbortSignal();
    const approvalSignal =
      ambientSignal === undefined
        ? lock.signal
        : AbortSignal.any([lock.signal, ambientSignal]);
    let fenceHolder: string | undefined;
    const runFenced = <T>(callback: () => Promise<T>): Promise<T> =>
      runWithAbortSignal(approvalSignal, () =>
        runWithProviderRequestGuard(
          {
            signal: approvalSignal,
            beforeRequest: async () => {
              if (fenceHolder !== undefined) {
                await this.#approvals.touch(ownerId, id, fenceHolder);
              }
            },
          },
          callback,
        ),
      );

    try {
      return await runFenced(async () => {
        assertOwned();
        const session = await this.#requireSession(ownerId, id);
        this.#assertVersion(session, expectedVersion);
        if (session.state !== 'decomposition') {
          throw IntakeError.illegalTransition(session.state, 'draft_approved');
        }
        const stored = await this.#agentRuns.loadDraft(ownerId, id);
        if (stored === null) throw new NotFoundError('decomposition draft', id);

        const validation = validateDecomposition(stored.draft as DecompositionDraft);
        const blocking = validation.issues.filter((issue) => issue.code !== 'hallucinated_ref');
        if (blocking.length > 0) {
          throw new ValidationFailedError(
            blocking.map((issue) => ({ path: issue.stepKey ?? '/steps', message: issue.message })),
          );
        }

        const ordered = topoSortSteps(validation.draft.steps);
        const proposedSteps = ordered.map((step) => ({
          stepKey: step.key,
          plannedTaskId: this.#ids.next(),
        }));
        const holderToken = this.#ids.next();

        assertOwned();
        const begun = await this.#approvals.begin({
          ownerId,
          sessionId: id,
          expectedVersion,
          idempotencyKey,
          leaseMs: 60_000,
          holderToken,
          providerMaxCallMs: this.#providerMaxCallMs,
          steps: proposedSteps,
        });
        if (begun.kind === 'not_found') throw new NotFoundError('intake session', id);
        if (begun.kind === 'version_conflict') {
          throw new VersionConflictError(expectedVersion as Version, begun.actualVersion as Version);
        }
        if (begun.kind === 'illegal_state') {
          throw IntakeError.illegalTransition(begun.state, 'draft_approved');
        }
        if (begun.kind === 'in_progress') {
          // ADR-020 §7: previous holder may still have a provider call in flight.
          // The lock was just acquired; release it in `finally`.
          throw new IntakeError(
            409,
            'approval_in_progress',
            'Approval in progress',
            'the previous approver may still be finishing a provider call',
            { 'Retry-After': String(begun.retryAfterSeconds) },
            true,
          );
        }
        if (begun.kind === 'completed') {
          const approval = await this.#approvals.load(ownerId, id);
          const tasks: { id: Id; version: Version }[] = [];
          for (const approvalStep of approval?.steps ?? []) {
            if (approvalStep.taskId === undefined) continue;
            assertOwned();
            const task = await this.#tasks.get(ownerId, approvalStep.taskId);
            if (task !== null) tasks.push({ id: task.id, version: task.version });
          }
          return { session: await this.#toDto(begun.session), tasks };
        }

        const holder = begun.approval.holderToken ?? holderToken;
        fenceHolder = holder;
        const approvalSteps = new Map(
          begun.approval.steps.map((step) => [step.stepKey, step] as const),
        );
        const taskIds = new Map<string, Id>();
        const created: { id: Id; version: Version }[] = [];
        const identityTasks: Task[] = [];
        // ADR-020 §3: the ledger's persisted planned_task_id is authoritative on
        // every retry; never substitute the freshly generated proposal above.
        const plannedIdByKey = new Map(
          begun.approval.steps.map((step) => [step.stepKey, step.plannedTaskId] as const),
        );
        const priority = (session.input.priority ?? 3) as TaskPriority;
        const maxFocus = session.input.maxFocusMinutes;

        // ADR-020 §6/§7: timestamp + verify ownership immediately before every
        // provider call. A lost lock surfaces as IntakeApprovalOwnershipLostError.
        const beforeProviderCall = async (): Promise<void> => {
          assertOwned();
          await this.#approvals.touch(ownerId, id, holder);
          assertOwned();
        };

        try {
          for (const step of ordered) {
            const plannedTaskId = plannedIdByKey.get(step.key);
            if (plannedTaskId === undefined) continue;
            const existingStep = approvalSteps.get(step.key);
            const skipped =
              existingStep?.state === 'unknown' &&
              existingStep.dependencyState === 'skipped:vanished';
            if (skipped) {
              // M3-04c probe I: a created step whose provider task was deleted
              // is skipped permanently instead of being recreated. Its
              // dependency state records why; no estimate is written for it.
              continue;
            }
            if (existingStep?.state === 'created' && existingStep.taskId !== undefined) {
              const identity = await this.#tasks.get(ownerId, existingStep.taskId);
              assertOwned();
              if (identity === null) {
                await this.#approvals.markStep(
                  ownerId,
                  id,
                  step.key,
                  { state: 'unknown', dependencyState: 'skipped:vanished' },
                  holder,
                );
                continue;
              }
              taskIds.set(step.key, existingStep.taskId);
              created.push({ id: existingStep.taskId, version: identity.version });
              identityTasks.push(identity);
              continue;
            }

            const dependsOn = step.dependsOn
              .map((ref) => taskIds.get(ref))
              .filter((taskId): taskId is Id => taskId !== undefined);
            const dependencyState =
              dependsOn.length === step.dependsOn.length
                ? 'satisfied'
                : `missing:${step.dependsOn.filter((ref) => !taskIds.has(ref)).join(',')}`;
            if (dependsOn.length !== step.dependsOn.length) {
              assertOwned();
              await this.#approvals.markStep(
                ownerId,
                id,
                step.key,
                { state: 'unknown', dependencyState },
                holder,
              );
              throw new ValidationFailedError(
                step.dependsOn
                  .filter((ref) => !taskIds.has(ref))
                  .map((ref) => ({ path: step.key, message: `missing dependency ${ref}` })),
              );
            }

            await beforeProviderCall();
            const existing = await this.#tasks.get(ownerId, plannedTaskId);
            assertOwned();
            if (existing !== null) {
              // ADR-020 §8: a mapping can exist even when its relation writes
              // failed. Repair the intended dependencies before marking created.
              const missingRelations = dependsOn.filter(
                (dependencyId) => !existing.dependsOn.includes(dependencyId),
              );
              let repaired = existing;
              if (missingRelations.length > 0) {
                await beforeProviderCall();
                repaired = await this.#tasks.update(
                  ownerId,
                  plannedTaskId,
                  { dependsOn },
                  existing.version,
                );
                assertOwned();
              }
              assertOwned();
              await this.#approvals.markStep(
                ownerId,
                id,
                step.key,
                { state: 'created', taskId: repaired.id },
                holder,
              );
              taskIds.set(step.key, repaired.id);
              // Publish the post-update version so the outbox event does not
              // carry the pre-repair version (M2-03cR2 LOW).
              created.push({ id: repaired.id, version: repaired.version });
              identityTasks.push(repaired);
              continue;
            }

            // Mark unknown before the provider call: if ownership is lost while
            // the create is in flight, the row stays resolvable on retry.
            assertOwned();
            await this.#approvals.markStep(
              ownerId,
              id,
              step.key,
              { state: 'unknown', dependencyState },
              holder,
            );

            const input: TaskCreate = {
              title: step.title,
              description: truncate(
                `Goal: ${session.input.title}\n\n${step.deliverable}\n\nDone when: ${step.doneCriteria}`,
                2_000,
              ),
              priority,
              splittable: step.splittable,
              dependsOn,
              ...(session.input.dueAt === undefined
                ? {}
                : { dueAt: session.input.dueAt as Instant }),
              ...(maxFocus === undefined
                ? {}
                : { session: { minMinutes: Math.min(15, maxFocus), maxMinutes: maxFocus } }),
            };
            await beforeProviderCall();
            const task = await this.#tasks.create(
              ownerId,
              input,
              `intake-approval:${id}:${step.key}`,
              { plannedId: plannedTaskId },
            );
            assertOwned();
            await this.#approvals.markStep(
              ownerId,
              id,
              step.key,
              { state: 'created', taskId: task.id, dependencyState },
              holder,
            );
            taskIds.set(step.key, task.id);
            created.push({ id: task.id, version: task.version });
            identityTasks.push(task);
          }
        } catch (error) {
          // Ownership loss is not recoverable by this request: leave the
          // in-flight step unknown and perform no further ledger writes.
          if (error instanceof IntakeApprovalOwnershipLostError) throw error;
          assertOwned();
          if (error instanceof ValidationFailedError) {
            await this.#approvals.fail(ownerId, id, holder);
            throw error;
          }
          const stepKey = ordered.find((step) => !taskIds.has(step.key))?.key;
          if (stepKey !== undefined) {
            await this.#approvals.markStep(
              ownerId,
              id,
              stepKey,
              { state: 'unknown' },
              holder,
            );
          }
          await this.#approvals.fail(ownerId, id, holder);
          throw error instanceof IntakeError
            ? error
            : new IntakeError(
                503,
                'provider_unavailable',
                'Provider unavailable',
                'task creation failed; approval can be retried',
              );
        }

        assertOwned();
        // 05 §6 cold start: a confirmed template (or the manual/no-LLM path,
        // which has always been recorded as template) is the template prior;
        // otherwise the LLM estimate is inflated x1.3 with confidence <= 0.3.
        const generatedMethod =
          session.manual || this.#llm === null || session.templateId !== undefined
            ? 'template'
            : 'llm';
        const edited = new Set(stored.editedEstimateKeys);
        const uniqueIdentityTasks = [
          ...new Map(identityTasks.map((task) => [task.id, task])).values(),
        ];
        // M3-04c probe I: estimates may only reference tasks whose planner
        // identity rows are actually written in the same TX. Vanished created
        // steps stay skipped (see above) and contribute no estimate.
        const identityIds = new Set(uniqueIdentityTasks.map((task) => task.id));
        const estimates = ordered.flatMap((step) => {
          const taskId = taskIds.get(step.key);
          if (taskId === undefined || !identityIds.has(taskId)) return [];
          // FU-48: a user-edited estimate is the user's own statement and is
          // recorded as `personal` (04 §2 method enum) at the edited value,
          // not as the generator's method. Every value lands on the 5-minute
          // scheduler grid (a non-grid requirement can never be placed).
          const interval = {
            p50Min: step.estimate.p50Minutes,
            p90Min: step.estimate.p90Minutes,
          };
          const estimate = edited.has(step.key)
            ? coldStartEstimate({ user: interval })
            : generatedMethod === 'template'
              ? coldStartEstimate({
                  template: interval,
                  ...(session.templateId === undefined ? {} : { templateId: session.templateId }),
                })
              : coldStartEstimate({ llm: interval });
          return [
            {
              id: this.#ids.next(),
              taskId,
              p50Min: estimate.p50Min,
              p90Min: estimate.p90Min,
              method: estimate.method as 'template' | 'llm' | 'personal',
              confidence: estimate.confidence,
            } as const,
          ];
        });
        let updated;
        try {
          updated = await this.#approvals.complete({
            ownerId,
            sessionId: id,
            expectedSessionVersion: session.version,
            outboxId: this.#ids.next(),
            holderToken: holder,
            identityTasks: uniqueIdentityTasks,
            estimates,
          });
        } catch (error) {
          // A cross-owner id collision surfaces as estimate_task_fk (23503)
          // inside complete(). Persist a failed approval and a stored 409;
          // never leak the raw 500 (probe J).
          if (isPgForeignKeyViolation(error)) {
            await this.#approvals.fail(ownerId, id, holder).catch(() => undefined);
            throw new IntakeError(
              409,
              'illegal_transition',
              'Approval cannot be completed',
              'a task id conflicts with another owner; the approval was failed and can be retried',
            );
          }
          throw error;
        }
        return { session: await this.#toDto(updated), tasks: created };
      });
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async pause(ownerId: Id, id: Id, expectedVersion: number): Promise<IntakeSessionDto> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state !== 'clarification') {
      throw IntakeError.illegalTransition(session.state, 'user_requested_more_time');
    }
    const result = transition(session.state, { type: 'user_requested_more_time' });
    const updated = await this.#sessions.update(
      ownerId,
      id,
      { state: result.state },
      session.version,
    );
    return this.#toDto(updated);
  }

  async resume(ownerId: Id, id: Id, expectedVersion: number): Promise<IntakeSessionDto> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (await this.#isInterruptedDecomposition(session)) {
      return this.#withAiRun(ownerId, id, (run) => this.#retryDecomposition(session, run));
    }
    if (session.state !== 'needs_input') {
      throw IntakeError.illegalTransition(session.state, 'user_answered');
    }
    const result = transition(session.state, { type: 'user_answered' });
    const updated = await this.#sessions.update(
      ownerId,
      id,
      { state: result.state },
      session.version,
    );
    return this.#toDto(updated);
  }

  async cancel(ownerId: Id, id: Id, expectedVersion: number): Promise<IntakeSessionDto> {
    let session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    // FU-76: cancelling the session also stops its in-flight AI run.
    if ((await this.#aiRuns.cancel(ownerId, id)) !== 'none') {
      session = await this.#requireSession(ownerId, id);
    }
    let state: IntakeState;
    try {
      state = transition(session.state, { type: 'user_cancelled' }).state;
    } catch {
      throw IntakeError.illegalTransition(session.state, 'user_cancelled');
    }
    const updated = await this.#sessions.update(ownerId, id, { state }, session.version);
    return this.#toDto(updated);
  }

  async enterManual(ownerId: Id, id: Id, expectedVersion: number): Promise<IntakeSessionDto> {
    let session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state === 'cancelled' || session.state === 'failed') {
      throw IntakeError.illegalTransition(session.state, 'enter_manual_mode');
    }
    // FU-76: 취소 / 직접 작성으로 계속 while the AI works. Abort the session's
    // in-flight run and wait (bounded) until it has settled its spend and
    // recorded agent_run `cancelled`; then continue from its final state.
    const cancelled = await this.#aiRuns.cancel(ownerId, id);
    if (cancelled !== 'none') {
      session = await this.#requireSession(ownerId, id);
      if (session.state === 'cancelled' || session.state === 'failed') {
        throw IntakeError.illegalTransition(session.state, 'enter_manual_mode');
      }
    }
    let updated = await this.#sessions.update(
      ownerId,
      id,
      { manual: true, error: cancelled === 'cancelled' ? { ...AI_CANCELLED_ERROR } : null },
      session.version,
    );
    if (updated.state === 'type_detection') {
      const detected: IntakeDetectedType = {
        classification: 'new',
        confidence: 1,
        reasons: ['manual_mode'],
        missingRequired: requiredMissing(updated.input, []),
      };
      updated = await this.#sessions.update(
        ownerId,
        id,
        {
          state: transition(updated.state, {
            type: 'type_detected',
            classification: 'new',
            missingRequired: detected.missingRequired,
          }).state,
          detectedType: detected,
        },
        updated.version,
      );
    } else if (updated.state === 'decomposition') {
      const stored = await this.#agentRuns.loadDraft(ownerId, id);
      if (stored === null) updated = await this.#generateDraft(updated, []);
    }
    return this.#toDto(updated);
  }

  /** FU-76: a decomposition that shutdown/crash interrupted and nothing is running. */
  async #isInterruptedDecomposition(session: IntakeSessionRecord): Promise<boolean> {
    if (session.state !== 'decomposition' || session.manual) return false;
    if (session.error?.code !== AI_INTERRUPTED_CODE) return false;
    if (this.#aiRuns.isRunning(session.ownerId, session.id)) return false;
    return (await this.#agentRuns.loadDraft(session.ownerId, session.id)) === null;
  }

  /** FU-76 "다시 시도": POST :resume re-runs an interrupted decomposition (one new charge). */
  async #retryDecomposition(
    session: IntakeSessionRecord,
    run: AiRunContext,
  ): Promise<IntakeSessionDto> {
    const cleared = await this.#sessions.update(
      session.ownerId,
      session.id,
      { error: null },
      session.version,
    );
    const answers = await this.#sessions.listAnswers(session.ownerId, session.id);
    return this.#toDto(await this.#generateDraft(cleared, answers, run));
  }

  async #requireSession(ownerId: Id, id: Id): Promise<IntakeSessionRecord> {
    const session = await this.#sessions.get(ownerId, id);
    if (session === null) throw new NotFoundError('intake session', id);
    return session;
  }

  #assertVersion(session: IntakeSessionRecord, expected: number): void {
    if (session.version !== expected) {
      throw new VersionConflictError(expected as Version, session.version as Version);
    }
  }

  async #runDetectionLlm(
    ownerId: Id,
    sessionId: Id,
    input: IntakeInput,
    templates: readonly TaskTemplate[],
    run: AiRunContext,
  ): Promise<DetectionLlmOutput> {
    const llm = this.#llm;
    if (llm === null) throw new LlmUnavailable('no LLM provider configured');
    const bundle = buildDetectionLlmInput(input, templates);
    const promptIdVersion = `${TYPE_DETECTION_PROMPT.promptId}@${TYPE_DETECTION_PROMPT.version}`;
    // FU-76: the run exists (pending) before the call, so a crash leaves a row
    // the startup sweep can cancel instead of an unaccounted call.
    const runId = await this.#startRun({
      ownerId,
      purpose: 'detect_type',
      promptIdVersion,
      redactionReport: bundle.redactionReport,
    });
    try {
      const result = await runStructured(
        llm,
        {
          ...TYPE_DETECTION_PROMPT,
          input: bundle.input,
          schemaId: TYPE_DETECTION_SCHEMA,
          ownerId,
          sessionKey: sessionId,
        },
        this.#runOptions(TYPE_DETECTION_PROMPT.promptId, run.handle.signal),
      );
      await this.#completeRun(ownerId, runId, {
        model: result.model,
        provider: result.provider ?? this.#llmProvider,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        costUsd: result.usage.costUsd ?? 0,
        latencyMs: result.latencyMs,
        status: 'succeeded',
      });
      return result.output as DetectionLlmOutput;
    } catch (error) {
      if (run.handle.abortCause() !== undefined) run.cancelled = true;
      const usage = usageFromError(error);
      await this.#completeRun(ownerId, runId, {
        model: 'unknown',
        provider: this.#llmProvider,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costUsd: usage.costUsd ?? 0,
        latencyMs: 0,
        status: run.cancelled ? 'cancelled' : runStatus(error),
      });
      throw error;
    }
  }

  async #generateDraft(
    session: IntakeSessionRecord,
    answers: readonly IntakeAnswerRecord[],
    run?: AiRunContext,
  ): Promise<IntakeSessionRecord> {
    const plan = planQuestions({
      known: session.input,
      previousAnswers: toDomainAnswers(answers),
      askedFields: answers.map((answer) => answer.field as IntakeField),
      round: session.round,
      maxPerRound: this.#config.questions.maxPerRound,
    });
    const assumptionText = plan.assumptions.map(
      (assumption) => `${assumption.field}=${assumption.value}`,
    );

    if (session.manual || this.#llm === null) {
      const draft = manualDraft(session.input, assumptionText);
      await this.#saveManualDraft(session.ownerId, session.id, draft);
      if (!session.manual) {
        return this.#sessions.update(
          session.ownerId,
          session.id,
          { manual: true },
          session.version,
        );
      }
      return session;
    }
    if (run === undefined) {
      return this.#withAiRun(session.ownerId, session.id, (inner) =>
        this.#generateDraft(session, answers, inner),
      );
    }

    const template =
      session.templateId === undefined
        ? undefined
        : (await this.#templates.get(session.ownerId, session.templateId)) ?? undefined;
    const noteContext = await this.#noteContext(session);
    const bundle = buildDecompositionLlmInput(session.input, template, noteContext);
    const prompt = noteContext === undefined ? DECOMPOSITION_PROMPT : GROUNDED_DECOMPOSITION_PROMPT;
    const schemaId =
      noteContext === undefined ? DECOMPOSITION_SCHEMA : GROUNDED_DECOMPOSITION_SCHEMA;
    const promptIdVersion = `${prompt.promptId}@${prompt.version}`;
    const llm = this.#llm;
    if (llm === null) throw new LlmUnavailable('no LLM provider configured');
    // Fired by the provider adapter only when the prompt actually leaves the
    // process (never for a call refused by the consent/budget gate).
    let dispatched = false;
    let result: RunStructuredResult;
    // FU-76: pending before the call; settled below whatever the outcome.
    const runId = await this.#startRun({
      ownerId: session.ownerId,
      purpose: 'decomposition',
      promptIdVersion,
      redactionReport: bundle.redactionReport,
    });
    try {
      result = await runStructured(
        llm,
        {
          ...prompt,
          input: bundle.input,
          schemaId,
          ownerId: session.ownerId,
          sessionKey: session.id,
          onDispatch: () => {
            dispatched = true;
          },
        },
        this.#runOptions(prompt.promptId, run.handle.signal),
      );
    } catch (error) {
      const cause = run.handle.abortCause();
      if (cause !== undefined) run.cancelled = true;
      const usage = usageFromError(error);
      await this.#completeRun(session.ownerId, runId, {
        model: 'unknown',
        provider: this.#llmProvider,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costUsd: usage.costUsd ?? 0,
        latencyMs: 0,
        status: cause === undefined ? runStatus(error) : 'cancelled',
      });
      // A failed call can still have sent the note sections (timeout, 5xx,
      // schema violation, abort); record them so the history stays complete.
      await this.#recordNoteUsage(session.ownerId, runId, noteContext, dispatched);
      if (cause === 'user_cancelled') {
        // POST :manual aborted the run and takes over (manual draft +
        // ai_cancelled) as soon as this request has settled.
        return session;
      }
      if (cause === 'shutdown') {
        // Recoverable after restart: no draft, error ai_interrupted, and
        // POST :resume ("다시 시도") re-runs the decomposition.
        return this.#sessions.update(
          session.ownerId,
          session.id,
          { error: { ...AI_INTERRUPTED_ERROR } },
          session.version,
        );
      }
      const draft = manualDraft(session.input, assumptionText);
      const updated = await this.#saveManualDraft(session.ownerId, session.id, draft, session);
      if (error instanceof BudgetExceeded) throw IntakeError.budgetExceeded(error.message);
      return updated;
    }

    // Success path: persistence failures here surface as errors instead of
    // being mistaken for an LLM failure (no second agent_run, no manual draft).
    await this.#completeRun(session.ownerId, runId, {
      model: result.model,
      provider: result.provider ?? this.#llmProvider,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      costUsd: result.usage.costUsd ?? 0,
      latencyMs: result.latencyMs,
      status: 'succeeded',
    });
    await this.#recordNoteUsage(session.ownerId, runId, noteContext, dispatched);

    let output = result.output as DecompositionLlmOutput;
    let evidence: DecompositionEvidenceDto[] | undefined;
    const groundingIssues: { code: string; message: string }[] = [];
    const groundingRefs: string[] = [];
    if (noteContext !== undefined) {
      const grounded = sanitizeGroundedDecomposition(
        result.output as GroundedDecompositionOutput,
        groundingIndexOf(noteContext),
      );
      output = {
        steps: grounded.output.steps as readonly DecompositionStep[],
        assumptions: grounded.output.assumptions,
        questionsRemaining: grounded.output.questionsRemaining,
      };
      const updatedAt = new Map(
        noteContext.documents.map((doc) => [doc.docId, doc.updatedAt] as const),
      );
      evidence = grounded.output.evidence.map((item) => ({
        kind: item.kind,
        statement: item.statement,
        source: { kind: 'note' as const, docId: item.docId, sectionHash: item.sectionHash },
        stepKeys: [...item.stepKeys],
        updatedAt: updatedAt.get(item.docId) ?? this.#clock.now(),
      }));
      const counts: Record<string, number> = {};
      for (const issue of grounded.hallucinatedRefs) {
        counts[issue.reason] = (counts[issue.reason] ?? 0) + 1;
        groundingRefs.push(issue.ref);
        groundingIssues.push({
          code: 'hallucinated_ref',
          message: `evidence ${issue.evidenceIndex} cites an ${issue.reason.replace('_', ' ')}; reference removed`,
        });
      }
      if (grounded.linksRemoved > 0) {
        groundingIssues.push({
          code: 'untrusted_link_removed',
          message: `${grounded.linksRemoved} link(s) removed from note-grounded output`,
        });
      }
      if (grounded.hallucinatedRefs.length > 0 && this.#notes !== undefined) {
        await this.#notes.recordHallucinatedRefs({
          id: this.#ids.next(),
          ownerId: session.ownerId,
          agentRunId: runId,
          counts,
        });
      }
    }

    const validation = validateDecomposition(output);
    const draft: DecompositionDraftDto = {
      ...(validation.draft as DecompositionDraftDto),
      ...(evidence === undefined ? {} : { evidence }),
    };
    await this.#agentRuns.saveDraft({
      id: this.#ids.next(),
      ownerId: session.ownerId,
      runId,
      kind: draftKind(session.id),
      payload: {
        draft,
        issues: [
          ...validation.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
          })),
          ...groundingIssues,
        ],
        hallucinatedRefs: [...validation.hallucinatedRefs, ...groundingRefs],
      } as unknown as import('../../db/types.js').JsonValue,
      schemaOk: true,
      policyOk: !validation.splitRequested,
      constraintOk: validation.issues.length === 0,
      decision: 'pending',
    });
    return session;
  }

  /**
   * M6-01: notes linked to the session goal that may be sent (live,
   * llm_allowed, same owner), reduced to ranked, redacted, fenced sections.
   * `undefined` keeps the ungrounded decomposition@v1 path byte-identical.
   */
  async #noteContext(session: IntakeSessionRecord): Promise<NoteContextResult | undefined> {
    if (this.#notes === undefined || session.goalId === undefined) return undefined;
    const documents = await this.#notes.linkedForContext(
      session.ownerId,
      [{ kind: 'goal', id: session.goalId }],
      this.#noteLimits.maxDocuments,
    );
    if (documents.length === 0) return undefined;
    const context = buildNoteContext({
      ownerId: session.ownerId,
      query: intakeQueryText(session.input),
      documents,
      limits: this.#noteLimits,
    });
    return context.sections.length === 0 ? undefined : context;
  }

  async #recordNoteUsage(
    ownerId: Id,
    runId: Id,
    context: NoteContextResult | undefined,
    dispatched: boolean,
  ): Promise<void> {
    if (context === undefined || !dispatched || this.#notes === undefined) return;
    await this.#notes.recordUsage(
      { ownerId, agentRunId: runId, purpose: 'decomposition', entries: context.documents },
      () => this.#ids.next(),
    );
  }

  async #saveManualDraft(
    ownerId: Id,
    sessionId: Id,
    draft: DecompositionDraftDto,
    current?: IntakeSessionRecord,
  ): Promise<IntakeSessionRecord> {
    const runId = await this.#recordManualRun(ownerId);
    const validation = validateDecomposition(draft as DecompositionDraft);
    await this.#agentRuns.saveDraft({
      id: this.#ids.next(),
      ownerId,
      runId,
      kind: draftKind(sessionId),
      payload: {
        draft: validation.draft,
        issues: validation.issues.map((issue) => ({ code: issue.code, message: issue.message })),
        hallucinatedRefs: [...validation.hallucinatedRefs],
      } as unknown as import('../../db/types.js').JsonValue,
      schemaOk: true,
      policyOk: !validation.splitRequested,
      constraintOk: validation.issues.length === 0,
      decision: 'pending',
    });
    if (current !== undefined) {
      return this.#sessions.update(
        ownerId,
        sessionId,
        { manual: true },
        current.version,
      );
    }
    return this.#sessions.get(ownerId, sessionId) as Promise<IntakeSessionRecord>;
  }

  async #recordManualRun(ownerId: Id): Promise<Id> {
    const runId = this.#ids.next();
    await this.#agentRuns.recordRun({
      id: runId,
      ownerId,
      purpose: 'decomposition_manual',
      promptIdVersion: 'manual@1',
      model: 'deterministic',
      provider: 'none',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 0,
      status: 'succeeded',
      redactionReport: {},
    });
    return runId;
  }

  /** FU-76: an AI run starts `pending` (zero usage) and is settled by #completeRun. */
  async #startRun(input: {
    ownerId: Id;
    purpose: string;
    promptIdVersion: string;
    redactionReport: Readonly<Record<string, number>>;
  }): Promise<Id> {
    return this.#recordRun({
      ...input,
      model: 'unknown',
      provider: this.#llmProvider,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 0,
      status: 'pending',
    });
  }

  async #completeRun(ownerId: Id, runId: Id, completion: AgentRunCompletion): Promise<void> {
    await this.#agentRuns.completeRun(ownerId, runId, completion);
  }

  async #recordRun(input: {
    ownerId: Id;
    purpose: string;
    promptIdVersion: string;
    model: string;
    provider: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    status: AgentRunStatus;
    redactionReport: Readonly<Record<string, number>>;
  }): Promise<Id> {
    const id = this.#ids.next();
    await this.#agentRuns.recordRun({ id, ...input });
    return id;
  }

  async #toDto(session: IntakeSessionRecord): Promise<IntakeSessionDto> {
    const answers = await this.#sessions.listAnswers(session.ownerId, session.id);
    const plan = planQuestions({
      known: session.input,
      previousAnswers: toDomainAnswers(answers),
      askedFields: answers.map((answer) => answer.field as IntakeField),
      round: session.round,
      maxPerRound: this.#config.questions.maxPerRound,
    });
    const stored = DRAFT_STATES.has(session.state)
      ? await this.#agentRuns.loadDraft(session.ownerId, session.id)
      : null;
    return {
      id: session.id,
      ownerId: session.ownerId,
      ...(session.goalId === undefined ? {} : { goalId: session.goalId }),
      state: session.state,
      input: session.input,
      ...(session.detectedType === undefined ? {} : { detectedType: session.detectedType }),
      ...(session.templateId === undefined ? {} : { templateId: session.templateId }),
      round: session.round,
      manual: session.manual,
      ...(session.error === undefined ? {} : { error: session.error }),
      ...(session.state === 'clarification'
        ? {
            questions: plan.questions
              .slice(0, MAX_QUESTIONS_PER_ROUND)
              .map((question) => questionDto(question)),
            assumptions: plan.assumptions.map((assumption) => assumptionDto(assumption)),
          }
        : {}),
      ...(answers.length === 0 ? {} : { answers: answers.map((answer) => answerDto(answer)) }),
      ...(stored === null ? {} : { draft: stored.draft }),
      version: session.version,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}

function usageFromError(error: unknown): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
} {
  if (error instanceof LlmError && error.usage !== undefined) return error.usage;
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function runStatus(error: unknown): Exclude<AgentRunStatus, 'pending' | 'succeeded' | 'cancelled'> {
  if (error instanceof BudgetExceeded) return 'budget_exceeded';
  return 'failed';
}
