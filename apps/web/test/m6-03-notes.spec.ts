import { HttpResponse, http } from 'msw';
import { isUuidV7Key } from '../src/api';
import { mockDb } from '../src/mocks/db';
import { NOTE_MEETING_ID, NOTE_PRIVATE_ID, NOTE_THESIS_ID } from '../src/mocks/notes-seed';
import { server } from '../src/mocks/server';
import { sessionJournal } from '../src/session/journal';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useOfflineStore } from '../src/stores/offline';
import { mountApp, settle, useTestClock, type MountedApp } from './m6-layout-utils';
import {
  buttonIn,
  buttonInElement,
  captureRequests,
  dialogByTitle,
  gate,
  liveText,
  noteById,
  seedManyNotes,
  setValue,
} from './m6-03-notes-utils';

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
});

async function openNotes(path = '/notes'): Promise<MountedApp> {
  mounted = await mountApp(path);
  await vi.waitFor(() => expect(mounted?.wrapper.find('[data-notes-page]').exists()).toBe(true));
  await settle();
  return mounted;
}

async function openNote(id: string): Promise<MountedApp> {
  const app = await openNotes(`/notes/${id}`);
  await vi.waitFor(() => expect(app.wrapper.find('[data-note-title]').exists()).toBe(true));
  await vi.waitFor(() =>
    expect((app.wrapper.get('[data-note-title]').element as HTMLInputElement).value).toBe(noteById(id).title),
  );
  await settle();
  return app;
}

function listTitles(app: MountedApp): string[] {
  return app.wrapper.findAll('[data-note-item] .note-list-title').map((item) => item.text());
}

describe('Notes workspace — list and search (07 §3.5)', () => {
  it('lists the owner’s notes newest first with AI / P1 badges, in the notes layout', async () => {
    const app = await openNotes();
    await vi.waitFor(() => expect(listTitles(app)).toEqual(['졸업 논문 참고 문헌', '발표 준비 회의', '개인 일정 메모']));
    expect(app.wrapper.get('.adaptive-frame').attributes('data-layout-mode')).toBe('notes');
    expect(app.wrapper.find('[data-layout-item="NotesWorkspace"]').exists()).toBe(true);
    const thesis = app.wrapper.get(`[data-note-item="${NOTE_THESIS_ID}"]`);
    expect(thesis.text()).toContain('AI 전송 허용');
    expect(thesis.text()).toContain('연결 1개');
    // The row shows a plain-text summary, never rendered Markdown.
    expect(thesis.find('.note-list-summary').text()).not.toContain('**');
    expect(thesis.find('a, strong').exists()).toBe(false);
    expect(app.wrapper.get(`[data-note-item="${NOTE_PRIVATE_ID}"]`).text()).toContain('P1 개인 일정 정보');
    expect(app.wrapper.text()).toContain('노트를 고르세요');
    expect(app.wrapper.findAll('h1').map((h) => h.text())).toEqual(['노트']);
  });

  it('searches on the server (q) and shows no-results with a clear action', async () => {
    const requests = captureRequests();
    const app = await openNotes();
    await vi.waitFor(() => expect(listTitles(app)).toHaveLength(3));
    await setValue(app.wrapper.get('[data-notes-search]'), '발표');
    await app.wrapper.get('form.notes-search').trigger('submit');
    await vi.waitFor(() => expect(listTitles(app)).toEqual(['발표 준비 회의']));
    const search = requests.find((request) => request.path.endsWith('/documents') && request.search.includes('q='));
    expect(new URLSearchParams(search?.search).get('q')).toBe('발표');
    expect(app.wrapper.get('[data-notes-search-status]').text()).toBe('“발표” 검색 결과 1개');

    await setValue(app.wrapper.get('[data-notes-search]'), '없는단어');
    await app.wrapper.get('form.notes-search').trigger('submit');
    await vi.waitFor(() => expect(app.wrapper.find('[data-notes-no-results]').exists()).toBe(true));
    expect(app.wrapper.text()).toContain('“없는단어”에 맞는 노트가 없어요');
    await buttonIn(app.wrapper.get('[data-notes-no-results]'), '검색 지우기').trigger('click');
    await vi.waitFor(() => expect(listTitles(app)).toHaveLength(3));
    expect(document.activeElement).toBe(app.wrapper.get('[data-notes-search]').element);
  });

  it('pages with “더 보기” (cursor) and shows the empty state when there are no notes', async () => {
    seedManyNotes(22);
    const app = await openNotes();
    await vi.waitFor(() => expect(listTitles(app)).toHaveLength(20));
    await app.wrapper.get('[data-notes-more]').trigger('click');
    await vi.waitFor(() => expect(listTitles(app)).toHaveLength(25));
    expect(app.wrapper.find('[data-notes-more]').exists()).toBe(false);
    app.wrapper.unmount();
    mounted = null;

    mockDb.notes.documents.clear();
    const empty = await openNotes();
    await vi.waitFor(() => expect(empty.wrapper.find('[data-notes-empty]').exists()).toBe(true));
    expect(empty.wrapper.text()).toContain('아직 노트가 없어요');
  });

  it('shows an error with retry when the list fails (negative)', async () => {
    let fail = true;
    server.use(
      http.get('*/api/v1/documents', () =>
        fail ? HttpResponse.json({ title: 'x', status: 500, code: 'internal_error' }, { status: 500 }) : undefined,
      ),
    );
    const app = await openNotes();
    await vi.waitFor(() => expect(app.wrapper.text()).toContain('노트를 불러오지 못했어요.'), { timeout: 10_000 });
    fail = false;
    await buttonIn(app.wrapper.get('[data-notes-list]'), '다시 시도').trigger('click');
    await vi.waitFor(() => expect(listTitles(app)).toHaveLength(3));
  }, 15_000);

  it('is read-only offline: the editor cannot save (negative)', async () => {
    const app = await openNote(NOTE_MEETING_ID);
    useOfflineStore(app.pinia).setOnline(false);
    await settle();
    expect(app.wrapper.text()).toContain('오프라인이라 노트를 읽기만 할 수 있어요.');
    expect(app.wrapper.get('[data-note-body]').attributes('readonly')).toBeDefined();
    expect(app.wrapper.get('[data-note-save]').attributes('disabled')).toBeDefined();
    expect(app.wrapper.get('[data-note-llm-toggle]').attributes('disabled')).toBeDefined();
    expect(app.wrapper.get('[data-note-delete]').attributes('disabled')).toBeDefined();
  });
});

