import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
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
import type { FastifyInstance } from 'fastify';
import { appendMarker } from '@ohmydate/provider-vikunja';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { createSyntheticUser, purgeUserData, type LiveUser } from '../../../packages/provider-vikunja/test/live-support.js';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createVikunjaRepositories } from '../src/adapters/vikunja/composition.js';
import type { Kysely } from 'kysely';
import type { Database } from '../src/db/types.js';
import type { AppRepositories } from '../src/application/ports.js';
import type { IntakeSessionDto } from '@ohmydate/contracts';
import {
  authHeaders,
  newIdempotencyKey,
  sessionFromResponse,
  type TestSession,
} from './support/test-context.js';
import { createPgTestStore, type PgTestStore } from './vikunja/pg-support.js';

const baseUrl = process.env['VIKUNJA_URL'];
const databaseUrl = process.env['DATABASE_URL'];
const live = baseUrl !== undefined && baseUrl.length > 0 && databaseUrl !== undefined;

class FaultInjectingTasks implements TaskRepository {
  readonly capabilities;
  afterCreate?: ((index: number) => Promise<void>) | undefined;
  #count = 0;

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
    const task = await this.inner.create(ownerId, input, idemKey, opts);
    await this.afterCreate?.(index);
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

interface LiveHarness {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly store: PgTestStore;
  readonly user: LiveUser;
  readonly ownerId: Id;
  readonly clock: FakeClock;
  readonly ids: ReturnType<typeof createSeededIdGenerator>;
  readonly faults: FaultInjectingTasks;
  readonly projects: AppRepositories['projects'];
  readonly mappings: Awaited<ReturnType<typeof createVikunjaRepositories>>['mappings'];
  readonly session: TestSession;
  close(): Promise<void>;
}

async function createLiveHarness(email: string, password: string): Promise<LiveHarness> {
  if (baseUrl === undefined || databaseUrl === undefined) {
    throw new Error('live harness requires VIKUNJA_URL and DATABASE_URL');
  }
  const store = await createPgTestStore();
  const user = await createSyntheticUser(baseUrl);
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(Math.floor(Math.random() * 1_000_000), clock);
  const ownerId = ids.next();
  const tokenDir = await mkdtemp(join(tmpdir(), 'ohmydate-m203c-'));
  const tokenPath = join(tokenDir, 'tokens.json');
  await writeFile(tokenPath, JSON.stringify({ [ownerId]: user.token }), 'utf8');
  await store.db
    .insertInto('user')
    .values({ id: ownerId, email, password_hash: await hash(password) })
    .execute();
  await store.db
    .insertInto('vikunja_owner_account')
    .values({
      owner_id: ownerId,
      vikunja_user_id: user.userId,
      token_secret_ref: `file:${tokenPath}`,
    })
    .execute();

  const config = createConfig({
    provider: 'vikunja',
    vikunjaUrl: baseUrl,
    vikunjaSecretsDir: tokenDir,
    databaseUrl,
    reconcileIntervalMs: 0,
    cookieSecure: false,
    logLevel: 'silent',
    loginRateLimit: { limit: 1_000, windowMs: 60_000 },
  });
  const composition = await createVikunjaRepositories({
    db: store.db,
    config,
    clock,
    ids,
  });
  const faults = new FaultInjectingTasks(composition.tasks);
  const app = await buildApp({
    config,
    clock,
    ids,
    db: store.db,
    repos: { tasks: faults, projects: composition.projects },
    logger: false,
  });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (login.statusCode !== 204) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  const session = sessionFromResponse(login.headers['set-cookie']);
  return {
    app,
    db: store.db,
    store,
    user,
    ownerId,
    clock,
    ids,
    faults,
    projects: composition.projects,
    mappings: composition.mappings,
    session,
    async close() {
      await app.close();
      await purgeUserData(user.client, composition.mappings, ownerId);
      await store.close();
      await rm(tokenDir, { recursive: true, force: true });
    },
  };
}

const sixSteps = Array.from({ length: 6 }, (_, index) => ({
  key: `s${index + 1}`,
  title: `Live step ${index + 1}`,
  deliverable: `Deliverable ${index + 1}`,
  doneCriteria: `Done ${index + 1}`,
  kind: index === 5 ? ('review' as const) : ('work' as const),
  estimate: { p50Minutes: 30, p90Minutes: 60 },
  dependsOn: index === 0 ? [] : [`s${index}`],
  splittable: false,
}));

async function createSixStepDecomposition(harness: LiveHarness): Promise<IntakeSessionDto> {
  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/intake-sessions',
    headers: authHeaders(harness.session, { 'idempotency-key': newIdempotencyKey() }),
    payload: { input: { title: 'Live approval task', deliverable: 'Ship it' } },
  });
  expect(created.statusCode).toBe(201);
  const body = created.json() as IntakeSessionDto;
  const answers = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/intake-sessions/${body.id}/answers`,
    headers: authHeaders(harness.session, {
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
  const patched = await harness.app.inject({
    method: 'PATCH',
    url: `/api/v1/intake-sessions/${body.id}/draft`,
    headers: authHeaders(harness.session, {
      'if-match': `W/"${current.version}"`,
      'idempotency-key': newIdempotencyKey(),
    }),
    payload: { steps: sixSteps },
  });
  expect(patched.statusCode).toBe(200);
  current = {
    ...current,
    version: Number(patched.headers['etag']?.toString().slice(3, -1)),
  };
  expect(current.state).toBe('decomposition');
  return current;
}

function approve(harness: LiveHarness, id: string, version: number, key = newIdempotencyKey()) {
  return harness.app.inject({
    method: 'POST',
    url: `/api/v1/intake-sessions/${id}/draft:approve`,
    headers: authHeaders(harness.session, {
      'if-match': `W/"${version}"`,
      'idempotency-key': key,
    }),
  });
}

async function remoteTaskCount(harness: LiveHarness): Promise<number> {
  return (await harness.user.client.listAllTasks()).length;
}

async function preInsertApproval(
  harness: LiveHarness,
  session: IntakeSessionDto,
  plannedIds: readonly Id[],
): Promise<void> {
  await harness.db
    .insertInto('intake_approval')
    .values({
      session_id: session.id,
      owner_id: harness.ownerId,
      draft_version: session.version,
      state: 'in_progress',
      lease_expires_at: new Date(Date.now() + 60_000),
      idempotency_key: 'pre-crash-key',
    })
    .execute();
  await harness.db
    .insertInto('intake_approval_step')
    .values(
      sixSteps.map((step, index) => ({
        session_id: session.id,
        step_key: step.key,
        planned_task_id: plannedIds[index] as Id,
        state: 'pending',
      })),
    )
    .execute();
}

async function createMarkerOrphan(
  harness: LiveHarness,
  plannedId: Id,
  title: string,
): Promise<string> {
  const inbox = await harness.projects.getInbox(harness.ownerId);
  const mapping = await harness.mappings.get('project', inbox.id);
  if (mapping === null) throw new Error('inbox mapping missing');
  const task = await harness.user.client.createTask(mapping.externalId, {
    title,
    description: appendMarker('created before crash', plannedId),
  });
  return String(task.id);
}

describe.skipIf(!live)(`intake approval with live Vikunja (${baseUrl ?? 'unset'})`, () => {
  test('crash after the first remote create retries with the persisted planned ids', async () => {
    const harness = await createLiveHarness('live-crash-after@example.com', 'correct-horse');
    try {
      const current = await createSixStepDecomposition(harness);
      harness.faults.afterCreate = async (index) => {
        if (index === 1) throw new ProviderUnavailableError('vikunja', 'injected crash');
      };
      const key = newIdempotencyKey();
      const failed = await approve(harness, current.id, current.version, key);
      expect(failed.statusCode).toBe(503);
      expect(await remoteTaskCount(harness)).toBe(1);

      harness.faults.afterCreate = undefined;
      const retried = await approve(harness, current.id, current.version, key);
      expect(retried.statusCode).toBe(200);
      expect(await remoteTaskCount(harness)).toBe(6);

      const rows = await harness.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .where('state', '=', 'created')
        .execute();
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(row.task_id).toBe(row.planned_task_id);
      }
    } finally {
      await harness.close();
    }
  });

  test('marker-only orphan (crash before mapping persistence) is adopted once', async () => {
    const harness = await createLiveHarness('live-marker@example.com', 'correct-horse');
    try {
      const current = await createSixStepDecomposition(harness);
      const plannedIds = sixSteps.map(() => harness.ids.next());
      await preInsertApproval(harness, current, plannedIds);
      await createMarkerOrphan(harness, plannedIds[0] as Id, sixSteps[0]?.title ?? 'Step 1');

      const approved = await approve(harness, current.id, current.version);
      expect(approved.statusCode).toBe(200);
      expect(await remoteTaskCount(harness)).toBe(6);
      const rows = await harness.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .where('state', '=', 'created')
        .execute();
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(row.task_id).toBe(row.planned_task_id);
      }
    } finally {
      await harness.close();
    }
  });

  test('a user-deleted orphan is recreated and still yields six tasks', async () => {
    const harness = await createLiveHarness('live-deleted@example.com', 'correct-horse');
    try {
      const current = await createSixStepDecomposition(harness);
      const plannedIds = sixSteps.map(() => harness.ids.next());
      await preInsertApproval(harness, current, plannedIds);
      const orphanId = await createMarkerOrphan(
        harness,
        plannedIds[0] as Id,
        sixSteps[0]?.title ?? 'Step 1',
      );
      await harness.user.client.deleteTask(orphanId);
      await harness.user.client.permanentDeleteTask(orphanId).catch(() => undefined);

      const approved = await approve(harness, current.id, current.version);
      expect(approved.statusCode).toBe(200);
      expect(await remoteTaskCount(harness)).toBe(6);
    } finally {
      await harness.close();
    }
  });

  test('knownLimitation: editing the orphan marker duplicates that step', async () => {
    const harness = await createLiveHarness('live-edited-marker@example.com', 'correct-horse');
    try {
      const current = await createSixStepDecomposition(harness);
      const plannedIds = sixSteps.map(() => harness.ids.next());
      await preInsertApproval(harness, current, plannedIds);
      const orphanId = await createMarkerOrphan(
        harness,
        plannedIds[0] as Id,
        sixSteps[0]?.title ?? 'Step 1',
      );
      await harness.user.client.patchTask(orphanId, {
        description: 'user edited this description and removed the marker',
      });

      const approved = await approve(harness, current.id, current.version);
      expect(approved.statusCode).toBe(200);
      // ADR-020 §3 knownLimitation: the edited orphan is invisible to marker
      // recovery, so a retry creates a fresh task for that step.
      expect(await remoteTaskCount(harness)).toBe(7);
    } finally {
      await harness.close();
    }
  });
});
