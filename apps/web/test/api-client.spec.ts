import { HttpResponse, http } from 'msw';
import {
  createPlannerClient,
  newActionId,
  plannerClient,
  type Project,
} from '../src/api';
import { server } from '../src/mocks/server';
import { USER_ID } from '../src/mocks/db';

const API = 'http://localhost:3000/api/v1';

describe('planner API client', () => {
  it('sends If-Match from the cached version and reports 412 version_conflict', async () => {
    const staleClient = createPlannerClient();
    const otherClient = createPlannerClient();

    const task = await staleClient.createTask({ title: 'Draft' }, newActionId('create'));
    expect(staleClient.cachedTaskVersion(task.id)).toBe(task.version);

    await otherClient.updateTask(task.id, { title: 'Draft v2' }, newActionId('update'));

    await expect(
      staleClient.updateTask(task.id, { title: 'Draft v3' }, newActionId('rename'), task.version),
    ).rejects.toMatchObject({ status: 412, code: 'version_conflict' });
  });

  it('returns 428 when a mutation omits If-Match', async () => {
    const task = await plannerClient.createTask({ title: 'Needs header' }, newActionId('create'));

    const response = await fetch(`${API}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': newActionId('missing-if-match'),
      },
      body: JSON.stringify({ title: 'Changed' }),
    });

    expect(response.status).toBe(428);
    const problem = (await response.json()) as { code: string };
    expect(problem.code).toBe('version_conflict');
  });

  it('exposes the current version as an ETag on reads', async () => {
    const task = await plannerClient.createTask({ title: 'ETag me' }, newActionId('create'));
    const response = await fetch(`${API}/tasks/${task.id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe(`W/"${task.version}"`);
  });

  it('sends X-CSRF-Token from the csrf cookie on mutations only', async () => {
    let captured: string | null = null;
    const project: Project = {
      id: '01900000-0000-7000-8000-0000000000aa',
      ownerId: USER_ID,
      title: 'CSRF',
      kind: 'normal',
      archived: false,
      version: 1,
      createdAt: '2026-11-01T08:00:00.000Z',
      updatedAt: '2026-11-01T08:00:00.000Z',
    };
    server.use(
      http.post('*/api/v1/projects', ({ request }) => {
        captured = request.headers.get('X-CSRF-Token');
        return HttpResponse.json(project, { status: 201 });
      }),
    );

    document.cookie = 'csrf=csrf-token-123; path=/';
    await plannerClient.createProject('CSRF project', newActionId('project:create'));

    expect(captured).toBe('csrf-token-123');
  });
});
