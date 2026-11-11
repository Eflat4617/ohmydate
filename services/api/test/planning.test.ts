import { randomUUID } from 'node:crypto';
import { planningRoutes, type Plan } from '@ohmydate/contracts';
import type { Id, Instant, Task } from '@ohmydate/domain';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

const AVAILABILITY_BODY = {
  timeZone: 'UTC',
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startLocal: '09:00',
    endLocal: '18:00',
    kind: 'work',
  })),
  exceptions: [],
  prefs: {
    maxDailyFocusMin: 480,
    breakAfterMin: 60,
    breakMin: 15,
    dayStartLocal: '08:00',
    dayEndLocal: '18:00',
    riskLevel: 'p50',
  },
};

const HORIZON = {
  start: '2026-11-11T00:00:00Z',
  end: '2026-11-14T00:00:00Z',
};

interface SeededTask {
  readonly task: Task;
  readonly projectId: string;
}

async function seedTask(
  ctx: TestContext,
  ownerId: Id,
  options: {
    title?: string;
    estimate?: { p50Min: number; p90Min: number } | null;
    dueAt?: string;
    goalId?: string;
  } = {},
): Promise<SeededTask> {
  const project = await ctx.repos.projects.create(
    ownerId,
    { title: options.goalId === undefined ? 'Plan project' : 'Goal project' },
    randomUUID(),
  );
  await ctx.db
    .insertInto('project')
    .values({
      id: project.id,
      owner_id: ownerId,
      title: project.title,
      kind: 'normal',
      ...(options.goalId === undefined ? {} : { goal_id: options.goalId }),
    })
    .execute();
  const task = await ctx.repos.tasks.create(
    ownerId,
    {
      projectId: project.id,
      title: options.title ?? 'Plan task',
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt as Instant }),
    },
    randomUUID(),
  );
  await ctx.db
    .insertInto('task')
    .values({
      id: task.id,
      owner_id: ownerId,
      project_id: project.id,
      title_cache: task.title,
      status_cache: 'todo',
      due_at: options.dueAt === undefined ? null : new Date(Date.parse(options.dueAt)),
      splittable: true,
      min_session_min: 30,
      max_session_min: 90,
      priority: 2,
    })
    .execute();
  if (options.estimate !== null) {
    const estimate = options.estimate ?? { p50Min: 60, p90Min: 60 };
    await ctx.db
      .insertInto('estimate')
      .values({
        id: ctx.ids.next(),
        owner_id: ownerId,
        task_id: task.id,
        p50_min: estimate.p50Min,
        p90_min: estimate.p90Min,
        method: 'template',
        confidence: 0.6,
        is_current: true,
      })
      .execute();
  }
  return { task, projectId: project.id };
}

async function currentAvailabilityVersion(
  ctx: TestContext,
  session: TestSession,
): Promise<number> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/availability',
    headers: authHeaders(session),
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { version: number }).version;
}

async function putAvailability(
  ctx: TestContext,
  session: TestSession,
  body: typeof AVAILABILITY_BODY = AVAILABILITY_BODY,
): Promise<number> {
  const expectedVersion = await currentAvailabilityVersion(ctx, session);
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/availability',
    headers: authHeaders(session, {
      'if-match': `W/"availability:${expectedVersion}"`,
      'idempotency-key': newIdempotencyKey(),
    }),
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { version: number }).version;
}

async function createPlan(
  ctx: TestContext,
  session: TestSession,
  taskIds: readonly string[],
): Promise<Plan> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/plans',
    headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    payload: { scope: { taskIds }, policies: ['balanced'], horizon: HORIZON },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Plan;
}