describe('Notes workspace — editor', () => {
  it('creates a note with a UUIDv7 Idempotency-Key, AI off by default, and opens it', async () => {
    const requests = captureRequests();
    const app = await openNotes('/notes/new');
    await vi.waitFor(() => expect(app.wrapper.find('[data-note-title]').exists()).toBe(true));
    const toggle = app.wrapper.get('[data-note-llm-toggle]');
    expect(toggle.attributes('role')).toBe('switch');
    expect((toggle.element as HTMLInputElement).checked).toBe(false);
    const llm = app.wrapper.get('[data-note-llm]').text();
    expect(llm).toContain('AI에 보내기 허용');
    expect(llm).toContain('기본값은 꺼짐이에요');
    expect(llm).toContain('완벽하게 가리지는 못해요');
    expect(llm).toContain('이 노트는 AI에 보내지 않아요.');
    expect((app.wrapper.get('[data-note-sensitivity] input[value="P2"]').element as HTMLInputElement).checked).toBe(true);

    await setValue(app.wrapper.get('[data-note-title]'), '  새 연구 메모  ');
    await setValue(app.wrapper.get('[data-note-body]'), '# 요약\n\n**핵심** 내용');
    await app.wrapper.get('[data-note-save]').trigger('click');
    await vi.waitFor(() => expect(app.router.currentRoute.value.name).toBe('notes-detail'));
    const create = requests.find((request) => request.method === 'POST' && request.path.endsWith('/documents'));
    expect(isUuidV7Key(create?.headers.get('Idempotency-Key') ?? '')).toBe(true);
    expect(JSON.parse(create?.body ?? '{}')).toEqual({
      title: '새 연구 메모',
      bodyMd: '# 요약\n\n**핵심** 내용',
      sensitivity: 'P2',
      llmAllowed: false,
    });
    const id = String(app.router.currentRoute.value.params['id']);
    expect(noteById(id).title).toBe('새 연구 메모');
    await vi.waitFor(() => expect(liveText(app.wrapper)).toBe('노트를 만들었어요'));
    expect(app.wrapper.get('[data-note-status]').text()).toBe('저장된 상태예요 · 버전 1');
    // The same editor stayed mounted: the title field keeps the trimmed server value.
    expect((app.wrapper.get('[data-note-title]').element as HTMLInputElement).value).toBe('새 연구 메모');
    // The list refreshes with the new note (its position depends on the mock clock).
    await vi.waitFor(() => expect(listTitles(app)).toContain('새 연구 메모'));
    expect(app.wrapper.get(`[data-note-item="${id}"]`).attributes('aria-current')).toBe('page');
  });

  it('requires a title before creating (negative)', async () => {
    const requests = captureRequests();
    const app = await openNotes('/notes/new');
    await vi.waitFor(() => expect(app.wrapper.find('[data-note-title]').exists()).toBe(true));
    await setValue(app.wrapper.get('[data-note-body]'), '본문만');
    await app.wrapper.get('[data-note-save]').trigger('click');
    await settle();
    expect(app.wrapper.text()).toContain('제목을 입력해 주세요.');
    expect(app.wrapper.get('[data-note-title]').attributes('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(app.wrapper.get('[data-note-title]').element);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('saves only the changed fields with If-Match + Idempotency-Key and announces the version', async () => {
    const requests = captureRequests();
    const app = await openNote(NOTE_THESIS_ID);
    expect(app.wrapper.get('[data-note-status]').text()).toBe('저장된 상태예요 · 버전 3');
    await setValue(app.wrapper.get('[data-note-body]'), '바뀐 본문');
    expect(app.wrapper.get('[data-note-status]').text()).toBe('저장하지 않은 변경 사항이 있어요');
    await app.wrapper.get('form.note-form').trigger('submit');
    await vi.waitFor(() => expect(liveText(app.wrapper)).toBe('저장했어요 · 버전 4'));
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.path).toBe(`/api/v1/documents/${NOTE_THESIS_ID}`);
    expect(patch?.headers.get('If-Match')).toBe('W/"3"');
    expect(isUuidV7Key(patch?.headers.get('Idempotency-Key') ?? '')).toBe(true);
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ bodyMd: '바뀐 본문' });
    expect(noteById(NOTE_THESIS_ID).version).toBe(4);
    expect(app.wrapper.get('[data-note-status]').text()).toBe('저장된 상태예요 · 버전 4');
    expect(app.wrapper.get('[data-note-live]').attributes('aria-live')).toBe('polite');
  });

  it('saves with Ctrl+S from the keyboard', async () => {
    const app = await openNote(NOTE_MEETING_ID);
    await setValue(app.wrapper.get('[data-note-title]'), '발표 준비 회의 (수정)');
    await app.wrapper.get('[data-note-title]').trigger('keydown', { key: 's', ctrlKey: true });
    await vi.waitFor(() => expect(noteById(NOTE_MEETING_ID).title).toBe('발표 준비 회의 (수정)'));
  });

  it('412: the conflict dialog reloads the server version', async () => {
    const app = await openNote(NOTE_MEETING_ID);
    // Another device edits the note meanwhile.
    const stored = noteById(NOTE_MEETING_ID);
    stored.title = '다른 기기에서 바꾼 제목';
    stored.version = 5;
    await setValue(app.wrapper.get('[data-note-body]'), '내가 쓴 본문');
    await app.wrapper.get('[data-note-save]').trigger('click');
    await vi.waitFor(() => expect(() => dialogByTitle('다른 곳에서 이 노트가 바뀌었어요')).not.toThrow());
    const dialog = dialogByTitle('다른 곳에서 이 노트가 바뀌었어요');
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('버전 5');
    expect(dialog.textContent).toContain('다른 기기에서 바꾼 제목');
    expect(document.activeElement).toBe(dialog.querySelector('[data-conflict-reload]'));
    buttonInElement(dialog, '서버 내용 불러오기').click();
    await settle();
    expect(document.body.querySelector('.note-conflict-dialog')).toBeNull();
    expect((app.wrapper.get('[data-note-title]').element as HTMLInputElement).value).toBe('다른 기기에서 바꾼 제목');
    expect((app.wrapper.get('[data-note-body]').element as HTMLTextAreaElement).value).toBe(stored.bodyMd);
    expect(app.wrapper.get('[data-note-status]').text()).toBe('저장된 상태예요 · 버전 5');
  });

  it('412: “keep mine as a copy” saves my text as a new note and leaves the server note alone', async () => {
    const requests = captureRequests();
    const app = await openNote(NOTE_MEETING_ID);
    const stored = noteById(NOTE_MEETING_ID);
    stored.bodyMd = '서버 본문';
    stored.version = 2;
    await setValue(app.wrapper.get('[data-note-body]'), '내 본문');
    await app.wrapper.get('[data-note-save]').trigger('click');
    await vi.waitFor(() => expect(() => dialogByTitle('다른 곳에서 이 노트가 바뀌었어요')).not.toThrow());
    buttonInElement(dialogByTitle('다른 곳에서 이 노트가 바뀌었어요'), '내 내용을 사본으로 저장').click();
    await vi.waitFor(() => expect(app.router.currentRoute.value.params['id']).not.toBe(NOTE_MEETING_ID));
    const copyId = String(app.router.currentRoute.value.params['id']);
    expect(noteById(copyId)).toMatchObject({ title: '발표 준비 회의 (사본)', bodyMd: '내 본문' });
    expect(noteById(NOTE_MEETING_ID)).toMatchObject({ bodyMd: '서버 본문', version: 2 });
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.headers.get('If-Match')).toBe('W/"1"');
  });

  it('deletes after an alertdialog confirmation whose focus starts on 취소', async () => {
    const requests = captureRequests();
    const app = await openNote(NOTE_PRIVATE_ID);
    await app.wrapper.get('[data-note-delete]').trigger('click');
    await settle();
    const dialog = dialogByTitle('노트를 삭제할까요?');
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('“개인 일정 메모” 노트가 목록과 검색, AI 전송에서 빠져요.');
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('취소'));
    buttonInElement(dialog, '삭제').click();
    await vi.waitFor(() => expect(app.router.currentRoute.value.path).toBe('/notes'));
    const remove = requests.find((request) => request.method === 'DELETE');
    expect(remove?.path).toBe(`/api/v1/documents/${NOTE_PRIVATE_ID}`);
    expect(remove?.headers.get('If-Match')).toBe('W/"1"');
    expect(isUuidV7Key(remove?.headers.get('Idempotency-Key') ?? '')).toBe(true);
    expect(noteById(NOTE_PRIVATE_ID).deletedAt).toBeDefined();
    await vi.waitFor(() => expect(listTitles(app)).not.toContain('개인 일정 메모'));
    expect(document.body.textContent).toContain('노트를 삭제했어요');
  });

  it('counts code points to the 65,536 limit and refuses to save above it (negative)', async () => {
    const requests = captureRequests();
    const app = await openNote(NOTE_MEETING_ID);
    await setValue(app.wrapper.get('[data-note-body]'), '😀'.repeat(3));
    expect(app.wrapper.get('[data-note-counter]').text()).toContain('3 / 65,536자');
    await setValue(app.wrapper.get('[data-note-body]'), 'a'.repeat(65_536));
    expect(app.wrapper.get('[data-note-counter]').text()).toContain('65,536 / 65,536자');
    expect(app.wrapper.get('[data-note-counter]').text()).not.toContain('넘었어요');
    await setValue(app.wrapper.get('[data-note-body]'), 'a'.repeat(65_537));
    const counter = app.wrapper.get('[data-note-counter]');
    expect(counter.text()).toContain('65,537 / 65,536자');
    expect(counter.text()).toContain('1자 넘었어요. 줄여야 저장할 수 있어요.');
    expect(app.wrapper.get('[data-note-body]').attributes('aria-invalid')).toBe('true');
    await app.wrapper.get('[data-note-save]').trigger('click');
    await settle();
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    expect(document.activeElement).toBe(app.wrapper.get('[data-note-body]').element);
  });

  it('previews the current body through the safe renderer (no split on narrow screens)', async () => {
    const app = await openNote(NOTE_MEETING_ID);
    expect(app.wrapper.find('[data-note-mode="split"]').exists()).toBe(false);
    await app.wrapper.get('[data-note-mode="edit"]').setValue(true);
    await setValue(app.wrapper.get('[data-note-body]'), '# 새 제목\n\n<script>window.__x=1</script> [링크](javascript:alert(1))');
    await app.wrapper.get('[data-note-mode="preview"]').setValue(true);
    await settle();
    const preview = app.wrapper.get('[data-note-preview]');
    expect(preview.isVisible()).toBe(true);
    expect(preview.find('h3').text()).toBe('새 제목');
    expect(preview.find('script, a').exists()).toBe(false);
    expect(preview.text()).toContain('<script>window.__x=1</script>');
  });

  it('offers side by side on desktop and debounces the preview while typing', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width: 1024px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      const app = await openNote(NOTE_MEETING_ID);
      // An opened note starts side by side on desktop, preview already filled.
      expect((app.wrapper.get('[data-note-mode="split"]').element as HTMLInputElement).checked).toBe(true);
      expect(app.wrapper.get('.note-body').classes()).toContain('note-body--split');
      expect(app.wrapper.get('[data-note-preview]').text()).toContain('지난 회의 메모');
      await setValue(app.wrapper.get('[data-note-body]'), '## 바로 바뀌지 않음');
      expect(app.wrapper.get('[data-note-preview]').text()).toContain('지난 회의 메모');
      await vi.waitFor(() => expect(app.wrapper.get('[data-note-preview] h4').text()).toBe('바로 바뀌지 않음'));
      expect(app.wrapper.get('[data-note-body]').isVisible()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('turning “AI에 보내기 허용” on is saved explicitly, with a warning for P1 notes', async () => {
    const requests = captureRequests();
    const app = await openNote(NOTE_PRIVATE_ID);
    await app.wrapper.get('[data-note-llm-toggle]').setValue(true);
    expect(app.wrapper.get('[data-note-llm]').text()).toContain('P1 개인 일정 정보예요. 꼭 필요할 때만 켜 주세요.');
    expect(app.wrapper.get('[data-note-llm]').text()).toContain('연결된 계획의 단계 초안을 만들 때 AI에 전송될 수 있어요.');
    await app.wrapper.get('[data-note-save]').trigger('click');
    await vi.waitFor(() => expect(noteById(NOTE_PRIVATE_ID).llmAllowed).toBe(true));
    expect(JSON.parse(requests.find((request) => request.method === 'PATCH')?.body ?? '{}')).toEqual({ llmAllowed: true });
  });

  it('asks before leaving unsaved changes; “계속 편집” stays, “저장하지 않고 이동” leaves', async () => {
    const app = await openNote(NOTE_MEETING_ID);
    await setValue(app.wrapper.get('[data-note-body]'), '아직 저장 안 함');
    await app.wrapper.get(`[data-note-item="${NOTE_THESIS_ID}"]`).trigger('click');
    await vi.waitFor(() => expect(() => dialogByTitle('저장하지 않은 변경 사항이 있어요')).not.toThrow());
    buttonInElement(dialogByTitle('저장하지 않은 변경 사항이 있어요'), '계속 편집').click();
    await settle();
    expect(app.router.currentRoute.value.params['id']).toBe(NOTE_MEETING_ID);
    expect((app.wrapper.get('[data-note-body]').element as HTMLTextAreaElement).value).toBe('아직 저장 안 함');

    await app.wrapper.get(`[data-note-item="${NOTE_THESIS_ID}"]`).trigger('click');
    await vi.waitFor(() => expect(() => dialogByTitle('저장하지 않은 변경 사항이 있어요')).not.toThrow());
    buttonInElement(dialogByTitle('저장하지 않은 변경 사항이 있어요'), '저장하지 않고 이동').click();
    await vi.waitFor(() => expect(app.router.currentRoute.value.params['id']).toBe(NOTE_THESIS_ID));
    await vi.waitFor(() =>
      expect((app.wrapper.get('[data-note-title]').element as HTMLInputElement).value).toBe('졸업 논문 참고 문헌'),
    );
    expect(noteById(NOTE_MEETING_ID).bodyMd).not.toBe('아직 저장 안 함');
  });
});

