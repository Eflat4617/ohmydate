import { mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { HttpResponse, http } from 'msw';
import { defineComponent, h } from 'vue';
import type { Project, Task } from '../src/api';
import {
  OwnerChangedError,
  collectPages,
  findPromotedNote,
  ownerFenced,
  useLinkTargets,
  useLinkedNotes,
} from '../src/composables/notes';
import { captureOwnerBinding } from '../src/session/ownerEpoch';
import { SEED_TASK_TITLE, mockDb } from '../src/mocks/db';
import { NOTE_MEETING_ID, seedLink } from '../src/mocks/notes-seed';
import { server } from '../src/mocks/server';
import { sessionJournal } from '../src/session/journal';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useSessionStore } from '../src/stores/session';
import { mountApp, settle, useTestClock, type MountedApp } from './m6-layout-utils';
import { buttonInElement, captureRequests, dialogByTitle, gate, noteById, setValue } from './m6-03-notes-utils';

/**
 * M6-03R-1 findings, reproduced first:
 * H1 — paginated link-target lookups must not mix owners (A → B → A);
 * M1 — a link/unlink 412 must not silently rebase conflicting content edits;
 * M2 — promote 409 must find the promoted note beyond the first page.
 */

const OWNER_A = '01900000-0000-7000-8000-00000000000a';
const OWNER_B = '01900000-0000-7000-8000-00000000000b';

let mounted: MountedApp | null = null;

beforeEach(async () => {
  localStorage.clear();
  await sessionJournal.clear();
  useTestClock();
});

afterEach(() => {
  mounted?.wrapper.unmount();
  mounted = null;
  vi.restoreAllMocks();
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
});

