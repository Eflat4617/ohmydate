import { ProblemSchema, contractRoutes as routes, type RouteDefinition } from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';

interface ExpectedRoute {
  readonly requiredHeaders: readonly string[];
  readonly optionalHeaders: readonly string[];
  readonly statuses: readonly number[];
}

const EXPECTED: Readonly<Record<string, ExpectedRoute>> = {
  login: {
    requiredHeaders: [],
    optionalHeaders: [],
    statuses: [204, 400, 401, 429],
  },
  logout: {
    requiredHeaders: [],
    optionalHeaders: [],
    statuses: [204, 401, 403],
  },
  getMe: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401],
  },
  updateMySettings: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 409, 412, 422, 428],
  },
  listProjects: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  createProject: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 409, 422],
  },
  listTasks: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422, 503],
  },
  createTask: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 422, 503],
  },
  getTask: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404, 503],
  },
  updateTask: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  completeTask: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  deleteTask: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [204, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  createTaskDependency: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  createIntakeSession: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 409, 422],
  },
  getIntakeSession: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404],
  },
  answerIntakeQuestions: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  confirmIntakeType: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  getIntakeDraft: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404],
  },
  updateIntakeDraft: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  approveIntakeDraft: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  pauseIntakeSession: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  resumeIntakeSession: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  cancelIntakeSession: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  enterManualIntakeMode: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  listTaskTemplates: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  getTaskTemplate: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404],
  },
  createPlan: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 422],
  },
  getPlan: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404],
  },
  previewPlanCandidateEdit: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 412, 422, 428],
  },
  approvePlanCandidate: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  regeneratePlan: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  getAvailability: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401],
  },
  putAvailability: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 409, 412, 422, 428],
  },
  listCommitments: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  createCommitment: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 422],
  },
  // CAL-02: reads drafts only; 409 idempotency_in_progress, 503 LLM.
  parseCommitments: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 409, 422, 503],
  },
  updateCommitment: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  deleteCommitment: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [204, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  getToday: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  listGoals: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  listScheduleBlocks: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  lockScheduleBlock: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  unlockScheduleBlock: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  acceptToday: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  shrinkToday: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  rescheduleToday: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  approveTodayProposal: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  createSession: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 422],
  },
  getSession: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404],
  },
  listSessions: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  pauseSession: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  resumeSession: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  completeSession: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  reviewSession: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  listNotifications: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  dismissNotification: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  createPushSubscription: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 409, 422],
  },
  deletePushSubscription: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [204, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  createExport: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [202, 400, 401, 403, 409, 422],
  },
  getExport: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404],
  },
  listReplanProposals: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  getReplanProposal: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404],
  },
  approveReplanProposal: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  rejectReplanProposal: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  requestReplanProposal: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 422],
  },
  getEstimationProfile: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401],
  },
  patchEstimationFeedback: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  resetEstimation: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 422],
  },
  listDocuments: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
  createDocument: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 422, 503],
  },
  getDocument: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404],
  },
  updateDocument: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  deleteDocument: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [204, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  addDocumentLink: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  removeDocumentLink: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 404, 409, 412, 422, 428],
  },
  listDocumentAiUsage: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 404, 422],
  },
  promoteTaskDescription: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [201, 400, 401, 403, 404, 409, 412, 422, 428, 503],
  },
  // CAL-03 Google Calendar integration. The OAuth callback is a browser
  // redirect and deliberately absent from this JSON header matrix.
  getGoogleIntegration: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401],
  },
  connectGoogleIntegration: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 409, 422],
  },
  updateGoogleIntegrationSettings: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 409, 412, 422, 428],
  },
  syncGoogleIntegration: {
    requiredHeaders: ['Idempotency-Key'],
    optionalHeaders: [],
    statuses: [200, 400, 401, 403, 409, 422, 503],
  },
  disconnectGoogleIntegration: {
    requiredHeaders: ['If-Match', 'Idempotency-Key'],
    optionalHeaders: [],
    statuses: [204, 400, 401, 403, 409, 412, 422, 428],
  },
  listCalendarDayEvents: {
    requiredHeaders: [],
    optionalHeaders: ['If-None-Match'],
    statuses: [200, 304, 400, 401, 422],
  },
};

const keyOf = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

interface HeaderShape {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

function headerShape(route: RouteDefinition): HeaderShape {
  return (route.headers ?? {}) as HeaderShape;
}

function validHeaders(route: RouteDefinition): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(headerShape(route).properties ?? {})) {
    if (name === 'If-Match') {
      headers[name] =
        route.operationId === 'approvePlanCandidate' ||
        route.operationId === 'putAvailability' ||
        route.operationId === 'approveTodayProposal' ||
        route.operationId === 'approveReplanProposal'
          ? 'W/"availability:3"'
          : 'W/"3"';
    }
    if (name === 'If-None-Match') headers[name] = 'W/"3"';
    if (name === 'Idempotency-Key') headers[name] = ID;
  }
  return headers;
}

