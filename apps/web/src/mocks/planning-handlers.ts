import { HttpResponse, http, type JsonBodyType } from 'msw';
import type {
  Availability,
  AvailabilityPut,
  Commitment,
  CommitmentCreate,
  CommitmentPatch,
  Plan,
  PlanBlock,
  PlanCandidate,
  PlanCreate,
  PlanVersion,
} from '../api/client';
import type { ProblemCode } from '../api/errors';
import { expandOccurrences } from '../domain/rrule';
import {
  createUuidV7,
  type MockDb,
} from './db';
import {
  type IdempotencyToken,
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
  commitmentsFor,
  generateCandidates,
  preflightBlocks,
  validateEditedBlocks,
  type GenerationInput,
} from './planning-engine';

const MAX_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_OCCURRENCES = 2_000;

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail: string;
  errors?: Array<{ path: string; message: string }>;
  violations?: unknown[];
}

function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'Authentication is required');
}

function availabilityEtag(version: number): string {
  return `W/"availability:${version}"`;
}

function parseAvailabilityIfMatch(request: Request): { version: number } | Response {
  const header = request.headers.get('If-Match');
  if (header === null) {
    return problem(428, 'version_conflict', 'If-Match header is required');
  }
  const match = /^W\/"availability:(\d+)"$/.exec(header);
  if (match === null) {
    return problem(400, 'validation_failed', 'If-Match must look like W/"availability:<version>"');
  }
  return { version: Number(match[1]) };
}

function problemWith(
  status: number,
  code: ProblemCode,
  detail: string,
  extra: { errors?: Array<{ path: string; message: string }>; violations?: unknown[] } = {},
): ProblemBody {
  return {
    type: 'about:blank',
    title: 'Request failed',
    status,
    code,
    detail,
    ...extra,
  };
}

