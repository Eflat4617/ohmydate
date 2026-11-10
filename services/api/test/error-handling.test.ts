import { Writable } from 'node:stream';
import type { TaskRepository } from '@ohmydate/domain';
import { DomainError, ProviderUnavailableError } from '@ohmydate/domain';
import pino from 'pino';
import type { LoggerInstanceOption } from '../src/app.js';
import type { AppRepositories } from '../src/application/ports.js';
import type {
  IdempotencyCompleteInput,
  IdempotencyReservation,
  IdempotencyStore,
} from '../src/application/ports.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
} from './support/test-context.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';

class UnmappedDomainError extends DomainError {
  readonly code = 'provider_unavailable' as const;

  constructor() {
    super('secret domain detail');
  }
}

class GenericFailureError extends Error {
  constructor() {
    super('secret generic detail');
  }
}

function captureStream(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, output: () => chunks.join('') };
}

function failingRepos(factory: () => Error): AppRepositories {
  const tasks = {
    get: async () => {
      throw factory();
    },
    update: async () => {
      throw factory();
    },
  } as unknown as TaskRepository;
  const projects = {
    getInbox: async () => ({ id: '01900000-0000-7000-8000-0000000000aa' }),
  };
  return { tasks, projects } as unknown as AppRepositories;
}

describe.skipIf(!hasDatabase)('500 error handling', () => {
  test('an unmapped DomainError is logged and returns a generic internal_error', async () => {
    const { stream, output } = captureStream();
    const loggerInstance = pino({ level: 'error' }, stream) as unknown as LoggerInstanceOption;
    const ctx = await createTestContext({
      loggerInstance,
      repos: failingRepos(() => new UnmappedDomainError()),
    });
    try {
      await ctx.seedUser({ email: 'boom@example.com', password: 'correct-horse' });
      const session = await login(ctx, 'boom@example.com', 'correct-horse');
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${ID}`,
        headers: authHeaders(session),
      });
      expect(response.statusCode).toBe(500);
      const body = response.json() as { code: string; detail?: string };
      expect(body.code).toBe('internal_error');
      expect(body.detail).toBe('an unexpected error occurred');
      expect(response.body).not.toContain('secret domain detail');
      expect(output()).toContain('unhandled domain error');
    } finally {
      await ctx.close();
    }
  });

  test('a generic Error is logged and returns a generic internal_error', async () => {
    const { stream, output } = captureStream();
    const loggerInstance = pino({ level: 'error' }, stream) as unknown as LoggerInstanceOption;
    const ctx = await createTestContext({
      loggerInstance,
      repos: failingRepos(() => new GenericFailureError()),
    });
    try {
      await ctx.seedUser({ email: 'boom2@example.com', password: 'correct-horse' });
      const session = await login(ctx, 'boom2@example.com', 'correct-horse');
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${ID}`,
        headers: authHeaders(session),
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: 'internal_error',
        detail: 'an unexpected error occurred',
      });
      expect(response.body).not.toContain('secret generic detail');
      expect(output()).toContain('unhandled request error');
    } finally {
      await ctx.close();
    }
  });
});

describe.skipIf(!hasDatabase)('provider unavailable mapping', () => {
  test('a provider outage on a read keeps the contracted 503 provider_unavailable', async () => {
    const ctx = await createTestContext({
      repos: failingRepos(() => new ProviderUnavailableError('vikunja')),
    });
    try {
      await ctx.seedUser({ email: 'provider@example.com', password: 'correct-horse' });
      const session = await login(ctx, 'provider@example.com', 'correct-horse');
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${ID}`,
        headers: authHeaders(session),
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const body = response.json() as {
        status: number;
        code: string;
        title: string;
        traceId?: string;
      };
      expect(body).toMatchObject({
        status: 503,
        code: 'provider_unavailable',
        title: 'Provider unavailable',
      });
      expect(typeof body.traceId).toBe('string');
    } finally {
      await ctx.close();
    }
  });

  test('a provider outage on a mutation returns 503 and releases the idempotency key', async () => {
    const ctx = await createTestContext({
      repos: failingRepos(() => new ProviderUnavailableError('vikunja')),
    });
    try {
      const ownerId = await ctx.seedUser({
        email: 'provider-write@example.com',
        password: 'correct-horse',
      });
      const session = await login(ctx, 'provider-write@example.com', 'correct-horse');
      const key = newIdempotencyKey();
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${ID}`,
        headers: authHeaders(session, {
          'if-match': 'W/"1"',
          'idempotency-key': key,
        }),
        payload: { title: 'provider outage write' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const body = response.json() as {
        status: number;
        code: string;
        title: string;
        traceId?: string;
      };
      expect(body).toMatchObject({
        status: 503,
        code: 'provider_unavailable',
        title: 'Provider unavailable',
      });
      expect(typeof body.traceId).toBe('string');

      const rows = await ctx.db
        .selectFrom('idempotency_record')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('owner_id', '=', ownerId)
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
      expect(Number(rows.count)).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});

describe.skipIf(!hasDatabase)('idempotency problem storage failure', () => {
  class FlakyStore implements IdempotencyStore {
    failProblemStorage = false;
    releases = 0;

    async reserve(): Promise<IdempotencyReservation> {
      return { kind: 'reserved' };
    }

    async complete(input: IdempotencyCompleteInput): Promise<void> {
      if (
        this.failProblemStorage &&
        (input.response.status === 409 || input.response.status === 422)
      ) {
        throw new Error('storage unavailable');
      }
    }

    async release(): Promise<void> {
      this.releases += 1;
    }
  }

  test('a failing problem store releases the key and rethrows the domain error', async () => {
    const store = new FlakyStore();
    const ctx: TestContext = await createTestContext({ idempotency: store });
    try {
      await ctx.seedUser({ email: 'cycle@example.com', password: 'correct-horse' });
      const session = await login(ctx, 'cycle@example.com', 'correct-horse');

      const createTask = async (title: string) => {
        const response = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
          payload: { title },
        });
        expect(response.statusCode).toBe(201);
        return response.json() as { id: string };
      };
      const first = await createTask('Store A');
      const second = await createTask('Store B');

      const depends = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${second.id}/dependencies`,
        headers: authHeaders(session, {
          'if-match': 'W/"1"',
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { dependsOnTaskId: first.id },
      });
      expect(depends.statusCode).toBe(201);

      store.failProblemStorage = true;
      const cycle = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${first.id}/dependencies`,
        headers: authHeaders(session, {
          'if-match': 'W/"1"',
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { dependsOnTaskId: second.id },
      });

      expect(cycle.statusCode).toBe(422);
      expect(cycle.json()).toMatchObject({ code: 'dependency_cycle' });
      expect(store.releases).toBe(1);
    } finally {
      await ctx.close();
    }
  });
});
