import type {
  DecompositionDraftDto,
  DecompositionDraftPatch,
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
  isIntakeState,
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
  type TaskCreate,
  type TaskPriority,
  type TaskRepository,
  type Version,
} from '@ohmydate/domain';
import {
  BudgetExceeded,
  LlmUnavailable,
  SchemaViolation,
  buildUntrustedBlock,
  redact,
  runStructured,
  type BudgetGuard,
  type LlmPort,
  type RedactionKind,
} from '@ohmydate/llm';
import { NotFoundError } from '@ohmydate/domain';
import { INTAKE_AGENT_CONFIG, type IntakeAgentConfig } from './config.js';
import { detectTypeDeterministic } from './detection.js';
import { IntakeError } from './intake-error.js';
import {
  draftKind,
  type AgentRunRepository,
  type AgentRunStatus,
  type IntakeAnswerRecord,
  type IntakeSessionRecord,
  type IntakeSessionRepository,
  type IntakeSessionUpdate,
  type StoredDraft,
  type TaskTemplateRepository,
} from './ports.js';

const TYPE_DETECTION_PROMPT = { promptId: 'type_detection', version: 'v1' } as const;
const DECOMPOSITION_PROMPT = { promptId: 'decomposition', version: 'v1' } as const;
const TYPE_DETECTION_SCHEMA = 'llm.type_detection.v1';
const DECOMPOSITION_SCHEMA = 'llm.decomposition.v1';

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
  /** `null` means no provider is configured: LLM-dependent steps notify manual mode. */
  readonly llm: LlmPort | null;
  readonly budgetGuard: BudgetGuard;
  readonly config?: IntakeAgentConfig;
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

function redactedTemplate(template: TaskTemplate, report: Record<string, number>): unknown {
  return redactValue(
    {
      id: template.id,
      name: template.name,
      source: template.source,
      confidence: template.confidence,
      steps: template.steps.map((step) => ({
        key: step.key,
        title: step.title,
        deliverable: step.deliverable,
        doneCriteria: step.doneCriteria,
        kind: step.kind,
      })),
    },
    report,
  );
}

function untrustedDocuments(input: IntakeInput, report: Record<string, number>): string[] {
  const documents: string[] = [];
  if (typeof input.deliverable === 'string' && input.deliverable.trim().length > 0) {
    const redacted = redact(input.deliverable);
    mergeRedaction(report, redacted.report);
    documents.push(buildUntrustedBlock('intake-deliverable', redacted.text));
  }
  if (typeof input.prerequisites === 'string' && input.prerequisites.trim().length > 0) {
    const redacted = redact(input.prerequisites);
    mergeRedaction(report, redacted.report);
    documents.push(buildUntrustedBlock('intake-prerequisites', redacted.text));
  }
  return documents;
}

/** Exported so tests can register the exact FakeLlm fixture input. */
export function buildDetectionLlmInput(
  input: IntakeInput,
  templates: readonly TaskTemplate[],
): LlmInputBundle {
  const report: Record<string, number> = {};
  const task = redactValue(input, report) as Record<string, unknown>;
  const documents = untrustedDocuments(input, report);
  return {
    input: {
      configVersion: INTAKE_AGENT_CONFIG.version,
      knownFields: Object.keys(input).sort(),
      task,
      candidates: templates.map((template) => redactedTemplate(template, report)),
      documents,
    },
    redactionReport: report,
  };
}