describe('H1 — paginated link targets are fenced to one owner (A → B → A)', () => {
  type Kind = 'project' | 'task';

  function stamp(kind: Kind, owner: string, page: number): string {
    return `${owner === OWNER_A ? 'A' : 'B'}-private-${kind}-p${page}`;
  }

  function project(owner: string, page: number): Project {
    const now = '2026-11-01T00:00:00.000Z';
    return {
      id: `01900000-0000-7000-8000-${(owner === OWNER_A ? 0xa00 : 0xb00) + page}`.padEnd(36, '0').slice(0, 36),
      ownerId: owner,
      title: stamp('project', owner, page),
      kind: 'normal',
      archived: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  function task(owner: string, page: number): Task {
    const now = '2026-11-01T00:00:00.000Z';
    return {
      id: `01900000-0000-7000-8000-${(owner === OWNER_A ? 0xa10 : 0xb10) + page}`.padEnd(36, '0').slice(0, 36),
      ownerId: owner,
      projectId: '01900000-0000-7000-8000-000000000001',
      title: stamp('task', owner, page),
      status: 'todo',
      splittable: true,
      priority: 2,
      dependsOn: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
      external: [],
    };
  }

  /**
   * The server answers for whoever's session cookie is current (`serverOwner`),
   * two pages per kind. The first page of the first A lookup is held until the
   * test releases it — after the user switched to B.
   */
  function scriptServer(kind: Kind) {
    const state = { serverOwner: OWNER_A, holdFirst: true };
    const held = gate();
    const requests: string[] = [];
    const path = kind === 'project' ? '*/api/v1/projects' : '*/api/v1/tasks';
    server.use(
      http.get(path, async ({ request }) => {
        const owner = state.serverOwner;
        const cursor = new URL(request.url).searchParams.get('cursor');
        const page = cursor === null ? 1 : 2;
        requests.push(`${owner === OWNER_A ? 'A' : 'B'}/page${page}`);
        if (page === 1 && owner === OWNER_A && state.holdFirst) {
          state.holdFirst = false;
          await held.promise;
        }
        const item = kind === 'project' ? project(owner, page) : task(owner, page);
        return HttpResponse.json({ items: [item], nextCursor: page === 1 ? 'next' : null });
      }),
    );
    // The other kind answers empty, without delay.
    server.use(
      http.get(kind === 'project' ? '*/api/v1/tasks' : '*/api/v1/projects', () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    return { state, held, requests };
  }

  function harness(queryClient: QueryClient) {
    const pinia = createPinia();
    let targets: ReturnType<typeof useLinkTargets> | null = null;
    const Probe = defineComponent({
      setup() {
        targets = useLinkTargets();
        return () => h('div');
      },
    });
    const wrapper = mount(Probe, { global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] } });
    useSessionStore(pinia);
    return {
      wrapper,
      titles(kind: Kind): string[] {
        const current = targets;
        if (current === null) return [];
        return kind === 'project' ? current.projects.value.map((item) => item.title) : current.tasks.value.map((item) => item.title);
      },
    };
  }

  function cachedTitles(queryClient: QueryClient, owner: string, kind: Kind): string[] {
    const data = queryClient.getQueryData<{ title: string }[]>(['notes', owner, 'targets', kind]);
    return (data ?? []).map((item) => item.title);
  }

  for (const kind of ['project', 'task'] as const) {
    it(`${kind}s: a held A page released after switching to B never pulls B pages into A, and B never sees A`, async () => {
      localStorage.setItem(OWNER_STORAGE_KEY, OWNER_A);
      adoptActiveOwner(OWNER_A, 'bootstrap');
      const queryClient = new QueryClient();
      const { state, held, requests } = scriptServer(kind);
      const probe = harness(queryClient);
      await vi.waitFor(() => expect(requests).toEqual(['A/page1']));

      // Owner switch while A's first page is in flight (the server now answers as B).
      state.serverOwner = OWNER_B;
      adoptActiveOwner(OWNER_B, 'storage');
      held.release();
      await settle();
      await vi.waitFor(() => expect(probe.titles(kind)).toEqual([stamp(kind, OWNER_B, 1), stamp(kind, OWNER_B, 2)]));
      // The A lookup stopped: it fetched no next page with B's credentials and cached nothing.
      expect(requests.filter((request) => request === 'B/page2')).toHaveLength(1);
      expect(requests.filter((request) => request.startsWith('A/'))).toEqual(['A/page1']);
      expect(cachedTitles(queryClient, OWNER_A, kind)).toEqual([]);
      expect(cachedTitles(queryClient, OWNER_B, kind).every((title) => title.startsWith('B-'))).toBe(true);

      // Back to A within staleTime: only A's own data, freshly fetched.
      state.serverOwner = OWNER_A;
      adoptActiveOwner(OWNER_A, 'storage');
      await settle();
      await vi.waitFor(() => expect(probe.titles(kind)).toEqual([stamp(kind, OWNER_A, 1), stamp(kind, OWNER_A, 2)]));
      expect(cachedTitles(queryClient, OWNER_A, kind).some((title) => title.startsWith('B-'))).toBe(false);
      expect(cachedTitles(queryClient, OWNER_B, kind).some((title) => title.startsWith('A-'))).toBe(false);
      probe.wrapper.unmount();
    });
  }
});

describe('H1 — the fence itself (one binding per lookup)', () => {
  it('ownerFenced refuses a lookup whose cache key belongs to another owner, and drops a stale result', async () => {
    adoptActiveOwner(OWNER_A, 'bootstrap');
    await expect(ownerFenced(OWNER_B, async () => 'B data')).rejects.toBeInstanceOf(OwnerChangedError);
    const held = gate();
    const pending = ownerFenced(OWNER_A, async () => {
      await held.promise;
      return 'A data';
    });
    adoptActiveOwner(OWNER_B, 'storage');
    held.release();
    await expect(pending).rejects.toBeInstanceOf(OwnerChangedError);
    adoptActiveOwner(OWNER_A, 'storage');
    await expect(ownerFenced(OWNER_A, async () => 'A data')).resolves.toBe('A data');
  });

  it('collectPages stops before the next page once the owner changed, and passes the binding signal', async () => {
    adoptActiveOwner(OWNER_A, 'bootstrap');
    const binding = captureOwnerBinding();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const lookup = collectPages<string>(binding, async (_cursor, signal) => {
      calls += 1;
      signals.push(signal);
      if (calls === 1) adoptActiveOwner(OWNER_B, 'storage');
      return { items: [`page${calls}`], nextCursor: 'more' };
    });
    await expect(lookup).rejects.toBeInstanceOf(OwnerChangedError);
    expect(calls).toBe(1);
    expect(signals[0]).toBe(binding.signal);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('the promoted-note search is owner-fenced across its pages (negative)', async () => {
    adoptActiveOwner(mockDb.user.id, 'bootstrap');
    const binding = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'storage');
    await expect(findPromotedNote('01900000-0000-7000-8000-0000000000a1', binding)).rejects.toBeInstanceOf(OwnerChangedError);
  });

  it('linked notes: a held A answer released after switching to B is never cached under A or shown under B', async () => {
    localStorage.setItem(OWNER_STORAGE_KEY, OWNER_A);
    adoptActiveOwner(OWNER_A, 'bootstrap');
    const held = gate();
    // The server answers for the session cookie's owner at the time it replies.
    const server_ = { owner: OWNER_A, holdA: true };
    server.use(
      http.get('*/api/v1/documents', async () => {
        if (server_.owner === OWNER_A && server_.holdA) {
          server_.holdA = false;
          await held.promise;
        }
        const title = server_.owner === OWNER_A ? 'A-private-note' : 'B-private-note';
        return HttpResponse.json({ items: [{ ...noteById(NOTE_MEETING_ID), title }], nextCursor: null });
      }),
    );
    const queryClient = new QueryClient();
    let titles: () => string[] = () => [];
    const Probe = defineComponent({
      setup() {
        const query = useLinkedNotes(
          () => 'project',
          () => '01900000-0000-7000-8000-000000000003',
        );
        titles = () => (query.data.value?.items ?? []).map((item) => item.title);
        return () => h('div');
      },
    });
    const wrapper = mount(Probe, { global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient }]] } });
    await vi.waitFor(() => expect(server_.holdA).toBe(false));
    server_.owner = OWNER_B;
    adoptActiveOwner(OWNER_B, 'storage');
    held.release();
    await vi.waitFor(() => expect(titles()).toEqual(['B-private-note']));
    const underA = queryClient.getQueriesData<{ items: { title: string }[] }>({ queryKey: ['notes', OWNER_A] });
    expect(underA.flatMap(([, data]) => data?.items ?? []).map((item) => item.title)).toEqual([]);
    wrapper.unmount();
  });

  it('notes list: a page-two request started for A after switching to B is refused, A’s cache keeps only A', async () => {
    const app = await mountApp('/notes');
    mounted = app;
    await vi.waitFor(() => expect(app.wrapper.findAll('[data-note-item]').length).toBe(3));
    // The list key still belongs to the mock owner while B is active: the fence refuses to fetch for it.
    adoptActiveOwner(OWNER_B, 'storage');
    const listKey = ['notes', mockDb.user.id, 'list', ''];
    await app.queryClient.refetchQueries({ queryKey: listKey }).catch(() => undefined);
    await settle();
    expect(app.queryClient.getQueryState(listKey)?.error).toBeInstanceOf(OwnerChangedError);
    const data = app.queryClient.getQueryData<{ pages: { items: { ownerId: string }[] }[] }>(listKey);
    expect((data?.pages ?? []).flatMap((page) => page.items).every((item) => item.ownerId === mockDb.user.id)).toBe(true);
  });
});