describe.skipIf(!hasDatabase)('planning API (M3-04)', () => {
  let ctx: TestContext;
  let aliceId: Id;
  let bob: TestSession;

  beforeAll(async () => {
    ctx = await createTestContext();
    aliceId = await ctx.seedUser({ email: 'planner@example.com', password: 'correct-horse' });
    await ctx.seedUser({ email: 'other@example.com', password: 'correct-horse' });
    bob = await login(ctx, 'other@example.com', 'correct-horse');
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('concurrent first availability PUTs: one wins, the other gets 412', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    const make = () =>
      ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/availability',
        headers: authHeaders(session, {
          'if-match': 'W/"availability:1"',
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: AVAILABILITY_BODY,
      });
    const responses = await Promise.all([make(), make()]);
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 412]);
    const conflict = responses.find((response) => response.statusCode === 412);
    expect(conflict?.json()).toMatchObject({ code: 'availability_changed' });

    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/availability',
      headers: authHeaders(session),
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers['etag']).toBe('W/"availability:2"');
  });

  test('commitments CRUD expands rrules and bumps availability_version', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    let version = await putAvailability(ctx, session);

    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Weekly seminar',
        startAt: '2026-11-17T05:00:00Z',
        endAt: '2026-11-17T07:00:00Z',
        timeZone: 'Asia/Seoul',
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
      },
    });
    expect(create.statusCode).toBe(201);
    const commitment = create.json() as { id: string; version: number };
    version += 1;
    const availabilityAfterCreate = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/availability',
      headers: authHeaders(session),
    });
    expect((availabilityAfterCreate.json() as { version: number }).version).toBe(version);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/commitments?from=2026-11-11T00:00:00Z&to=2026-11-25T00:00:00Z',
      headers: authHeaders(session),
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as {
      items: { id: string; occurrences: { startAt: string; endAt: string }[] }[];
    };
    const item = page.items.find((entry) => entry.id === commitment.id);
    expect(item?.occurrences.length).toBeGreaterThanOrEqual(2);

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/commitments/${commitment.id}`,
      headers: authHeaders(session, {
        'if-match': `W/"${commitment.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { title: 'Renamed seminar' },
    });
    expect(patch.statusCode).toBe(200);
    version += 1;
    const patched = patch.json() as { version: number };
    const availabilityAfterPatch = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/availability',
      headers: authHeaders(session),
    });
    expect((availabilityAfterPatch.json() as { version: number }).version).toBe(version);

    const deleteResponse = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/commitments/${commitment.id}`,
      headers: authHeaders(session, {
        'if-match': `W/"${patched.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(deleteResponse.statusCode).toBe(204);
    version += 1;
    const availabilityAfterDelete = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/availability',
      headers: authHeaders(session),
    });
    expect((availabilityAfterDelete.json() as { version: number }).version).toBe(version);

    const tooWide = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/commitments?from=2026-01-01T00:00:00Z&to=2027-02-01T00:00:00Z',
      headers: authHeaders(session),
    });
    expect(tooWide.statusCode).toBe(422);
    expect(tooWide.json()).toMatchObject({ code: 'validation_failed' });

    const badRule = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Bad rule',
        startAt: '2026-11-17T05:00:00Z',
        endAt: '2026-11-17T07:00:00Z',
        timeZone: 'Asia/Seoul',
        rrule: 'FREQ=HOURLY',
      },
    });
    expect(badRule.statusCode).toBe(422);
  });

  test('commitment occurrence cap rejects more than 2000 occurrences per query', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    for (let index = 0; index < 6; index += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/commitments',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: {
          title: `Daily ${index}`,
          startAt: '2026-01-01T09:00:00Z',
          endAt: '2026-01-01T10:00:00Z',
          timeZone: 'UTC',
          rrule: 'FREQ=DAILY',
        },
      });
      expect(response.statusCode).toBe(201);
    }
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/commitments?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z',
      headers: authHeaders(session),
    });
    expect(list.statusCode).toBe(422);
    expect(list.json()).toMatchObject({ code: 'validation_failed' });
  });

  test('plan create rejects missing estimates and non-minute horizons', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, { estimate: null });

    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { scope: { taskIds: [task.id] }, horizon: HORIZON },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ code: 'validation_failed' });
    expect(JSON.stringify(missing.json())).toContain('missing_estimate');
    expect(JSON.stringify(missing.json())).toContain('/scope/');

    const micro = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        scope: { taskIds: [task.id] },
        horizon: { start: '2026-11-11T00:00:00.123456Z', end: HORIZON.end },
      },
    });
    expect(micro.statusCode).toBe(422);

    const tooLong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        scope: { taskIds: [task.id] },
        horizon: { start: '2026-01-01T00:00:00Z', end: '2027-03-01T00:00:00Z' },
      },
    });
    expect(tooLong.statusCode).toBe(422);
  });

  test('goal-scoped plans resolve tasks through project.goal_id', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    await putAvailability(ctx, session);
    const goalId = ctx.ids.next();
    await ctx.db
      .insertInto('goal')
      .values({ id: goalId, owner_id: aliceId, title: 'Goal' })
      .execute();
    await seedTask(ctx, aliceId, { goalId, title: 'Goal task' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { scope: { goalId }, policies: ['balanced'], horizon: HORIZON },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as Plan).scope).toEqual({ goalId });
  });

  test('preview-edit preflights /blocks paths and returns H1-H8 violations', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, { dueAt: '2026-11-13T18:00:00Z' });
    const plan = await createPlan(ctx, session, [task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const url = `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:preview-edit`;

    const readPlan = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/plans/${plan.id}`,
      headers: authHeaders(session),
    });
    expect(readPlan.statusCode).toBe(200);
    expect(readPlan.headers['etag']).toBe(`W/"${plan.version}"`);

    const stalePreview = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(session, {
        'if-match': 'W/"999"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { blocks: [] },
    });
    expect(stalePreview.statusCode).toBe(412);
    expect(stalePreview.json()).toMatchObject({ code: 'version_conflict' });

    const outside = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(session, {
        'if-match': `W/"${plan.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {
        blocks: [
          {
            taskId: task.id,
            startAt: '2026-11-20T09:00:00Z',
            endAt: '2026-11-20T10:00:00Z',
          },
        ],
      },
    });
    expect(outside.statusCode).toBe(422);
    const outsideProblem = outside.json() as {
      code: string;
      errors?: { path: string }[];
    };
    expect(outsideProblem.code).toBe('validation_failed');
    expect(outsideProblem.errors?.[0]?.path).toBe('/blocks/0');

    const unknown = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(session, {
        'if-match': `W/"${plan.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {
        blocks: [
          {
            taskId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c99',
            startAt: '2026-11-12T09:00:00Z',
            endAt: '2026-11-12T10:00:00Z',
          },
        ],
      },
    });
    expect(unknown.statusCode).toBe(422);
    expect((unknown.json() as { errors?: { path: string }[] }).errors?.[0]?.path).toBe(
      '/blocks/0',
    );

    const overlap = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(session, {
        'if-match': `W/"${plan.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {
        blocks: [
          { taskId: task.id, startAt: '2026-11-12T09:00:00Z', endAt: '2026-11-12T10:00:00Z' },
          { taskId: task.id, startAt: '2026-11-12T09:30:00Z', endAt: '2026-11-12T10:30:00Z' },
        ],
      },
    });
    expect(overlap.statusCode).toBe(200);
    expect(overlap.json()).toMatchObject({ feasible: false });
    expect(
      (overlap.json() as { violations: { code: string }[] }).violations.map((violation) => violation.code),
    ).toContain('H1');

    const valid = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(session, {
        'if-match': `W/"${plan.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { blocks: candidate?.blocks ?? [] },
    });
    expect(valid.statusCode).toBe(200);
    expect((valid.json() as { feasible: boolean }).feasible).toBe(true);
  });

  test('approve is atomic, idempotent and rejects stale availability', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, { dueAt: '2026-11-13T18:00:00Z' });
    const plan = await createPlan(ctx, session, [task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const url = `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`;
    const key = newIdempotencyKey();
    const headers = authHeaders(session, {
      'if-match': `W/"availability:${availabilityVersion}"`,
      'idempotency-key': key,
    });

    const first = await ctx.app.inject({ method: 'POST', url, headers, payload: {} });
    expect(first.statusCode).toBe(201);
    const version = first.json() as { id: string; seq: number; blocks: unknown[] };

    const replay = await ctx.app.inject({ method: 'POST', url, headers, payload: {} });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(version);
    const approvals = await ctx.db
      .selectFrom('schedule_approval')
      .select('id')
      .where('owner_id', '=', aliceId)
      .where('idempotency_key', '=', key)
      .execute();
    expect(approvals).toHaveLength(1);

    const bumped = await putAvailability(ctx, session);
    const staleAvailability = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${bumped - 1}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(staleAvailability.statusCode).toBe(412);
    expect(staleAvailability.json()).toMatchObject({ code: 'availability_changed' });

    const active = await ctx.db
      .selectFrom('schedule_block')
      .select(['start_at', 'end_at'])
      .where('owner_id', '=', aliceId)
      .where('status', '<>', 'superseded')
      .execute();
    expect(active.length).toBeGreaterThan(0);
  });

  test('approve preflights /editedBlocks and maps validator findings to constraint_violation', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, {
      dueAt: '2026-11-13T18:00:00Z',
      title: 'Edited task',
    });
    const plan = await createPlan(ctx, session, [task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const url = `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`;

    const outside = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {
        editedBlocks: [
          {
            taskId: task.id,
            startAt: '2026-11-20T09:00:00Z',
            endAt: '2026-11-20T10:00:00Z',
          },
        ],
      },
    });
    expect(outside.statusCode).toBe(422);
    expect((outside.json() as { errors?: { path: string }[] }).errors?.[0]?.path).toBe(
      '/editedBlocks/0',
    );

    const overlap = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {
        editedBlocks: [
          { taskId: task.id, startAt: '2026-11-12T09:00:00Z', endAt: '2026-11-12T10:00:00Z' },
          { taskId: task.id, startAt: '2026-11-12T09:30:00Z', endAt: '2026-11-12T10:30:00Z' },
        ],
      },
    });
    expect(overlap.statusCode).toBe(422);
    expect(overlap.json()).toMatchObject({ code: 'constraint_violation' });
    expect(
      (overlap.json() as { violations: { code: string }[] }).violations.map(
        (violation) => violation.code,
      ),
    ).toContain('H1');
  });

  test('two concurrent approvals: one 201, one conflict, no overlapping active blocks', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, {
      dueAt: '2026-11-13T18:00:00Z',
      title: 'Race task',
    });
    const plan = await createPlan(ctx, session, [task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const url = `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`;
    const make = () =>
      ctx.app.inject({
        method: 'POST',
        url,
        headers: authHeaders(session, {
          'if-match': `W/"availability:${availabilityVersion}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {},
      });
    const responses = await Promise.all([make(), make()]);
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses[0]).toBe(201);
    expect([409, 412]).toContain(statuses[1]);

    const blocks = await ctx.db
      .selectFrom('schedule_block')
      .select(['plan_version_id', 'start_at', 'end_at'])
      .where('owner_id', '=', aliceId)
      .where('status', '<>', 'superseded')
      .execute();
    const byInterval = new Map<string, Set<string>>();
    for (const block of blocks) {
      const key = `${block.start_at.toISOString()}|${block.end_at.toISOString()}`;
      const versions = byInterval.get(key) ?? new Set<string>();
      versions.add(block.plan_version_id);
      byInterval.set(key, versions);
    }
    for (const versions of byInterval.values()) {
      expect(versions.size).toBe(1);
    }
  });

  test('regenerate keeps the horizon and adopts the current availability time zone', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, {
      dueAt: '2026-11-13T18:00:00Z',
      title: 'TZ task',
    });
    const plan = await createPlan(ctx, session, [task.id]);
    const seoul = {
      ...AVAILABILITY_BODY,
      timeZone: 'Asia/Seoul',
    };
    const nextVersion = await putAvailability(ctx, session, seoul);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}:regenerate`,
      headers: authHeaders(session, {
        'if-match': `W/"${plan.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(response.statusCode).toBe(201);
    const regenerated = response.json() as Plan;
    expect(regenerated.timeZone).toBe('Asia/Seoul');
    expect(regenerated.horizon).toEqual({
      start: '2026-11-11T00:00:00.000Z',
      end: '2026-11-14T00:00:00.000Z',
    });
    expect((await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/availability',
      headers: authHeaders(session),
    })).json()).toMatchObject({ version: nextVersion, timeZone: 'Asia/Seoul' });
  });

  test('owner isolation: another owner sees 404 on plans and commitments', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, {
      dueAt: '2026-11-13T18:00:00Z',
      title: 'Isolation task',
    });
    const plan = await createPlan(ctx, session, [task.id]);
    const candidate = plan.candidates[0];

    const foreignPlan = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/plans/${plan.id}`,
      headers: authHeaders(bob),
    });
    expect(foreignPlan.statusCode).toBe(404);

    const foreignPreview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:preview-edit`,
      headers: authHeaders(bob, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { blocks: [] },
    });
    expect(foreignPreview.statusCode).toBe(404);

    const foreignApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
      headers: authHeaders(bob, {
        'if-match': 'W/"availability:1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(foreignApprove.statusCode).toBe(404);

    const foreignRegenerate = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}:regenerate`,
      headers: authHeaders(bob, {
        'if-match': `W/"${plan.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(foreignRegenerate.statusCode).toBe(404);

    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Private',
        startAt: '2026-11-17T05:00:00Z',
        endAt: '2026-11-17T06:00:00Z',
        timeZone: 'UTC',
      },
    });
    expect(create.statusCode).toBe(201);
    const commitment = create.json() as { id: string; version: number };
    const foreignPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/commitments/${commitment.id}`,
      headers: authHeaders(bob, {
        'if-match': `W/"${commitment.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { title: 'Hijacked' },
    });
    expect(foreignPatch.statusCode).toBe(404);

    const foreignDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/commitments/${commitment.id}`,
      headers: authHeaders(bob, {
        'if-match': `W/"${commitment.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(foreignDelete.statusCode).toBe(404);
  });

  test('route walk: every planning route returns a declared status', async () => {
    const id = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
    const authorised = await login(ctx, 'planner@example.com', 'correct-horse');
    for (const route of planningRoutes) {
      const url = `/api/v1${route.path.replace(/\{id\}/g, id).replace(/\{cid\}/g, id)}`;
      const declared = new Set(Object.keys(route.responses).map(Number));

      const anonymous = await ctx.app.inject({
        method: route.method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url,
        ...(route.method === 'get' ? {} : { payload: {} }),
      });
      expect({
        route: route.operationId,
        status: anonymous.statusCode,
        declared: declared.has(anonymous.statusCode),
      }).toEqual({ route: route.operationId, status: expect.any(Number), declared: true });

      const authenticated = await ctx.app.inject({
        method: route.method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url,
        headers: authHeaders(authorised),
        ...(route.method === 'get' ? {} : { payload: {} }),
      });
      expect({
        route: route.operationId,
        status: authenticated.statusCode,
        declared: declared.has(authenticated.statusCode),
      }).toEqual({ route: route.operationId, status: expect.any(Number), declared: true });
    }
  });
});
