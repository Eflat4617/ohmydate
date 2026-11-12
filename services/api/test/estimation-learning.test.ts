import type {
  EstimationFeedback,
  EstimationProfile,
  EstimationProfileItem,
  IntakeInput,
  IntakeSessionDto,
  ReplanProposal,
  WorkSession,
} from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import { BudgetGuard, FakeLlm } from '@ohmydate/llm';
import { PgEstimationStore } from '../src/adapters/pg-estimation-store.js';
import {
  buildDecompositionLlmInput,
  buildDetectionLlmInput,
  editedEstimateKeys,
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
import {
  approvedPlan,
  linkTaskToTemplate,
  listProposals,
  minutesOf,
  putM5Availability,
  replanServiceFor,
  seedPlanTask,
} from './support/m5-fixtures.js';

/** FU-89: seeded test users keep the DB default locale `en`, so intake LLM calls send `en`. */
const SEEDED_LANGUAGE = resolveOutputLanguage('en');

const START = '2026-11-11T08:00:00Z' as Instant;

describe('FU-48 edited draft estimate keys (unit)', () => {
  const step = (key: string, p50: number, p90: number) => ({
    key,
    estimate: { p50Minutes: p50, p90Minutes: p90 },
  });

  it('marks changed and new steps, keeps earlier edits, drops removed keys', () => {
    expect(
      editedEstimateKeys(
        [step('s1', 30, 60), step('s2', 120, 240), step('s3', 30, 60)],
        [step('s1', 30, 60), step('s2', 150, 240), step('s4', 15, 30)],
        ['s3'],
      ),
    ).toEqual(['s2', 's4']);
    expect(
      editedEstimateKeys([step('s1', 30, 60)], [step('s1', 30, 60)], ['s1']),
    ).toEqual(['s1']);
  });

  it('reports nothing when only non-estimate fields change (negative)', () => {
    expect(editedEstimateKeys([step('s1', 30, 60)], [step('s1', 30, 60)], [])).toEqual([]);
  });
});

describe.skipIf(!hasDatabase)('estimation learning API (M5-02)', () => {
  let ctx: TestContext;
  let counter = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  async function newOwner(label: string): Promise<{ ownerId: Id; session: TestSession }> {
    counter += 1;
    const email = `m5-est-${label}-${counter}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    await putM5Availability(ctx, session);
    return { ownerId, session };
  }

  async function currentEstimate(ownerId: Id, taskId: Id) {
    return ctx.db
      .selectFrom('estimate')
      .select(['id', 'p50_min', 'p90_min', 'method', 'confidence'])
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', taskId)
      .where('is_current', '=', true)
      .executeTakeFirstOrThrow();
  }

  /** Run a 120-minute completed session on `taskId` and review it. */
  async function reviewedSession(
    session: TestSession,
    taskId: Id,
    focusMin: number,
  ): Promise<EstimationFeedback> {
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        taskId,
        clientId: 'device-1',
        clientStartedAt: new Date(Date.parse(START) - focusMin * 60_000).toISOString(),
      },
    });
    expect(started.statusCode).toBe(201);
    const work = started.json() as WorkSession;
    const completed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${work.id}:complete`,
      headers: authHeaders(session, { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() }),
      payload: { clientAt: START },
    });
    expect(completed.statusCode).toBe(200);
    const review = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${work.id}/review`,
      headers: authHeaders(session, {
        'if-match': `W/"${(completed.json() as WorkSession).version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { outcome: 'partial', reasonChips: ['task_larger'], note: 'private review note' },
    });
    expect(review.statusCode).toBe(201);
    return review.json() as EstimationFeedback;
  }

  async function profile(session: TestSession, headers: Record<string, string> = {}) {
    return ctx.app.inject({
      method: 'GET',
      url: '/api/v1/estimation/profile',
      headers: authHeaders(session, headers),
    });
  }

  async function patchFeedback(session: TestSession, id: string, version: number, excluded: boolean) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/estimation/feedback/${id}`,
      headers: authHeaders(session, { 'if-match': `W/"${version}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { excluded },
    });
  }

  async function reset(session: TestSession, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/estimation:reset',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: body,
    });
  }

  test('session review quietly updates current estimates; G09: the 200% underestimate triggers deadline_risk', async () => {
    const { ownerId, session } = await newOwner('g09');
    const templateId = await ctx.seedTemplate({ ownerId, name: 'Report', steps: [] });
    const seededTemplateId = (await ctx.seedTemplate({ ownerId, name: 'Seeded', steps: [] })) as Id;
    const worked = await seedPlanTask(ctx, ownerId, { title: 'Worked' });
    const sibling = await seedPlanTask(ctx, ownerId, { title: 'Sibling', dueAt: '2026-11-11T17:00:00Z' });
    const unrelated = await seedPlanTask(ctx, ownerId, { title: 'Unrelated' });
    await linkTaskToTemplate(ctx, ownerId, worked.id, templateId as Id);
    await linkTaskToTemplate(ctx, ownerId, sibling.id, templateId as Id);
    await approvedPlan(ctx, session, [worked.id, sibling.id, unrelated.id]);
    const before = await currentEstimate(ownerId, sibling.id);

    const feedback = await reviewedSession(session, worked.id, 120);
    expect(feedback).toEqual({ taskId: worked.id, estimatedP50: 60, actualFocusMin: 120, quality: 'ok' });

    // ratio 2, n = 1, k = 5: e^(ln 2 / 6) = 1.12 -> 67.3 -> 70 on the 5-min grid.
    const after = await currentEstimate(ownerId, sibling.id);
    expect(after).toMatchObject({ p50_min: 70, p90_min: 70, method: 'personal' });
    expect(after.id).not.toBe(before.id);
    const history = await ctx.db
      .selectFrom('estimate')
      .select(['id', 'is_current'])
      .where('task_id', '=', sibling.id)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    expect(history).toEqual([
      { id: before.id, is_current: false },
      { id: after.id, is_current: true },
    ]);
    const evidence = await ctx.db
      .selectFrom('estimate_evidence')
      .select(['kind', 'ref', 'summary'])
      .where('estimate_id', '=', after.id)
      .orderBy('kind', 'asc')
      .execute();
    expect(evidence.map((row) => row.kind)).toEqual(['personal_correction', 'template']);
    expect(evidence.every((row) => !String(row.summary).includes('private'))).toBe(true);
    // A task outside the template group is not corrected.
    expect(await currentEstimate(ownerId, unrelated.id)).toMatchObject({ p50_min: 60, method: 'template' });
    const template = await ctx.db
      .selectFrom('task_template')
      .select('stats')
      .where('id', '=', templateId as Id)
      .executeTakeFirstOrThrow();
    expect(template.stats).toMatchObject({ sampleCount: 1, source: 'estimator@1' });
    // A template without personal samples keeps its seeded (non-learned) stats.
    const untouched = await ctx.db
      .selectFrom('task_template')
      .select('stats')
      .where('id', '=', seededTemplateId)
      .executeTakeFirstOrThrow();
    expect(untouched.stats).toEqual({ sampleCount: 3, meanRatio: 1.1, p90Ratio: 1.4 });

    // G09: P90 70 > 60 planned before the 17:00 deadline -> slack -10 < 0.
    expect(await replanServiceFor(ctx).runDetection(ctx.clock.now())).toBe(1);
    const proposal = (await listProposals(ctx, session, 'pending'))[0] as ReplanProposal;
    expect(proposal.trigger).toMatchObject({ kind: 'deadline_risk', affectedTaskIds: [sibling.id] });
    expect(minutesOf(proposal.candidate.blocks, sibling.id)).toBe(70);
  });

  test('profile, feedback exclusion/re-inclusion and reset recompute the current estimates', async () => {
    const { ownerId, session } = await newOwner('profile');
    const templateId = (await ctx.seedTemplate({ ownerId, name: 'Essay', steps: [] })) as Id;
    const worked = await seedPlanTask(ctx, ownerId, { title: 'Worked' });
    const sibling = await seedPlanTask(ctx, ownerId, { title: 'Sibling' });
    await linkTaskToTemplate(ctx, ownerId, worked.id, templateId);
    await linkTaskToTemplate(ctx, ownerId, sibling.id, templateId);
    await approvedPlan(ctx, session, [worked.id, sibling.id]);
    const feedback = await reviewedSession(session, worked.id, 120);
    void feedback;

    const read = await profile(session);
    expect(read.statusCode).toBe(200);
    const body = read.json() as EstimationProfile;
    expect(body).toMatchObject({ sampleCount: 1, shrinkageK: 5, outlierZThreshold: 2.5 });
    expect(body.groups).toEqual([
      expect.objectContaining({
        dimension: 'template',
        key: `template:${templateId}`,
        templateId,
        sampleCount: 1,
      }),
    ]);
    const item = body.items[0] as EstimationProfileItem;
    expect(item).toMatchObject({
      taskId: worked.id,
      templateId,
      estimatedP50: 60,
      actualFocusMin: 120,
      ratio: 2,
      quality: 'ok',
      excluded: false,
      version: 1,
    });
    const cached = await profile(session, { 'if-none-match': String(read.headers['etag']) });
    expect(cached.statusCode).toBe(304);

    const stale = await patchFeedback(session, item.feedbackId, 7, true);
    expect(stale.statusCode).toBe(412);
    const excluded = await patchFeedback(session, item.feedbackId, 1, true);
    expect(excluded.statusCode).toBe(200);
    expect(excluded.json()).toMatchObject({ feedbackId: item.feedbackId, excluded: true, version: 2 });
    expect(await currentEstimate(ownerId, sibling.id)).toMatchObject({ p50_min: 60, method: 'template' });
    expect((await profile(session)).json()).toMatchObject({ sampleCount: 0 });

    const included = await patchFeedback(session, item.feedbackId, 2, false);
    expect(included.statusCode).toBe(200);
    expect(await currentEstimate(ownerId, sibling.id)).toMatchObject({ p50_min: 70, method: 'personal' });

    const other = await newOwner('profile-other');
    expect((await patchFeedback(other.session, item.feedbackId, 3, true)).statusCode).toBe(404);
    expect((await profile(other.session)).json()).toMatchObject({ sampleCount: 0, items: [] });

    const missingTemplate = await reset(session, { scope: 'template' });
    expect(missingTemplate.statusCode).toBe(422);
    expect(missingTemplate.json()).toMatchObject({ code: 'validation_failed' });
    const unknownTemplate = await reset(session, { scope: 'template', templateId: ctx.ids.next() });
    expect(unknownTemplate.statusCode).toBe(422);
    const foreign = await reset(other.session, { scope: 'template', templateId });
    expect(foreign.statusCode).toBe(422);
    expect(await currentEstimate(ownerId, sibling.id)).toMatchObject({ p50_min: 70 });

    const resetTemplate = await reset(session, { scope: 'template', templateId });
    expect(resetTemplate.statusCode).toBe(200);
    expect(resetTemplate.json()).toMatchObject({ sampleCount: 0, items: [] });
    expect(await currentEstimate(ownerId, sibling.id)).toMatchObject({ p50_min: 60, method: 'template' });
    const stats = await ctx.db
      .selectFrom('task_template')
      .select('stats')
      .where('id', '=', templateId)
      .executeTakeFirstOrThrow();
    expect(stats.stats).toEqual({});

    // scope=all forgets everything, including samples without a template.
    const loose = await seedPlanTask(ctx, ownerId, { title: 'Loose' });
    void loose;
    const resetAll = await reset(session, { scope: 'all' });
    expect(resetAll.statusCode).toBe(200);
    const remaining = await ctx.db
      .selectFrom('estimation_feedback')
      .select('id')
      .where('owner_id', '=', ownerId)
      .execute();
    expect(remaining).toEqual([]);
  });
});