describe('M1 — a link/unlink 412 never silently rebases conflicting content', () => {
  async function openMeeting(): Promise<MountedApp> {
    mounted = await mountApp(`/notes/${NOTE_MEETING_ID}`);
    await vi.waitFor(() => expect(mounted?.wrapper.find('[data-note-links]').exists()).toBe(true));
    await vi.waitFor(() =>
      expect((mounted?.wrapper.get('[data-note-title]').element as HTMLInputElement).value).toBe('발표 준비 회의'),
    );
    await settle();
    return mounted;
  }

  async function linkSampleProject(app: MountedApp): Promise<void> {
    await app.wrapper.get('[data-note-link-add]').trigger('click');
    await settle();
    const picker = dialogByTitle('연결할 대상 고르기');
    await vi.waitFor(() => expect(picker.querySelector('[data-link-option] input:not([disabled])')).not.toBeNull());
    picker.querySelector<HTMLInputElement>('[data-link-option] input:not([disabled])')?.click();
    await settle();
    buttonInElement(picker, '연결').click();
    await settle();
  }

  function remoteEdit(changes: { bodyMd?: string; linkOnly?: boolean }): void {
    const stored = noteById(NOTE_MEETING_ID);
    if (changes.bodyMd !== undefined) stored.bodyMd = changes.bodyMd;
    if (changes.linkOnly === true) {
      stored.links = [...stored.links, seedLink('01900000-0000-7000-8000-00000000c0de', stored.id, 'task', [...mockDb.tasks.keys()][0] ?? '', stored.createdAt)];
    }
    stored.version += 1;
  }

  it('link 412 after a remote body change opens the conflict dialog instead of adopting the new version', async () => {
    const requests = captureRequests();
    const app = await openMeeting();
    await setValue(app.wrapper.get('[data-note-body]'), '내 로컬 수정');
    remoteEdit({ bodyMd: '다른 탭에서 저장한 본문' });
    await linkSampleProject(app);
    await vi.waitFor(() => expect(() => dialogByTitle('다른 곳에서 이 노트가 바뀌었어요')).not.toThrow());
    const dialog = dialogByTitle('다른 곳에서 이 노트가 바뀌었어요');
    expect(dialog.textContent).toContain('버전 2');
    // The base did not advance: my unsaved text is still there, and nothing was saved over the other tab.
    expect((app.wrapper.get('[data-note-body]').element as HTMLTextAreaElement).value).toBe('내 로컬 수정');
    expect(app.wrapper.get('[data-note-status]').text()).toBe('저장하지 않은 변경 사항이 있어요');
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    // Keep editing, then Save: still pinned to the version I edited (412 again), never W/"2".
    buttonInElement(dialog, '계속 편집').click();
    await settle();
    await app.wrapper.get('[data-note-save]').trigger('click');
    await settle();
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.headers.get('If-Match')).toBe('W/"1"');
    expect(noteById(NOTE_MEETING_ID).bodyMd).toBe('다른 탭에서 저장한 본문');
    // Keep mine as a copy is offered from the same dialog.
    await vi.waitFor(() => expect(() => dialogByTitle('다른 곳에서 이 노트가 바뀌었어요')).not.toThrow());
    expect(dialogByTitle('다른 곳에서 이 노트가 바뀌었어요').textContent).toContain('내 내용을 사본으로 저장');
  });

  it('unlink 412 after a remote body change opens the conflict dialog too', async () => {
    const requests = captureRequests();
    const stored = noteById(NOTE_MEETING_ID);
    stored.links = [seedLink('01900000-0000-7000-8000-00000000beef', stored.id, 'project', mockDb.inboxProjectId, stored.createdAt)];
    const app = await openMeeting();
    await vi.waitFor(() => expect(app.wrapper.find('[data-note-link="project"]').exists()).toBe(true));
    await setValue(app.wrapper.get('[data-note-body]'), '내 로컬 수정');
    remoteEdit({ bodyMd: '다른 탭에서 저장한 본문' });
    const remove = app.wrapper.get('[data-note-link="project"]').findAll('button').find((item) => item.text().includes('연결 해제'));
    await remove?.trigger('click');
    await vi.waitFor(() => expect(() => dialogByTitle('다른 곳에서 이 노트가 바뀌었어요')).not.toThrow());
    expect((app.wrapper.get('[data-note-body]').element as HTMLTextAreaElement).value).toBe('내 로컬 수정');
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    // Reload shows the other tab's text: nothing was lost on the server.
    buttonInElement(dialogByTitle('다른 곳에서 이 노트가 바뀌었어요'), '서버 내용 불러오기').click();
    await settle();
    expect((app.wrapper.get('[data-note-body]').element as HTMLTextAreaElement).value).toBe('다른 탭에서 저장한 본문');
  });

  it('link 412 after a link-only remote change rebases silently and keeps my unsaved text', async () => {
    const requests = captureRequests();
    const app = await openMeeting();
    await setValue(app.wrapper.get('[data-note-body]'), '내 로컬 수정');
    remoteEdit({ linkOnly: true });
    await linkSampleProject(app);
    await settle();
    expect(document.body.querySelector('.note-conflict-dialog')).toBeNull();
    expect((app.wrapper.get('[data-note-body]').element as HTMLTextAreaElement).value).toBe('내 로컬 수정');
    // Wait until the editor has the latest (link-only) version, then save against it.
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.method === 'GET' && request.path.endsWith(`/documents/${NOTE_MEETING_ID}`))).toHaveLength(2),
    );
    await settle();
    await app.wrapper.get('[data-note-save]').trigger('click');
    await vi.waitFor(() => expect(noteById(NOTE_MEETING_ID).bodyMd).toBe('내 로컬 수정'));
    const patches = requests.filter((request) => request.method === 'PATCH');
    expect(patches.map((request) => request.headers.get('If-Match'))).toEqual(['W/"2"']);
    expect(document.body.querySelector('.note-conflict-dialog')).toBeNull();
  });

  it('a save 412 caused by a link-only change elsewhere rebases and sends the edit once more', async () => {
    const requests = captureRequests();
    const app = await openMeeting();
    await setValue(app.wrapper.get('[data-note-body]'), '내 로컬 수정');
    remoteEdit({ linkOnly: true });
    await app.wrapper.get('[data-note-save]').trigger('click');
    await vi.waitFor(() => expect(noteById(NOTE_MEETING_ID).bodyMd).toBe('내 로컬 수정'));
    const patches = requests.filter((request) => request.method === 'PATCH');
    expect(patches.map((request) => request.headers.get('If-Match'))).toEqual(['W/"1"', 'W/"2"']);
    // A new If-Match is a new action: the retry carries a fresh Idempotency-Key.
    expect(patches[0]?.headers.get('Idempotency-Key')).not.toBe(patches[1]?.headers.get('Idempotency-Key'));
    expect(document.body.querySelector('.note-conflict-dialog')).toBeNull();
    await vi.waitFor(() => expect(app.wrapper.get('[data-note-live]').text()).toBe('저장했어요 · 버전 3'));
  });

  it('a save 412 caused by a content change elsewhere still opens the dialog and never retries (negative)', async () => {
    const requests = captureRequests();
    const app = await openMeeting();
    await setValue(app.wrapper.get('[data-note-body]'), '내 로컬 수정');
    remoteEdit({ bodyMd: '다른 탭에서 저장한 본문', linkOnly: true });
    await app.wrapper.get('[data-note-save]').trigger('click');
    await vi.waitFor(() => expect(() => dialogByTitle('다른 곳에서 이 노트가 바뀌었어요')).not.toThrow());
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(noteById(NOTE_MEETING_ID).bodyMd).toBe('다른 탭에서 저장한 본문');
  });

  it('unlink 412 after a link-only remote change rebases silently', async () => {
    const stored = noteById(NOTE_MEETING_ID);
    stored.links = [seedLink('01900000-0000-7000-8000-00000000beef', stored.id, 'project', mockDb.inboxProjectId, stored.createdAt)];
    const app = await openMeeting();
    await vi.waitFor(() => expect(app.wrapper.find('[data-note-link="project"]').exists()).toBe(true));
    await setValue(app.wrapper.get('[data-note-body]'), '내 로컬 수정');
    remoteEdit({ linkOnly: true });
    const remove = app.wrapper.get('[data-note-link="project"]').findAll('button').find((item) => item.text().includes('연결 해제'));
    await remove?.trigger('click');
    await vi.waitFor(() => expect(app.wrapper.text()).toContain('다른 곳에서 노트가 바뀌어 최신 내용을 불러왔어요'));
    expect(document.body.querySelector('.note-conflict-dialog')).toBeNull();
    expect((app.wrapper.get('[data-note-body]').element as HTMLTextAreaElement).value).toBe('내 로컬 수정');
    expect(app.wrapper.findAll('[data-note-link="task"]')).toHaveLength(1);
  });
});

