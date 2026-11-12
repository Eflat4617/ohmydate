import type { DecompositionStepDto, IntakeInput, IntakeSessionDto } from '@ohmydate/contracts';
import {
  BudgetGuard,
  FakeLlm,
  LlmUnavailable,
  appendValidationErrors,
  validateOutput,
} from '@ohmydate/llm';
import {
  buildDecompositionLlmInput,
  buildDetectionLlmInput,
} from '../src/application/intake/intake-service.js';
import { resolveOutputLanguage } from '../src/application/intake/output-language.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

/** FU-89: seeded test users keep the DB default locale `en`, so intake LLM calls send `en`. */
const SEEDED_LANGUAGE = resolveOutputLanguage('en');

const hasDatabaseEnv = hasDatabase;

const readyInput: IntakeInput = {
  title: 'Quarterly report',
  deliverable: 'Write the quarterly report for Q3 (contact alice@example.com)',
  dueAt: '2026-12-01T00:00:00.000Z',
  estimatedScope: 'medium',
  currentProgress: 0.1,
  availabilityConfirmed: true,
};

const validDraft = {
  steps: [
    {
      key: 's1',
      title: 'Gather quarterly inputs',
      deliverable: 'Inputs collected',
      doneCriteria: 'All sources present',
      kind: 'prep',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: [],
      splittable: false,
    },
    {
      key: 's2',
      title: 'Write the report',
      deliverable: 'Draft report',
      doneCriteria: 'Draft reviewed',
      kind: 'work',
      estimate: { p50Minutes: 120, p90Minutes: 240 },
      dependsOn: ['s1', 's9'],
      splittable: true,
    },
    {
      key: 's3',
      title: 'Review the report',
      deliverable: 'Reviewed report',
      doneCriteria: 'Review notes resolved',
      kind: 'review',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: ['s2'],
      splittable: false,
    },
  ],
  assumptions: ['fixture draft'],
  questionsRemaining: [],
};

const templateSteps: DecompositionStepDto[] = [
  {
    key: 's1',
    title: 'Prepare',
    deliverable: 'Inputs',
    doneCriteria: 'Inputs ready',
    kind: 'prep',
    estimate: { p50Minutes: 30, p90Minutes: 60 },
    dependsOn: [],
    splittable: false,
  },
  {
    key: 's2',
    title: 'Quarterly report work',
    deliverable: 'Report',
    doneCriteria: 'Draft done',
    kind: 'work',
    estimate: { p50Minutes: 120, p90Minutes: 240 },
    dependsOn: ['s1'],
    splittable: true,
  },
  {
    key: 's3',
    title: 'Review',
    deliverable: 'Reviewed report',
    doneCriteria: 'Review complete',
    kind: 'review',
    estimate: { p50Minutes: 30, p90Minutes: 60 },
    dependsOn: ['s2'],
    splittable: false,
  },
];

function generousGuard(): BudgetGuard {
  return new BudgetGuard(
    { dailyUsd: 10, monthlyUsd: 100 },
    { allowUnpricedModels: ['fake-llm'] },
  );
}

async function createSession(
  ctx: TestContext,
  session: TestSession,
  input: IntakeInput,
): Promise<{ response: Awaited<ReturnType<TestContext['app']['inject']>>; body?: IntakeSessionDto }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/intake-sessions',
    headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    payload: { input },
  });
  return {
    response,
    ...(response.statusCode < 300
      ? { body: response.json() as IntakeSessionDto }
      : {}),
  };
}

function actionHeaders(session: TestSession, version: number): Record<string, string> {
  return authHeaders(session, {
    'if-match': `W/"${version}"`,
    'idempotency-key': newIdempotencyKey(),
  });
}

