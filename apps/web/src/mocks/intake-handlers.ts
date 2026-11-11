import { HttpResponse, http } from 'msw';
import {
  OPTIONAL_INTAKE_FIELDS,
  REQUIRED_INTAKE_FIELDS,
  conservativeAssumptions,
  isFieldKnown,
  planQuestions,
  transition,
  validateDecomposition,
  type DecompositionDraft as DomainDraft,
  type IntakeAnswer as DomainAnswer,
  type IntakeField as DomainField,
  type PlannedQuestion as DomainQuestion,
} from '../../../../packages/domain/src/index.js';
import type {
  DecompositionDraft,
  DecompositionStep,
  IntakeAnswerInput,
  IntakeAssumption,
  IntakeField,
  IntakeInput,
  IntakeSession,
  IntakeSessionCreate,
  IntakeTypeConfirmation,
  PlannedQuestion,
  Task,
  TaskTemplate,
} from '../api/client';
import {
  etag,
  json,
  parseBody,
  parseIdempotency,
  parseIfMatch,
  problem,
  remember,
  rememberDomainResult,
} from './handlers';
import {
  REPORT_TEMPLATE_ID,
  createUuidV7,
  type MockDb,
  type MockIntakeSession,
} from './db';

const INTAKE_ACTIONS = ['answer', 'skip', 'idk'] as const;

function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'Authentication is required');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const ALL_INTAKE_FIELDS: readonly string[] = [...REQUIRED_INTAKE_FIELDS, ...OPTIONAL_INTAKE_FIELDS];

function isIntakeField(value: unknown): value is IntakeField {
  return typeof value === 'string' && ALL_INTAKE_FIELDS.includes(value);
}

