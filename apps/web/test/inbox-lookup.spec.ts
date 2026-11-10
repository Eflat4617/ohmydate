import { HttpResponse, http } from 'msw';
import { createPlannerClient, findInboxProject } from '../src/api';
import { server } from '../src/mocks/server';

const INBOX_ID = '01900000-0000-7000-8000-0000000000f1';
const NORMAL_ID = '01900000-0000-7000-8000-0000000000f2';
const OWNER_ID = '01900000-0000-7000-8000-0000000000f3';

function project(id: string, kind: 'inbox' | 'normal'): Record<string, unknown> {
  return {
    id,
    ownerId: OWNER_ID,
    title: kind === 'inbox' ? 'Inbox' : 'Project',
    kind,
    archived: false,
    version: 1,
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T08:00:00.000Z',
  };
}

describe('findInboxProject', () => {
  it('pages past a first page without the Inbox', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get('*/api/v1/projects', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        seen.push(cursor);
        if (cursor === null) {
          return HttpResponse.json({
            items: [project(NORMAL_ID, 'normal')],
            nextCursor: 'page-2',
          });
        }
        return HttpResponse.json({ items: [project(INBOX_ID, 'inbox')], nextCursor: null });
      }),
    );

    const inbox = await findInboxProject(createPlannerClient(), 1);
    expect(inbox?.id).toBe(INBOX_ID);
    expect(seen).toEqual([null, 'page-2']);
  });

  it('returns undefined after the final page when no Inbox exists', async () => {
    server.use(
      http.get('*/api/v1/projects', () =>
        HttpResponse.json({
          items: [project(NORMAL_ID, 'normal')],
          nextCursor: null,
        }),
      ),
    );

    await expect(findInboxProject(createPlannerClient(), 1)).resolves.toBeNull();
  });
});