describe.skipIf(!hasDatabaseEnv)('intake sessions', () => {
  test('a failed repair persists the accumulated usage of the charged detection attempt', async () => {
    const detectionInput = buildDetectionLlmInput(readyInput, [], SEEDED_LANGUAGE);
    const invalid = { classification: 'maybe' };
    const errors = validateOutput('llm.type_detection.v1', invalid).errors;
    // M6-01 fix round 1: the repair input repeats the rendered output contract.
    const repairedInput = appendValidationErrors(detectionInput.input, errors, 'llm.type_detection.v1');
    const llm = new FakeLlm([
      {
        promptId: 'type_detection',
        input: detectionInput.input,
        response: {
          output: invalid,
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
        },
      },
      {
        promptId: 'type_detection',
        input: repairedInput,
        response: {
          error: new LlmUnavailable('gateway rejected the repair', 'provider', false),
        },
      },
    ]);
    const ctx = await createTestContext({ llm, budgetGuard: generousGuard() });
    const ownerId = await ctx.seedUser({
      email: 'intake-usage@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'intake-usage@example.com', 'correct-horse');

    try {
      const created = await createSession(ctx, session, readyInput);
      expect(created.response.statusCode).toBe(201);
      expect((created.body as IntakeSessionDto).manual).toBe(true);

      const run = await ctx.db
        .selectFrom('agent_run')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .where('purpose', '=', 'detect_type')
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('failed');
      expect(run.tokens_in).toBe(100);
      expect(run.tokens_out).toBe(10);
      expect(Number(run.cost_usd)).toBeCloseTo(0.1, 12);
    } finally {
      await ctx.close();
    }
  });

  test('scenario A: new type detection, decomposition, draft edit, idempotent approval', async () => {
    const detectionInput = buildDetectionLlmInput(readyInput, [], SEEDED_LANGUAGE);
    const answerInput: IntakeInput = { ...readyInput, priority: 2 };
    const decompositionInput = buildDecompositionLlmInput(answerInput, undefined, SEEDED_LANGUAGE);
    const llm = new FakeLlm([
      {
        promptId: 'type_detection',
        input: detectionInput.input,
        response: {
          output: {
            classification: 'new',
            confidence: 0.91,
            reasons: ['fixture: no similar template'],
            missingRequired: [],
          },
        },
      },
      {
        promptId: 'decomposition',
        input: decompositionInput.input,
        response: { output: validDraft },
      },
    ]);
    const ctx = await createTestContext({ llm, budgetGuard: generousGuard() });
    const aliceId = await ctx.seedUser({
      email: 'intake-a@example.com',
      password: 'correct-horse',
    });
    await ctx.seedUser({ email: 'intake-b@example.com', password: 'correct-horse' });
    const alice = await login(ctx, 'intake-a@example.com', 'correct-horse');
    const bob = await login(ctx, 'intake-b@example.com', 'correct-horse');

    try {
      const created = await createSession(ctx, alice, readyInput);
      expect(created.response.statusCode).toBe(201);
      const session = created.body as IntakeSessionDto;
      expect(session.state).toBe('clarification');
      expect(session.detectedType?.classification).toBe('new');
      expect(session.manual).toBe(false);
      expect(session.questions?.length).toBeGreaterThan(0);

      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${session.id}/answers`,
        headers: actionHeaders(alice, session.version),
        payload: { answers: [{ questionKey: 'priority', action: 'answer', value: 2 }] },
      });
      expect(answered.statusCode).toBe(200);
      const decomposing = answered.json() as IntakeSessionDto;
      expect(decomposing.state).toBe('decomposition');
      const draft = decomposing.draft;
      expect(draft).toBeDefined();
      expect(draft?.steps).toHaveLength(3);
      expect(draft?.steps[1]?.dependsOn).toEqual(['s1']);

      const proposals = await ctx.db
        .selectFrom('agent_proposal')
        .selectAll()
        .where('owner_id', '=', aliceId)
        .execute();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.constraint_ok).toBe(false);

      const runs = await ctx.db
        .selectFrom('agent_run')
        .selectAll()
        .where('owner_id', '=', aliceId)
        .execute();
      const purposes = runs.map((run) => run.purpose).sort();
      expect(purposes).toEqual(['decomposition', 'detect_type']);
      const detectionRun = runs.find((run) => run.purpose === 'detect_type');
      expect(detectionRun?.model).toBe('fake-llm');
      expect(detectionRun?.status).toBe('succeeded');
      expect(detectionRun?.redaction_report).toMatchObject({ email: 1 });

      const stale = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/intake-sessions/${session.id}/draft`,
        headers: actionHeaders(alice, session.version + 10),
        payload: { assumptions: ['stale'] },
      });
      expect(stale.statusCode).toBe(412);

      const missingPrecondition = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/intake-sessions/${session.id}/draft`,
        headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
        payload: { assumptions: ['missing if-match'] },
      });
      expect(missingPrecondition.statusCode).toBe(428);

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/intake-sessions/${session.id}/draft`,
        headers: actionHeaders(alice, decomposing.version),
        payload: { steps: draft?.steps, assumptions: ['edited by user'] },
      });
      expect(patched.statusCode).toBe(200);
      expect((patched.json() as { assumptions: string[] }).assumptions).toEqual([
        'edited by user',
      ]);
      const patchedVersion = Number(patched.headers['etag']?.toString().slice(3, -1));

      const key = newIdempotencyKey();
      const approveHeaders = authHeaders(alice, {
        'if-match': `W/"${patchedVersion}"`,
        'idempotency-key': key,
      });
      const approved = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${session.id}/draft:approve`,
        headers: approveHeaders,
      });
      expect(approved.statusCode).toBe(200);
      const approvedSession = approved.json() as IntakeSessionDto;
      expect(approvedSession.state).toBe('feasibility_check');

      const replay = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${session.id}/draft:approve`,
        headers: approveHeaders,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(approved.json());

      const tasksResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/tasks?limit=100',
        headers: authHeaders(alice),
      });
      expect(tasksResponse.statusCode).toBe(200);
      const tasks = (tasksResponse.json() as {
        items: { id: string; title: string; dependsOn: string[] }[];
      }).items;
      expect(tasks).toHaveLength(3);
      const gather = tasks.find((task) => task.title === 'Gather quarterly inputs');
      const write = tasks.find((task) => task.title === 'Write the report');
      expect(write?.dependsOn).toEqual([gather?.id]);

      const secondApprove = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${session.id}/draft:approve`,
        headers: authHeaders(alice, {
          'if-match': `W/"${approvedSession.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      expect(secondApprove.statusCode).toBe(409);
      expect(secondApprove.json()).toMatchObject({ code: 'illegal_transition' });

      const stranger = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${session.id}`,
        headers: authHeaders(bob),
      });
      expect(stranger.statusCode).toBe(404);

      const illegalPause = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${session.id}:pause`,
        headers: actionHeaders(alice, approvedSession.version),
      });
      expect(illegalPause.statusCode).toBe(409);
      expect(illegalPause.json()).toMatchObject({ code: 'illegal_transition' });

      const cancelled = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${session.id}:cancel`,
        headers: actionHeaders(alice, approvedSession.version),
      });
      expect(cancelled.statusCode).toBe(200);
      expect((cancelled.json() as IntakeSessionDto).state).toBe('cancelled');

      const resumeCancelled = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${session.id}:resume`,
        headers: actionHeaders(alice, (cancelled.json() as IntakeSessionDto).version),
      });
      expect(resumeCancelled.statusCode).toBe(409);
      expect(resumeCancelled.json()).toMatchObject({ code: 'illegal_transition' });
    } finally {
      await ctx.close();
    }
  });

  test('scenario B: similar type requires confirmation and rejecting it clarifies as new', async () => {
    const ctx = await createTestContext({ llm: new FakeLlm(), budgetGuard: generousGuard() });
    const ownerId = await ctx.seedUser({
      email: 'intake-similar@example.com',
      password: 'correct-horse',
    });
    await ctx.seedTemplate({ ownerId, name: 'Quarterly report', steps: templateSteps });
    await ctx.seedTemplate({ ownerId, name: 'Conference talk', steps: templateSteps });
    await ctx.seedTemplate({ ownerId, name: 'Home renovation', steps: templateSteps });
    const session = await login(ctx, 'intake-similar@example.com', 'correct-horse');
    try {
      const created = await createSession(ctx, session, {
        title: 'Quarterly report for Q3',
        deliverable: 'Quarterly report for Q3',
      });
      expect(created.response.statusCode).toBe(201);
      const body = created.body as IntakeSessionDto;
      expect(body.state).toBe('type_detection');
      expect(body.detectedType?.classification).toBe('similar');
      const templateId = body.detectedType?.templateId;
      expect(templateId).toBeDefined();
      const fingerprints = await ctx.db
        .selectFrom('task_type_fingerprint')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .execute();
      expect(fingerprints).toHaveLength(0);
      await ctx.seedFingerprint({ ownerId, templateId: templateId as never });

      const rejected = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}/type-confirmation`,
        headers: actionHeaders(session, body.version),
        payload: { similar: false },
      });
      expect(rejected.statusCode).toBe(200);
      const clarified = rejected.json() as IntakeSessionDto;
      expect(clarified.state).toBe('clarification');
      expect(clarified.detectedType?.classification).toBe('new');
      expect(clarified.questions?.length).toBeGreaterThan(0);

      const fingerprintsAfter = await ctx.db
        .selectFrom('task_type_fingerprint')
        .select(['false_positive_count'])
        .where('owner_id', '=', ownerId)
        .execute();
      expect(fingerprintsAfter[0]?.false_positive_count).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  test('schema failure is repaired once and falls back to manual mode', async () => {
    const detectionInput = buildDetectionLlmInput({ title: 'Write a poem', deliverable: 'Write a poem' }, [], SEEDED_LANGUAGE);
    const invalidOutput = { classification: 'bogus', confidence: 2 };
    // M6-01 fix round 1: the repair input repeats the rendered output contract.
    const repairInput = appendValidationErrors(
      detectionInput.input,
      validateOutput('llm.type_detection.v1', invalidOutput).errors,
      'llm.type_detection.v1',
    );
    const llm = new FakeLlm([
      {
        promptId: 'type_detection',
        input: detectionInput.input,
        response: { output: invalidOutput },
      },
      {
        promptId: 'type_detection',
        input: repairInput,
        response: { output: { classification: 'still-bogus' } },
      },
    ]);
    const ctx = await createTestContext({ llm, budgetGuard: generousGuard() });
    await ctx.seedUser({ email: 'intake-schema@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'intake-schema@example.com', 'correct-horse');
    try {
      const created = await createSession(ctx, session, { title: 'Write a poem', deliverable: 'Write a poem' });
      expect(created.response.statusCode).toBe(201);
      const body = created.body as IntakeSessionDto;
      expect(body.manual).toBe(true);
      expect(body.error?.code).toBe('llm_unavailable');
      // One invalid attempt + one repair attempt, never a full second repair.
      expect(llm.callCount).toBe(2);
    } finally {
      await ctx.close();
    }
  });

  test('budget exhaustion degrades to 201 manual with Location/ETag', async () => {
    const guard = new BudgetGuard(
      { dailyUsd: 0.01, monthlyUsd: 0.01 },
      {
        spentTodayUsd: 0.01,
        spentThisMonthUsd: 0.01,
        allowUnpricedModels: ['fake-llm'],
      },
    );
    const ctx = await createTestContext({
      llm: new FakeLlm(),
      budgetGuard: guard,
    });
    await ctx.seedUser({ email: 'intake-budget@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'intake-budget@example.com', 'correct-horse');
    try {
      const created = await createSession(ctx, session, readyInput);
      expect(created.response.statusCode).toBe(201);
      expect(created.response.headers['location']).toBe(
        `/api/v1/intake-sessions/${(created.body as IntakeSessionDto).id}`,
      );
      expect(created.response.headers['etag']).toMatch(/^W\/"\d+"$/);
      expect((created.body as IntakeSessionDto).manual).toBe(true);
      expect((created.body as IntakeSessionDto).error?.code).toBe('budget_exceeded');

      const list = await ctx.db
        .selectFrom('intake_session')
        .selectAll()
        .execute();
      expect(list).toHaveLength(1);
      expect(list[0]?.manual).toBe(true);

      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${list[0]?.id}`,
        headers: authHeaders(session),
      });
      expect(read.statusCode).toBe(200);
      const persisted = read.json() as IntakeSessionDto;
      expect(persisted.manual).toBe(true);
      expect(persisted.error?.code).toBe('budget_exceeded');

      const manual = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${persisted.id}:manual`,
        headers: actionHeaders(session, persisted.version),
      });
      expect(manual.statusCode).toBe(200);
      expect((manual.json() as IntakeSessionDto).state).toBe('clarification');
    } finally {
      await ctx.close();
    }
  });

  test('missing LLM provider degrades to 201 llm_unavailable and manual still works', async () => {
    const ctx = await createTestContext();
    await ctx.seedUser({ email: 'intake-no-llm@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'intake-no-llm@example.com', 'correct-horse');
    try {
      const created = await createSession(ctx, session, { title: 'Offline plan', deliverable: 'Offline plan' });
      expect(created.response.statusCode).toBe(201);
      expect((created.body as IntakeSessionDto).manual).toBe(true);
      expect((created.body as IntakeSessionDto).error?.code).toBe('llm_unavailable');

      const row = await ctx.db.selectFrom('intake_session').selectAll().executeTakeFirstOrThrow();
      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${row.id}`,
        headers: authHeaders(session),
      });
      expect(read.statusCode).toBe(200);
      const persisted = read.json() as IntakeSessionDto;

      const manual = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${persisted.id}:manual`,
        headers: actionHeaders(session, persisted.version),
      });
      expect(manual.statusCode).toBe(200);
      const manualSession = manual.json() as IntakeSessionDto;
      expect(manualSession.manual).toBe(true);
      expect(manualSession.state).toBe('clarification');

      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${persisted.id}/answers`,
        headers: actionHeaders(session, manualSession.version),
        payload: {
          answers: [
            { questionKey: 'deliverable', action: 'answer', value: 'Offline plan' },
            { questionKey: 'dueAt', action: 'skip' },
            { questionKey: 'estimatedScope', action: 'idk' },
            { questionKey: 'currentProgress', action: 'skip' },
            { questionKey: 'availabilityConfirmed', action: 'skip' },
          ],
        },
      });
      expect(answered.statusCode).toBe(200);
      const withDraft = answered.json() as IntakeSessionDto;
      expect(withDraft.state).toBe('decomposition');
      expect(withDraft.draft?.steps.length).toBeGreaterThanOrEqual(3);
    } finally {
      await ctx.close();
    }
  });

  test('templates are owner-scoped and searchable', async () => {
    const ctx = await createTestContext({ budgetGuard: generousGuard() });
    const aliceId = await ctx.seedUser({
      email: 'intake-templates-a@example.com',
      password: 'correct-horse',
    });
    await ctx.seedUser({ email: 'intake-templates-b@example.com', password: 'correct-horse' });
    const alice = await login(ctx, 'intake-templates-a@example.com', 'correct-horse');
    const bob = await login(ctx, 'intake-templates-b@example.com', 'correct-horse');
    const templateId = await ctx.seedTemplate({
      ownerId: aliceId,
      name: 'Quarterly report',
      steps: templateSteps,
    });
    try {
      const found = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/templates?query=quarterly',
        headers: authHeaders(alice),
      });
      expect(found.statusCode).toBe(200);
      expect((found.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
        templateId,
      ]);

      const byId = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/templates/${templateId}`,
        headers: authHeaders(alice),
      });
      expect(byId.statusCode).toBe(200);
      expect((byId.json() as { steps: unknown[] }).steps).toHaveLength(3);

      const stranger = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/templates/${templateId}`,
        headers: authHeaders(bob),
      });
      expect(stranger.statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});