function isProvided(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function missingRequired(input: IntakeInput): IntakeField[] {
  return REQUIRED_INTAKE_FIELDS.filter((field) => !isFieldKnown(field, input[field]));
}

function toQuestions(questions: readonly DomainQuestion[]): PlannedQuestion[] {
  return questions.map((question) => ({
    field: question.field,
    prompt: question.prompt,
    required: question.required,
    choices: ['answer', 'skip', 'idk'] as PlannedQuestion['choices'],
  }));
}

function toAssumptions(
  assumptions: readonly { field: DomainField; reason: 'skip' | 'idk' | 'unanswered'; value: string }[],
): IntakeAssumption[] {
  return assumptions.map((assumption) => ({
    field: assumption.field,
    reason: assumption.reason,
    value: assumption.value,
  }));
}

type SessionAnswer = NonNullable<IntakeSession['answers']>[number];

function toDomainAnswers(answers: readonly SessionAnswer[] | undefined): DomainAnswer[] {
  return (answers ?? []).map((answer) => ({
    field: answer.questionKey,
    action: answer.action,
    ...(answer.value === undefined ? {} : { value: answer.value }),
  }));
}

interface DraftStepShape {
  readonly key: string;
  readonly title: string;
  readonly deliverable: string;
  readonly doneCriteria: string;
  readonly kind: DecompositionStep['kind'];
  readonly estimate: { readonly p50Minutes: number; readonly p90Minutes: number };
  readonly dependsOn: readonly string[];
  readonly splittable: boolean;
}

function cloneSteps(steps: readonly DraftStepShape[]): DecompositionStep[] {
  return steps.map((step) => ({
    key: step.key,
    title: step.title,
    deliverable: step.deliverable,
    doneCriteria: step.doneCriteria,
    kind: step.kind,
    estimate: { p50Minutes: step.estimate.p50Minutes, p90Minutes: step.estimate.p90Minutes },
    dependsOn: [...step.dependsOn],
    splittable: step.splittable,
  }));
}

function genericSteps(title: string): DecompositionStep[] {
  const prefix = title.trim().length > 0 ? title.trim() : '새 작업';
  return [
    {
      key: 's1',
      title: '요구사항 정리',
      deliverable: `${prefix} 요구사항 메모`,
      doneCriteria: '필요한 결과물과 제약을 한 곳에 정리',
      kind: 'prep',
      estimate: { p50Minutes: 30, p90Minutes: 45 },
      dependsOn: [],
      splittable: true,
    },
    {
      key: 's2',
      title: '초안 작성',
      deliverable: `${prefix} 초안`,
      doneCriteria: '핵심 내용을 빠짐없이 작성',
      kind: 'work',
      estimate: { p50Minutes: 120, p90Minutes: 180 },
      dependsOn: ['s1'],
      splittable: true,
    },
    {
      key: 's3',
      title: '검토 및 수정',
      deliverable: `${prefix} 수정본`,
      doneCriteria: '검토 의견을 반영',
      kind: 'review',
      estimate: { p50Minutes: 30, p90Minutes: 45 },
      dependsOn: ['s2'],
      splittable: false,
    },
    {
      key: 's4',
      title: '마무리 버퍼',
      deliverable: `${prefix} 최종본`,
      doneCriteria: '제출 형식과 마감 확인',
      kind: 'buffer',
      estimate: { p50Minutes: 15, p90Minutes: 30 },
      dependsOn: ['s3'],
      splittable: false,
    },
  ];
}

function buildDraft(session: MockIntakeSession, db: MockDb): DecompositionDraft {
  const template =
    session.templateId === undefined ? undefined : db.templates.get(session.templateId);
  const steps =
    template === undefined
      ? genericSteps(String(session.input.title ?? ''))
      : cloneSteps(template.steps);
  const candidate: DomainDraft = {
    steps,
    assumptions: (session.assumptions ?? []).map(
      (assumption) => `${assumption.field}: ${assumption.value}`,
    ),
    questionsRemaining: [],
  };
  const validated = validateDecomposition(candidate);
  return {
    steps: cloneSteps(validated.draft.steps),
    assumptions: [...validated.draft.assumptions],
    questionsRemaining: [...validated.draft.questionsRemaining],
  };
}

function detectType(
  db: MockDb,
  input: IntakeInput,
): { classification: 'new' | 'similar'; templateId?: string; confidence: number; reasons: string[]; missingRequired: IntakeField[] } {
  const missing = missingRequired(input);
  const title = String(input.title ?? '');
  const template =
    db.templates.get(REPORT_TEMPLATE_ID) ??
    [...db.templates.values()].find((candidate) => candidate.name.includes('보고서'));
  if (template !== undefined && /보고서|report/i.test(title)) {
    return {
      classification: 'similar',
      templateId: template.id,
      confidence: template.confidence,
      reasons: ['태그: 보고서', '과거 작업 3건', '제목 유사도 높음'],
      missingRequired: missing,
    };
  }
  return {
    classification: 'new',
    confidence: 0.21,
    reasons: ['새 유형', '일치하는 템플릿 없음'],
    missingRequired: missing,
  };
}

function nextQuestions(session: MockIntakeSession, round: number): ReturnType<typeof planQuestions> {
  return planQuestions({
    known: session.input,
    previousAnswers: toDomainAnswers(session.answers),
    askedFields: session.askedFields,
    round,
    maxPerRound: 5,
  });
}

function touch(session: MockIntakeSession): void {
  session.version += 1;
  session.updatedAt = new Date().toISOString();
}

function findSession(db: MockDb, id: string): MockIntakeSession | undefined {
  return db.intakeSessions.get(id);
}

function applyAnswers(
  db: MockDb,
  session: MockIntakeSession,
  answers: readonly IntakeAnswerInput[],
): Response | null {
  const current = session.questions ?? [];
  const currentFields = new Set(current.map((question) => question.field));
  const seen = new Set<IntakeField>();
  for (const answer of answers) {
    if (!isIntakeField(answer.questionKey)) {
      return problem(422, 'validation_failed', `unknown intake field: ${String(answer.questionKey)}`);
    }
    if (seen.has(answer.questionKey)) {
      return problem(422, 'validation_failed', 'duplicate answer for the same field');
    }
    seen.add(answer.questionKey);
    if (!currentFields.has(answer.questionKey)) {
      return problem(422, 'validation_failed', 'question was not asked in the current round');
    }
    if (!INTAKE_ACTIONS.includes(answer.action)) {
      return problem(422, 'validation_failed', `unknown answer action: ${String(answer.action)}`);
    }
    if (answer.action === 'answer' && !isProvided(answer.value)) {
      return problem(422, 'validation_failed', 'answer action requires a value');
    }
    if (answer.action !== 'answer' && 'value' in answer) {
      return problem(422, 'validation_failed', `${answer.action} action must not carry a value`);
    }
  }

  const answeredFields = new Set(answers.map((answer) => answer.questionKey));
  const newAnswers: NonNullable<IntakeSession['answers']> = answers.map((answer) => {
    const question = current.find((candidate) => candidate.field === answer.questionKey);
    return {
      questionKey: answer.questionKey,
      ...(question === undefined ? {} : { questionText: question.prompt }),
      action: answer.action,
      ...(answer.action === 'answer' ? { value: answer.value } : {}),
      skipped: answer.action !== 'answer',
    };
  });
  const allAnswers = [...(session.answers ?? []), ...newAnswers];
  const nextInput: Record<string, unknown> = { ...session.input };
  for (const answer of answers) {
    if (answer.action === 'answer' && answer.value !== undefined) {
      nextInput[answer.questionKey] = answer.value;
    }
  }

  session.input = nextInput as IntakeInput;
  session.answers = allAnswers;

  const remaining = current.filter((question) => !answeredFields.has(question.field));
  if (remaining.length > 0) {
    session.questions = remaining;
    session.assumptions = toAssumptions(conservativeAssumptions(toDomainAnswers(allAnswers)));
    return null;
  }

  session.askedFields = [
    ...new Set<IntakeField>([
      ...session.askedFields,
      ...current.map((question) => question.field),
    ]),
  ];
  const plan = nextQuestions(session, session.round + 1);
  if (plan.questions.length > 0) {
    session.round += 1;
    session.questions = toQuestions(plan.questions);
    session.assumptions = toAssumptions(plan.assumptions);
    session.askedFields = [
      ...new Set<IntakeField>([
        ...session.askedFields,
        ...plan.questions.map((question) => question.field),
      ]),
    ];
    return null;
  }

  const advanced = transition('clarification', { type: 'proceed_with_defaults' });
  session.state = advanced.state;
  session.assumptions = toAssumptions(plan.assumptions);
  delete session.questions;
  session.round += 1;
  session.draft = buildDraft(session, db);
  return null;
}

function createTasksForDraft(db: MockDb, session: MockIntakeSession): void {
  const draft = session.draft;
  if (draft === undefined) return;
  const now = new Date().toISOString();
  const ids = new Map<string, string>();
  for (const step of draft.steps) ids.set(step.key, createUuidV7());
  const created: Task[] = [];
  for (const step of draft.steps) {
    const id = ids.get(step.key);
    if (id === undefined) continue;
    const dependsOn = step.dependsOn
      .map((ref) => ids.get(ref))
      .filter((value): value is string => value !== undefined);
    const task: Task = {
      id,
      ownerId: db.user.id,
      projectId: db.inboxProjectId,
      title: step.title,
      status: 'todo',
      splittable: step.splittable,
      priority: 2,
      dependsOn,
      version: 1,
      createdAt: now,
      updatedAt: now,
      external: [],
      ...(step.deliverable.length > 0 ? { description: step.deliverable } : {}),
    };
    db.tasks.set(task.id, task);
    created.push(task);
  }
  if (created.length > 0) db.taskRevision += 1;
  session.createdTaskIds = created.map((task) => task.id);
}

export function createIntakeHandlers(db: MockDb) {
  return [
    http.post('*/api/v1/intake-sessions', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<IntakeSessionCreate>(raw);
      const input = body === undefined ? null : asRecord(body.input);
      if (input === null || Object.keys(input).length === 0) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'input is required');
      }
      const title = input['title'];
      if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
        return rememberDomainResult(
          db,
          token,
          422,
          'validation_failed',
          'title is required and must be 1-200 characters',
        );
      }
      const description = input['description'];
      if (
        description !== undefined &&
        (typeof description !== 'string' || description.length > 4_000)
      ) {
        return rememberDomainResult(
          db,
          token,
          422,
          'validation_failed',
          'description must be a string of at most 4000 characters',
        );
      }
      const now = new Date().toISOString();
      const detected = detectType(db, input as IntakeInput);
      const session: MockIntakeSession = {
        id: createUuidV7(),
        ownerId: db.user.id,
        state: 'type_detection',
        input: input as IntakeInput,
        detectedType: {
          classification: detected.classification,
          confidence: detected.confidence,
          reasons: detected.reasons,
          missingRequired: detected.missingRequired,
          ...(detected.templateId === undefined ? {} : { templateId: detected.templateId }),
        },
        round: 1,
        manual: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
        askedFields: [],
      };
      if (detected.classification === 'new' || detected.missingRequired.length > 0) {
        const advanced = transition('type_detection', {
          type: 'type_detected',
          classification: detected.classification,
          missingRequired: detected.missingRequired,
        });
        session.state = advanced.state;
        const plan = nextQuestions(session, 1);
        session.questions = toQuestions(plan.questions);
        session.assumptions = toAssumptions(plan.assumptions);
        session.askedFields = plan.questions.map((question) => question.field);
      }
      db.intakeSessions.set(session.id, session);
      remember(db, token, 201, session, { ETag: etag(session.version) });
      return json(session as unknown as Record<string, unknown>, 201, {
        ETag: etag(session.version),
      });
    }),

    http.get('*/api/v1/intake-sessions/:id', ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const session = findSession(db, String(params.id));
      if (session === undefined) return problem(404, 'not_found', 'Intake session not found');
      const current = etag(session.version);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(session as unknown as Record<string, unknown>, 200, { ETag: current });
    }),

    http.post('*/api/v1/intake-sessions/:id/answers', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const session = findSession(db, String(params.id));
      if (session === undefined) return problem(404, 'not_found', 'Intake session not found');
      if (session.version !== ifMatch.version) {
        return problem(412, 'version_conflict', `Server version is ${session.version}`);
      }
      if (session.state !== 'clarification') {
        return rememberDomainResult(
          db,
          token,
          409,
          'illegal_transition',
          `cannot answer questions in state ${session.state}`,
        );
      }
      const body = parseBody<{ answers?: unknown }>(raw);
      const answers = body === undefined ? undefined : body.answers;
      if (!Array.isArray(answers) || answers.length < 1 || answers.length > 5) {
        return rememberDomainResult(
          db,
          token,
          422,
          'validation_failed',
          'answers must contain 1-5 items',
        );
      }
      const failure = applyAnswers(db, session, answers as IntakeAnswerInput[]);
      if (failure !== null) return failure;
      touch(session);
      remember(db, token, 200, session, { ETag: etag(session.version) });
      return json(session as unknown as Record<string, unknown>, 200, {
        ETag: etag(session.version),
      });
    }),

    http.post('*/api/v1/intake-sessions/:id/type-confirmation', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const session = findSession(db, String(params.id));
      if (session === undefined) return problem(404, 'not_found', 'Intake session not found');
      if (session.version !== ifMatch.version) {
        return problem(412, 'version_conflict', `Server version is ${session.version}`);
      }
      if (session.state !== 'type_detection' && session.state !== 'clarification') {
        return rememberDomainResult(
          db,
          token,
          409,
          'illegal_transition',
          `cannot confirm type in state ${session.state}`,
        );
      }
      const body = parseBody<IntakeTypeConfirmation>(raw);
      if (body === undefined) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'confirmation is required');
      }
      if (body.similar) {
        const template = db.templates.get(body.templateId);
        if (template === undefined) {
          return rememberDomainResult(db, token, 422, 'validation_failed', 'templateId does not exist');
        }
        session.templateId = template.id;
        if (session.state === 'type_detection') {
          const advanced = transition('type_detection', {
            type: 'type_detected',
            classification: 'similar',
            missingRequired: missingRequired(session.input),
            similarConfirmed: true,
          });
          session.state = advanced.state;
          session.draft = buildDraft(session, db);
          delete session.questions;
        } else if (session.questions === undefined) {
          const plan = nextQuestions(session, session.round);
          session.questions = toQuestions(plan.questions);
          session.assumptions = toAssumptions(plan.assumptions);
          session.askedFields = plan.questions.map((question) => question.field);
        }
        delete session.detectedType;
      } else {
        if (session.state === 'type_detection') {
          const advanced = transition('type_detection', {
            type: 'type_detected',
            classification: 'similar',
            missingRequired: missingRequired(session.input),
            similarConfirmed: false,
          });
          session.state = advanced.state;
        }
        delete session.detectedType;
        if (session.questions === undefined) {
          const plan = nextQuestions(session, session.round);
          session.questions = toQuestions(plan.questions);
          session.assumptions = toAssumptions(plan.assumptions);
          session.askedFields = plan.questions.map((question) => question.field);
        }
      }
      touch(session);
      remember(db, token, 200, session, { ETag: etag(session.version) });
      return json(session as unknown as Record<string, unknown>, 200, {
        ETag: etag(session.version),
      });
    }),

    http.get('*/api/v1/intake-sessions/:id/draft', ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const session = findSession(db, String(params.id));
      if (session === undefined) return problem(404, 'not_found', 'Intake session not found');
      if (session.draft === undefined) return problem(404, 'not_found', 'Draft is not ready');
      const current = etag(session.version);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(session.draft, 200, { ETag: current });
    }),

    http.patch('*/api/v1/intake-sessions/:id/draft', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const session = findSession(db, String(params.id));
      if (session === undefined) return problem(404, 'not_found', 'Intake session not found');
      if (session.version !== ifMatch.version) {
        return problem(412, 'version_conflict', `Server version is ${session.version}`);
      }
      if (session.state !== 'decomposition' || session.draft === undefined) {
        return rememberDomainResult(
          db,
          token,
          409,
          'illegal_transition',
          `cannot edit the draft in state ${session.state}`,
        );
      }
      const patch = parseBody<Partial<DecompositionDraft>>(raw);
      if (patch === undefined) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'draft patch is required');
      }
      const merged: DomainDraft = {
        steps: patch.steps === undefined ? session.draft.steps : patch.steps,
        assumptions: patch.assumptions === undefined ? session.draft.assumptions : patch.assumptions,
        questionsRemaining:
          patch.questionsRemaining === undefined
            ? session.draft.questionsRemaining
            : patch.questionsRemaining,
      };
      const validated = validateDecomposition(merged);
      if (!validated.valid) {
        return rememberDomainResult(
          db,
          token,
          422,
          'validation_failed',
          validated.issues.map((issue) => issue.message).join('; '),
        );
      }
      session.draft = {
        steps: cloneSteps(validated.draft.steps),
        assumptions: [...validated.draft.assumptions],
        questionsRemaining: [...validated.draft.questionsRemaining],
      };
      touch(session);
      remember(db, token, 200, session.draft, { ETag: etag(session.version) });
      return json(session.draft, 200, { ETag: etag(session.version) });
    }),

    http.post(/\/api\/v1\/intake-sessions\/([^/]+)\/draft:approve$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/intake-sessions\/([^/]+)\/draft:approve$/.exec(
        new URL(request.url).pathname,
      );
      const sessionId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const session = findSession(db, sessionId);
      if (session === undefined) return problem(404, 'not_found', 'Intake session not found');
      if (session.version !== ifMatch.version) {
        return problem(412, 'version_conflict', `Server version is ${session.version}`);
      }
      if (session.state !== 'decomposition' || session.draft === undefined) {
        return rememberDomainResult(
          db,
          token,
          409,
          'illegal_transition',
          `cannot approve in state ${session.state}`,
        );
      }
      const validated = validateDecomposition(session.draft as DomainDraft);
      if (!validated.valid) {
        return rememberDomainResult(
          db,
          token,
          422,
          'validation_failed',
          validated.issues.map((issue) => issue.message).join('; '),
        );
      }
      const advanced = transition('decomposition', { type: 'draft_approved' });
      session.state = advanced.state;
      createTasksForDraft(db, session);
      touch(session);
      remember(db, token, 200, session, { ETag: etag(session.version) });
      return json(session as unknown as Record<string, unknown>, 200, {
        ETag: etag(session.version),
      });
    }),

    http.post(/\/api\/v1\/intake-sessions\/([^/]+):(pause|resume|cancel|manual)$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/intake-sessions\/([^/]+):(pause|resume|cancel|manual)$/.exec(
        new URL(request.url).pathname,
      );
      const sessionId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const action = match?.[2];
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const session = findSession(db, sessionId);
      if (session === undefined) return problem(404, 'not_found', 'Intake session not found');
      if (session.version !== ifMatch.version) {
        return problem(412, 'version_conflict', `Server version is ${session.version}`);
      }
      const terminal = session.state === 'cancelled' || session.state === 'failed';
      if (terminal) {
        return rememberDomainResult(
          db,
          token,
          409,
          'illegal_transition',
          `cannot ${String(action)} a terminal session`,
        );
      }
      if (action === 'pause') {
        if (session.state !== 'clarification') {
          return rememberDomainResult(
            db,
            token,
            409,
            'illegal_transition',
            `cannot pause in state ${session.state}`,
          );
        }
        session.pausedFrom = session.state;
        session.state = 'needs_input';
      } else if (action === 'resume') {
        if (session.state !== 'needs_input') {
          return rememberDomainResult(db, token, 409, 'illegal_transition', 'session is not paused');
        }
        session.state = 'clarification';
        delete session.pausedFrom;
      } else if (action === 'cancel') {
        const advanced = transition(session.state, { type: 'user_cancelled' });
        session.state = advanced.state;
        delete session.pausedFrom;
      } else if (action === 'manual') {
        session.manual = true;
        session.state = 'decomposition';
        delete session.questions;
        delete session.detectedType;
        delete session.error;
        delete session.pausedFrom;
        if (session.draft === undefined) session.draft = buildDraft(session, db);
      } else {
        return problem(400, 'validation_failed', 'unknown intake action');
      }
      touch(session);
      remember(db, token, 200, session, { ETag: etag(session.version) });
      return json(session as unknown as Record<string, unknown>, 200, {
        ETag: etag(session.version),
      });
    }),

    http.get('*/api/v1/templates', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const query = url.searchParams.get('query');
      const items: TaskTemplate[] = [...db.templates.values()]
        .filter((template) => template.deletedAt === undefined)
        .filter(
          (template) =>
            query === null ||
            query.trim().length === 0 ||
            template.name.toLowerCase().includes(query.trim().toLowerCase()),
        );
      return json({ items, nextCursor: null }, 200, { ETag: 'W/"templates-1"' });
    }),

    http.get('*/api/v1/templates/:id', ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const template = db.templates.get(String(params.id));
      if (template === undefined) return problem(404, 'not_found', 'Template not found');
      const current = etag(template.version);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(template, 200, { ETag: current });
    }),
  ];
}