describe('M2 — promote 409 follows nextCursor to the existing promoted note', () => {
  it('opens a promoted note that sits on the second page of the task’s notes', async () => {
    const task = [...mockDb.tasks.values()].find((item) => item.title === SEED_TASK_TITLE);
    if (task === undefined) throw new Error('seed task missing');
    task.description = '이미 옮긴 설명';
    const promotedId = '01900000-0000-7000-8000-0000000009a0';
    mockDb.notes.documents.set(promotedId, {
      id: promotedId,
      ownerId: mockDb.user.id,
      title: '승격된 노트',
      bodyMd: '이미 옮긴 설명',
      sensitivity: 'P2',
      llmAllowed: false,
      source: 'task_description',
      sourceTaskId: task.id,
      links: [seedLink('01900000-0000-7000-8000-0000000009a1', promotedId, 'task', task.id, '2026-11-01T00:00:00.000Z')],
      version: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    // 50 newer manual notes on the same task push it to page two.
    for (let index = 0; index < 50; index += 1) {
      const id = `01900000-0000-7000-8000-${(0x700 + index).toString(16).padStart(12, '0')}`;
      mockDb.notes.documents.set(id, {
        id,
        ownerId: mockDb.user.id,
        title: `작업 메모 ${index}`,
        bodyMd: '',
        sensitivity: 'P2',
        llmAllowed: false,
        source: 'manual',
        links: [seedLink(`01900000-0000-7000-8000-${(0x800 + index).toString(16).padStart(12, '0')}`, id, 'task', task.id, '2026-11-02T00:00:00.000Z')],
        version: 1,
        createdAt: '2026-11-02T00:00:00.000Z',
        updatedAt: `2026-11-1${index % 2}T0${index % 10}:00:00.000Z`,
      });
    }
    const requests = captureRequests();
    mounted = await mountApp(`/tasks/${task.id}`);
    await vi.waitFor(() => expect(mounted?.wrapper.find('[data-task-promote]').attributes('disabled')).toBeUndefined());
    await mounted.wrapper.get('[data-task-promote]').trigger('click');
    await vi.waitFor(() => expect(mounted?.router.currentRoute.value.params['id']).toBe(promotedId));
    expect(document.body.textContent).toContain('이미 승격한 노트가 있어서 그 노트를 열었어요.');
    const lookups = requests.filter((request) => request.path.endsWith('/documents') && request.search.includes('targetKind=task'));
    expect(lookups.some((request) => new URLSearchParams(request.search).get('cursor') !== null)).toBe(true);
  });

  it('reports a missing promoted note only after every page was read (negative)', async () => {
    const task = [...mockDb.tasks.values()].find((item) => item.title === SEED_TASK_TITLE);
    if (task === undefined) throw new Error('seed task missing');
    task.description = '설명';
    server.use(
      http.post(/\/api\/v1\/tasks\/([^/]+):promote-description$/, () =>
        HttpResponse.json({ title: 'x', status: 409, code: 'illegal_transition' }, { status: 409 }),
      ),
    );
    mounted = await mountApp(`/tasks/${task.id}`);
    await vi.waitFor(() => expect(mounted?.wrapper.find('[data-task-promote]').attributes('disabled')).toBeUndefined());
    await mounted.wrapper.get('[data-task-promote]').trigger('click');
    await vi.waitFor(() => expect(mounted?.wrapper.find('[data-task-promote-error]').exists()).toBe(true));
    expect(mounted.wrapper.get('[data-task-promote-error]').text()).toContain('이미 승격한 노트가 있어요.');
  });
});