/** Exported so tests can register the exact FakeLlm fixture input. */
export function buildDecompositionLlmInput(
  input: IntakeInput,
  template: TaskTemplate | undefined,
): LlmInputBundle {
  const report: Record<string, number> = {};
  const task = redactValue(input, report) as Record<string, unknown>;
  const documents = untrustedDocuments(input, report);
  return {
    input: {
      configVersion: INTAKE_AGENT_CONFIG.version,
      task,
      template: template === undefined ? null : redactedTemplate(template, report),
      documents,
    },
    redactionReport: report,
  };
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
        title: truncate(input.deliverable ?? 'Complete the main deliverable', 120),
        deliverable: truncate(input.deliverable ?? 'Main deliverable', 300),
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
  readonly #llm: LlmPort | null;
  readonly #budgetGuard: BudgetGuard;
  readonly #config: IntakeAgentConfig;

  constructor(options: IntakeServiceOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#sessions = options.sessions;
    this.#templates = options.templates;
    this.#agentRuns = options.agentRuns;
    this.#tasks = options.tasks;
    this.#llm = options.llm;
    this.#budgetGuard = options.budgetGuard;
    this.#config = options.config ?? INTAKE_AGENT_CONFIG;
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
    let session = await this.#sessions.create({
      id: this.#ids.next(),
      ownerId,
      ...(body.goalId === undefined ? {} : { goalId: body.goalId as Id }),
      state: accepted.state,
      input: body.input,
      round: 1,
      manual: false,
      version: 1 as Version,
      createdAt: now,
      updatedAt: now,
    });

    const templates = await this.#templates.list(ownerId, { limit: 100 });
    const missing = requiredMissing(body.input, []);
    let detection = detectTypeDeterministic(body.input, templates.items, missing, this.#config);

    let manual = false;
    let error: IntakeErrorDto | undefined;
    let budgetFailure: IntakeError | undefined;
    let unavailableWithoutProvider = false;

    if (this.#llm === null) {
      manual = true;
      unavailableWithoutProvider = true;
      error = { code: 'llm_unavailable', message: 'no LLM provider configured; manual mode' };
    } else {
      try {
        const output = await this.#runDetectionLlm(ownerId, body.input, templates.items);
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
        if (caught instanceof BudgetExceeded) {
          budgetFailure = IntakeError.budgetExceeded(caught.message);
          error = { code: 'budget_exceeded', message: truncate(caught.message, 500) };
        } else if (caught instanceof SchemaViolation || caught instanceof LlmUnavailable) {
          const message =
            caught instanceof SchemaViolation
              ? 'LLM type detection did not match the schema after one repair; manual mode'
              : 'LLM unavailable; manual mode';
          error = { code: 'llm_unavailable', message };
        } else {
          throw caught;
        }
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

    if (budgetFailure !== undefined) throw budgetFailure;
    if (unavailableWithoutProvider) {
      throw IntakeError.llmUnavailable(
        'no LLM provider configured (set LLM_PROVIDER=fake); the session remains usable via :manual',
      );
    }
    return this.#toDto(session);
  }

  async get(ownerId: Id, id: Id): Promise<IntakeSessionDto> {
    return this.#toDto(await this.#requireSession(ownerId, id));
  }

  async submitAnswers(
    ownerId: Id,
    id: Id,
    request: IntakeAnswersRequest,
    expectedVersion: number,
  ): Promise<IntakeSessionDto> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state !== 'clarification') {
      throw IntakeError.illegalTransition(session.state, 'user_answered');
    }

    const input: Record<string, unknown> = { ...session.input };
    const answerRecords: IntakeAnswerRecord[] = [];
    const now = this.#clock.now();
    for (const answer of request.answers) {
      const field = answer.questionKey as IntakeField;
      if (answer.action === 'answer' && answer.value !== undefined) {
        input[field] = answer.value;
      }
      answerRecords.push({
        field,
        action: answer.action,
        ...(answer.value === undefined ? {} : { value: answer.value }),
        questionText: truncate(QUESTION_PROMPTS[field], 300),
        skipped: answer.action !== 'answer',
        createdAt: now,
      });
    }

    await this.#sessions.appendAnswers(ownerId, id, answerRecords);
    const previous = await this.#sessions.listAnswers(ownerId, id);
    const nextInput = input as IntakeInput;
    const plan = planQuestions({
      known: nextInput,
      previousAnswers: toDomainAnswers(previous),
      askedFields: previous.map((answer) => answer.field as IntakeField),
      round: session.round,
      maxPerRound: this.#config.questions.maxPerRound,
    });

    const proceed = plan.complete || plan.exhausted;
    let next: IntakeSessionUpdate;
    if (proceed) {
      const result = transition(session.state, { type: 'proceed_with_defaults' });
      next = { state: result.state, input: nextInput };
    } else {
      next = {
        state: transition(session.state, { type: 'user_answered' }).state,
        input: nextInput,
        round: Math.min(session.round + 1, MAX_QUESTION_ROUNDS),
      };
    }

    let updated = await this.#sessions.update(ownerId, id, next, session.version);
    if (updated.state === 'decomposition') {
      updated = await this.#generateDraft(updated, previous);
    }
    return this.#toDto(updated);
  }

  async confirmType(
    ownerId: Id,
    id: Id,
    confirmation: IntakeTypeConfirmation,
    expectedVersion: number,
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
        updated = await this.#generateDraft(updated, answers);
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

    await this.#agentRuns.updateDraft(ownerId, id, {
      draft: validation.draft as DecompositionDraftDto,
      schemaOk: true,
      policyOk: !validation.splitRequested,
      constraintOk: validation.issues.length === 0,
      issues: validation.issues.map((issue) => ({ code: issue.code, message: issue.message })),
    });
    const updated = await this.#sessions.update(ownerId, id, {}, session.version);
    return { draft: validation.draft as DecompositionDraftDto, version: updated.version };
  }

  async approveDraft(
    ownerId: Id,
    id: Id,
    expectedVersion: number,
  ): Promise<ApprovalResult> {
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
    const taskIds = new Map<string, Id>();
    const created: { id: Id; version: Version }[] = [];
    const priority = (session.input.priority ?? 3) as TaskPriority;
    const maxFocus = session.input.maxFocusMinutes;
    for (const step of ordered) {
      const dependsOn = step.dependsOn
        .map((ref) => taskIds.get(ref))
        .filter((taskId): taskId is Id => taskId !== undefined);
      const input: TaskCreate = {
        title: step.title,
        description: truncate(
          `${step.deliverable}\n\nDone when: ${step.doneCriteria}`,
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
      const task = await this.#tasks.create(
        ownerId,
        input,
        `intake:${session.id}:${step.key}`,
      );
      taskIds.set(step.key, task.id);
      created.push({ id: task.id, version: task.version });
    }

    const result = transition(session.state, { type: 'draft_approved' });
    const updated = await this.#sessions.update(
      ownerId,
      id,
      { state: result.state },
      session.version,
    );
    await this.#agentRuns.markDraftDecision(ownerId, id, 'approved');
    return { session: await this.#toDto(updated), tasks: created };
  }

  async pause(ownerId: Id, id: Id, expectedVersion: number): Promise<IntakeSessionDto> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state === 'cancelled' || session.state === 'failed' || session.state === 'needs_input') {
      throw IntakeError.illegalTransition(session.state, 'user_requested_more_time');
    }
    const updated = await this.#sessions.update(
      ownerId,
      id,
      {
        state: 'needs_input',
        error: { code: 'paused', message: `paused from ${session.state}` },
      },
      session.version,
    );
    return this.#toDto(updated);
  }

  async resume(ownerId: Id, id: Id, expectedVersion: number): Promise<IntakeSessionDto> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state !== 'needs_input') {
      throw IntakeError.illegalTransition(session.state, 'user_answered');
    }
    const previous = session.error?.code === 'paused' ? session.error.message : undefined;
    const restored =
      previous !== undefined && previous.startsWith('paused from ')
        ? previous.slice('paused from '.length)
        : undefined;
    const state = isIntakeState(restored) ? restored : 'clarification';
    const updated = await this.#sessions.update(
      ownerId,
      id,
      { state, error: null },
      session.version,
    );
    return this.#toDto(updated);
  }

  async cancel(ownerId: Id, id: Id, expectedVersion: number): Promise<IntakeSessionDto> {
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
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
    const session = await this.#requireSession(ownerId, id);
    this.#assertVersion(session, expectedVersion);
    if (session.state === 'cancelled' || session.state === 'failed') {
      throw IntakeError.illegalTransition(session.state, 'enter_manual_mode');
    }
    let updated = await this.#sessions.update(
      ownerId,
      id,
      { manual: true, error: null },
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
    input: IntakeInput,
    templates: readonly TaskTemplate[],
  ): Promise<DetectionLlmOutput> {
    const llm = this.#llm;
    if (llm === null) throw new LlmUnavailable('no LLM provider configured');
    const bundle = buildDetectionLlmInput(input, templates);
    try {
      const result = await runStructured(
        llm,
        {
          ...TYPE_DETECTION_PROMPT,
          input: bundle.input,
          schemaId: TYPE_DETECTION_SCHEMA,
        },
        { budgetGuard: this.#budgetGuard, estimatedCostUsd: 0 },
      );
      await this.#recordRun({
        ownerId,
        purpose: 'detect_type',
        promptIdVersion: `${TYPE_DETECTION_PROMPT.promptId}@${TYPE_DETECTION_PROMPT.version}`,
        model: result.model,
        provider: 'fake',
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        costUsd: result.usage.costUsd ?? 0,
        latencyMs: result.latencyMs,
        status: 'succeeded',
        redactionReport: bundle.redactionReport,
      });
      return result.output as DetectionLlmOutput;
    } catch (error) {
      await this.#recordRun({
        ownerId,
        purpose: 'detect_type',
        promptIdVersion: `${TYPE_DETECTION_PROMPT.promptId}@${TYPE_DETECTION_PROMPT.version}`,
        model: 'unknown',
        provider: 'fake',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: 0,
        status: runStatus(error),
        redactionReport: bundle.redactionReport,
      });
      throw error;
    }
  }

  async #generateDraft(
    session: IntakeSessionRecord,
    answers: readonly IntakeAnswerRecord[],
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

    const template =
      session.templateId === undefined
        ? undefined
        : (await this.#templates.get(session.ownerId, session.templateId)) ?? undefined;
    const bundle = buildDecompositionLlmInput(session.input, template);
    const llm = this.#llm;
    if (llm === null) throw new LlmUnavailable('no LLM provider configured');
    try {
      const result = await runStructured(
        llm,
        {
          ...DECOMPOSITION_PROMPT,
          input: bundle.input,
          schemaId: DECOMPOSITION_SCHEMA,
        },
        { budgetGuard: this.#budgetGuard, estimatedCostUsd: 0 },
      );
      const runId = await this.#recordRun({
        ownerId: session.ownerId,
        purpose: 'decomposition',
        promptIdVersion: `${DECOMPOSITION_PROMPT.promptId}@${DECOMPOSITION_PROMPT.version}`,
        model: result.model,
        provider: 'fake',
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        costUsd: result.usage.costUsd ?? 0,
        latencyMs: result.latencyMs,
        status: 'succeeded',
        redactionReport: bundle.redactionReport,
      });
      const output = result.output as DecompositionLlmOutput;
      const validation = validateDecomposition(output);
      await this.#agentRuns.saveDraft({
        id: this.#ids.next(),
        ownerId: session.ownerId,
        runId,
        kind: draftKind(session.id),
        payload: {
          draft: validation.draft,
          issues: validation.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
          })),
          hallucinatedRefs: [...validation.hallucinatedRefs],
        } as unknown as import('../../db/types.js').JsonValue,
        schemaOk: true,
        policyOk: !validation.splitRequested,
        constraintOk: validation.issues.length === 0,
        decision: 'pending',
      });
      return session;
    } catch (error) {
      await this.#recordRun({
        ownerId: session.ownerId,
        purpose: 'decomposition',
        promptIdVersion: `${DECOMPOSITION_PROMPT.promptId}@${DECOMPOSITION_PROMPT.version}`,
        model: 'unknown',
        provider: 'fake',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: 0,
        status: runStatus(error),
        redactionReport: bundle.redactionReport,
      });
      const draft = manualDraft(session.input, assumptionText);
      const updated = await this.#saveManualDraft(session.ownerId, session.id, draft, session);
      if (error instanceof BudgetExceeded) throw IntakeError.budgetExceeded(error.message);
      return updated;
    }
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

function runStatus(error: unknown): AgentRunStatus {
  if (error instanceof BudgetExceeded) return 'budget_exceeded';
  return 'failed';
}