function rememberProblem(
  db: MockDb,
  token: IdempotencyToken,
  body: ProblemBody,
): Response {
  remember(db, token, body.status, body, { 'Content-Type': 'application/problem+json' });
  return HttpResponse.json(body as unknown as JsonBodyType, {
    status: body.status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function matchPath(request: Request, pattern: RegExp): string[] | null {
  const match = pattern.exec(new URL(request.url).pathname);
  return match === null ? null : match.slice(1).map((value) => decodeURIComponent(value));
}

function findPlan(db: MockDb, planId: string): Plan | undefined {
  return db.plans.get(planId);
}

function planTasks(db: MockDb, plan: Plan) {
  const ids =
    'taskIds' in plan.scope
      ? plan.scope.taskIds
      : [...db.tasks.values()]
          .filter((task) => task.deletedAt === undefined && task.status !== 'done')
          .map((task) => task.id);
  return ids
    .map((id) => db.tasks.get(id))
    .filter((task): task is NonNullable<typeof task> => task !== undefined && task.deletedAt === undefined);
}

function generationInput(db: MockDb, plan: Plan): GenerationInput {
  return {
    horizon: plan.horizon,
    timeZone: plan.timeZone,
    availability: db.availability,
    commitments: commitmentsFor(db),
    tasks: planTasks(db, plan),
  };
}

function taskIdSet(db: MockDb, plan: Plan): Set<string> {
  return new Set(planTasks(db, plan).map((task) => task.id));
}

function validateHorizon(horizon: PlanCreate['horizon']): string | null {
  const start = Date.parse(horizon.start);
  const end = Date.parse(horizon.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'horizon has an invalid instant';
  if (end <= start) return 'horizon end must be after start';
  if (end - start > MAX_HORIZON_MS) return 'horizon is longer than 366 days';
  return null;
}

function resolveScopeTasks(db: MockDb, scope: PlanCreate['scope']) {
  if ('taskIds' in scope) {
    if (!Array.isArray(scope.taskIds) || scope.taskIds.length === 0) return { error: 'taskIds must not be empty' };
    const tasks = [];
    for (const id of scope.taskIds) {
      const task = db.tasks.get(id);
      if (task === undefined || task.deletedAt !== undefined) {
        return { error: `task ${id} does not exist` };
      }
      tasks.push(task);
    }
    return { tasks };
  }
  if (typeof scope.goalId !== 'string' || scope.goalId.length === 0) {
    return { error: 'goalId must not be empty' };
  }
  return {
    tasks: [...db.tasks.values()].filter(
      (task) => task.deletedAt === undefined && task.status !== 'done',
    ),
  };
}

function applyCommitmentPatch(commitment: Commitment, patch: CommitmentPatch): Commitment {
  const updated: Commitment = { ...commitment };
  if (patch.title !== undefined) updated.title = patch.title;
  if (patch.startAt !== undefined) updated.startAt = patch.startAt;
  if (patch.endAt !== undefined) updated.endAt = patch.endAt;
  if (patch.timeZone !== undefined) updated.timeZone = patch.timeZone;
  if (patch.source !== undefined) updated.source = patch.source;
  if (patch.rrule !== undefined) {
    if (patch.rrule === null) delete updated.rrule;
    else updated.rrule = patch.rrule;
  }
  updated.version = commitment.version + 1;
  updated.updatedAt = new Date().toISOString();
  return updated;
}

function validCommitmentFields(input: {
  title?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  timeZone?: unknown;
  rrule?: unknown;
}): string | null {
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.trim().length === 0)) {
    return 'title must be a non-empty string';
  }
  if (input.startAt !== undefined && (typeof input.startAt !== 'string' || !Number.isFinite(Date.parse(input.startAt)))) {
    return 'startAt must be an instant';
  }
  if (input.endAt !== undefined && (typeof input.endAt !== 'string' || !Number.isFinite(Date.parse(input.endAt)))) {
    return 'endAt must be an instant';
  }
  if (input.timeZone !== undefined && typeof input.timeZone !== 'string') {
    return 'timeZone must be a string';
  }
  if (input.rrule !== undefined && input.rrule !== null && typeof input.rrule !== 'string') {
    return 'rrule must be a string or null';
  }
  if (
    typeof input.startAt === 'string' &&
    typeof input.endAt === 'string' &&
    Date.parse(input.endAt) <= Date.parse(input.startAt)
  ) {
    return 'endAt must be after startAt';
  }
  return null;
}

function commitmentWithOccurrences(
  commitment: Commitment,
  from: string,
  to: string,
): Commitment {
  const occurrences = expandOccurrences(commitment, from, to, MAX_OCCURRENCES).map((occurrence) => ({
    commitmentId: commitment.id,
    startAt: occurrence.startAt,
    endAt: occurrence.endAt,
  }));
  return { ...commitment, occurrences };
}

function cloneCommitment(commitment: Commitment): Commitment {
  return {
    ...commitment,
    ...(commitment.rrule === undefined ? {} : { rrule: commitment.rrule }),
  };
}

export function createPlanningHandlers(db: MockDb) {
  return [
    http.get('*/api/v1/availability', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const current = availabilityEtag(db.availabilityVersion);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(db.availability, 200, { ETag: current });
    }),

    http.put('*/api/v1/availability', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseAvailabilityIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      if (ifMatch.version !== db.availabilityVersion) {
        return problem(
          412,
          'availability_changed',
          `Availability is now version ${db.availabilityVersion}; the request used ${ifMatch.version}`,
        );
      }
      const body = parseBody<AvailabilityPut>(raw);
      if (
        body === undefined ||
        typeof body.timeZone !== 'string' ||
        !Array.isArray(body.rules) ||
        !Array.isArray(body.exceptions) ||
        body.prefs === undefined ||
        typeof body.prefs !== 'object'
      ) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'Invalid availability body');
      }
      const nextVersion = db.availabilityVersion + 1;
      const updated: Availability = { ...body, version: nextVersion };
      db.availability = updated;
      db.availabilityVersion = nextVersion;
      const headers = { ETag: availabilityEtag(nextVersion) };
      remember(db, token, 200, updated, headers);
      return json(updated, 200, headers);
    }),

    http.get('*/api/v1/commitments', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (from === null || to === null) {
        return problem(422, 'validation_failed', 'from and to are required');
      }
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
        return problem(422, 'validation_failed', 'from and to must be a valid range');
      }
      if (toMs - fromMs > MAX_HORIZON_MS) {
        return problem(422, 'validation_failed', 'commitment range must be at most 366 days');
      }
      const items = [...db.commitments.values()]
        .map((commitment) => commitmentWithOccurrences(cloneCommitment(commitment), from, to))
        .filter((commitment) => (commitment.occurrences?.length ?? 0) > 0)
        .sort((left, right) => left.startAt.localeCompare(right.startAt));
      const total = items.reduce((sum, item) => sum + (item.occurrences?.length ?? 0), 0);
      if (total > MAX_OCCURRENCES) {
        return problem(422, 'validation_failed', 'commitment expansion exceeds 2000 occurrences');
      }
      const current = `W/"commitments-${db.availabilityVersion}"`;
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json({ items, nextCursor: null }, 200, { ETag: current });
    }),

    http.post('*/api/v1/commitments', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<CommitmentCreate>(raw);
      if (body === undefined) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'Invalid commitment body');
      }
      const failure = validCommitmentFields(body);
      if (failure !== null) return rememberDomainResult(db, token, 422, 'validation_failed', failure);
      const now = new Date().toISOString();
      const commitment: Commitment = {
        id: createUuidV7(),
        ownerId: db.user.id,
        title: body.title.trim(),
        startAt: body.startAt,
        endAt: body.endAt,
        timeZone: body.timeZone,
        source: body.source ?? 'manual',
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...(body.rrule === undefined || body.rrule.length === 0 ? {} : { rrule: body.rrule }),
      };
      db.commitments.set(commitment.id, commitment);
      db.availabilityVersion += 1;
      remember(db, token, 201, commitment);
      return json(commitment, 201);
    }),

    http.patch('*/api/v1/commitments/:id', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const commitment = db.commitments.get(String(params.id));
      if (commitment === undefined) return problem(404, 'not_found', 'Commitment not found');
      // CAL-03: an imported 약속 is edited in Google, never here.
      if (commitment.source === 'google') {
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'Imported commitments are read-only');
      }
      if (commitment.version !== ifMatch.version) {
        return problem(
          412,
          'version_conflict',
          `Server version is ${commitment.version}; the request used ${ifMatch.version}`,
        );
      }
      const patch = parseBody<CommitmentPatch>(raw);
      if (patch === undefined) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'Invalid commitment patch');
      }
      const failure = validCommitmentFields(patch);
      if (failure !== null) return rememberDomainResult(db, token, 422, 'validation_failed', failure);
      const updated = applyCommitmentPatch(commitment, patch);
      db.commitments.set(updated.id, updated);
      db.availabilityVersion += 1;
      remember(db, token, 200, updated);
      return json(updated, 200);
    }),

    http.delete('*/api/v1/commitments/:id', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const commitment = db.commitments.get(String(params.id));
      if (commitment === undefined) return problem(404, 'not_found', 'Commitment not found');
      if (commitment.source === 'google') {
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'Imported commitments are read-only');
      }
      if (commitment.version !== ifMatch.version) {
        return problem(
          412,
          'version_conflict',
          `Server version is ${commitment.version}; the request used ${ifMatch.version}`,
        );
      }
      db.commitments.delete(commitment.id);
      db.availabilityVersion += 1;
      remember(db, token, 204, null);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post('*/api/v1/plans', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<PlanCreate>(raw);
      if (body === undefined || body.scope === undefined || body.horizon === undefined) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'Invalid plan body');
      }
      const horizonFailure = validateHorizon(body.horizon);
      if (horizonFailure !== null) {
        return rememberDomainResult(db, token, 422, 'validation_failed', horizonFailure);
      }
      const scope = resolveScopeTasks(db, body.scope);
      if ('error' in scope) {
        return rememberDomainResult(db, token, 422, 'validation_failed', scope.error);
      }
      if (scope.tasks.length === 0) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'plan scope has no tasks');
      }
      const policies =
        body.policies === undefined || body.policies.length === 0
          ? (['front_loaded', 'balanced', 'focus_blocked'] as const)
          : body.policies;
      let generated;
      try {
        generated = generateCandidates(
          {
            horizon: body.horizon,
            timeZone: db.availability.timeZone,
            availability: db.availability,
            commitments: commitmentsFor(db),
            tasks: scope.tasks,
          },
          policies,
        );
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Generation failed';
        return rememberDomainResult(db, token, 422, 'validation_failed', detail);
      }
      const now = new Date().toISOString();
      const plan: Plan = {
        id: createUuidV7(),
        ownerId: db.user.id,
        scope: body.scope,
        status: 'draft',
        availabilityVersion: db.availabilityVersion,
        horizon: body.horizon,
        timeZone: db.availability.timeZone,
        candidates: generated.candidates,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.plans.set(plan.id, plan);
      const headers = { ETag: etag(plan.version) };
      remember(db, token, 201, plan, headers);
      return json(plan, 201, headers);
    }),

    http.get('*/api/v1/plans/:id', ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const plan = findPlan(db, String(params.id));
      if (plan === undefined) return problem(404, 'not_found', 'Plan not found');
      const current = etag(plan.version);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(plan, 200, { ETag: current });
    }),

    http.post(/\/api\/v1\/plans\/([^/]+)\/candidates\/([^/]+):preview-edit$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const parts = matchPath(request, /\/api\/v1\/plans\/([^/]+)\/candidates\/([^/]+):preview-edit$/);
      if (parts === null) return problem(400, 'validation_failed', 'Malformed preview path');
      const [planId = '', candidateId = ''] = parts;
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const plan = findPlan(db, planId);
      if (plan === undefined) return problem(404, 'not_found', 'Plan not found');
      if (plan.version !== ifMatch.version) {
        return problem(
          412,
          'version_conflict',
          `Plan is now version ${plan.version}; the request used ${ifMatch.version}`,
        );
      }
      const candidate = plan.candidates.find((item) => item.id === candidateId);
      if (candidate === undefined) return problem(404, 'not_found', 'Candidate not found');
      const body = parseBody<{ blocks?: unknown }>(raw);
      if (body === undefined || !Array.isArray(body.blocks)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'blocks must be an array');
      }
      const blocks = body.blocks as PlanBlock[];
      const preflight = preflightBlocks(blocks, plan.horizon, taskIdSet(db, plan), 'blocks');
      if (preflight.length > 0) {
        return rememberProblem(
          db,
          token,
          problemWith(422, 'validation_failed', 'Edited blocks failed pre-flight validation', {
            errors: preflight.map((error) => ({ path: error.path, message: error.message })),
          }),
        );
      }
      let result;
      try {
        result = validateEditedBlocks(generationInput(db, plan), blocks);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Preview failed';
        return rememberDomainResult(db, token, 422, 'validation_failed', detail);
      }
      remember(db, token, 200, result);
      return json(result, 200);
    }),

    http.post(/\/api\/v1\/plans\/([^/]+)\/candidates\/([^/]+):approve$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const parts = matchPath(request, /\/api\/v1\/plans\/([^/]+)\/candidates\/([^/]+):approve$/);
      if (parts === null) return problem(400, 'validation_failed', 'Malformed approve path');
      const [planId = '', candidateId = ''] = parts;
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseAvailabilityIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      if (ifMatch.version !== db.availabilityVersion) {
        return problem(
          412,
          'availability_changed',
          `Availability is now version ${db.availabilityVersion}; the plan used ${ifMatch.version}`,
        );
      }
      const plan = findPlan(db, planId);
      if (plan === undefined) return problem(404, 'not_found', 'Plan not found');
      const candidate = plan.candidates.find((item) => item.id === candidateId);
      if (candidate === undefined) return problem(404, 'not_found', 'Candidate not found');
      const body = parseBody<{ editedBlocks?: unknown }>(raw);
      if (body === undefined) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'Invalid approve body');
      }
      if (body.editedBlocks !== undefined && !Array.isArray(body.editedBlocks)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'editedBlocks must be an array');
      }
      const edited = body.editedBlocks as PlanBlock[] | undefined;
      const blocks = edited ?? candidate.blocks;
      if (edited !== undefined) {
        const preflight = preflightBlocks(edited, plan.horizon, taskIdSet(db, plan), 'editedBlocks');
        if (preflight.length > 0) {
          return rememberProblem(
            db,
            token,
            problemWith(422, 'validation_failed', 'Edited blocks failed pre-flight validation', {
              errors: preflight.map((error) => ({ path: error.path, message: error.message })),
            }),
          );
        }
      }
      let validation;
      try {
        validation = validateEditedBlocks(generationInput(db, plan), blocks);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Validation failed';
        return rememberDomainResult(db, token, 422, 'validation_failed', detail);
      }
      if (!validation.feasible) {
        return rememberProblem(
          db,
          token,
          problemWith(422, 'constraint_violation', 'The plan violates hard constraints', {
            violations: validation.violations,
          }),
        );
      }
      const now = new Date().toISOString();
      const seq =
        [...db.planVersions.values()].filter((version) => version.planId === plan.id).length + 1;
      const versionId = createUuidV7();
      const planVersion: PlanVersion = {
        id: versionId,
        planId: plan.id,
        seq,
        candidateId: candidate.id,
        createdBy: 'user',
        availabilityVersion: db.availabilityVersion,
        blocks: blocks.map((block) => ({
          id: createUuidV7(),
          planVersionId: versionId,
          taskId: block.taskId,
          startAt: block.startAt,
          endAt: block.endAt,
          locked: false,
          status: 'planned',
          version: 1,
        })),
        version: 1,
        createdAt: now,
      };
      db.planVersions.set(planVersion.id, planVersion);
      const updatedPlan: Plan = {
        ...plan,
        status: 'active',
        currentVersionId: planVersion.id,
        version: plan.version + 1,
        updatedAt: now,
      };
      db.plans.set(updatedPlan.id, updatedPlan);
      remember(db, token, 201, planVersion);
      return json(planVersion, 201);
    }),

    http.post(/\/api\/v1\/plans\/([^/]+):regenerate$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const parts = matchPath(request, /\/api\/v1\/plans\/([^/]+):regenerate$/);
      if (parts === null) return problem(400, 'validation_failed', 'Malformed regenerate path');
      const [planId = ''] = parts;
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const plan = findPlan(db, planId);
      if (plan === undefined) return problem(404, 'not_found', 'Plan not found');
      if (plan.version !== ifMatch.version) {
        return problem(
          412,
          'version_conflict',
          `Plan is now version ${plan.version}; the request used ${ifMatch.version}`,
        );
      }
      const policies = plan.candidates.map((candidate) => candidate.policy);
      let generated;
      try {
        generated = generateCandidates(
          {
            horizon: plan.horizon,
            timeZone: plan.timeZone,
            availability: db.availability,
            commitments: commitmentsFor(db),
            tasks: planTasks(db, plan),
          },
          policies.length === 0 ? ['front_loaded', 'balanced', 'focus_blocked'] : policies,
        );
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Regeneration failed';
        return rememberDomainResult(db, token, 422, 'validation_failed', detail);
      }
      const updated: Plan = {
        ...plan,
        candidates: generated.candidates,
        availabilityVersion: db.availabilityVersion,
        version: plan.version + 1,
        updatedAt: new Date().toISOString(),
      };
      db.plans.set(updated.id, updated);
      const headers = { ETag: etag(updated.version) };
      remember(db, token, 201, updated, headers);
      return json(updated, 201, headers);
    }),
  ];
}

export type { PlanCandidate };
