import { hash } from '@node-rs/argon2';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import pg from 'pg';
import {
  VikunjaClient,
  VikunjaProjectRepository,
  VikunjaTaskRepository,
  appendMarker,
  type FetchLike,
} from '@ohmydate/provider-vikunja';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { createSyntheticUser, purgeUserData, type LiveUser } from '../../../packages/provider-vikunja/test/live-support.js';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { intakeSessionLockKey } from '../src/adapters/intake-session-advisory.js';
import { PgChangeJournalStore } from '../src/adapters/vikunja/pg-change-journal-store.js';
import { PgMappingStore } from '../src/adapters/vikunja/pg-mapping-store.js';
import { PgPlannerFieldStore } from '../src/adapters/vikunja/pg-planner-field-store.js';
import type { Kysely } from 'kysely';
import type { Database } from '../src/db/types.js';
import type { IntakeSessionDto, Plan } from '@ohmydate/contracts';
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
  beforeCreate?: ((index: number) => Promise<void>) | undefined;
  getCalls = 0;
  createCalls = 0;
  updateCalls = 0;
  #count = 0;

  constructor(private readonly inner: TaskRepository) {
    this.capabilities = inner.capabilities;
  }

  providerCalls(): number {
    return this.getCalls + this.createCalls + this.updateCalls;
  }

  async create(
    ownerId: Id,
    input: TaskCreate,
    idemKey: string,
    opts?: { readonly plannedId?: Id },
  ): Promise<Task> {
    const index = (this.#count += 1);
    this.createCalls += 1;
    await this.beforeCreate?.(index);
    const task = await this.inner.create(ownerId, input, idemKey, opts);
    await this.afterCreate?.(index);
    return task;
  }
  get(ownerId: Id, id: Id): Promise<Task | null> {
    this.getCalls += 1;
    return this.inner.get(ownerId, id);
  }
  list(ownerId: Id, query: TaskQuery): Promise<Page<Task>> {
    return this.inner.list(ownerId, query);
  }
  update(ownerId: Id, id: Id, patch: TaskPatch, version: Version): Promise<Task> {
    this.updateCalls += 1;
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
  readonly tasks: VikunjaTaskRepository;
  readonly projects: VikunjaProjectRepository;
  readonly mappings: PgMappingStore;
  readonly plannerFields: PgPlannerFieldStore;
  readonly journal: PgChangeJournalStore;
  readonly client: VikunjaClient;
  readonly session: TestSession;
  close(): Promise<void>;
}

async function createLiveHarness(
  email: string,
  password: string,
  options: { readonly fetch?: FetchLike } = {},
): Promise<LiveHarness> {
  if (baseUrl === undefined || databaseUrl === undefined) {
    throw new Error('live harness requires VIKUNJA_URL and DATABASE_URL');
  }
  const store = await createPgTestStore();
  const user = await createSyntheticUser(baseUrl);
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(Math.floor(Math.random() * 1_000_000), clock);
  const ownerId = ids.next();
  await store.db
    .insertInto('user')
    .values({ id: ownerId, email, password_hash: await hash(password) })
    .execute();

  const config = createConfig({
    provider: 'vikunja',
    vikunjaUrl: baseUrl,
    databaseUrl,
    reconcileIntervalMs: 0,
    cookieSecure: false,
    logLevel: 'silent',
    loginRateLimit: { limit: 1_000, windowMs: 60_000 },
  });
  const client =
    options.fetch === undefined
      ? user.client
      : new VikunjaClient({ baseUrl, token: user.token, fetch: options.fetch });
  const clients = new Map<Id, VikunjaClient>([[ownerId, client]]);
  const mappings = new PgMappingStore(store.db);
  const plannerFields = new PgPlannerFieldStore(store.db, clock);
  const journal = new PgChangeJournalStore(store.db, clock);
  const projects = new VikunjaProjectRepository({ clients, mappings, clock, ids });
  const tasks = new VikunjaTaskRepository({
    clients,
    mappings,
    plannerFields,
    journal,
    projects,
    clock,
    ids,
  });
  const faults = new FaultInjectingTasks(tasks);
  const app = await buildApp({
    config,
    clock,
    ids,
    db: store.db,
    repos: { tasks: faults, projects },
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
    tasks,
    projects,
    mappings,
    plannerFields,
    journal,
    client,
    session,
    async close() {
      await app.close();
      await purgeUserData(user.client, mappings, ownerId);
      await store.close();
    },
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface ProductionLiveHarness {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly store: PgTestStore;
  readonly user: LiveUser;
  readonly ownerId: Id;
  readonly session: TestSession;
  close(): Promise<void>;
}

/**
 * Builds the app without injected repositories so the approval path runs on the
 * production composition: `createVikunjaRepositories` with durable PostgreSQL
 * stores and a Vikunja client/account resolved by `loadVikunjaClients`.
 */
async function createProductionLiveHarness(
  email: string,
  password: string,
): Promise<ProductionLiveHarness> {
  if (baseUrl === undefined || databaseUrl === undefined) {
    throw new Error('live harness requires VIKUNJA_URL and DATABASE_URL');
  }
  const store = await createPgTestStore();
  const user = await createSyntheticUser(baseUrl);
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(Math.floor(Math.random() * 1_000_000), clock);
  const ownerId = ids.next();
  await store.db
    .insertInto('user')
    .values({ id: ownerId, email, password_hash: await hash(password) })
    .execute();
  const tokenDir = await mkdtemp(join(tmpdir(), 'ohmydate-m203d-'));
  const tokenPath = join(tokenDir, 'tokens.json');
  await writeFile(tokenPath, JSON.stringify({ [ownerId]: user.token }), 'utf8');
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
    reconcileIntervalMs: 0,
    cookieSecure: false,
    logLevel: 'silent',
    loginRateLimit: { limit: 1_000, windowMs: 60_000 },
  });
  const app = await buildApp({ config, clock, ids, db: store.db, logger: false });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (login.statusCode !== 204) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  return {
    app,
    db: store.db,
    store,
    user,
    ownerId,
    session: sessionFromResponse(login.headers['set-cookie']),
    async close() {
      await app.close();
      await purgeUserData(user.client, new PgMappingStore(store.db), ownerId);
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

type IntakeAppHarness = Pick<LiveHarness, 'app' | 'session'>;

async function createSixStepDecomposition(harness: IntakeAppHarness): Promise<IntakeSessionDto> {
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

function approve(harness: IntakeAppHarness, id: string, version: number, key = newIdempotencyKey()) {
  return harness.app.inject({
    method: 'POST',
    url: `/api/v1/intake-sessions/${id}/draft:approve`,
    headers: authHeaders(harness.session, {
      'if-match': `W/"${version}"`,
      'idempotency-key': key,
    }),
  });
}

async function remoteTaskCount(harness: Pick<LiveHarness, 'user'>): Promise<number> {
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

async function lockBackendPids(sessionId: Id): Promise<number[]> {
  if (databaseUrl === undefined) throw new Error('DATABASE_URL required');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ pid: number }>(
      `SELECT a.pid
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.objsubid = 1
          AND l.granted
          AND ((((l.classid::text::numeric * 4294967296) + l.objid::text::numeric)
                + 9223372036854775808) % 18446744073709551616)
              - 9223372036854775808 = hashtextextended($1, 0)::numeric`,
      [intakeSessionLockKey(sessionId)],
    );
    return result.rows.map((row) => row.pid);
  } finally {
    await client.end();
  }
}

async function terminateLockBackends(sessionId: Id): Promise<number> {
  if (databaseUrl === undefined) throw new Error('DATABASE_URL required');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const pids = await lockBackendPids(sessionId);
    for (const pid of pids) {
      await client.query('SELECT pg_terminate_backend($1)', [pid]);
    }
    return pids.length;
  } finally {
    await client.end();
  }
}

async function waitForLockRelease(sessionId: Id): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await lockBackendPids(sessionId)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('approval lock backend did not end');
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

  test('active lock-connection loss stops the holder before its next write and B succeeds after the window', async () => {
    const harness = await createLiveHarness('live-lock-loss@example.com', 'correct-horse');
    let releaseA: (() => void) | undefined;
    try {
      const current = await createSixStepDecomposition(harness);
      let entered!: () => void;
      const firstCreated = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      harness.faults.afterCreate = async (index) => {
        if (index !== 1) return;
        entered();
        await gateA;
      };

      const keyA = newIdempotencyKey();
      const aPromise = approve(harness, current.id, current.version, keyA);
      await firstCreated;
      expect(await remoteTaskCount(harness)).toBe(1);

      // The reviewer probe: kill the actual advisory-lock backend while A's
      // process remains alive and paused after its first successful create.
      expect(await terminateLockBackends(current.id as Id)).toBe(1);
      await waitForLockRelease(current.id as Id);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const bEarly = await approve(harness, current.id, current.version, newIdempotencyKey());
      expect(bEarly.statusCode).toBe(409);
      expect(bEarly.json()).toMatchObject({ code: 'approval_in_progress' });
      expect(bEarly.headers['retry-after']).toBeDefined();
      expect(await remoteTaskCount(harness)).toBe(1);

      const callsAtLoss = harness.faults.providerCalls();
      releaseA?.();
      const aResult = await aPromise;
      expect([409, 503]).toContain(aResult.statusCode);
      // No provider calls or ledger writes after ownership was lost.
      expect(harness.faults.providerCalls()).toBe(callsAtLoss);
      const afterLossSteps = await harness.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .execute();
      expect(afterLossSteps.find((row) => row.step_key === 's1')?.state).toBe('unknown');
      const afterLossApproval = await harness.db
        .selectFrom('intake_approval')
        .selectAll()
        .where('session_id', '=', current.id)
        .executeTakeFirstOrThrow();
      expect(afterLossApproval.state).toBe('in_progress');

      harness.faults.afterCreate = undefined;
      harness.clock.advance(40_001);
      // Hold B's second-step POST while the previous holder's work is known to
      // be finished; exactly one step-2 create may reach the provider.
      let stepTwoEntered!: () => void;
      const stepTwoPost = new Promise<void>((resolve) => {
        stepTwoEntered = resolve;
      });
      let releaseStepTwo!: () => void;
      const stepTwoGate = new Promise<void>((resolve) => {
        releaseStepTwo = resolve;
      });
      harness.faults.beforeCreate = async (index) => {
        if (index !== 2) return;
        stepTwoEntered();
        await stepTwoGate;
      };
      const bRetryPromise = approve(
        harness,
        current.id,
        current.version,
        newIdempotencyKey(),
      );
      await stepTwoPost;
      expect(await remoteTaskCount(harness)).toBe(1);
      releaseStepTwo();
      const bRetry = await bRetryPromise;
      expect(bRetry.statusCode).toBe(200);
      expect(await remoteTaskCount(harness)).toBe(6);
      harness.faults.beforeCreate = undefined;
      const rows = await harness.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .where('state', '=', 'created')
        .execute();
      expect(rows).toHaveLength(6);
      for (const row of rows) expect(row.task_id).toBe(row.planned_task_id);
    } finally {
      releaseA?.();
      harness.faults.afterCreate = undefined;
      await harness.close();
    }
  });

  test('mapped unknown step with failed relation write and failed rollback repairs its dependency on retry', async () => {
    let failAttempt = true;
    let relationFailed = false;
    const faultyFetch: FetchLike = async (input, init) => {
      const url = input;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (failAttempt) {
        if (method === 'POST' && /\/tasks\/\d+\/relations$/.test(url) && !relationFailed) {
          relationFailed = true;
          throw new TypeError('injected relation transport failure');
        }
        if (method === 'DELETE' && /\/tasks\/\d+$/.test(url)) {
          throw new TypeError('injected rollback delete failure');
        }
      }
      return globalThis.fetch(input, init);
    };
    const harness = await createLiveHarness('live-mapped-repair@example.com', 'correct-horse', {
      fetch: faultyFetch,
    });
    try {
      const current = await createSixStepDecomposition(harness);
      const key = newIdempotencyKey();
      const first = await approve(harness, current.id, current.version, key);
      expect(first.statusCode).toBe(503);
      failAttempt = false;

      const retried = await approve(harness, current.id, current.version, key);
      expect(retried.statusCode).toBe(200);
      expect(await remoteTaskCount(harness)).toBe(6);

      const rows = await harness.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .execute();
      const s1 = rows.find((row) => row.step_key === 's1');
      const s2 = rows.find((row) => row.step_key === 's2');
      if (s1?.task_id == null || s2?.planned_task_id == null) {
        throw new Error('missing approval step rows');
      }
      const s1Mapping = await harness.mappings.get('task', s1.task_id as Id);
      const s2Mapping = await harness.mappings.get('task', s2.planned_task_id as Id);
      if (s1Mapping === null || s2Mapping === null) throw new Error('missing mappings');

      const remote = await harness.client.getTask(s2Mapping.externalId);
      const blocked = remote.data.related_tasks?.['blocked'] ?? [];
      expect(blocked.map((task) => String(task.id))).toContain(s1Mapping.externalId);

      const reread = await harness.tasks.get(harness.ownerId, s2.planned_task_id as Id);
      expect(reread?.dependsOn).toContain(s1.task_id);

      const restarted = new VikunjaTaskRepository({
        clients: new Map<Id, VikunjaClient>([[harness.ownerId, harness.client]]),
        mappings: harness.mappings,
        plannerFields: harness.plannerFields,
        journal: harness.journal,
        projects: harness.projects,
        clock: harness.clock,
        ids: harness.ids,
      });
      const afterRestart = await restarted.get(harness.ownerId, s2.planned_task_id as Id);
      expect(afterRestart?.dependsOn).toContain(s1.task_id);
    } finally {
      await harness.close();
    }
  });

  test('P2: a create POST held past the succession window is fenced before it reaches the provider', async () => {
    const secondCreate = deferred();
    const releaseSecond = deferred();
    let createPosts = 0;
    let captured = false;
    const fetch: FetchLike = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = new URL(input).pathname;
      if (!captured && method === 'POST' && /\/api\/v2\/projects\/[^/]+\/tasks$/.test(path)) {
        createPosts += 1;
        if (createPosts === 2) {
          captured = true;
          secondCreate.resolve();
          await releaseSecond.promise;
        }
      }
      return globalThis.fetch(input, init);
    };
    const harness = await createLiveHarness('live-p2-window@example.com', 'correct-horse', {
      fetch,
    });
    try {
      const current = await createSixStepDecomposition(harness);
      const aPromise = approve(harness, current.id, current.version, newIdempotencyKey());
      await secondCreate.promise;
      expect(await remoteTaskCount(harness)).toBe(1);

      // Kill A's real advisory-lock backend while its step-2 create POST is
      // held before reaching Vikunja.
      expect(await terminateLockBackends(current.id as Id)).toBe(1);
      await waitForLockRelease(current.id as Id);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const bEarly = await approve(harness, current.id, current.version, newIdempotencyKey());
      expect(bEarly.statusCode).toBe(409);
      expect(bEarly.json()).toMatchObject({ code: 'approval_in_progress' });
      expect(bEarly.headers['retry-after']).toBeDefined();

      harness.clock.advance(40_001);
      const bRetry = await approve(harness, current.id, current.version, newIdempotencyKey());
      expect(bRetry.statusCode).toBe(200);
      expect(await remoteTaskCount(harness)).toBe(6);

      releaseSecond.resolve();
      const aResult = await aPromise;
      expect(aResult.statusCode).toBe(503);
      // A's held POST was aborted before fetch: no duplicate remote task, and
      // the late completion cannot re-point s2's mapping.
      expect(await remoteTaskCount(harness)).toBe(6);

      const rows = await harness.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .where('state', '=', 'created')
        .execute();
      expect(rows).toHaveLength(6);
      const s2 = rows.find((row) => row.step_key === 's2');
      const s3 = rows.find((row) => row.step_key === 's3');
      if (s2?.task_id == null || s3?.task_id == null) throw new Error('missing step rows');
      const s2Mapping = await harness.mappings.get('task', s2.task_id as Id);
      const s2PlannedMapping = await harness.mappings.get('task', s2.planned_task_id as Id);
      const s3Mapping = await harness.mappings.get('task', s3.task_id as Id);
      if (s2Mapping === null || s3Mapping === null || s2PlannedMapping === null) {
        throw new Error('missing mappings');
      }
      expect(s2PlannedMapping.externalId).toBe(s2Mapping.externalId);
      const remoteS3 = await harness.client.getTask(s3Mapping.externalId);
      const blocked = remoteS3.data.related_tasks?.['blocked'] ?? [];
      expect(blocked.map((task) => String(task.id))).toContain(s2Mapping.externalId);
      const approval = await harness.db
        .selectFrom('intake_approval')
        .selectAll()
        .where('session_id', '=', current.id)
        .executeTakeFirstOrThrow();
      expect(approval.state).toBe('completed');
    } finally {
      releaseSecond.resolve();
      await harness.close();
    }
  });

  test('P6: a relation POST held past the window suppresses rollback DELETE after B completes', async () => {
    const firstRelation = deferred();
    const releaseRelation = deferred();
    let captured = false;
    let deleteCalls = 0;
    const fetch: FetchLike = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = new URL(input).pathname;
      if (method === 'DELETE') deleteCalls += 1;
      if (!captured && method === 'POST' && /\/api\/v2\/tasks\/\d+\/relations$/.test(path)) {
        captured = true;
        firstRelation.resolve();
        await releaseRelation.promise;
      }
      return globalThis.fetch(input, init);
    };
    const harness = await createLiveHarness('live-p6-relation@example.com', 'correct-horse', {
      fetch,
    });
    try {
      const current = await createSixStepDecomposition(harness);
      const aPromise = approve(harness, current.id, current.version, newIdempotencyKey());
      await firstRelation.promise;
      // s1 and s2 exist remotely; A's s2 mapping is persisted, its relation
      // write is in flight.
      expect(await remoteTaskCount(harness)).toBe(2);

      expect(await terminateLockBackends(current.id as Id)).toBe(1);
      await waitForLockRelease(current.id as Id);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const bEarly = await approve(harness, current.id, current.version, newIdempotencyKey());
      expect(bEarly.statusCode).toBe(409);
      expect(bEarly.json()).toMatchObject({ code: 'approval_in_progress' });

      harness.clock.advance(40_001);
      const bRetry = await approve(harness, current.id, current.version, newIdempotencyKey());
      expect(bRetry.statusCode).toBe(200);
      expect(await remoteTaskCount(harness)).toBe(6);

      releaseRelation.resolve();
      const aResult = await aPromise;
      expect(aResult.statusCode).toBe(503);
      expect(deleteCalls).toBe(0);
      expect(await remoteTaskCount(harness)).toBe(6);

      const rows = await harness.db
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', current.id)
        .where('state', '=', 'created')
        .execute();
      expect(rows).toHaveLength(6);
      const s2 = rows.find((row) => row.step_key === 's2');
      if (s2?.planned_task_id == null) throw new Error('missing s2 row');
      expect(await harness.tasks.get(harness.ownerId, s2.planned_task_id as Id)).not.toBeNull();
    } finally {
      releaseRelation.resolve();
      await harness.close();
    }
  });

  test('P7: the same key retries a transient succession 409 after the window', async () => {
    const harness = await createLiveHarness('live-p7-retry@example.com', 'correct-horse');
    let releaseA: (() => void) | undefined;
    try {
      const current = await createSixStepDecomposition(harness);
      let entered!: () => void;
      const firstCreated = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      harness.faults.afterCreate = async (index) => {
        if (index !== 1) return;
        entered();
        await gateA;
      };

      const key = newIdempotencyKey();
      const aPromise = approve(harness, current.id, current.version, key);
      await firstCreated;
      expect(await terminateLockBackends(current.id as Id)).toBe(1);
      await waitForLockRelease(current.id as Id);
      await new Promise((resolve) => setTimeout(resolve, 50));

      releaseA?.();
      const aResult = await aPromise;
      expect(aResult.statusCode).toBe(503);

      // The natural client flow: the same key retried immediately after the
      // 503 waits for the previous holder's window instead of replaying the
      // 503 or being stuck in idempotency_in_progress.
      const bEarly = await approve(harness, current.id, current.version, key);
      expect(bEarly.statusCode).toBe(409);
      expect(bEarly.json()).toMatchObject({ code: 'approval_in_progress' });
      expect(bEarly.headers['retry-after']).toBeDefined();
      // ADR-020 §11: the transient 409 is not stored; its reservation is gone.
      const recorded = await harness.db
        .selectFrom('idempotency_record')
        .selectAll()
        .where('owner_id', '=', harness.ownerId)
        .where('key', '=', key)
        .executeTakeFirst();
      expect(recorded).toBeUndefined();

      harness.faults.afterCreate = undefined;
      harness.clock.advance(40_001);
      const retried = await approve(harness, current.id, current.version, key);
      expect(retried.statusCode).toBe(200);
      expect(await remoteTaskCount(harness)).toBe(6);
    } finally {
      releaseA?.();
      harness.faults.afterCreate = undefined;
      await harness.close();
    }
  });

  test('production composition plans and approves intake-created tasks end to end', async () => {
    const harness = await createProductionLiveHarness(
      'live-production-planning@example.com',
      'correct-horse',
    );
    try {
      const current = await createSixStepDecomposition(harness);
      const approved = await approve(harness, current.id, current.version);
      expect(approved.statusCode).toBe(200);

      const steps = await harness.db
        .selectFrom('intake_approval_step')
        .select(['task_id'])
        .where('session_id', '=', current.id)
        .where('state', '=', 'created')
        .execute();
      expect(steps).toHaveLength(6);
      const taskIds = steps.map((step) => step.task_id).filter((id): id is string => id !== null);
      expect(taskIds).toHaveLength(6);

      // No hand-inserted identity rows: FU-45 writes them during approval.
      const plannerTasks = await harness.db
        .selectFrom('task')
        .select('id')
        .where('owner_id', '=', harness.ownerId)
        .execute();
      expect(plannerTasks).toHaveLength(6);
      const estimates = await harness.db
        .selectFrom('estimate')
        .select('task_id')
        .where('owner_id', '=', harness.ownerId)
        .where('is_current', '=', true)
        .execute();
      expect(estimates).toHaveLength(6);

      const availability = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/availability',
        headers: authHeaders(harness.session, {
          'if-match': 'W/"availability:1"',
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {
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
        },
      });
      expect(availability.statusCode).toBe(200);
      const availabilityVersion = (availability.json() as { version: number }).version;

      const planResponse = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        headers: authHeaders(harness.session, { 'idempotency-key': newIdempotencyKey() }),
        payload: {
          scope: { taskIds },
          policies: ['balanced'],
          horizon: {
            start: '2026-11-11T00:00:00Z',
            end: '2026-11-18T00:00:00Z',
          },
        },
      });
      expect(planResponse.statusCode).toBe(201);
      const plan = planResponse.json() as Plan;
      const candidate = plan.candidates.find((entry) => entry.feasible);
      expect(candidate).toBeDefined();
      if (candidate === undefined) throw new Error('no feasible candidate');

      const planApprove = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/plans/${plan.id}/candidates/${candidate.id}:approve`,
        headers: authHeaders(harness.session, {
          'if-match': `W/"availability:${availabilityVersion}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: {},
      });
      expect(planApprove.statusCode).toBe(201);
      const blocks = await harness.db
        .selectFrom('schedule_block')
        .select('id')
        .where('owner_id', '=', harness.ownerId)
        .where('status', '<>', 'superseded')
        .execute();
      expect(blocks.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  test('production composition (createVikunjaRepositories + owner-account token) approves six steps', async () => {
    const harness = await createProductionLiveHarness(
      'live-production-composition@example.com',
      'correct-horse',
    );
    try {
      const current = await createSixStepDecomposition(harness);
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
      for (const row of rows) expect(row.task_id).toBe(row.planned_task_id);
    } finally {
      await harness.close();
    }
  });
 });
