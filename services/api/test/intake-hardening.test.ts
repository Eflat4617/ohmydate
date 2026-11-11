import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { routes, type IntakeInput, type IntakeSessionDto } from '@ohmydate/contracts';
import {
  ProviderUnavailableError,
  type Id,
  type Page,
  type Task,
  type TaskChangePage,
  type TaskCreate,
  type TaskPatch,
  type TaskQuery,
  type TaskRepository,
  type Version,
} from '@ohmydate/domain';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import pino from 'pino';
import pg from 'pg';
import { defaultLoggerOptions } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { intakeSessionLockKey } from '../src/adapters/intake-session-advisory.js';
import type { AppRepositories } from '../src/application/ports.js';
import {
  authHeaders,
  createTestContext,
  databaseUrl,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

const titleInput: IntakeInput = { title: 'Hardening task', deliverable: 'Ship it' };

const sixSteps = Array.from({ length: 6 }, (_, index) => ({
  key: `s${index + 1}`,
  title: `Step ${index + 1}`,
  deliverable: `Deliverable ${index + 1}`,
  doneCriteria: `Done ${index + 1}`,
  kind: index === 5 ? ('review' as const) : ('work' as const),
  estimate: { p50Minutes: 30, p90Minutes: 60 },
  dependsOn: index === 0 ? [] : [`s${index}`],
  splittable: false,
}));

class ScriptedTasks implements TaskRepository {
  readonly capabilities;
  #count = 0;
  beforeCreate?: ((index: number) => Promise<void>) | undefined;
  afterCreate?: ((index: number, task: Task) => Promise<void>) | undefined;

  constructor(private readonly inner: TaskRepository) {
    this.capabilities = inner.capabilities;
  }

  async create(
    ownerId: Id,
    input: TaskCreate,
    idemKey: string,
    opts?: { readonly plannedId?: Id },
  ): Promise<Task> {
    const index = (this.#count += 1);
    await this.beforeCreate?.(index);
    const task = await this.inner.create(ownerId, input, idemKey, opts);
    await this.afterCreate?.(index, task);
    return task;
  }
  get(ownerId: Id, id: Id): Promise<Task | null> {
    return this.inner.get(ownerId, id);
  }
  list(ownerId: Id, query: TaskQuery): Promise<Page<Task>> {
    return this.inner.list(ownerId, query);
  }
  update(ownerId: Id, id: Id, patch: TaskPatch, version: Version): Promise<Task> {
    return this.inner.update(ownerId, id, patch, version);
  }
  complete(ownerId: Id, id: Id, version: Version): Promise<Task> {
    return this.inner.complete(ownerId, id, version);
  }
  softDelete(ownerId: Id, id: Id, version: Version): Promise<Version> {
    return this.inner.softDelete(ownerId, id, version);
  }
  listChangedSince(ownerId: Id, cursor: string | null): Promise<TaskChangePage> {
    return this.inner.listChangedSince(ownerId, cursor);
  }
}

function scriptedRepos(): { script: ScriptedTasks; repos: AppRepositories } {
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(20261130, clock);
  const base = createInMemoryRepositories({ clock, ids });
  const script = new ScriptedTasks(base.tasks);
  return { script, repos: { tasks: script, projects: base.projects } };
}

async function createManualDecomposing(
  ctx: TestContext,
  session: TestSession,
  six = false,
): Promise<IntakeSessionDto> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/intake-sessions',
    headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    payload: { input: titleInput },
  });
  expect(created.statusCode).toBe(201);
  const body = created.json() as IntakeSessionDto;
  const answers = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/intake-sessions/${body.id}/answers`,
    headers: authHeaders(session, {
      'if-match': `W/"${body.version}"`,
      'idempotency-key': newIdempotencyKey(),
    }),
    payload: {
      answers: [
        { questionKey: 'dueAt', action: 'skip' },
        { questionKey: 'estimatedScope', action: 'idk' },
        { questionKey: 'currentProgress', action: 'skip' },
        { questionKey: 'availabilityConfirmed', action: 'skip' },
        { questionKey: 'priority', action: 'skip' },
      ],
    },
  });
  expect(answers.statusCode).toBe(200);
  let current = answers.json() as IntakeSessionDto;
  if (six) {
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/intake-sessions/${body.id}/draft`,
      headers: authHeaders(session, {
        'if-match': `W/"${current.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { steps: sixSteps },
    });
    expect(patched.statusCode).toBe(200);
    current = { ...current, version: Number(patched.headers['etag']?.toString().slice(3, -1)) };
  }
  expect(current.state).toBe('decomposition');
  return current;
}

function approve(
  ctx: TestContext,
  session: TestSession,
  id: string,
  version: number,
  key = newIdempotencyKey(),
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/intake-sessions/${id}/draft:approve`,
    headers: authHeaders(session, {
      'if-match': `W/"${version}"`,
      'idempotency-key': key,
    }),
  });
}

