import {
  NotFoundError,
  ProviderUnavailableError,
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { VikunjaClient } from '../../src/client.js';
import { InMemoryMappingStore, type ExternalMapping } from '../../src/mapping-store.js';
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

interface SetupState {
  defaultProjectId: number;
  userStatus: number;
  projectGetStatus: Map<number, number>;
}

function setupWithProjects(
  projects: Record<string, unknown>[],
  state: SetupState = {
    defaultProjectId: 0,
    userStatus: 200,
    projectGetStatus: new Map(),
  },
) {
  const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
  const ids = createSeededIdGenerator(41, clock);
  const ownerId = ids.next();
  let nextProjectId = 99;

  const http = new FakeHttp((request) => {
    if (request.method === 'GET' && request.path === '/api/v2/user') {
      if (state.userStatus !== 200) {
        return { status: state.userStatus, body: { title: 'unavailable' } };
      }
      return {
        status: 200,
        body: { id: 1, settings: { default_project_id: state.defaultProjectId } },
      };
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
      const status = state.projectGetStatus.get(id);
      if (status !== undefined) {
        return { status, body: { code: 3001, detail: 'not found' } };
      }
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
  return { repo, http, mappings, ownerId, projects, state, clock, ids };
}

function projectMapping(
  ownerId: Id,
  entityId: Id,
  externalId: string,
  createdAt: Instant,
): ExternalMapping {
  return {
    provider: 'vikunja',
    entityType: 'project',
    entityId,
    externalId,
    ownerId,
    localVersion: 1 as Version,
    createdAt,
    updatedAt: createdAt,
  };
}

function postCount(http: FakeHttp): number {
  return http.calls.filter(
    (call) => call.method === 'POST' && call.path === '/api/v2/projects',
  ).length;
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
    expect(postCount(context.http)).toBe(0);
    expect(context.projects).toHaveLength(1);
    const stored = await context.mappings.get('project', first.id);
    expect(stored?.inbox).toBe(true);
    expect(stored?.contentFingerprint).toBeUndefined();
  });

  test('default 0 with no candidate creates one Inbox and keeps it after a PATCH 401', async () => {
    const context = setupWithProjects([]);

    const created = await context.repo.getInbox(context.ownerId);
    expect(created.kind).toBe('inbox');

    const again = await context.repo.getInbox(context.ownerId);
    expect(again.id).toBe(created.id);

    const list = await context.repo.list(context.ownerId, { limit: 100 });
    expect(list.items.filter((project) => project.kind === 'inbox')).toHaveLength(1);
    expect(postCount(context.http)).toBe(1);
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

  test('renaming the replacement Inbox keeps the marker and never creates a third', async () => {
    const context = setupWithProjects([]);
    await context.repo.getInbox(context.ownerId);

    // Trash the default, then get a replacement.
    const original = context.projects[0] as Record<string, unknown>;
    original['deleted_at'] = '2026-01-02T00:00:00Z';
    const replacement = await context.repo.getInbox(context.ownerId);
    const replacementExternalId = Number(
      (await context.mappings.get('project', replacement.id))?.externalId,
    );
    const postsBefore = postCount(context.http);

    // Rename the replacement in Vikunja (no planner PATCH route exists).
    const remoteReplacement = context.projects.find(
      (project) => project['id'] === replacementExternalId,
    ) as Record<string, unknown>;
    remoteReplacement['title'] = 'Personal';

    const resolved = await context.repo.getInbox(context.ownerId);
    expect(resolved.id).toBe(replacement.id);
    expect(resolved.title).toBe('Personal');
    expect(resolved.kind).toBe('inbox');
    expect(postCount(context.http)).toBe(postsBefore);

    const list = await context.repo.list(context.ownerId, { limit: 100 });
    const inboxes = list.items.filter((project) => project.kind === 'inbox');
    expect(inboxes).toHaveLength(1);
    expect(inboxes[0]?.id).toBe(replacement.id);
  });

  test('restoring the trashed original moves the marker back and bumps its version', async () => {
    const context = setupWithProjects([]);
    const original = await context.repo.getInbox(context.ownerId);
    const originalMapping = await context.mappings.get('project', original.id);
    const originalExternalId = Number(originalMapping?.externalId);

    const remoteOriginal = context.projects.find(
      (project) => project['id'] === originalExternalId,
    ) as Record<string, unknown>;
    remoteOriginal['deleted_at'] = '2026-01-02T00:00:00Z';
    const replacement = await context.repo.getInbox(context.ownerId);
    expect(replacement.id).not.toBe(original.id);
    expect((await context.mappings.get('project', original.id))?.inbox).toBeUndefined();
    expect((await context.mappings.get('project', replacement.id))?.inbox).toBe(true);

    // Restore the original from trash and make Vikunja default point at it.
    delete remoteOriginal['deleted_at'];
    context.state.defaultProjectId = originalExternalId;

    const restored = await context.repo.getInbox(context.ownerId);
    expect(restored.id).toBe(original.id);
    expect(restored.kind).toBe('inbox');
    expect(restored.version).toBe(2);
    expect((await context.mappings.get('project', replacement.id))?.inbox).toBeUndefined();

    const list = await context.repo.list(context.ownerId, { limit: 100 });
    const inboxes = list.items.filter((project) => project.kind === 'inbox');
    expect(inboxes).toHaveLength(1);
    expect(inboxes[0]?.id).toBe(original.id);
  });
});

describe('VikunjaProjectRepository inbox settings failures', () => {
  test('a transient GET /user failure surfaces instead of creating a stray Inbox', async () => {
    const context = setupWithProjects([], {
      defaultProjectId: 0,
      userStatus: 503,
      projectGetStatus: new Map(),
    });

    await expect(context.repo.getInbox(context.ownerId)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(postCount(context.http)).toBe(0);
    expect(context.projects).toHaveLength(0);
    expect(await context.mappings.listByOwner(context.ownerId)).toEqual([]);
  });

  test('a token without other:user (401) still falls back to the marker', async () => {
    const context = setupWithProjects([], {
      defaultProjectId: 0,
      userStatus: 401,
      projectGetStatus: new Map(),
    });

    const created = await context.repo.getInbox(context.ownerId);
    expect(created.kind).toBe('inbox');
    expect(created.title).toBe('Inbox');
  });

  test('#kindFor keeps listing a marked Inbox even when the marker GET is missing', async () => {
    const context = setupWithProjects([projectBody(5, 'Personal')], {
      defaultProjectId: 0,
      userStatus: 401,
      projectGetStatus: new Map([[5, 404]]),
    });
    const entityId = context.ids.next();
    const mapping = projectMapping(
      context.ownerId,
      entityId,
      '5',
      context.clock.now(),
    );
    await context.mappings.put(mapping);
    await context.mappings.markInbox(context.ownerId, entityId);

    const list = await context.repo.list(context.ownerId, { limit: 100 });
    expect(list.items.find((project) => project.id === entityId)?.kind).toBe(
      'inbox',
    );
  });
});
