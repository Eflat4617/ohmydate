import {
  NotFoundError,
  epochMsToInstant,
  type Id,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { VikunjaClient } from '../../src/client.js';
import { InMemoryMappingStore } from '../../src/mapping-store.js';
import { VikunjaProjectRepository } from '../../src/project-repository.js';
import { FakeHttp } from './fake-http.js';

function projectBody(id: number, title = 'Inbox'): Record<string, unknown> {
  return {
    id,
    title,
    is_archived: false,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
  };
}

function setupWithProjects(projects: Record<string, unknown>[]) {
  const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
  const ids = createSeededIdGenerator(41, clock);
  const ownerId = ids.next();
  let nextProjectId = 99;

  const http = new FakeHttp((request) => {
    if (request.method === 'GET' && request.path === '/api/v2/user') {
      return { status: 200, body: { id: 1, settings: { default_project_id: 0 } } };
    }
    if (request.method === 'GET' && request.path === '/api/v2/projects') {
      const active = projects.filter((project) => project['deleted_at'] === undefined);
      return {
        status: 200,
        body: {
          items: active,
          total: active.length,
          page: 1,
          per_page: 50,
          total_pages: 1,
        },
      };
    }
    if (request.method === 'POST' && request.path === '/api/v2/projects') {
      const created = projectBody(nextProjectId, 'Inbox');
      nextProjectId += 1;
      projects.push(created);
      return { status: 201, body: created };
    }
    if (request.method === 'GET' && request.path.startsWith('/api/v2/projects/')) {
      const id = Number(request.path.slice('/api/v2/projects/'.length));
      const found = projects.find((project) => project['id'] === id);
      return found === undefined
        ? { status: 404, body: { code: 3001, detail: 'not found' } }
        : { status: 200, body: found };
    }
    if (
      request.method === 'PATCH' &&
      request.path === '/api/v2/user/settings/general'
    ) {
      // API tokens cannot patch user settings (JWT-only).
      return { status: 401, body: { code: 11, detail: 'invalid token' } };
    }
    return { status: 404, body: { code: 3001, detail: 'not found' } };
  });

  const client = new VikunjaClient({
    baseUrl: 'http://vikunja.test',
    token: 'tk_test',
    fetch: http.fetch,
    retries: 0,
    sleep: async () => {},
  });
  const mappings = new InMemoryMappingStore();
  const repo = new VikunjaProjectRepository({
    clients: new Map<Id, VikunjaClient>([[ownerId, client]]),
    mappings,
    clock,
    ids,
  });
  return { repo, http, mappings, ownerId, projects };
}

describe('VikunjaProjectRepository inbox adoption', () => {
  test('default 0 + settings PATCH 401 adopts the existing Inbox, idempotently', async () => {
    const context = setupWithProjects([projectBody(5)]);

    const first = await context.repo.getInbox(context.ownerId);
    expect(first.kind).toBe('inbox');
    expect(first.title).toBe('Inbox');

    const second = await context.repo.getInbox(context.ownerId);
    expect(second.id).toBe(first.id);

    const list = await context.repo.list(context.ownerId, { limit: 100 });
    expect(list.items.filter((project) => project.kind === 'inbox')).toHaveLength(1);
    expect(list.items.find((project) => project.kind === 'inbox')?.id).toBe(first.id);

    // No proliferation: the existing project was adopted, not replaced.
    expect(
      context.http.calls.filter(
        (call) => call.method === 'POST' && call.path === '/api/v2/projects',
      ),
    ).toHaveLength(0);
    expect(context.projects).toHaveLength(1);
    expect((await context.mappings.get('project', first.id))?.contentFingerprint).toBe(
      'inbox',
    );
  });

  test('default 0 with no candidate creates one Inbox and keeps it after a PATCH 401', async () => {
    const context = setupWithProjects([]);

    const created = await context.repo.getInbox(context.ownerId);
    expect(created.kind).toBe('inbox');

    const again = await context.repo.getInbox(context.ownerId);
    expect(again.id).toBe(created.id);

    const list = await context.repo.list(context.ownerId, { limit: 100 });
    expect(list.items.filter((project) => project.kind === 'inbox')).toHaveLength(1);
    expect(
      context.http.calls.filter(
        (call) => call.method === 'POST' && call.path === '/api/v2/projects',
      ),
    ).toHaveLength(1);
  });

  test('getInbox rejects (does not throw synchronously) without an owner client', async () => {
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(42, clock);
    const ownerId = ids.next();
    const repo = new VikunjaProjectRepository({
      clients: new Map<Id, VikunjaClient>(),
      mappings: new InMemoryMappingStore(),
      clock,
      ids,
    });

    await expect(repo.getInbox(ownerId)).rejects.toBeInstanceOf(NotFoundError);
  });

  test('a trashed default project is replaced and the list still shows one Inbox', async () => {
    const context = setupWithProjects([]);
    const first = await context.repo.getInbox(context.ownerId);
    const firstMapping = await context.mappings.get('project', first.id);
    expect(firstMapping).not.toBeNull();

    // Simulate Vikunja trashing the default project: it disappears from the
    // list and its GET reports deleted_at.
    const externalId = Number(firstMapping?.externalId);
    context.projects.splice(
      0,
      context.projects.length,
      { ...projectBody(externalId), deleted_at: '2026-01-02T00:00:00Z' },
    );

    const second = await context.repo.getInbox(context.ownerId);
    expect(second.kind).toBe('inbox');
    expect(second.id).not.toBe(first.id);

    const list = await context.repo.list(context.ownerId, { limit: 100 });
    expect(list.items.filter((project) => project.kind === 'inbox')).toHaveLength(1);
    expect(list.items.find((project) => project.kind === 'inbox')?.id).toBe(second.id);
  });
});
