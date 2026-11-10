import { hash } from '@node-rs/argon2';
import { PgUserRepository } from '../src/adapters/pg-user-repository.js';
import { UserService } from '../src/application/user-service.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
} from './support/test-context.js';

interface ProjectItems {
  items: { id: string; kind: string }[];
}

function inboxIds(body: unknown): string[] {
  return (body as ProjectItems).items
    .filter((project) => project.kind === 'inbox')
    .map((project) => project.id);
}

describe.skipIf(!hasDatabase)('lazy Inbox for CLI-style users', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function seedCliUser(email: string, password: string): Promise<void> {
    // Mirrors services/api/src/cli/create-user.ts: no project repository is
    // passed, so nothing creates the Inbox at signup time.
    const users = new PgUserRepository(ctx.db, ctx.clock);
    const service = new UserService(users);
    await service.create({
      id: ctx.ids.next(),
      email,
      passwordHash: await hash(password),
    });
  }

  test('serves exactly one Inbox on concurrent first GET and POST', async () => {
    await seedCliUser('cli-style@example.com', 'correct-horse');
    const session = await login(ctx, 'cli-style@example.com', 'correct-horse');
    const headers = authHeaders(session);

    const [firstList, created, secondList] = await Promise.all([
      ctx.app.inject({ method: 'GET', url: '/api/v1/projects?limit=100', headers }),
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { title: 'Captured without a project' },
      }),
      ctx.app.inject({ method: 'GET', url: '/api/v1/projects?limit=100', headers }),
    ]);

    expect(firstList.statusCode).toBe(200);
    expect(secondList.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);

    const firstInbox = inboxIds(firstList.json());
    const secondInbox = inboxIds(secondList.json());
    expect(firstInbox).toHaveLength(1);
    expect(secondInbox).toEqual(firstInbox);

    const finalList = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=100',
      headers,
    });
    expect(finalList.statusCode).toBe(200);
    const finalInbox = inboxIds(finalList.json());
    expect(finalInbox).toHaveLength(1);
    expect(finalInbox).toEqual(firstInbox);

    const task = created.json() as { projectId: string };
    expect(task.projectId).toBe(firstInbox[0]);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/tasks?limit=100',
      headers,
    });
    expect(listed.statusCode).toBe(200);
    const items = (listed.json() as { items: { id: string; projectId: string }[] }).items;
    expect(items.find((item) => item.id === (created.json() as { id: string }).id)?.projectId)
      .toBe(firstInbox[0]);
  });
});
