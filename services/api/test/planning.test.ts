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
    dependsOn?: readonly Id[];
    status?: 'todo' | 'in_progress' | 'done';
    splittable?: boolean;
  } = {},
): Promise<SeededTask> {
  const project = await ctx.repos.projects.create(
    ownerId,
    { title: 'Plan project' },
    randomUUID(),
  );
  await ctx.db
    .insertInto('project')
    .values({
      id: project.id,
      owner_id: ownerId,
      title: project.title,
      kind: 'normal',
    })
    .execute();
  const task = await ctx.repos.tasks.create(
    ownerId,
    {
      projectId: project.id,
      title: options.title ?? 'Plan task',
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt as Instant }),
      ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.splittable === undefined ? {} : { splittable: options.splittable }),
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
      status_cache: options.status ?? 'todo',
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

  test('goal-scoped plans resolve tasks through the intake approval ledger', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    await putAvailability(ctx, session);
    const goalId = ctx.ids.next();
    const intakeSessionId = ctx.ids.next();
    const { task } = await seedTask(ctx, aliceId, { title: 'Goal task' });
    await ctx.db
      .insertInto('goal')
      .values({ id: goalId, owner_id: aliceId, title: 'Goal' })
      .execute();
    await ctx.db
      .insertInto('intake_session')
      .values({ id: intakeSessionId, owner_id: aliceId, goal_id: goalId, state: 'scheduled' })
      .execute();
    await ctx.db
      .insertInto('intake_approval')
      .values({
        session_id: intakeSessionId,
        owner_id: aliceId,
        draft_version: 1,
        state: 'completed',
        lease_expires_at: new Date(Date.parse('2026-11-11T00:00:00Z')),
        idempotency_key: `goal-${goalId}`,
      })
      .execute();
    await ctx.db
      .insertInto('intake_approval_step')
      .values({
        session_id: intakeSessionId,
        step_key: 's1',
        planned_task_id: task.id,
        state: 'created',
        task_id: task.id,
      })
      .execute();

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

    const versions = await ctx.db
      .selectFrom('plan_version')
      .select('id')
      .where('plan_id', '=', plan.id)
      .execute();
    expect(versions).toHaveLength(0);
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

  test('approve returns 409 when a scoped task vanished after generation', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, {
      dueAt: '2026-11-13T18:00:00Z',
      title: 'Vanishing task',
    });
    const plan = await createPlan(ctx, session, [task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    await ctx.repos.tasks.softDelete(aliceId, task.id, task.version);

    const key = newIdempotencyKey();
    const make = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
        headers: authHeaders(session, {
          'if-match': `W/"availability:${availabilityVersion}"`,
          'idempotency-key': key,
        }),
        payload: {},
      });
    const response = await make();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'illegal_transition' });
    const replay = await make();
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'illegal_transition' });
    const record = await ctx.db
      .selectFrom('idempotency_record')
      .select('status')
      .where('owner_id', '=', aliceId)
      .where('key', '=', key)
      .executeTakeFirst();
    expect(record?.status).toBe('completed');
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

  test('planning sees commitments beyond the first 100 rows', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    await putAvailability(ctx, session);
    const oldRows = Array.from({ length: 105 }, (_, index) => ({
      id: ctx.ids.next(),
      owner_id: aliceId,
      title: `Old ${index}`,
      start_at: new Date(Date.parse('2026-02-01T09:00:00Z')),
      end_at: new Date(Date.parse('2026-02-01T10:00:00Z')),
      time_zone: 'UTC',
      source: 'manual',
    }));
    await ctx.db.insertInto('commitment_event').values(oldRows).execute();
    const blockerStart = '2026-11-11T09:00:00Z';
    const blockerEnd = '2026-11-11T10:00:00Z';
    await ctx.db
      .insertInto('commitment_event')
      .values({
        id: ctx.ids.next(),
        owner_id: aliceId,
        title: 'Horizon blocker',
        start_at: new Date(Date.parse(blockerStart)),
        end_at: new Date(Date.parse(blockerEnd)),
        time_zone: 'UTC',
        source: 'manual',
      })
      .execute();
    const { task } = await seedTask(ctx, aliceId, {
      dueAt: '2026-11-13T18:00:00Z',
      title: 'After-100 task',
    });
    const plan = await createPlan(ctx, session, [task.id]);
    for (const candidate of plan.candidates) {
      for (const block of candidate.blocks) {
        const start = Date.parse(block.startAt);
        const end = Date.parse(block.endAt);
        expect(start < Date.parse(blockerEnd) && end > Date.parse(blockerStart)).toBe(false);
      }
    }
  });

  test('dependency closure is schedulable, previewable and approvable', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const dependency = await seedTask(ctx, aliceId, { title: 'Closure dependency' });
    const main = await seedTask(ctx, aliceId, {
      title: 'Closure main',
      dueAt: '2026-11-13T18:00:00Z',
      dependsOn: [dependency.task.id],
    });
    const plan = await createPlan(ctx, session, [main.task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const taskIds = new Set((candidate?.blocks ?? []).map((block) => block.taskId));
    expect(taskIds.has(dependency.task.id)).toBe(true);
    expect(taskIds.has(main.task.id)).toBe(true);

    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:preview-edit`,
      headers: authHeaders(session, {
        'if-match': `W/"${plan.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { blocks: candidate?.blocks ?? [] },
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { feasible: boolean }).feasible).toBe(true);

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(approve.statusCode).toBe(201);
  });

  test('out-of-scope locked tasks get no new placement when their estimate grows', async () => {
    const ownerId = await ctx.seedUser({
      email: 'probe-g@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'probe-g@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const locked = await seedTask(ctx, ownerId, {
      title: 'Already approved',
      estimate: { p50Min: 60, p90Min: 60 },
      dueAt: '2026-11-13T18:00:00Z',
    });
    const firstPlan = await createPlan(ctx, session, [locked.task.id]);
    const firstCandidate = firstPlan.candidates[0];
    expect(firstCandidate).toBeDefined();
    const firstApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${firstPlan.id}/candidates/${firstCandidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(firstApprove.statusCode).toBe(201);

    await ctx.db
      .updateTable('estimate')
      .set({ p50_min: 120, p90_min: 120 })
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', locked.task.id)
      .where('is_current', '=', true)
      .execute();

    const other = await seedTask(ctx, ownerId, {
      title: 'New scope task',
      dueAt: '2026-11-13T18:00:00Z',
    });
    const secondPlan = await createPlan(ctx, session, [other.task.id]);
    const scheduled = new Set(
      secondPlan.candidates.flatMap((candidate) => candidate.blocks.map((block) => block.taskId)),
    );
    expect(scheduled.has(locked.task.id)).toBe(false);
    expect(scheduled.has(other.task.id)).toBe(true);
  });

  test('done tasks are never scheduled, including done dependencies', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    await putAvailability(ctx, session);
    const doneDependency = await seedTask(ctx, aliceId, {
      title: 'Done dependency',
      status: 'done',
    });
    const main = await seedTask(ctx, aliceId, {
      title: 'Live main',
      dueAt: '2026-11-13T18:00:00Z',
      dependsOn: [doneDependency.task.id],
    });
    const doneScope = await seedTask(ctx, aliceId, {
      title: 'Done scope',
      status: 'done',
    });
    const plan = await createPlan(ctx, session, [main.task.id, doneScope.task.id]);
    const scheduled = new Set(plan.candidates.flatMap((candidate) => candidate.blocks.map((block) => block.taskId)));
    expect(scheduled.has(doneDependency.task.id)).toBe(false);
    expect(scheduled.has(doneScope.task.id)).toBe(false);
    expect(scheduled.has(main.task.id)).toBe(true);
  });

  test('history blocks enter existingBlocks and are never re-placed', async () => {
    const historyOwnerId = await ctx.seedUser({
      email: 'history@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'history@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const first = await seedTask(ctx, historyOwnerId, {
      title: 'History first',
      estimate: { p50Min: 60, p90Min: 60 },
      dueAt: '2026-11-13T18:00:00Z',
    });
    const plan = await createPlan(ctx, session, [first.task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(approve.statusCode).toBe(201);
    const version = approve.json() as { blocks: { startAt: string; endAt: string }[] };
    const firstBlock = version.blocks[0];
    expect(firstBlock).toBeDefined();
    if (firstBlock === undefined) throw new Error('no approved block');
    ctx.clock.set(
      new Date((Date.parse(firstBlock.startAt) + Date.parse(firstBlock.endAt)) / 2).toISOString() as never,
    );
    try {
      const second = await seedTask(ctx, historyOwnerId, {
        title: 'History second',
        dueAt: '2026-11-13T18:00:00Z',
      });
      const laterSession = await login(ctx, 'history@example.com', 'correct-horse');
      const secondPlan = await createPlan(ctx, laterSession, [second.task.id]);
      for (const candidateBlock of secondPlan.candidates.flatMap((entry) => entry.blocks)) {
        const start = Date.parse(candidateBlock.startAt);
        const end = Date.parse(candidateBlock.endAt);
        expect(start < Date.parse(firstBlock.endAt) && end > Date.parse(firstBlock.startAt)).toBe(
          false,
        );
      }
    } finally {
      ctx.clock.set('2026-01-01T00:00:00.000Z' as never);
    }
  });

  test('re-approval supersedes only future blocks and keeps history active', async () => {
    const supersedeOwnerId = await ctx.seedUser({
      email: 'supersede@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'supersede@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const task = await seedTask(ctx, supersedeOwnerId, {
      title: 'Supersede history',
      estimate: { p50Min: 120, p90Min: 120 },
      dueAt: '2026-11-13T18:00:00Z',
      splittable: true,
    });
    const plan = await createPlan(ctx, session, [task.task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const firstApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(firstApprove.statusCode).toBe(201);
    const firstVersion = firstApprove.json() as {
      blocks: { id: string; startAt: string; endAt: string }[];
    };
    const historyBlock = firstVersion.blocks[0];
    expect(historyBlock).toBeDefined();
    if (historyBlock === undefined) throw new Error('no history block');
    ctx.clock.set(
      new Date(Date.parse(historyBlock.startAt) + 30 * 60_000).toISOString() as never,
    );
    try {
      const laterSession = await login(ctx, 'supersede@example.com', 'correct-horse');
      const currentPlan = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/plans/${plan.id}`,
        headers: authHeaders(laterSession),
      });
      expect(currentPlan.statusCode).toBe(200);
      const currentVersion = (currentPlan.json() as Plan).version;
      const regenerated = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}:regenerate`,
        headers: authHeaders(laterSession, {
          'if-match': `W/"${currentVersion}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      expect(regenerated.statusCode).toBe(201);
      const regeneratedPlan = regenerated.json() as Plan;
      const regeneratedCandidate = regeneratedPlan.candidates[0];
      expect(regeneratedCandidate).toBeDefined();
      const secondApprove = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/candidates/${regeneratedCandidate?.id}:approve`,
        headers: authHeaders(laterSession, {
          'if-match': `W/"availability:${availabilityVersion}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {},
      });
      expect(secondApprove.statusCode).toBe(201);
      const historic = await ctx.db
        .selectFrom('schedule_block')
        .select(['status'])
        .where('id', '=', historyBlock.id)
        .executeTakeFirst();
      expect(historic?.status).toBe('planned');
    } finally {
      ctx.clock.set('2026-01-01T00:00:00.000Z' as never);
    }
  });

  test('stored idempotency replays constraint_violation 422', async () => {
    const session = await login(ctx, 'planner@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const { task } = await seedTask(ctx, aliceId, {
      dueAt: '2026-11-13T18:00:00Z',
      title: 'Stored 422',
    });
    const plan = await createPlan(ctx, session, [task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const key = newIdempotencyKey();
    const payload = {
      editedBlocks: [
        { taskId: task.id, startAt: '2026-11-12T09:00:00Z', endAt: '2026-11-12T10:00:00Z' },
        { taskId: task.id, startAt: '2026-11-12T09:30:00Z', endAt: '2026-11-12T10:30:00Z' },
      ],
    };
    const make = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
        headers: authHeaders(session, {
          'if-match': `W/"availability:${availabilityVersion}"`,
          'idempotency-key': key,
        }),
        payload,
      });
    const first = await make();
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({ code: 'constraint_violation' });
    const replay = await make();
    expect(replay.statusCode).toBe(422);
    expect(replay.json()).toMatchObject({ code: 'constraint_violation' });
    const record = await ctx.db
      .selectFrom('idempotency_record')
      .select(['status'])
      .where('owner_id', '=', aliceId)
      .where('key', '=', key)
      .executeTakeFirst();
    expect(record?.status).toBe('completed');
  });

  test('regenerate drops a completed task future block and re-approval releases it (probe H)', async () => {
    const ownerId = await ctx.seedUser({
      email: 'probe-h@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'probe-h@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const done = await seedTask(ctx, ownerId, {
      title: 'Completed after approval',
      estimate: { p50Min: 60, p90Min: 60 },
      splittable: false,
    });
    const plan = await createPlan(ctx, session, [done.task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const firstApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(firstApprove.statusCode).toBe(201);

    const completed = await ctx.repos.tasks.complete(
      ownerId,
      done.task.id,
      done.task.version,
    );
    expect(completed.status).toBe('done');

    const currentPlan = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/plans/${plan.id}`,
      headers: authHeaders(session),
    });
    expect(currentPlan.statusCode).toBe(200);
    const currentVersion = (currentPlan.json() as Plan).version;
    const regenerated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}:regenerate`,
      headers: authHeaders(session, {
        'if-match': `W/"${currentVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(regenerated.statusCode).toBe(201);
    const regeneratedPlan = regenerated.json() as Plan;
    const regeneratedCandidate = regeneratedPlan.candidates[0];
    expect(regeneratedCandidate).toBeDefined();
    expect(
      regeneratedCandidate?.blocks.some((block) => block.taskId === done.task.id),
    ).toBe(false);
    expect(regeneratedCandidate?.feasible).toBe(true);

    const secondApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${regeneratedCandidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(secondApprove.statusCode).toBe(201);
    const active = await ctx.db
      .selectFrom('schedule_block')
      .select(['id'])
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', done.task.id)
      .where('status', '<>', 'superseded')
      .execute();
    expect(active).toHaveLength(0);
  });

  test('regenerate does not move a completed task under a displacing commitment (probe H2)', async () => {
    const ownerId = await ctx.seedUser({
      email: 'probe-h2@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'probe-h2@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const done = await seedTask(ctx, ownerId, {
      title: 'Completed under pressure',
      estimate: { p50Min: 60, p90Min: 60 },
      splittable: false,
    });
    const plan = await createPlan(ctx, session, [done.task.id]);
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const firstApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(firstApprove.statusCode).toBe(201);
    const approvedBlock = (firstApprove.json() as { blocks: { startAt: string; endAt: string }[] })
      .blocks[0];
    expect(approvedBlock).toBeDefined();
    if (approvedBlock === undefined) throw new Error('no approved block');

    const completed = await ctx.repos.tasks.complete(
      ownerId,
      done.task.id,
      done.task.version,
    );
    expect(completed.status).toBe('done');
    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Displacing commitment',
        startAt: approvedBlock.startAt,
        endAt: approvedBlock.endAt,
        timeZone: 'UTC',
      },
    });
    expect(commitment.statusCode).toBe(201);
    const bumpedAvailability = await currentAvailabilityVersion(ctx, session);

    const currentPlan = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/plans/${plan.id}`,
      headers: authHeaders(session),
    });
    const currentVersion = (currentPlan.json() as Plan).version;
    const regenerated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}:regenerate`,
      headers: authHeaders(session, {
        'if-match': `W/"${currentVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(regenerated.statusCode).toBe(201);
    const regeneratedCandidate = (regenerated.json() as Plan).candidates[0];
    expect(regeneratedCandidate).toBeDefined();
    expect(
      regeneratedCandidate?.blocks.some((block) => block.taskId === done.task.id),
    ).toBe(false);
    expect(regeneratedCandidate?.feasible).toBe(true);

    const secondApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${regeneratedCandidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${bumpedAvailability}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(secondApprove.statusCode).toBe(201);
    const active = await ctx.db
      .selectFrom('schedule_block')
      .select(['id'])
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', done.task.id)
      .where('status', '<>', 'superseded')
      .execute();
    expect(active).toHaveLength(0);
  });

  test('a provider-deleted task releases its future blocks instead of locking planning (probe K)', async () => {
    const ownerId = await ctx.seedUser({
      email: 'probe-k@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'probe-k@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    const k1 = await seedTask(ctx, ownerId, {
      title: 'Deleted upstream',
      estimate: { p50Min: 60, p90Min: 60 },
      splittable: false,
    });
    const firstPlan = await createPlan(ctx, session, [k1.task.id]);
    const firstCandidate = firstPlan.candidates[0];
    expect(firstCandidate).toBeDefined();
    const firstApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${firstPlan.id}/candidates/${firstCandidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(firstApprove.statusCode).toBe(201);

    await ctx.repos.tasks.softDelete(ownerId, k1.task.id, k1.task.version);
    const k2 = await seedTask(ctx, ownerId, {
      title: 'New work after deletion',
      estimate: { p50Min: 60, p90Min: 60 },
      splittable: false,
    });
    const secondPlan = await createPlan(ctx, session, [k2.task.id]);
    const secondCandidate = secondPlan.candidates[0];
    expect(secondCandidate).toBeDefined();
    expect(secondCandidate?.blocks.some((block) => block.taskId === k1.task.id)).toBe(false);
    const secondApprove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${secondPlan.id}/candidates/${secondCandidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(secondApprove.statusCode).toBe(201);
    const released = await ctx.db
      .selectFrom('schedule_block')
      .select(['id', 'status'])
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', k1.task.id)
      .execute();
    expect(released.length).toBeGreaterThan(0);
    expect(released.every((block) => block.status === 'superseded')).toBe(true);
  });

  test('stored old or finished recurrences never poison commitments or plans (probe R)', async () => {
    const ownerId = await ctx.seedUser({
      email: 'probe-r@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'probe-r@example.com', 'correct-horse');
    await putAvailability(ctx, session);

    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Too old',
        startAt: '2010-03-01T09:00:00Z',
        endAt: '2010-03-01T10:00:00Z',
        timeZone: 'UTC',
        rrule: 'FREQ=WEEKLY;UNTIL=20110301T000000Z',
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(JSON.stringify(rejected.json())).toContain('/startAt');

    const tooMany = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Too many occurrences',
        startAt: '2026-11-11T09:00:00Z',
        endAt: '2026-11-11T10:00:00Z',
        timeZone: 'UTC',
        rrule: 'FREQ=DAILY;COUNT=1001',
      },
    });
    expect(tooMany.statusCode).toBe(422);
    expect(JSON.stringify(tooMany.json())).toContain('/rrule');

    const legacyId = ctx.ids.next();
    await ctx.db
      .insertInto('commitment_event')
      .values({
        id: legacyId,
        owner_id: ownerId,
        title: 'Legacy finished recurrence',
        start_at: new Date('2010-03-01T09:00:00Z'),
        end_at: new Date('2010-03-01T10:00:00Z'),
        rrule: 'FREQ=WEEKLY;UNTIL=20110301T000000Z',
        time_zone: 'UTC',
        source: 'manual',
      })
      .execute();
    const liveOldId = ctx.ids.next();
    await ctx.db
      .insertInto('commitment_event')
      .values({
        id: liveOldId,
        owner_id: ownerId,
        title: 'Legacy live recurrence',
        start_at: new Date('2010-03-03T09:00:00Z'),
        end_at: new Date('2010-03-03T10:00:00Z'),
        rrule: 'FREQ=WEEKLY;BYDAY=WE',
        time_zone: 'UTC',
        source: 'manual',
      })
      .execute();

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/commitments?from=2026-11-11T00:00:00Z&to=2026-11-14T00:00:00Z',
      headers: authHeaders(session),
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json() as {
      items: { id: string; occurrences: { startAt: string }[] }[];
    };
    expect(page.items.find((item) => item.id === legacyId)?.occurrences).toEqual([]);
    const liveOccurrences =
      page.items.find((item) => item.id === liveOldId)?.occurrences ?? [];
    expect(liveOccurrences.length).toBeGreaterThan(0);
    expect(liveOccurrences[0]?.startAt).toBe('2026-11-11T09:00:00Z');

    const task = await seedTask(ctx, ownerId, {
      title: 'Plan with legacy commitment',
      estimate: { p50Min: 30, p90Min: 30 },
    });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        scope: { taskIds: [task.task.id] },
        policies: ['balanced'],
        horizon: HORIZON,
      },
    });
    expect(created.statusCode).toBe(201);

    const fresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Fresh then patched old',
        startAt: '2026-11-17T09:00:00Z',
        endAt: '2026-11-17T10:00:00Z',
        timeZone: 'UTC',
      },
    });
    expect(fresh.statusCode).toBe(201);
    const freshBody = fresh.json() as { id: string; version: number };
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/commitments/${freshBody.id}`,
      headers: authHeaders(session, {
        'if-match': `W/"${freshBody.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { startAt: '2010-03-01T09:00:00Z' },
    });
    expect(patched.statusCode).toBe(422);
    expect(JSON.stringify(patched.json())).toContain('/startAt');
  });

  test('a legacy leap-day recurrence blocks its real 2028 occurrence in generation and approval', async () => {
    const ownerId = await ctx.seedUser({
      email: 'probe-r2@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'probe-r2@example.com', 'correct-horse');
    const availabilityVersion = await putAvailability(ctx, session);
    await ctx.db
      .insertInto('commitment_event')
      .values({
        id: ctx.ids.next(),
        owner_id: ownerId,
        title: 'Legacy leap day',
        start_at: new Date('2000-02-29T09:00:00Z'),
        end_at: new Date('2000-02-29T10:00:00Z'),
        rrule: 'FREQ=YEARLY;COUNT=10',
        time_zone: 'UTC',
        source: 'manual',
      })
      .execute();
    const task = await seedTask(ctx, ownerId, {
      title: 'Leap day task',
      estimate: { p50Min: 60, p90Min: 60 },
      splittable: false,
    });
    const horizon = {
      start: '2028-02-29T09:00:00Z',
      end: '2028-02-29T11:00:00Z',
    };
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { scope: { taskIds: [task.task.id] }, policies: ['balanced'], horizon },
    });
    expect(created.statusCode).toBe(201);
    const plan = created.json() as Plan;
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    const occurrenceStart = Date.parse('2028-02-29T09:00:00Z');
    const occurrenceEnd = Date.parse('2028-02-29T10:00:00Z');
    const overlaps = (blocks: readonly { startAt: string; endAt: string }[]): boolean =>
      blocks.some(
        (block) =>
          Date.parse(block.startAt) < occurrenceEnd && Date.parse(block.endAt) > occurrenceStart,
      );
    expect(overlaps(candidate?.blocks ?? [])).toBe(false);
    expect(candidate?.feasible).toBe(true);

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(approve.statusCode).toBe(201);
    const approved = approve.json() as { blocks: { startAt: string; endAt: string }[] };
    expect(overlaps(approved.blocks)).toBe(false);
  });

  test('planner cache project rows use a neutral title unless a provider title is known (LOW)', async () => {
    const { ensurePlannerTaskIdentity } = await import(
      '../src/adapters/planner-task-identity.js'
    );
    const ownerId = await ctx.seedUser({
      email: 'planner-cache@example.com',
      password: 'correct-horse',
    });
    const project = await ctx.repos.projects.create(
      ownerId,
      { title: 'Provider project name' },
      randomUUID(),
    );
    const task = await ctx.repos.tasks.create(
      ownerId,
      { projectId: project.id, title: 'First task title' },
      randomUUID(),
    );
    await ctx.db.transaction().execute(async (trx) => {
      await ensurePlannerTaskIdentity(trx, ownerId, [task]);
    });
    const cached = await ctx.db
      .selectFrom('project')
      .select(['title'])
      .where('id', '=', project.id)
      .executeTakeFirst();
    expect(cached?.title).toBe('planner cache');

    const otherProject = await ctx.repos.projects.create(
      ownerId,
      { title: 'Known provider project' },
      randomUUID(),
    );
    const otherTask = await ctx.repos.tasks.create(
      ownerId,
      { projectId: otherProject.id, title: 'Second task title' },
      randomUUID(),
    );
    await ctx.db.transaction().execute(async (trx) => {
      await ensurePlannerTaskIdentity(
        trx,
        ownerId,
        [otherTask],
        new Map([[otherProject.id, 'Known provider project']]),
      );
    });
    const titled = await ctx.db
      .selectFrom('project')
      .select(['title'])
      .where('id', '=', otherProject.id)
      .executeTakeFirst();
    expect(titled?.title).toBe('Known provider project');
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