async function taskCount(ctx: TestContext, session: TestSession): Promise<number> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tasks?limit=100',
    headers: authHeaders(session),
  });
  return (response.json() as { items: unknown[] }).items.length;
}

describe.skipIf(!hasDatabase)('M2-03 hardening', () => {
  test('fault before step 3 then same-key retry creates exactly six tasks', async () => {
    const { script, repos } = scriptedRepos();
    const ctx = await createTestContext({ repos });
    await ctx.seedUser({ email: 'h1-before@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h1-before@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      script.beforeCreate = async (index) => {
        if (index === 3) throw new ProviderUnavailableError('vikunja', 'injected');
      };
      const key = newIdempotencyKey();
      const failed = await approve(ctx, session, current.id, current.version, key);
      expect(failed.statusCode).toBe(503);
      expect(await taskCount(ctx, session)).toBe(2);

      script.beforeCreate = undefined;
      const retried = await approve(ctx, session, current.id, current.version, key);
      expect(retried.statusCode).toBe(200);
      expect((retried.json() as IntakeSessionDto).state).toBe('feasibility_check');
      expect(await taskCount(ctx, session)).toBe(6);
    } finally {
      await ctx.close();
    }
  });

  test('a task created just before a crash is adopted without duplication', async () => {
    const { script, repos } = scriptedRepos();
    const ctx = await createTestContext({ repos });
    await ctx.seedUser({ email: 'h1-unknown@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h1-unknown@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      let thrown = false;
      script.afterCreate = async () => {
        if (thrown) return;
        thrown = true;
        throw new ProviderUnavailableError('vikunja', 'crash after create');
      };
      const key = newIdempotencyKey();
      const failed = await approve(ctx, session, current.id, current.version, key);
      expect(failed.statusCode).toBe(503);
      const approval = await ctx.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .execute();
      expect(approval.some((step) => step.state === 'unknown')).toBe(true);

      script.afterCreate = undefined;
      const retried = await approve(ctx, session, current.id, current.version, key);
      expect(retried.statusCode).toBe(200);
      expect(await taskCount(ctx, session)).toBe(6);
    } finally {
      await ctx.close();
    }
  });

  test('concurrent approvals with different keys create six tasks and one 409', async () => {
    const { script, repos } = scriptedRepos();
    const ctx = await createTestContext({ repos });
    await ctx.seedUser({ email: 'h1-race@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h1-race@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const hit = new Promise<void>((resolve) => {
        entered = resolve;
      });
      script.beforeCreate = async (index) => {
        if (index !== 1) return;
        entered();
        await gate;
      };
      const first = approve(ctx, session, current.id, current.version);
      await hit;
      const second = await approve(ctx, session, current.id, current.version);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: 'approval_in_progress' });
      release();
      expect((await first).statusCode).toBe(200);
      expect(await taskCount(ctx, session)).toBe(6);
    } finally {
      await ctx.close();
    }
  });

  test('approve racing PATCH never creates tasks before the PATCH conflict', async () => {
    const { script, repos } = scriptedRepos();
    const ctx = await createTestContext({ repos });
    await ctx.seedUser({ email: 'h1-patch@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h1-patch@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const hit = new Promise<void>((resolve) => {
        entered = resolve;
      });
      script.beforeCreate = async (index) => {
        if (index !== 1) return;
        entered();
        await gate;
      };
      const first = approve(ctx, session, current.id, current.version);
      await hit;
      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/intake-sessions/${current.id}/draft`,
        headers: authHeaders(session, {
          'if-match': `W/"${current.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { assumptions: ['racing patch'] },
      });
      expect(patched.statusCode).toBe(409);
      expect(patched.json()).toMatchObject({ code: 'approval_in_progress' });
      release();
      expect((await first).statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  test('PATCH-first makes approval 412 with zero tasks', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'h1-patch-first@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h1-patch-first@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/intake-sessions/${current.id}/draft`,
        headers: authHeaders(session, {
          'if-match': `W/"${current.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { assumptions: ['edited first'] },
      });
      expect(patched.statusCode).toBe(200);
      const stale = await approve(ctx, session, current.id, current.version);
      expect(stale.statusCode).toBe(412);
      expect(await taskCount(ctx, session)).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test('barrier race: one PATCH wins, the loser leaves draft untouched', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'h2-draft@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h2-draft@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      const make = (assumption: string) =>
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/intake-sessions/${current.id}/draft`,
          headers: authHeaders(session, {
            'if-match': `W/"${current.version}"`,
            'idempotency-key': newIdempotencyKey(),
          }),
          payload: { assumptions: [assumption] },
        });
      const [a, b] = await Promise.all([make('A'), make('B')]);
      // ADR-020: the loser either hits the session mutation lock (409) or,
      // when the winner already committed, the version CAS (412). Either way
      // exactly one write must land.
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses[0]).toBe(200);
      expect([409, 412]).toContain(statuses[1]);
      const winner = a.statusCode === 200 ? 'A' : 'B';
      const draft = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${current.id}/draft`,
        headers: authHeaders(session),
      });
      expect((draft.json() as { assumptions: string[] }).assumptions).toEqual([winner]);
    } finally {
      await ctx.close();
    }
  });

  test('barrier race: one answers request wins and the loser writes nothing', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'h2-answers@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h2-answers@example.com', 'correct-horse');
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input: { title: 'Answers race' } },
      });
      const body = created.json() as IntakeSessionDto;
      const make = (value: number) =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/intake-sessions/${body.id}/answers`,
          headers: authHeaders(session, {
            'if-match': `W/"${body.version}"`,
            'idempotency-key': newIdempotencyKey(),
          }),
          payload: { answers: [{ questionKey: 'priority', action: 'answer', value }] },
        });
      const [a, b] = await Promise.all([make(1), make(4)]);
      // ADR-020: lock loss is 409 and a committed winner yields a 412 CAS.
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses[0]).toBe(200);
      expect([409, 412]).toContain(statuses[1]);
      const winner = a.statusCode === 200 ? 1 : 4;
      const rows = await ctx.db
        .selectFrom('intake_answer')
        .selectAll()
        .where('session_id', '=', body.id)
        .execute();
      expect(rows).toHaveLength(1);
      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${body.id}`,
        headers: authHeaders(session),
      });
      expect((read.json() as IntakeSessionDto).input.priority).toBe(winner);
    } finally {
      await ctx.close();
    }
  });

  test('partial answers stay 200 in clarification and persist atomically', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'h3-partial@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h3-partial@example.com', 'correct-horse');
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input: { title: 'Partial answers' } },
      });
      const body = created.json() as IntakeSessionDto;
      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}/answers`,
        headers: authHeaders(session, {
          'if-match': `W/"${body.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { answers: [{ questionKey: 'priority', action: 'answer', value: 2 }] },
      });
      expect(answered.statusCode).toBe(200);
      const after = answered.json() as IntakeSessionDto;
      expect(after.state).toBe('clarification');
      expect(after.round).toBe(2);
      expect(after.answers).toHaveLength(1);
      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${body.id}`,
        headers: authHeaders(session),
      });
      expect(read.statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  test('invalid answer values return 422 with a path and keep the session usable', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'h4-invalid@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h4-invalid@example.com', 'correct-horse');
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input: { title: 'Invalid values' } },
      });
      const body = created.json() as IntakeSessionDto;
      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}/answers`,
        headers: authHeaders(session, {
          'if-match': `W/"${body.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
          answers: [{ questionKey: 'estimatedScope', action: 'answer', value: 'gigantic' }],
        },
      });
      expect(answered.statusCode).toBe(422);
      const problem = answered.json() as { errors: { path: string }[] };
      expect(problem.errors[0]?.path).toBe('/answers/0/value');
      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${body.id}`,
        headers: authHeaders(session),
      });
      expect(read.statusCode).toBe(200);
      expect((read.json() as IntakeSessionDto).state).toBe('clarification');
    } finally {
      await ctx.close();
    }
  });

  test('error logs never contain answer values on validation or serialization failure', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const loggerInstance = pino(
      defaultLoggerOptions(createConfig()) as unknown as pino.LoggerOptions,
      stream,
    );
    const ctx = await createTestContext({ loggerInstance });
    const ownerId = await ctx.seedUser({
      email: 'h5-logs@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'h5-logs@example.com', 'correct-horse');
    const marker = 'private-answer@example.test';
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input: { title: 'Log leak' } },
      });
      const body = created.json() as IntakeSessionDto;
      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}/answers`,
        headers: authHeaders(session, {
          'if-match': `W/"${body.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
          answers: [{ questionKey: 'estimatedScope', action: 'answer', value: marker }],
        },
      });
      expect(answered.statusCode).toBe(422);

      // Force a response serialization failure with an invalid persisted enum.
      const brokenId = ctx.ids.next();
      await ctx.db
        .insertInto('intake_session')
        .values({
          id: brokenId,
          owner_id: ownerId,
          state: 'clarification',
          input: JSON.stringify({ title: marker }) as never,
          detected_type: JSON.stringify({
            classification: marker,
            confidence: 1,
            reasons: [],
            missingRequired: [],
          }) as never,
        })
        .execute();
      const broken = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${brokenId}`,
        headers: authHeaders(session),
      });
      expect(broken.statusCode).toBe(500);

      const logs = chunks.join('');
      expect(logs).not.toContain(marker);
      expect(logs).toContain('/intake-sessions');
    } finally {
      await ctx.close();
    }
  });

  test('create degrades to 201 manual and replays idempotently', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'h6-idem@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h6-idem@example.com', 'correct-horse');
    try {
      const key = newIdempotencyKey();
      const headers = authHeaders(session, { 'idempotency-key': key });
      const payload = { input: { title: 'Idempotent manual' } };
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers,
        payload,
      });
      const replay = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(replay.headers['location']).toBe(first.headers['location']);
      expect(replay.headers['etag']).toBe(first.headers['etag']);
      const sessions = await ctx.db.selectFrom('intake_session').selectAll().execute();
      expect(sessions).toHaveLength(1);
      const goal = await ctx.db.selectFrom('goal').selectAll().executeTakeFirstOrThrow();
      expect(goal.title).toBe('Idempotent manual');
    } finally {
      await ctx.close();
    }
  });

  test('pause/resume only map clarification to needs_input and back', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'pause@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'pause@example.com', 'correct-horse');
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input: { title: 'Pause me' } },
      });
      const body = created.json() as IntakeSessionDto;
      const paused = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:pause`,
        headers: authHeaders(session, {
          'if-match': `W/"${body.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      expect(paused.statusCode).toBe(200);
      const pausedBody = paused.json() as IntakeSessionDto;
      expect(pausedBody.state).toBe('needs_input');
      expect(pausedBody.error?.code).not.toBe('paused');

      const resumed = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:resume`,
        headers: authHeaders(session, {
          'if-match': `W/"${pausedBody.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      expect(resumed.statusCode).toBe(200);
      expect((resumed.json() as IntakeSessionDto).state).toBe('clarification');

      const secondPause = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:pause`,
        headers: authHeaders(session, {
          'if-match': `W/"${(resumed.json() as IntakeSessionDto).version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      expect(secondPause.statusCode).toBe(200);
      const pausedAgain = secondPause.json() as IntakeSessionDto;
      const cancelled = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:cancel`,
        headers: authHeaders(session, {
          'if-match': `W/"${pausedAgain.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      expect(cancelled.statusCode).toBe(200);
      const pauseCancelled = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:pause`,
        headers: authHeaders(session, {
          'if-match': `W/"${(cancelled.json() as IntakeSessionDto).version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      expect(pauseCancelled.statusCode).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  test('malformed stored template steps normalize kind without a 500', async () => {
    const ctx = await createTestContext({});
    const ownerId = await ctx.seedUser({
      email: 'l-template@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'l-template@example.com', 'correct-horse');
    const templateId = ctx.ids.next();
    await ctx.db
      .insertInto('task_template')
      .values({
        id: templateId,
        owner_id: ownerId,
        name: 'Malformed template',
        steps: JSON.stringify([{ key: 's1', title: 'Only step', kind: 'weird' }]) as never,
        source: 'system',
      })
      .execute();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/templates/${templateId}`,
        headers: authHeaders(session),
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { steps: { kind: string }[] }).steps[0]?.kind).toBe('work');
    } finally {
      await ctx.close();
    }
  });

  test('dueAt answers accept the contract instant and reject an invalid date', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'h3-dueat@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'h3-dueat@example.com', 'correct-horse');
    try {
      const createSession = async () => {
        const created = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/intake-sessions',
          headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
          payload: { input: { title: 'Review goal', deliverable: 'Ship' } },
        });
        expect(created.statusCode).toBe(201);
        return created.json() as IntakeSessionDto;
      };

      const valid = await createSession();
      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${valid.id}/answers`,
        headers: authHeaders(session, {
          'if-match': `W/"${valid.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
          answers: [
            { questionKey: 'dueAt', action: 'answer', value: '2026-12-01T00:00:00.000Z' },
          ],
        },
      });
      expect(answered.statusCode).toBe(200);
      const after = answered.json() as IntakeSessionDto;
      expect(after.state).toBe('clarification');
      expect(after.answers?.[0]?.value).toBe('2026-12-01T00:00:00.000Z');
      expect(after.input.dueAt).toBe('2026-12-01T00:00:00.000Z');

      const invalid = await createSession();
      const rejected = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${invalid.id}/answers`,
        headers: authHeaders(session, {
          'if-match': `W/"${invalid.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
          answers: [{ questionKey: 'dueAt', action: 'answer', value: '2026-13-99T00:00:00Z' }],
        },
      });
      expect(rejected.statusCode).toBe(422);
      expect((rejected.json() as { errors: { path: string }[] }).errors[0]?.path).toBe(
        '/answers/0/value',
      );
      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${invalid.id}`,
        headers: authHeaders(session),
      });
      expect(read.statusCode).toBe(200);
      expect((read.json() as IntakeSessionDto).state).toBe('clarification');
    } finally {
      await ctx.close();
    }
  });

  test('goalId references are owner-scoped and return 422 instead of 500', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'goal-owner@example.com', password: 'correct-horse' });
    const otherOwner = await ctx.seedUser({
      email: 'goal-other@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'goal-owner@example.com', 'correct-horse');
    const otherGoalId = ctx.ids.next();
    await ctx.db
      .insertInto('goal')
      .values({ id: otherGoalId, owner_id: otherOwner, title: 'Other goal' })
      .execute();
    try {
      const cases = [ctx.ids.next(), otherGoalId];
      for (const goalId of cases) {
        const response = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/intake-sessions',
          headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
          payload: { input: { title: 'Unknown goal' }, goalId },
        });
        expect(response.statusCode).toBe(422);
        expect((response.json() as { errors: { path: string }[] }).errors[0]?.path).toBe(
          '/goalId',
        );
      }
      const sessions = await ctx.db.selectFrom('intake_session').selectAll().execute();
      expect(sessions).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  test('stalled approver keeps the lock: second approval is 409, resume creates six', async () => {
    const { script, repos } = scriptedRepos();
    const ctx = await createTestContext({ repos });
    await ctx.seedUser({ email: 'lock-stall@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'lock-stall@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const hit = new Promise<void>((resolve) => {
        entered = resolve;
      });
      script.beforeCreate = async (index) => {
        if (index !== 1) return;
        entered();
        await gate;
      };
      const first = approve(ctx, session, current.id, current.version);
      await hit;
      const second = await approve(ctx, session, current.id, current.version);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: 'approval_in_progress' });
      release();
      expect((await first).statusCode).toBe(200);
      expect(await taskCount(ctx, session)).toBe(6);
    } finally {
      await ctx.close();
    }
  });

  test('approval-first makes cancel and manual return 409 and still creates six tasks', async () => {
    const { script, repos } = scriptedRepos();
    const ctx = await createTestContext({ repos });
    await ctx.seedUser({ email: 'lock-approval-first@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'lock-approval-first@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const hit = new Promise<void>((resolve) => {
        entered = resolve;
      });
      script.beforeCreate = async (index) => {
        if (index !== 1) return;
        entered();
        await gate;
      };
      const first = approve(ctx, session, current.id, current.version);
      await hit;
      for (const action of ['cancel', 'manual'] as const) {
        const raced = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/intake-sessions/${current.id}:${action}`,
          headers: authHeaders(session, {
            'if-match': `W/"${current.version}"`,
            'idempotency-key': newIdempotencyKey(),
          }),
        });
        expect(raced.statusCode).toBe(409);
        expect(raced.json()).toMatchObject({ code: 'approval_in_progress' });
      }
      release();
      expect((await first).statusCode).toBe(200);
      expect(await taskCount(ctx, session)).toBe(6);
    } finally {
      await ctx.close();
    }
  });

  test('cancel-first and manual-first make a stale approval 412 with zero tasks', async () => {
    const actionCases = ['cancel', 'manual'] as const;
    for (const action of actionCases) {
      const ctx = await createTestContext({});
      const email = `lock-mutation-first-${action}@example.com`;
      await ctx.seedUser({ email, password: 'correct-horse' });
      const session = await login(ctx, email, 'correct-horse');
      try {
        const current = await createManualDecomposing(ctx, session, true);
        const mutated = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/intake-sessions/${current.id}:${action}`,
          headers: authHeaders(session, {
            'if-match': `W/"${current.version}"`,
            'idempotency-key': newIdempotencyKey(),
          }),
        });
        expect(mutated.statusCode).toBe(200);
        const stale = await approve(ctx, session, current.id, current.version);
        expect(stale.statusCode).toBe(412);
        expect(await taskCount(ctx, session)).toBe(0);
      } finally {
        await ctx.close();
      }
    }
  });

  test('destroying the approval lock client releases the session for the next approval', async () => {
    const ctx = await createTestContext({});
    await ctx.seedUser({ email: 'lock-death@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'lock-death@example.com', 'correct-horse');
    if (databaseUrl === undefined) throw new Error('DATABASE_URL required');
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const current = await createManualDecomposing(ctx, session, true);
    try {
      const acquired = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [intakeSessionLockKey(current.id as Id)],
      );
      expect(acquired.rows[0]?.locked).toBe(true);
      const blocked = await approve(ctx, session, current.id, current.version);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ code: 'approval_in_progress' });

      // Abrupt process death: the connection closes and PostgreSQL drops the
      // session lock. There is no lease timer to wait for.
      await client.end();

      const retried = await approve(ctx, session, current.id, current.version);
      expect(retried.statusCode).toBe(200);
      expect(await taskCount(ctx, session)).toBe(6);
    } finally {
      await client.end().catch(() => undefined);
      await ctx.close();
    }
  });

  test('an absent template step kind is normalized to work', async () => {
    const ctx = await createTestContext({});
    const ownerId = await ctx.seedUser({
      email: 'l-template-absent@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'l-template-absent@example.com', 'correct-horse');
    const templateId = ctx.ids.next();
    await ctx.db
      .insertInto('task_template')
      .values({
        id: templateId,
        owner_id: ownerId,
        name: 'Absent kind template',
        steps: JSON.stringify([{}]) as never,
        source: 'system',
      })
      .execute();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/templates/${templateId}`,
        headers: authHeaders(session),
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { steps: { kind: string }[] }).steps[0]?.kind).toBe('work');
    } finally {
      await ctx.close();
    }
  });

  test('probe I: retry after a created task was deleted skips it and never returns 500', async () => {
    const { script, repos } = scriptedRepos();
    const ctx = await createTestContext({ repos });
    const ownerId = await ctx.seedUser({
      email: 'probe-i@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'probe-i@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      script.beforeCreate = async (index) => {
        if (index === 6) throw new ProviderUnavailableError('vikunja', 'injected');
      };
      const key = newIdempotencyKey();
      const failed = await approve(ctx, session, current.id, current.version, key);
      expect(failed.statusCode).toBe(503);
      const rows = await ctx.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .execute();
      expect(rows.filter((row) => row.state === 'created')).toHaveLength(5);
      const victimId = rows.find((row) => row.step_key === 's1')?.task_id;
      expect(victimId).toBeDefined();
      const victim = await ctx.repos.tasks.get(ownerId, victimId as Id);
      if (victim === null) throw new Error('victim task missing');
      await ctx.repos.tasks.softDelete(ownerId, victim.id, victim.version);

      script.beforeCreate = undefined;
      const retried = await approve(ctx, session, current.id, current.version, key);
      expect(retried.statusCode).toBe(200);
      expect((retried.json() as IntakeSessionDto).state).toBe('feasibility_check');
      const skipped = await ctx.db
        .selectFrom('intake_approval_step')
        .select(['state', 'dependency_state'])
        .where('session_id', '=', current.id)
        .where('step_key', '=', 's1')
        .executeTakeFirst();
      expect(skipped?.state).toBe('unknown');
      expect(skipped?.dependency_state).toBe('skipped:vanished');
      const estimates = await ctx.db
        .selectFrom('estimate')
        .select(['task_id'])
        .where('owner_id', '=', ownerId)
        .where('is_current', '=', true)
        .execute();
      expect(estimates.map((row) => row.task_id)).not.toContain(victimId);
      expect(estimates).toHaveLength(5);
    } finally {
      await ctx.close();
    }
  });

  test('probe J: a cross-owner id collision in complete() is a stored 409, not a 500', async () => {
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(20261201, clock);
    const base = createInMemoryRepositories({ clock, ids });
    const collision = { id: '' as Id };
    let injected = false;
    const originalCreate = base.tasks.create.bind(base.tasks);
    const tasks: TaskRepository = {
      capabilities: base.tasks.capabilities,
      create: async (ownerId, input, idemKey, opts) => {
        if (injected) return originalCreate(ownerId, input, idemKey, opts);
        injected = true;
        return originalCreate(ownerId, input, idemKey, {
          ...opts,
          plannedId: collision.id,
        });
      },
      get: (ownerId, id) => base.tasks.get(ownerId, id),
      list: (ownerId, query) => base.tasks.list(ownerId, query),
      update: (ownerId, id, patch, version) => base.tasks.update(ownerId, id, patch, version),
      complete: (ownerId, id, version) => base.tasks.complete(ownerId, id, version),
      softDelete: (ownerId, id, version) => base.tasks.softDelete(ownerId, id, version),
      listChangedSince: (ownerId, cursor) => base.tasks.listChangedSince(ownerId, cursor),
    };
    const ctx = await createTestContext({ repos: { tasks, projects: base.projects } });
    collision.id = ctx.ids.next();
    await ctx.seedUser({ email: 'probe-j@example.com', password: 'correct-horse' });
    const bobId = await ctx.seedUser({
      email: 'probe-j-bob@example.com',
      password: 'correct-horse',
    });
    const bobProjectId = randomUUID();
    await ctx.db
      .insertInto('project')
      .values({ id: bobProjectId, owner_id: bobId, title: 'Bob project', kind: 'normal' })
      .execute();
    await ctx.db
      .insertInto('task')
      .values({
        id: collision.id,
        owner_id: bobId,
        project_id: bobProjectId,
        title_cache: 'Bob task',
        status_cache: 'todo',
        splittable: true,
        priority: 2,
      })
      .execute();
    const session = await login(ctx, 'probe-j@example.com', 'correct-horse');
    try {
      const current = await createManualDecomposing(ctx, session, true);
      const response = await approve(ctx, session, current.id, current.version);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'illegal_transition' });
      const approval = await ctx.db
        .selectFrom('intake_approval')
        .select(['state'])
        .where('session_id', '=', current.id)
        .executeTakeFirst();
      expect(approval?.state).toBe('failed');
      const bobRow = await ctx.db
        .selectFrom('task')
        .select(['owner_id', 'title_cache'])
        .where('id', '=', collision.id)
        .executeTakeFirst();
      expect(bobRow).toMatchObject({ owner_id: bobId, title_cache: 'Bob task' });
    } finally {
      await ctx.close();
    }
  });

  test('all 13 intake and template routes stay within their declared statuses', async () => {
    const declared = new Map(
      routes.map((route) => [
        route.operationId,
        new Set(Object.keys(route.responses).map((status) => Number(status))),
      ]),
    );
    const ctx = await createTestContext({});
    const ownerId = await ctx.seedUser({
      email: 'route-walk@example.com',
      password: 'correct-horse',
    });
    const session = await login(ctx, 'route-walk@example.com', 'correct-horse');
    const check = (operationId: string, statusCode: number): void => {
      const allowed = declared.get(operationId);
      expect(allowed, `route ${operationId} is registered`).toBeDefined();
      expect([...(allowed ?? [])], `${operationId} -> ${statusCode}`).toContain(statusCode);
    };
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input: { title: 'Route walk' } },
      });
      check('createIntakeSession', created.statusCode);
      const body = created.json() as IntakeSessionDto;

      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${body.id}`,
        headers: authHeaders(session),
      });
      check('getIntakeSession', read.statusCode);

      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}/answers`,
        headers: authHeaders(session, {
          'if-match': `W/"${body.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { answers: [{ questionKey: 'priority', action: 'answer', value: 2 }] },
      });
      check('answerIntakeQuestions', answered.statusCode);
      let current = answered.json() as IntakeSessionDto;
      expect(current.state).toBe('clarification');

      const confirmed = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}/type-confirmation`,
        headers: authHeaders(session, {
          'if-match': `W/"${current.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { similar: false },
      });
      check('confirmIntakeType', confirmed.statusCode);

      const manual = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:manual`,
        headers: authHeaders(session, {
          'if-match': `W/"${current.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      check('enterManualIntakeMode', manual.statusCode);
      current = manual.json() as IntakeSessionDto;

      const paused = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:pause`,
        headers: authHeaders(session, {
          'if-match': `W/"${current.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      check('pauseIntakeSession', paused.statusCode);
      current = paused.json() as IntakeSessionDto;

      const resumed = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:resume`,
        headers: authHeaders(session, {
          'if-match': `W/"${current.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      check('resumeIntakeSession', resumed.statusCode);
      current = resumed.json() as IntakeSessionDto;

      const cancelled = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}:cancel`,
        headers: authHeaders(session, {
          'if-match': `W/"${current.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
      });
      check('cancelIntakeSession', cancelled.statusCode);

      const decomposing = await createManualDecomposing(ctx, session);
      const draft = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/intake-sessions/${decomposing.id}/draft`,
        headers: authHeaders(session),
      });
      check('getIntakeDraft', draft.statusCode);

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/intake-sessions/${decomposing.id}/draft`,
        headers: authHeaders(session, {
          'if-match': `W/"${decomposing.version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { assumptions: ['route walk'] },
      });
      check('updateIntakeDraft', patched.statusCode);

      const approved = await approve(ctx, session, decomposing.id, decomposing.version);
      check('approveIntakeDraft', approved.statusCode);

      const templateId = await ctx.seedTemplate({
        ownerId,
        name: 'Route walk template',
        steps: [
          {
            key: 's1',
            title: 'Step',
            deliverable: 'Thing',
            doneCriteria: 'Done',
            kind: 'work',
            estimate: { p50Minutes: 30, p90Minutes: 60 },
            dependsOn: [],
            splittable: false,
          },
        ],
      });
      const templates = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/templates',
        headers: authHeaders(session),
      });
      check('listTaskTemplates', templates.statusCode);

      const template = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/templates/${templateId}`,
        headers: authHeaders(session),
      });
      check('getTaskTemplate', template.statusCode);
    } finally {
      await ctx.close();
    }
  });
 });