function invalidHeader(name: string): string {
  if (name === 'If-Match') return '3';
  if (name === 'If-None-Match') return '';
  return 'not-a-uuid';
}

test('route table covers auth and account endpoints from 08 §2.1', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'POST /auth/login',
    'POST /auth/logout',
    'GET /me',
    'PATCH /me/settings',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('route table covers task and project endpoints from 08 §2.2', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'GET /projects',
    'POST /projects',
    'GET /tasks',
    'POST /tasks',
    'GET /tasks/{id}',
    'PATCH /tasks/{id}',
    'POST /tasks/{id}:complete',
    'DELETE /tasks/{id}',
    'POST /tasks/{id}/dependencies',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('route table covers intake and template endpoints from 08 §2.3', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'POST /intake-sessions',
    'GET /intake-sessions/{id}',
    'POST /intake-sessions/{id}/answers',
    'POST /intake-sessions/{id}/type-confirmation',
    'GET /intake-sessions/{id}/draft',
    'PATCH /intake-sessions/{id}/draft',
    'POST /intake-sessions/{id}/draft:approve',
    'POST /intake-sessions/{id}:pause',
    'POST /intake-sessions/{id}:resume',
    'POST /intake-sessions/{id}:cancel',
    'POST /intake-sessions/{id}:manual',
    'GET /templates',
    'GET /templates/{id}',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('route table covers availability, commitment and planning endpoints from 08 §2.4/§2.4a', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'POST /plans',
    'GET /plans/{id}',
    'GET /goals',
    'POST /plans/{id}/candidates/{cid}:preview-edit',
    'POST /plans/{id}/candidates/{cid}:approve',
    'POST /plans/{id}:regenerate',
    'GET /availability',
    'PUT /availability',
    'GET /commitments',
    'POST /commitments',
    'POST /commitments:parse',
    'PATCH /commitments/{id}',
    'DELETE /commitments/{id}',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('route table covers today, session, notification and export endpoints from 08 §2.5/§2.9/§2.10', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'GET /today',
    'POST /today:accept',
    'POST /today:shrink',
    'POST /today:reschedule',
    'POST /today/proposals/{id}:approve',
    'POST /sessions',
    'POST /sessions/{id}:pause',
    'POST /sessions/{id}:resume',
    'POST /sessions/{id}:complete',
    'POST /sessions/{id}/review',
    'GET /notifications',
    'POST /notifications/{id}:dismiss',
    'POST /push-subscriptions',
    'DELETE /push-subscriptions/{id}',
    'POST /exports',
    'GET /exports/{id}',
    'POST /schedule-blocks/{id}:lock',
    'POST /schedule-blocks/{id}:unlock',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('route table covers replanning and estimation endpoints from 08 §2.6/§2.10', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'GET /replan-proposals',
    'GET /replan-proposals/{id}',
    'POST /replan-proposals/{id}:approve',
    'POST /replan-proposals/{id}:reject',
    'POST /replan-proposals:request',
    'GET /estimation/profile',
    'PATCH /estimation/feedback/{id}',
    'POST /estimation:reset',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('route table covers notes endpoints from 08 §2.7 (M6-01)', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'GET /documents',
    'POST /documents',
    'GET /documents/{id}',
    'PATCH /documents/{id}',
    'DELETE /documents/{id}',
    'POST /documents/{id}/links',
    'DELETE /documents/{id}/links/{linkId}',
    'GET /documents/{id}/ai-usage',
    'POST /tasks/{id}:promote-description',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('route table covers the Google Calendar integration endpoints from 08 §2.11 (CAL-03)', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'GET /integrations/google',
    'POST /integrations/google:connect',
    'PUT /integrations/google/settings',
    'POST /integrations/google:sync',
    'DELETE /integrations/google',
    'GET /calendar-day-events',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
  // The callback is a 302 browser redirect, not a JSON operation.
  expect(keys.has('GET /integrations/google/callback')).toBe(false);
});

test('approval and availability replacement pin If-Match to availability versions', () => {
  for (const operationId of [
    'approvePlanCandidate',
    'putAvailability',
    'approveTodayProposal',
    'approveReplanProposal',
  ]) {
    const route = routes.find((candidate) => candidate.operationId === operationId);
    expect(route).toBeDefined();
    if (route?.headers === undefined) throw new Error(`${operationId} headers missing`);
    const validate = compile(route.headers);
    expect(validate({ 'If-Match': 'W/"availability:7"', 'Idempotency-Key': ID })).toBe(true);
    expect(validate({ 'If-Match': 'W/"7"', 'Idempotency-Key': ID })).toBe(false);
  }
});

test('every route matches the explicit header and status matrix', () => {
  expect(routes.map((route) => route.operationId).sort()).toEqual(Object.keys(EXPECTED).sort());

  for (const route of routes) {
    const expected = EXPECTED[route.operationId];
    expect(expected).toBeDefined();
    if (expected === undefined) continue;

    const shape = headerShape(route);
    expect({
      route: route.operationId,
      required: [...(shape.required ?? [])].sort(),
    }).toEqual({ route: route.operationId, required: [...expected.requiredHeaders].sort() });
    expect({
      route: route.operationId,
      headers: Object.keys(shape.properties ?? {}).sort(),
    }).toEqual({
      route: route.operationId,
      headers: [...expected.requiredHeaders, ...expected.optionalHeaders].sort(),
    });
    expect({
      route: route.operationId,
      statuses: Object.keys(route.responses)
        .map(Number)
        .sort((left, right) => left - right),
    }).toEqual({ route: route.operationId, statuses: [...expected.statuses] });
  }
});

test('each declared header schema rejects missing and invalid required headers', () => {
  for (const route of routes) {
    if (route.headers === undefined) continue;
    const shape = headerShape(route);
    const validate = compile(route.headers);
    const valid = validHeaders(route);

    expect({ route: route.operationId, valid: validate(valid) }).toEqual({
      route: route.operationId,
      valid: true,
    });
    expect({
      route: route.operationId,
      extra: validate({ ...valid, 'X-Unknown': 'value' }),
    }).toEqual({ route: route.operationId, extra: false });

    for (const name of shape.required ?? []) {
      const missing = { ...valid };
      delete missing[name];
      expect({ route: route.operationId, header: name, missing: validate(missing) }).toEqual({
        route: route.operationId,
        header: name,
        missing: false,
      });
    }

    for (const name of Object.keys(shape.properties ?? {})) {
      expect({
        route: route.operationId,
        header: name,
        invalid: validate({ ...valid, [name]: invalidHeader(name) }),
      }).toEqual({ route: route.operationId, header: name, invalid: false });
    }
  }
});

test('existing-resource mutations require both If-Match and Idempotency-Key', () => {
  for (const operationId of [
    'updateMySettings',
    'updateTask',
    'completeTask',
    'deleteTask',
    'createTaskDependency',
    'answerIntakeQuestions',
    'confirmIntakeType',
    'updateIntakeDraft',
    'approveIntakeDraft',
    'pauseIntakeSession',
    'resumeIntakeSession',
    'cancelIntakeSession',
    'enterManualIntakeMode',
    'previewPlanCandidateEdit',
    'approvePlanCandidate',
    'regeneratePlan',
    'putAvailability',
    'updateCommitment',
    'deleteCommitment',
    'acceptToday',
    'shrinkToday',
    'rescheduleToday',
    'approveTodayProposal',
    'pauseSession',
    'resumeSession',
    'completeSession',
    'reviewSession',
    'dismissNotification',
    'lockScheduleBlock',
    'unlockScheduleBlock',
    'deletePushSubscription',
    'approveReplanProposal',
    'rejectReplanProposal',
    'patchEstimationFeedback',
    'updateDocument',
    'deleteDocument',
    'addDocumentLink',
    'removeDocumentLink',
    'promoteTaskDescription',
    'updateGoogleIntegrationSettings',
    'disconnectGoogleIntegration',
  ]) {
    const route = routes.find((candidate) => candidate.operationId === operationId);
    expect(route).toBeDefined();
    expect([...(headerShape(route as RouteDefinition).required ?? [])].sort()).toEqual([
      'Idempotency-Key',
      'If-Match',
    ]);
  }
});

test('creation POSTs require Idempotency-Key without If-Match', () => {
  for (const operationId of [
    'createProject',
    'createTask',
    'createIntakeSession',
    'createPlan',
    'createCommitment',
    'parseCommitments',
    'createSession',
    'createPushSubscription',
    'createExport',
    'requestReplanProposal',
    'resetEstimation',
    'createDocument',
    'connectGoogleIntegration',
    'syncGoogleIntegration',
  ]) {
    const route = routes.find((candidate) => candidate.operationId === operationId);
    expect(route).toBeDefined();
    expect(headerShape(route as RouteDefinition).required).toEqual(['Idempotency-Key']);
  }
});

test('every problem status declares a Problem schema', () => {
  for (const route of routes) {
    for (const [status, response] of Object.entries(route.responses)) {
      if (Number(status) < 400) continue;
      expect({ route: route.operationId, status, hasSchema: response.schema !== undefined }).toEqual({
        route: route.operationId,
        status,
        hasSchema: true,
      });
    }
  }
});

test('getMe rejects empty If-None-Match and declares a 400 Problem', () => {
  const route = routes.find((candidate) => candidate.operationId === 'getMe');
  expect(route).toBeDefined();
  if (route === undefined || route.headers === undefined) throw new Error('getMe headers missing');

  const validate = compile(route.headers);
  expect(validate({ 'If-None-Match': '' })).toBe(false);
  expect(validate({ 'If-None-Match': 'W/"3"' })).toBe(true);
  expect(route.responses[400]?.schema).toBe(ProblemSchema);
});