describe('Notes workspace — AI usage history', () => {
  it('lists the AI calls with run, time, status and section hashes, never note text', async () => {
    const app = await openNote(NOTE_THESIS_ID);
    await vi.waitFor(() => expect(app.wrapper.findAll('[data-note-ai-item]')).toHaveLength(2));
    const section = app.wrapper.get('[data-note-ai-usage]');
    const [latest, older] = section.findAll('[data-note-ai-item]');
    expect(latest?.attributes('data-note-ai-item')).toBe('succeeded');
    expect(latest?.text()).toContain('계획 단계 나누기');
    expect(latest?.text()).toContain('성공');
    expect(latest?.text()).toContain('구간 2개');
    expect(latest?.text()).toContain('약 1.5KB 전송');
    expect(latest?.text()).toContain('노트 버전 3 기준');
    expect(latest?.text()).toContain('11월 12일 (목) 오후 3:00');
    expect(latest?.findAll('[data-section-hash]')).toHaveLength(2);
    expect(latest?.text()).not.toContain('이후 수정됨');
    expect(older?.text()).toContain('실패');
    expect(older?.text()).toContain('이후 수정됨');
    // Only ids and hashes: none of the note's words appear in the history.
    expect(section.text()).not.toContain('실험 설계');
    expect(section.text()).not.toContain('지도 교수님');
  });

  it('shows the empty history for a note never sent', async () => {
    const app = await openNote(NOTE_MEETING_ID);
    await vi.waitFor(() => expect(app.wrapper.find('[data-note-ai-empty]').exists()).toBe(true));
    expect(app.wrapper.get('[data-note-ai-empty]').text()).toBe('아직 AI에 보낸 적이 없어요.');
  });
});