describe.skipIf(!hasDatabase)('FU-48 intake approval records user-edited estimates', () => {
  const input: IntakeInput = {
    title: 'Quarterly report',
    deliverable: 'Write the quarterly report for Q3',
    dueAt: '2026-12-01T00:00:00.000Z',
    estimatedScope: 'medium',
    currentProgress: 0.1,
    availabilityConfirmed: true,
  };
  const draft = {
    steps: [
      {
        key: 's1',
        title: 'Gather inputs',
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
        dependsOn: ['s1'],
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

  async function approvedIntake(edit: boolean): Promise<{ ctx: TestContext; ownerId: Id; titles: Map<string, string> }> {
    const answerInput: IntakeInput = { ...input, priority: 2 };
    const llm = new FakeLlm([
      {
        promptId: 'type_detection',
        input: buildDetectionLlmInput(input, [], SEEDED_LANGUAGE).input,
        response: {
          output: { classification: 'new', confidence: 0.9, reasons: ['fixture'], missingRequired: [] },
        },
      },
      {
        promptId: 'decomposition',
        input: buildDecompositionLlmInput(answerInput, undefined, SEEDED_LANGUAGE).input,
        response: { output: draft },
      },
    ]);
    const ctx = await createTestContext({
      llm,
      budgetGuard: new BudgetGuard({ dailyUsd: 10, monthlyUsd: 100 }, { allowUnpricedModels: ['fake-llm'] }),
    });
    const email = `fu48-${edit ? 'edit' : 'plain'}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/intake-sessions',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { input },
    });
    expect(created.statusCode).toBe(201);
    const intake = created.json() as IntakeSessionDto;
    const answered = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/intake-sessions/${intake.id}/answers`,
      headers: authHeaders(session, { 'if-match': `W/"${intake.version}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { answers: [{ questionKey: 'priority', action: 'answer', value: 2 }] },
    });
    expect(answered.statusCode).toBe(200);
    const decomposing = answered.json() as IntakeSessionDto;
    const steps = (decomposing.draft?.steps ?? []).map((step) =>
      edit && step.key === 's2'
        ? { ...step, estimate: { p50Minutes: 150, p90Minutes: 240 } }
        : step,
    );
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/intake-sessions/${intake.id}/draft`,
      headers: authHeaders(session, { 'if-match': `W/"${decomposing.version}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { steps, assumptions: ['user looked at it'] },
    });
    expect(patched.statusCode).toBe(200);
    const version = Number(String(patched.headers['etag']).slice(3, -1));
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/intake-sessions/${intake.id}/draft:approve`,
      headers: authHeaders(session, { 'if-match': `W/"${version}"`, 'idempotency-key': newIdempotencyKey() }),
    });
    expect(approved.statusCode).toBe(200);
    const tasks = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/tasks?limit=100',
      headers: authHeaders(session),
    });
    const titles = new Map(
      (tasks.json() as { items: { id: string; title: string }[] }).items.map((task) => [task.title, task.id]),
    );
    return { ctx, ownerId, titles };
  }

  async function methods(ctx: TestContext, ownerId: Id, titles: Map<string, string>) {
    const rows = await ctx.db
      .selectFrom('estimate')
      .select(['task_id', 'method', 'p50_min', 'confidence'])
      .where('owner_id', '=', ownerId)
      .where('is_current', '=', true)
      .execute();
    const byTask = new Map(rows.map((row) => [row.task_id, row]));
    return Object.fromEntries(
      [...titles].map(([title, id]) => [title, byTask.get(id)]),
    );
  }

  test('the edited step is recorded as personal with the edited value; others keep llm', async () => {
    const { ctx, ownerId, titles } = await approvedIntake(true);
    try {
      // LLM cold start: 30 x 1.3 = 39 -> 40 on the grid, confidence <= 0.3.
      expect(await methods(ctx, ownerId, titles)).toMatchObject({
        'Gather inputs': { method: 'llm', p50_min: 40, confidence: 0.3 },
        'Write the report': { method: 'personal', p50_min: 150, confidence: 0.5 },
        'Review the report': { method: 'llm', p50_min: 40 },
      });
      // The intake ledger is the estimator's task context: kinds resolve.
      const snapshot = await new PgEstimationStore({ db: ctx.db, ids: ctx.ids }).snapshot(ownerId);
      expect(snapshot.contexts.get(titles.get('Write the report') as string)).toEqual({ kind: 'work' });
      expect(snapshot.contexts.get(titles.get('Gather inputs') as string)).toEqual({ kind: 'prep' });
    } finally {
      await ctx.close();
    }
  });

  test('a patch that leaves estimates untouched keeps the generator method (negative)', async () => {
    const { ctx, ownerId, titles } = await approvedIntake(false);
    try {
      const recorded = await methods(ctx, ownerId, titles);
      expect(Object.values(recorded).map((row) => row?.method)).toEqual(['llm', 'llm', 'llm']);
    } finally {
      await ctx.close();
    }
  });
});