describe('Notes workspace — owner change (ADR-023)', () => {
  it('drops a create whose answer arrives after another owner signed in', async () => {
    const held = gate();
    server.use(
      http.post('*/api/v1/documents', async () => {
        await held.promise;
        return undefined;
      }),
    );
    const app = await openNotes('/notes/new');
    await vi.waitFor(() => expect(app.wrapper.find('[data-note-title]').exists()).toBe(true));
    await setValue(app.wrapper.get('[data-note-title]'), '전 사용자의 노트');
    await app.wrapper.get('[data-note-save]').trigger('click');
    await settle();
    adoptActiveOwner('01900000-0000-7000-8000-00000000beef', 'storage');
    held.release();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    // No navigation to the created note and no "created" announcement for the new owner.
    expect(app.router.currentRoute.value.name).toBe('notes-new');
    expect(app.wrapper.find('[data-note-live]').exists() ? liveText(app.wrapper) : '').not.toBe('노트를 만들었어요');
    adoptActiveOwner(mockDb.user.id, 'bootstrap');
  });

  it('drops a save continuation after an owner change (no “saved”, no conflict dialog)', async () => {
    const held = gate();
    server.use(
      http.patch('*/api/v1/documents/:id', async () => {
        await held.promise;
        return HttpResponse.json({ title: 'x', status: 412, code: 'version_conflict' }, { status: 412 });
      }),
    );
    const app = await openNote(NOTE_MEETING_ID);
    await setValue(app.wrapper.get('[data-note-body]'), '바꾼 본문');
    await app.wrapper.get('[data-note-save]').trigger('click');
    await settle();
    adoptActiveOwner('01900000-0000-7000-8000-00000000beef', 'storage');
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    expect(document.body.querySelector('.note-conflict-dialog')).toBeNull();
    expect(document.body.textContent).not.toContain('저장했어요');
    adoptActiveOwner(mockDb.user.id, 'bootstrap');
  });
});
