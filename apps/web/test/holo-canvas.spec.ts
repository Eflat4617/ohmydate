import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { HttpResponse, http } from 'msw';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/api';
import {
  CANVAS_MEMORY_LIMIT,
  EMPTY_CANVAS_MEMORY,
  canvasMemoryKey,
  parseCanvasMemory,
  pruneCanvasMemory,
  readCanvasMemory,
  serializeCanvasMemory,
  writeCanvasMemory,
} from '../src/composables/canvasMemory';
import { setLayoutClock } from '../src/layout/clock';
import {
  INBOX_PROJECT_ID,
  MONTH_TASK_ENGLISH_ID,
  MONTH_TASK_REPORT_ID,
  MONTH_TASK_SCHOLARSHIP_ID,
  MONTH_TASK_SLIDES_ID,
  MONTH_TASK_SUMMARY_ID,
  MONTH_TASK_THESIS_ID,
  SAMPLE_PROJECT_ID,
  SEED_TASK_TITLE,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_TWO_ID,
  mockDb,
  seedMonth,
} from '../src/mocks/db';
import { seedCanvas } from '../src/mocks/canvas-seed';
import { server } from '../src/mocks/server';
import { routes } from '../src/router';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';
import { OWNER_STORAGE_MANIFEST } from '../src/session/ownerStorage';
import { useAuthStore } from '../src/stores/auth';
import { useOfflineStore } from '../src/stores/offline';
import { useToastStore } from '../src/stores/toast';
import { useUiStore } from '../src/stores/ui';
import TasksView from '../src/views/TasksView.vue';

/**
 * HOLO-05, 할 일 as a canvas: every open to-do floats on a wide surface as a
 * real, named, focusable element; it is dragged, opened, picked and filed;
 * folders are dishes on the surface and real projects; and the same surface
 * is a list to the keyboard and to assistive technology.
 *
 * The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul. With `seedMonth` the
 * inbox holds six open to-dos (and one finished), and the folder 졸업 논문 two.
 * jsdom measures nothing, so capsules have their estimated sizes and the
 * surface is 1100 px wide.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const OWNER_B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02';
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];

interface Place {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
  readonly queryClient: QueryClient;
}

function placeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: routes.map((route) => (route.name === 'tasks' || 'redirect' in route ? route : { ...route, component: Stub })) as never,
  });
}

/** Reduced motion on (the default here: every body is exactly on its anchor) or off. */
function motion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduce : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

async function mountPlace(path = '/tasks'): Promise<Place> {
  const router = placeRouter();
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  await useAuthStore(pinia).ensureOwnerConfirmed();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(TasksView, { global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, router, pinia, queryClient };
}

async function mountCanvas(path = '/tasks'): Promise<Place> {
  const place = await mountPlace(path);
  await vi.waitFor(() => expect(place.wrapper.find('[data-todo-canvas]').exists()).toBe(true));
  await flushPromises();
  await nextTick();
  return place;
}

function todo(wrapper: VueWrapper, id: string) {
  return wrapper.get(`[data-todo="${id}"]`);
}

function options(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[role="option"]').map((item) => item.attributes('data-todo') as string);
}

/** Where a capsule is drawn (its top-left corner), from the one transform that places it. */
function placeOf(wrapper: VueWrapper, id: string): { x: number; y: number; text: string } {
  const element = todo(wrapper, id).element as HTMLElement;
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(element.style.transform);
  if (match === null) throw new Error(`no place: ${element.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]), text: element.style.transform };
}

function boxOf(wrapper: VueWrapper, folderId: string): { left: number; top: number; width: number; height: number } {
  const style = (wrapper.get(`[data-folder-dish="${folderId}"]`).element as HTMLElement).style;
  return { left: parseFloat(style.left), top: parseFloat(style.top), width: parseFloat(style.width), height: parseFloat(style.height) };
}

/** True when a capsule's corner is inside a dish. */
function inDish(at: { x: number; y: number }, dish: { left: number; top: number; width: number; height: number }): boolean {
  return at.x >= dish.left && at.x < dish.left + dish.width && at.y >= dish.top && at.y < dish.top + dish.height;
}

function pointer(
  target: Element,
  type: string,
  at: { x: number; y: number },
  init: { shiftKey?: boolean; pointerType?: string; pointerId?: number; button?: number } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
    button: init.button ?? 0,
    shiftKey: init.shiftKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
  target.dispatchEvent(event);
}

async function click(wrapper: VueWrapper, id: string, init: { shiftKey?: boolean } = {}): Promise<void> {
  const at = placeOf(wrapper, id);
  const point = { x: at.x + 8, y: at.y + 8 };
  pointer(todo(wrapper, id).element, 'pointerdown', point, init);
  pointer(todo(wrapper, id).element, 'pointerup', point, init);
  await flushPromises();
  await nextTick();
}

async function drag(wrapper: VueWrapper, id: string, to: { x: number; y: number }): Promise<void> {
  const stage = wrapper.get('[data-todo-canvas]').element;
  const at = placeOf(wrapper, id);
  const from = { x: at.x + 8, y: at.y + 8 };
  pointer(todo(wrapper, id).element, 'pointerdown', from);
  pointer(stage, 'pointermove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  pointer(stage, 'pointermove', to);
  pointer(stage, 'pointerup', to);
  await flushPromises();
  await nextTick();
}

async function press(wrapper: VueWrapper, id: string, key: string, init: KeyboardEventInit = {}): Promise<void> {
  const element = todo(wrapper, id).element as HTMLElement;
  element.focus();
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  await flushPromises();
  await nextTick();
}

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-todo-card]');
}

function dialog(selector: string): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
}

async function setInput(element: Element | null, value: string): Promise<void> {
  if (!(element instanceof HTMLInputElement)) throw new Error('not an input');
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const seen: Seen[] = [];

function mutations(): string[] {
  return seen.map((request) => `${request.method} ${request.path}`);
}

function task(id: string): Task {
  const found = mockDb.tasks.get(id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
}

function seedTaskId(): string {
  const found = [...mockDb.tasks.values()].find((item) => item.title === SEED_TASK_TITLE);
  if (found === undefined) throw new Error('seed task missing');
  return found.id;
}

function storedMemory(ownerId: string = mockDb.user.id) {
  return parseCanvasMemory(localStorage.getItem(canvasMemoryKey(ownerId)));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  setLayoutClock({ now: () => NOW });
  seedMonth(mockDb);
  motion(true);
  seen.length = 0;
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET') return;
    const path = new URL(request.url).pathname.replace('/api/v1', '');
    void request
      .clone()
      .text()
      .then((raw) => seen.push({ method: request.method, path, body: raw.length > 0 ? JSON.parse(raw) : null }));
  });
});

afterEach(() => {
  vi.useRealTimers();
  while (mounted.length > 0) mounted.pop()?.unmount();
  server.events.removeAllListeners();
  vi.unstubAllGlobals();
  setLayoutClock(null);
  adoptActiveOwner(null, 'bootstrap');
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('the canvas: every open to-do floats, and is a real element', () => {
  it('is one listbox with a group for the inbox and one for each folder, an option a to-do', async () => {
    const { wrapper } = await mountCanvas();
    expect(wrapper.get('[data-tasks-place]').attributes('data-tasks-view')).toBe('canvas');
    const field = wrapper.get('[role="listbox"]');
    expect(field.attributes('aria-multiselectable')).toBe('true');
    expect(field.attributes('aria-label')).toBe('할 일 캔버스, 열린 할 일 8개');
    expect(field.attributes('aria-describedby')).toBe('pond-help');
    expect(wrapper.get('#pond-help').text()).toContain('Enter로 열고');
    expect(field.findAll('[role="group"]').map((group) => group.attributes('aria-label'))).toEqual(['인박스', '폴더 졸업 논문']);
    // Six open in the inbox, two in the folder. The finished one is not on the surface.
    expect(field.get('[data-canvas-group="inbox"]').findAll('[role="option"]')).toHaveLength(6);
    expect(field.get(`[data-canvas-group="${SAMPLE_PROJECT_ID}"]`).findAll('[role="option"]')).toHaveLength(2);
    expect(wrapper.find(`[data-todo="${MONTH_TASK_SUMMARY_ID}"]`).exists()).toBe(false);
    // One page heading, and the count in words.
    expect(wrapper.findAll('h1').map((heading) => heading.text())).toEqual(['할 일']);
    expect(wrapper.findAll('[data-tasks-summary] > span').map((part) => part.text())).toEqual(['열린 할 일 8개', '폴더 1개']);
  });

  it('is one tab stop: exactly one to-do is in the tab order', async () => {
    const { wrapper } = await mountCanvas();
    const stops = wrapper.findAll('[role="option"]').filter((item) => item.attributes('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(wrapper.findAll('[role="option"]').filter((item) => item.attributes('tabindex') === '-1')).toHaveLength(7);
  });

  it('names each to-do for a screen reader: title, state, deadline, plan, where it is', async () => {
    const { wrapper } = await mountCanvas();
    expect(todo(wrapper, MONTH_TASK_ENGLISH_ID).attributes('aria-label')).toBe('영어 회화 과제, 마감 11월 6일 (금) 오후 6:00, 지났어요, 인박스');
    expect(todo(wrapper, MONTH_TASK_SLIDES_ID).attributes('aria-label')).toBe(
      '세미나 발표 자료, 진행 중, 마감 11월 20일 (금) 오후 2:00, 계획에 있음, 인박스',
    );
    expect(todo(wrapper, MONTH_TASK_THESIS_ID).attributes('aria-label')).toContain('폴더 졸업 논문');
    expect(todo(wrapper, seedTaskId()).attributes('aria-label')).toBe(`${SEED_TASK_TITLE}, 인박스`);
  });

  it('shows quietly what matters: a nearer deadline is nearer, past it is the red word, a plan is the bar', async () => {
    const { wrapper } = await mountCanvas();
    const english = todo(wrapper, MONTH_TASK_ENGLISH_ID);
    expect(english.attributes('data-depth')).toBe('0');
    expect(english.attributes('data-overdue')).toBe('true');
    expect(english.get('[data-todo-due]').text()).toBe('8일 지남');
    expect(english.get('[data-todo-due]').attributes('data-due')).toBe('overdue');

    const scholarship = todo(wrapper, MONTH_TASK_SCHOLARSHIP_ID);
    expect(scholarship.attributes('data-depth')).toBe('0');
    expect(scholarship.get('[data-todo-due]').text()).toBe('오늘');

    const slides = todo(wrapper, MONTH_TASK_SLIDES_ID);
    expect(slides.attributes('data-depth')).toBe('1');
    expect(slides.attributes('data-status')).toBe('in_progress');
    expect(slides.get('[data-todo-due]').text()).toBe('6일 남음');
    expect(slides.get('[data-todo-due]').attributes('data-due')).toBe('soon');
    expect(slides.find('[data-todo-planned]').exists()).toBe(true);

    const report = todo(wrapper, MONTH_TASK_REPORT_ID);
    expect(report.attributes('data-depth')).toBe('2');
    expect(report.get('[data-todo-due]').text()).toBe('12월 4일');
    expect(report.get('[data-todo-due]').attributes('data-due')).toBe('far');
  });

  it('a to-do with no deadline and no plan says only its title (negative)', async () => {
    const { wrapper } = await mountCanvas();
    const plain = todo(wrapper, seedTaskId());
    expect(plain.attributes('data-depth')).toBe('2');
    expect(plain.find('[data-todo-due]').exists()).toBe(false);
    expect(plain.find('[data-todo-planned]').exists()).toBe(false);
    expect(plain.attributes('data-overdue')).toBeUndefined();
    expect(plain.get('.pond-title').text()).toBe(SEED_TASK_TITLE);
  });

  it('capsules and dishes are still glass: no backdrop blur on the surface', async () => {
    const { wrapper } = await mountCanvas();
    for (const capsule of wrapper.findAll('.pond-capsule')) {
      expect(capsule.classes()).toEqual(expect.arrayContaining(['glass', 'glass--still', 'glass--flat']));
    }
    for (const dish of wrapper.findAll('[data-folder-dish]')) expect(dish.classes()).toContain('glass--still');
    // The one frosted thing is the floating detail.
    await click(wrapper, seedTaskId());
    expect(card()?.classList.contains('glass')).toBe(true);
    expect(card()?.classList.contains('glass--still')).toBe(false);
    expect(document.body.querySelectorAll('.pond .glass:not(.glass--still)')).toHaveLength(1);
  });

  it('the seeded field is the same picture on every visit, with nothing on top of anything', async () => {
    const first = await mountCanvas();
    const before = options(first.wrapper).map((id) => [id, placeOf(first.wrapper, id).text]);
    first.wrapper.unmount();
    mounted.length = 0;
    localStorage.removeItem(canvasMemoryKey(mockDb.user.id));
    const second = await mountCanvas();
    expect(options(second.wrapper).map((id) => [id, placeOf(second.wrapper, id).text])).toEqual(before);
    expect(new Set(before.map(([, text]) => text)).size).toBe(before.length);
    // On the surface: nothing is drawn off its left or top edge.
    for (const id of options(second.wrapper)) {
      expect(placeOf(second.wrapper, id).x).toBeGreaterThanOrEqual(0);
      expect(placeOf(second.wrapper, id).y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('motion: weightless, and still when it should be', () => {
  it('under reduced motion nothing moves: every capsule is exactly on its anchor and no frame is asked for', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    const { wrapper } = await mountCanvas();
    expect(wrapper.get('[data-todo-canvas]').attributes('data-motion')).toBe('still');
    for (const id of options(wrapper)) {
      const place = placeOf(wrapper, id);
      expect(place.text).toMatch(/^translate3d\(-?\d+px, -?\d+px, 0\)$/);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(frames).not.toHaveBeenCalled();
  });

  it('with motion allowed it sways: frames are asked for and a capsule leaves its anchor by a few pixels', async () => {
    motion(false);
    const { wrapper } = await mountCanvas();
    expect(wrapper.get('[data-todo-canvas]').attributes('data-motion')).toBe('full');
    const id = seedTaskId();
    const anchor = placeOf(wrapper, id);
    await vi.waitFor(
      () => {
        const now = placeOf(wrapper, id);
        expect(now.text).not.toBe(anchor.text);
        expect(now.text).toContain('rotate(');
      },
      { timeout: 4000 },
    );
    const now = placeOf(wrapper, id);
    // Moored: never further than the sway's reach from where it was left.
    expect(Math.abs(now.x - anchor.x)).toBeLessThanOrEqual(8);
    expect(Math.abs(now.y - anchor.y)).toBeLessThanOrEqual(8);
  });

  it('in a hidden tab nothing moves', async () => {
    motion(false);
    const { wrapper } = await mountCanvas();
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(wrapper.get('[data-todo-canvas]').attributes('data-motion')).toBe('still');
    const id = seedTaskId();
    const held = placeOf(wrapper, id).text;
    expect(held).toMatch(/^translate3d\(-?\d+px, -?\d+px, 0\)$/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(placeOf(wrapper, id).text).toBe(held);
    state.mockRestore();
  });
});

describe('drag to move: the place you leave it is remembered', () => {
  it('moves a to-do with the pointer and writes where it was left into this owner’s storage', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    const before = placeOf(wrapper, id);
    const target = { x: 120, y: 560 };
    await drag(wrapper, id, target);
    const after = placeOf(wrapper, id);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(40);
    expect(Math.abs(after.x + 8 - target.x)).toBeLessThan(40);
    expect(Math.abs(after.y + 8 - target.y)).toBeLessThan(40);
    // A drag is not a click: no detail opened, nothing sent.
    expect(card()).toBeNull();
    expect(seen).toEqual([]);

    await vi.waitFor(() => expect(storedMemory().places[id]).toBeDefined());
    const place = storedMemory().places[id];
    expect(place?.u).toBeGreaterThan(0);
    expect(place?.u).toBeLessThan(0.3);
    expect(place?.v).toBeGreaterThan(0.6);
    // Ids and numbers only: no title is ever stored.
    expect(localStorage.getItem(canvasMemoryKey(mockDb.user.id))).not.toContain(SEED_TASK_TITLE);
  });

  it('opens on the same place next time', async () => {
    const first = await mountCanvas();
    const id = seedTaskId();
    await drag(first.wrapper, id, { x: 140, y: 580 });
    await vi.waitFor(() => expect(storedMemory().places[id]).toBeDefined());
    const left = placeOf(first.wrapper, id);
    first.wrapper.unmount();
    mounted.length = 0;
    const second = await mountCanvas();
    const again = placeOf(second.wrapper, id);
    expect(Math.abs(again.x - left.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(again.y - left.y)).toBeLessThanOrEqual(2);
  });

  it('what it is dropped on gives way: two to-dos are never left on top of each other', async () => {
    const { wrapper } = await mountCanvas();
    const moved = seedTaskId();
    const other = placeOf(wrapper, MONTH_TASK_SCHOLARSHIP_ID);
    await drag(wrapper, moved, { x: other.x + 8, y: other.y + 8 });
    const a = placeOf(wrapper, moved);
    const b = placeOf(wrapper, MONTH_TASK_SCHOLARSHIP_ID);
    expect(Math.abs(a.x - b.x) > 60 || Math.abs(a.y - b.y) > 30).toBe(true);
  });

  it('never shows one owner where the other left things (negative)', async () => {
    const { wrapper } = await mountCanvas();
    await drag(wrapper, seedTaskId(), { x: 140, y: 580 });
    await vi.waitFor(() => expect(Object.keys(storedMemory().places).length).toBeGreaterThan(0));
    expect(localStorage.getItem(canvasMemoryKey(OWNER_B))).toBeNull();
    expect(readCanvasMemory(OWNER_B)).toEqual(EMPTY_CANVAS_MEMORY);
  });

  it('a small wobble of the pointer is a click, not a move (negative)', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    const before = placeOf(wrapper, id);
    const stage = wrapper.get('[data-todo-canvas]').element;
    pointer(todo(wrapper, id).element, 'pointerdown', { x: before.x + 8, y: before.y + 8 });
    pointer(stage, 'pointermove', { x: before.x + 10, y: before.y + 9 });
    pointer(stage, 'pointerup', { x: before.x + 10, y: before.y + 9 });
    await flushPromises();
    expect(placeOf(wrapper, id).text).toBe(before.text);
    expect(card()).not.toBeNull();
  });
});

describe('the floating detail: one at a time', () => {
  it('a click opens it on that to-do, a click on another moves it, and there is never a second', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    expect(document.body.querySelectorAll('[data-todo-card]')).toHaveLength(1);
    expect(card()?.getAttribute('role')).toBe('dialog');
    expect(card()?.getAttribute('aria-label')).toBe('할 일 상세');
    expect((card()?.querySelector('[data-todo-card-title]') as HTMLInputElement).value).toBe(SEED_TASK_TITLE);
    expect(todo(wrapper, id).attributes('data-open')).toBe('true');

    await click(wrapper, MONTH_TASK_ENGLISH_ID);
    expect(document.body.querySelectorAll('[data-todo-card]')).toHaveLength(1);
    expect((card()?.querySelector('[data-todo-card-title]') as HTMLInputElement).value).toBe('영어 회화 과제');
    expect(card()?.querySelector('[data-todo-card-overdue]')?.textContent).toBe('지났어요');
    expect(card()?.querySelector('[data-todo-card-due]')?.textContent).toContain('11월 6일 (금) 오후 6:00');
  });

  it('none of its buttons is filled: the screen’s one primary is 계획에 넣기 in the head', async () => {
    const { wrapper } = await mountCanvas();
    await click(wrapper, seedTaskId());
    expect(card()?.querySelector('.btn--primary')).toBeNull();
    const primary = wrapper.findAll('.btn--primary');
    expect(primary).toHaveLength(1);
    expect(primary[0]?.attributes('data-tasks-to-plan')).toBeDefined();
  });

  it('Escape closes it and gives the focus back; a press on the water closes it too', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    card()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(todo(wrapper, id).element);

    await click(wrapper, id);
    expect(card()).not.toBeNull();
    const stage = wrapper.get('[data-todo-canvas]').element;
    pointer(stage, 'pointerdown', { x: 4, y: 4 });
    pointer(stage, 'pointerup', { x: 4, y: 4 });
    await nextTick();
    expect(card()).toBeNull();
  });

  it('leads on: 작업 열기 and 계획에 넣기 carry the to-do', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    expect(card()?.querySelector('[data-todo-card-open]')?.getAttribute('href')).toBe(`/tasks/${id}`);
    expect(card()?.querySelector('[data-todo-card-plan]')?.getAttribute('href')).toBe(`/plan/schedule?taskIds=${id}`);
    expect(card()?.querySelector('[data-todo-card-focus]')?.textContent).toContain('집중 시작');
  });

  it('renames in place: the title is saved and the capsule says it', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    // Nothing to save until the title differs.
    expect(card()?.querySelector('[data-todo-card-save]')).toBeNull();
    await setInput(card()?.querySelector('[data-todo-card-title]') ?? null, '주간 계획 다시 보기');
    expect(card()?.querySelector('[data-todo-card-save]')?.textContent).toContain('저장');
    card()?.querySelector('form.pond-card-title')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(todo(wrapper, id).get('.pond-title').text()).toBe('주간 계획 다시 보기'));
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([['PATCH', `/tasks/${id}`, { title: '주간 계획 다시 보기' }]]);
    expect(task(id).title).toBe('주간 계획 다시 보기');
  });

  it('a rename that meets a newer version asks first, and overwrites with the title that was typed', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    await setInput(card()?.querySelector('[data-todo-card-title]') ?? null, '내가 고친 제목');
    // Another device changed it meanwhile.
    mockDb.tasks.set(id, { ...task(id), title: '다른 곳에서 바꾼 제목', version: task(id).version + 1 });
    card()?.querySelector('form.pond-card-title')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.body.querySelector('.conflict-dialog')).not.toBeNull());
    const conflict = dialog('.conflict-dialog');
    expect(conflict.textContent).toContain('다른 곳에서 이 작업이 바뀌었어요');
    expect(conflict.textContent).toContain('다른 곳에서 바꾼 제목');
    expect(task(id).title).toBe('다른 곳에서 바꾼 제목');

    const overwrite = [...conflict.querySelectorAll('button')].find((button) => button.textContent?.includes('내 수정으로 덮어쓰기'));
    overwrite?.click();
    await vi.waitFor(() => expect(task(id).title).toBe('내가 고친 제목'));
    await vi.waitFor(() => expect(document.body.querySelector('.conflict-dialog')).toBeNull());
    await vi.waitFor(() => expect(todo(wrapper, id).get('.pond-title').text()).toBe('내가 고친 제목'));
  });

  it('sets a deadline, and takes it away', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    expect(card()?.querySelector('[data-todo-card-due]')?.textContent).toContain('마감 없음');
    (card()?.querySelector('[data-todo-card-due-toggle]') as HTMLButtonElement).click();
    await nextTick();
    await setInput(card()?.querySelector('[data-todo-card-due-input]') ?? null, '2026-11-18T15:00');
    card()?.querySelector('[data-todo-card-due-form]')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(task(id).dueAt).toBe('2026-11-18T06:00:00.000Z'));
    await vi.waitFor(() => expect(todo(wrapper, id).get('[data-todo-due]').text()).toBe('4일 남음'));
    expect(todo(wrapper, id).attributes('data-depth')).toBe('1');

    (card()?.querySelector('[data-todo-card-due-toggle]') as HTMLButtonElement).click();
    await nextTick();
    (card()?.querySelector('[data-todo-card-due-clear]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(task(id).dueAt).toBeUndefined());
    await vi.waitFor(() => expect(todo(wrapper, id).find('[data-todo-due]').exists()).toBe(false));
    expect(seen.map((request) => request.body)).toEqual([{ dueAt: '2026-11-18T06:00:00.000Z' }, { dueAt: null }]);
  });

  it('완료: the to-do is finished on the server and leaves the surface', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    const complete = card()?.querySelector('[data-todo-card-complete]') as HTMLButtonElement;
    expect(complete.getAttribute('aria-label')).toBe(`${SEED_TASK_TITLE} 완료로 표시`);
    complete.click();
    await vi.waitFor(() => expect(wrapper.find(`[data-todo="${id}"]`).exists()).toBe(false));
    expect(mutations()).toEqual([`POST /tasks/${id}:complete`]);
    expect(task(id).status).toBe('done');
    expect(card()).toBeNull();
    expect(wrapper.get('[data-canvas-status]').text()).toBe(`“${SEED_TASK_TITLE}” 할 일을 끝냈어요.`);
    expect(wrapper.get('[role="listbox"]').attributes('aria-label')).toBe('할 일 캔버스, 열린 할 일 7개');
  });

  it('with motion allowed a finished to-do stays a moment to leave, then is gone', async () => {
    motion(false);
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    (card()?.querySelector('[data-todo-card-complete]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(wrapper.find(`[data-todo="${id}"]`).attributes('data-state')).toBe('leaving'));
    expect(task(id).status).toBe('done');
    await vi.waitFor(() => expect(wrapper.find(`[data-todo="${id}"]`).exists()).toBe(false), { timeout: 3000 });
  });

  it('삭제 hides it at once and offers an undo; undone, nothing is sent (negative)', async () => {
    const { wrapper, pinia } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const remove = card()?.querySelector('[data-todo-card-remove]') as HTMLButtonElement;
    expect(remove.getAttribute('aria-label')).toBe(`${SEED_TASK_TITLE} 삭제`);
    remove.click();
    await nextTick();
    expect(wrapper.find(`[data-todo="${id}"]`).exists()).toBe(false);
    const toast = useToastStore(pinia);
    expect(toast.toasts.map((item) => item.message)).toEqual([`“${SEED_TASK_TITLE}” 작업을 삭제했어요.`]);
    toast.toasts[0]?.action?.handler();
    await nextTick();
    expect(wrapper.find(`[data-todo="${id}"]`).exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(seen).toEqual([]);
    expect(task(id).deletedAt).toBeUndefined();
  });

  it('삭제 is sent when the undo window closes', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    (card()?.querySelector('[data-todo-card-remove]') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(6_100);
    vi.useRealTimers();
    await vi.waitFor(() => expect(mutations()).toEqual([`DELETE /tasks/${id}`]));
    await vi.waitFor(() => expect(task(id).deletedAt).toBeDefined());
    expect(wrapper.find(`[data-todo="${id}"]`).exists()).toBe(false);
  });
});

describe('selection: pick several, and act on them', () => {
  it('Shift-click picks and unpicks; what is picked travels to the plan flow in the surface’s order', async () => {
    const { wrapper } = await mountCanvas();
    const plan = wrapper.get('[data-tasks-to-plan]');
    expect(plan.text()).toBe('계획에 넣기');
    expect(plan.attributes('href')).toBe('/plan/schedule');
    expect(plan.classes()).toContain('btn--primary');

    await click(wrapper, MONTH_TASK_ENGLISH_ID, { shiftKey: true });
    await click(wrapper, seedTaskId(), { shiftKey: true });
    expect(todo(wrapper, MONTH_TASK_ENGLISH_ID).attributes('aria-selected')).toBe('true');
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(2);
    // A pick is not an open.
    expect(card()).toBeNull();
    expect(plan.text()).toBe('고른 2개 계획에 넣기');
    const order = options(wrapper);
    const picked = [MONTH_TASK_ENGLISH_ID, seedTaskId()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    expect(plan.attributes('href')).toBe(`/plan/schedule?taskIds=${picked.join(',')}`);
    expect(wrapper.get('[data-canvas-selection-count]').text()).toBe('2개 고름');
    expect(wrapper.get('[data-canvas-status]').text()).toBe('2개 골랐어요.');

    await click(wrapper, seedTaskId(), { shiftKey: true });
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(1);
    expect(plan.text()).toBe('고른 1개 계획에 넣기');
  });

  it('a lasso picks what it touches; a click on the water lets go', async () => {
    const { wrapper } = await mountCanvas();
    const stage = wrapper.get('[data-todo-canvas]').element;
    const a = placeOf(wrapper, MONTH_TASK_ENGLISH_ID);
    const b = placeOf(wrapper, MONTH_TASK_SCHOLARSHIP_ID);
    const from = { x: Math.min(a.x, b.x) - 6, y: Math.min(a.y, b.y) - 6 };
    const to = { x: Math.max(a.x, b.x) + 30, y: Math.max(a.y, b.y) + 20 };
    pointer(stage, 'pointerdown', from);
    pointer(stage, 'pointermove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    await nextTick();
    expect(wrapper.find('[data-canvas-lasso]').exists()).toBe(true);
    pointer(stage, 'pointermove', to);
    pointer(stage, 'pointerup', to);
    await nextTick();
    expect(wrapper.find('[data-canvas-lasso]').exists()).toBe(false);
    const picked = wrapper.findAll('[aria-selected="true"]').map((item) => item.attributes('data-todo'));
    expect(picked).toEqual(expect.arrayContaining([MONTH_TASK_ENGLISH_ID, MONTH_TASK_SCHOLARSHIP_ID]));

    pointer(stage, 'pointerdown', { x: 3, y: 3 });
    pointer(stage, 'pointerup', { x: 3, y: 3 });
    await nextTick();
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(0);
    expect(wrapper.find('[data-canvas-selection]').exists()).toBe(false);
    expect(wrapper.get('[data-canvas-status]').text()).toBe('선택을 풀었어요.');
  });

  it('the keyboard picks too: Space, Shift+arrow, Ctrl+A, and Escape lets go', async () => {
    const { wrapper } = await mountCanvas();
    const first = options(wrapper)[0] as string;
    await press(wrapper, first, ' ');
    expect(todo(wrapper, first).attributes('aria-selected')).toBe('true');
    await press(wrapper, first, ' ');
    expect(todo(wrapper, first).attributes('aria-selected')).toBe('false');

    await press(wrapper, first, 'ArrowDown', { shiftKey: true });
    const afterRange = wrapper.findAll('[aria-selected="true"]');
    expect(afterRange.length).toBeGreaterThanOrEqual(2);
    expect(afterRange.map((item) => item.attributes('data-todo'))).toContain(first);

    await press(wrapper, first, 'a', { ctrlKey: true });
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(8);
    await press(wrapper, first, 'Escape');
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(0);
  });

  it('완료 on the selection finishes each one', async () => {
    const { wrapper } = await mountCanvas();
    const ids = [seedTaskId(), TODAY_TASK_ONE_ID];
    for (const id of ids) await click(wrapper, id, { shiftKey: true });
    await wrapper.get('[data-canvas-selection-complete]').trigger('click');
    await vi.waitFor(() => expect(ids.every((id) => task(id).status === 'done')).toBe(true));
    await vi.waitFor(() => expect(ids.some((id) => wrapper.find(`[data-todo="${id}"]`).exists())).toBe(false));
    expect(mutations().sort()).toEqual(ids.map((id) => `POST /tasks/${id}:complete`).sort());
    expect(wrapper.get('[data-canvas-status]').text()).toBe('할 일 2개를 끝냈어요.');
    expect(wrapper.find('[data-canvas-selection]').exists()).toBe(false);
  });

  it('what is picked stays picked across a look at the list: the canvas comes back, with the same selection (HOLO-06)', async () => {
    // The place keeps the selection while the canvas is away. A canvas that
    // was handed a selection as it mounted used to throw in its setup (the
    // first run of the `selected` watcher read `openId` before it existed),
    // and 할 일 came back empty.
    const { wrapper } = await mountCanvas();
    await click(wrapper, MONTH_TASK_ENGLISH_ID, { shiftKey: true });
    await click(wrapper, seedTaskId(), { shiftKey: true });
    expect(wrapper.get('[data-tasks-to-plan]').text()).toBe('고른 2개 계획에 넣기');

    await wrapper.get('[data-tasks-view-link="list"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-tasks-list]').exists()).toBe(true));
    expect(wrapper.find('[data-todo-canvas]').exists()).toBe(false);
    await wrapper.get('[data-tasks-view-link="canvas"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-todo-canvas]').exists()).toBe(true));
    await flushPromises();
    await nextTick();

    expect(wrapper.findAll('[data-todo]')).toHaveLength(8);
    expect(wrapper.findAll('[aria-selected="true"]').map((option) => option.attributes('data-todo')).sort()).toEqual(
      [MONTH_TASK_ENGLISH_ID, seedTaskId()].sort(),
    );
    expect(wrapper.get('[data-canvas-selection-count]').text()).toBe('2개 고름');
    expect(wrapper.get('[data-tasks-to-plan]').text()).toBe('고른 2개 계획에 넣기');
    // Coming back is not a new pick: nothing is announced, and no detail opens.
    expect(wrapper.get('[data-canvas-status]').text()).toBe('');
    expect(card()).toBeNull();
  });

  it('with nothing picked the canvas comes back with nothing picked (negative)', async () => {
    const { wrapper } = await mountCanvas();
    await wrapper.get('[data-tasks-view-link="list"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-tasks-list]').exists()).toBe(true));
    await wrapper.get('[data-tasks-view-link="canvas"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-todo-canvas]').exists()).toBe(true));
    await flushPromises();
    await nextTick();
    expect(wrapper.findAll('[data-todo]')).toHaveLength(8);
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(0);
    expect(wrapper.find('[data-canvas-selection]').exists()).toBe(false);
    expect(wrapper.get('[data-tasks-to-plan]').text()).toBe('계획에 넣기');
  });

  it('a to-do that left the surface is no longer picked (negative)', async () => {
    const { wrapper, queryClient } = await mountCanvas();
    const id = seedTaskId();
    await click(wrapper, id, { shiftKey: true });
    expect(wrapper.get('[data-tasks-to-plan]').text()).toBe('고른 1개 계획에 넣기');
    // Finished somewhere else.
    mockDb.tasks.set(id, { ...task(id), status: 'done', version: task(id).version + 1 });
    mockDb.taskRevision += 1;
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    await vi.waitFor(() => expect(wrapper.find(`[data-todo="${id}"]`).exists()).toBe(false));
    expect(wrapper.get('[data-tasks-to-plan]').text()).toBe('계획에 넣기');
    expect(wrapper.get('[data-tasks-to-plan]').attributes('href')).toBe('/plan/schedule');
  });
});

describe('without a pointer: the canvas is a list to the keyboard', () => {
  it('the arrow keys go to a to-do that way and carry the one tab stop with them', async () => {
    const { wrapper } = await mountCanvas();
    const start = options(wrapper)[0] as string;
    await press(wrapper, start, 'ArrowDown');
    const next = (document.activeElement as HTMLElement).dataset['todo'] as string;
    expect(next).not.toBe(start);
    expect(placeOf(wrapper, next).y).toBeGreaterThan(placeOf(wrapper, start).y);
    expect(todo(wrapper, next).attributes('tabindex')).toBe('0');
    expect(todo(wrapper, start).attributes('tabindex')).toBe('-1');

    await press(wrapper, next, 'ArrowUp');
    expect(placeOf(wrapper, (document.activeElement as HTMLElement).dataset['todo'] as string).y).toBeLessThan(placeOf(wrapper, next).y);
  });

  it('Home and End go to the first and the last in reading order', async () => {
    const { wrapper } = await mountCanvas();
    const ids = options(wrapper);
    const tops = ids.map((id) => placeOf(wrapper, id).y);
    await press(wrapper, ids[3] as string, 'Home');
    const first = (document.activeElement as HTMLElement).dataset['todo'] as string;
    expect(placeOf(wrapper, first).y).toBeLessThanOrEqual(Math.min(...tops) + 30);
    await press(wrapper, first, 'End');
    const last = (document.activeElement as HTMLElement).dataset['todo'] as string;
    expect(placeOf(wrapper, last).y).toBeGreaterThanOrEqual(Math.max(...tops) - 30);
  });

  it('Enter opens the detail and Escape closes it', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await press(wrapper, id, 'Enter');
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(card());
    await press(wrapper, id, 'Escape');
    expect(card()).toBeNull();
  });

  it('v files into a folder: a menu of the inbox, the folders and a new one', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await press(wrapper, id, 'v');
    const picker = dialog('[data-folder-picker]');
    expect(picker.getAttribute('role')).toBe('menu');
    expect([...picker.querySelectorAll('[role="menuitem"] .pond-picker-name')].map((item) => item.textContent?.trim())).toEqual([
      '인박스 (폴더 밖)',
      '졸업 논문',
      '새 폴더 만들기',
    ]);
    expect(picker.querySelector('[data-folder-pick="inbox"] .pond-picker-here')?.textContent).toBe('지금 여기');
    // Where it already is cannot be picked.
    expect((picker.querySelector('[data-folder-pick="inbox"]') as HTMLButtonElement).disabled).toBe(true);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-folder-pick')).toBe(SAMPLE_PROJECT_ID));

    (picker.querySelector(`[data-folder-pick="${SAMPLE_PROJECT_ID}"]`) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(task(id).projectId).toBe(SAMPLE_PROJECT_ID));
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([['PATCH', `/tasks/${id}`, { projectId: SAMPLE_PROJECT_ID }]]);
    await vi.waitFor(() => expect(todo(wrapper, id).attributes('data-folder')).toBe(SAMPLE_PROJECT_ID));
    expect(document.body.querySelector('[data-folder-picker]')).toBeNull();
    await vi.waitFor(() => expect(wrapper.get('[data-canvas-status]').text()).toBe('할 일 1개를 “졸업 논문” 폴더로 옮겼어요.'));
  });

  it('Alt+arrow moves a to-do, and where it lands is remembered', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    const before = placeOf(wrapper, id);
    await press(wrapper, id, 'ArrowRight', { altKey: true });
    const after = placeOf(wrapper, id);
    expect(after.x - before.x).toBeGreaterThan(10);
    expect(wrapper.get('[data-canvas-status]').text()).toBe('자리를 옮겼어요.');
    await vi.waitFor(() => expect(storedMemory().places[id]).toBeDefined());
    // The focus did not move: the to-do did.
    expect(document.activeElement).toBe(todo(wrapper, id).element);
  });

  it('keys the app owns are left alone: n, t and / are not canvas shortcuts (negative)', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    for (const key of ['n', 't', '/', 'o', 'p', 'm', 'f', '?']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      (todo(wrapper, id).element as HTMLElement).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(card()).toBeNull();
    expect(document.body.querySelector('[data-folder-picker]')).toBeNull();
  });
});

describe('folders: dishes on the surface, and real projects', () => {
  it('draws a dish for each folder with its name and count, and none for the inbox', async () => {
    const { wrapper } = await mountCanvas();
    const dishes = wrapper.findAll('[data-folder-dish]');
    expect(dishes.map((dish) => dish.attributes('data-folder-dish'))).toEqual([SAMPLE_PROJECT_ID]);
    expect(dishes[0]?.attributes('aria-label')).toBe('폴더 졸업 논문');
    expect(dishes[0]?.get('[data-folder-name]').text()).toBe('졸업 논문');
    expect(dishes[0]?.findAll('[data-folder-count] > span').map((part) => part.text())).toEqual(['2', '할 일 2개']);
    // The inbox is the open water: no dish, no label, no rename.
    expect(wrapper.find(`[data-folder-dish="${INBOX_PROJECT_ID}"]`).exists()).toBe(false);
  });

  it('an archived folder is not drawn, and neither is anything in it (the mock still lists both)', async () => {
    const sample = mockDb.projects.get(SAMPLE_PROJECT_ID);
    if (sample === undefined) throw new Error('missing');
    mockDb.projects.set(sample.id, { ...sample, archived: true });
    const { wrapper } = await mountCanvas();
    expect(wrapper.findAll('[data-folder-dish]')).toHaveLength(0);
    expect(options(wrapper)).toHaveLength(6);
    expect(wrapper.find(`[data-todo="${MONTH_TASK_THESIS_ID}"]`).exists()).toBe(false);
    expect(wrapper.get('[data-tasks-summary]').text()).toBe('열린 할 일 6개');
  });

  it('dragging a to-do into a dish files it: its project becomes the folder', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    const dish = boxOf(wrapper, SAMPLE_PROJECT_ID);
    const stage = wrapper.get('[data-todo-canvas]').element;
    const at = placeOf(wrapper, id);
    const inside = { x: dish.left + dish.width / 2, y: dish.top + dish.height / 2 + 20 };
    pointer(todo(wrapper, id).element, 'pointerdown', { x: at.x + 8, y: at.y + 8 });
    pointer(stage, 'pointermove', inside);
    await nextTick();
    // In the hand over the dish: the dish says it will take it.
    expect(wrapper.get(`[data-folder-dish="${SAMPLE_PROJECT_ID}"]`).classes()).toContain('pond-folder--drop');
    expect(todo(wrapper, id).attributes('data-state')).toBe('held');
    pointer(stage, 'pointerup', inside);
    await flushPromises();
    await vi.waitFor(() => expect(task(id).projectId).toBe(SAMPLE_PROJECT_ID));
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([['PATCH', `/tasks/${id}`, { projectId: SAMPLE_PROJECT_ID }]]);
    await vi.waitFor(() => expect(todo(wrapper, id).attributes('data-folder')).toBe(SAMPLE_PROJECT_ID));
    expect(wrapper.get(`[data-folder-dish="${SAMPLE_PROJECT_ID}"]`).classes()).not.toContain('pond-folder--drop');
    // It is inside the dish now.
    expect(inDish(placeOf(wrapper, id), boxOf(wrapper, SAMPLE_PROJECT_ID))).toBe(true);
    await vi.waitFor(() => expect(wrapper.get(`[data-folder-dish="${SAMPLE_PROJECT_ID}"] [data-folder-count]`).text()).toContain('3'));
  });

  it('dragging it out onto the open water files it back into the inbox', async () => {
    const { wrapper } = await mountCanvas();
    await drag(wrapper, MONTH_TASK_REPORT_ID, { x: 80, y: 80 });
    await vi.waitFor(() => expect(task(MONTH_TASK_REPORT_ID).projectId).toBe(INBOX_PROJECT_ID));
    await vi.waitFor(() => expect(todo(wrapper, MONTH_TASK_REPORT_ID).attributes('data-folder')).toBe('inbox'));
    await vi.waitFor(() => expect(wrapper.get('[data-canvas-status]').text()).toBe('할 일 1개를 인박스로 꺼냈어요.'));
  });

  it('a to-do the server would not file comes back to where it was (negative)', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    server.use(http.patch(`*/api/v1/tasks/${id}`, () => HttpResponse.json({ type: 'about:blank', title: 'x', status: 500, code: 'internal', detail: 'x' }, { status: 500 })));
    const dish = boxOf(wrapper, SAMPLE_PROJECT_ID);
    await drag(wrapper, id, { x: dish.left + dish.width / 2, y: dish.top + dish.height / 2 + 20 });
    await vi.waitFor(() => expect(wrapper.find('[data-tasks-error]').exists()).toBe(true));
    await vi.waitFor(() => expect(todo(wrapper, id).attributes('data-folder')).toBe('inbox'));
    expect(task(id).projectId).toBe(INBOX_PROJECT_ID);
    // Back on the open water, outside the dish.
    await vi.waitFor(() => expect(inDish(placeOf(wrapper, id), dish)).toBe(false));
  });

  it('filed things are put away: smaller, in the folder’s own group', async () => {
    const { wrapper } = await mountCanvas();
    expect(todo(wrapper, MONTH_TASK_THESIS_ID).attributes('data-filed')).toBe('true');
    expect(todo(wrapper, seedTaskId()).attributes('data-filed')).toBeUndefined();
    const dish = boxOf(wrapper, SAMPLE_PROJECT_ID);
    for (const id of [MONTH_TASK_THESIS_ID, MONTH_TASK_REPORT_ID]) {
      const at = placeOf(wrapper, id);
      expect(at.x).toBeGreaterThanOrEqual(dish.left);
      expect(at.x).toBeLessThan(dish.left + dish.width);
      expect(at.y).toBeGreaterThanOrEqual(dish.top + 40);
      expect(at.y).toBeLessThan(dish.top + dish.height);
    }
    // …and the open water's to-dos keep out of the dish.
    for (const id of options(wrapper).filter((item) => todo(wrapper, item).attributes('data-folder') === 'inbox')) {
      expect(placeOf(wrapper, id).x).toBeLessThan(dish.left);
    }
  });

  it('폴더 만들기 makes a labelled dish with the existing route', async () => {
    const { wrapper, pinia } = await mountCanvas();
    await wrapper.get('[data-new-folder]').trigger('click');
    const form = dialog('[data-new-folder-dialog]');
    expect(form.textContent).toContain('새 폴더');
    // The dialog's own filled button waits for a name.
    expect((form.querySelector('[data-new-folder-submit]') as HTMLButtonElement).disabled).toBe(true);
    await setInput(form.querySelector('[data-new-folder-name]'), '세미나');
    form.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(wrapper.findAll('[data-folder-dish]')).toHaveLength(2));
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([['POST', '/projects', { title: '세미나' }]]);
    expect(wrapper.findAll('[data-folder-name]').map((name) => name.text())).toEqual(['졸업 논문', '세미나']);
    expect(document.body.querySelector('[data-new-folder-dialog]')).toBeNull();
    expect(useToastStore(pinia).toasts.map((item) => item.message)).toEqual(['“세미나” 폴더를 만들었어요.']);
    expect(wrapper.findAll('[data-tasks-summary] > span').map((part) => part.text())).toEqual(['열린 할 일 8개', '폴더 2개']);
  });

  it('a new folder asked for from the picker takes what was picked with it', async () => {
    const { wrapper } = await mountCanvas();
    const id = seedTaskId();
    await press(wrapper, id, 'v');
    (dialog('[data-folder-picker]').querySelector('[data-folder-pick="new"]') as HTMLButtonElement).click();
    await nextTick();
    const form = dialog('[data-new-folder-dialog]');
    await setInput(form.querySelector('[data-new-folder-name]'), '집안일');
    form.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(task(id).projectId).not.toBe(INBOX_PROJECT_ID));
    const created = [...mockDb.projects.values()].find((item) => item.title === '집안일');
    expect(task(id).projectId).toBe(created?.id);
    expect(mutations()).toEqual(['POST /projects', `PATCH /tasks/${id}`]);
    await vi.waitFor(() => expect(todo(wrapper, id).attributes('data-folder')).toBe(created?.id));
  });

  it('renames in place on the folder’s label', async () => {
    const { wrapper } = await mountCanvas();
    const name = wrapper.get(`[data-folder-name="${SAMPLE_PROJECT_ID}"]`);
    expect(name.attributes('aria-label')).toBe('졸업 논문 폴더 이름 바꾸기');
    await name.trigger('click');
    const input = wrapper.get(`[data-folder-rename="${SAMPLE_PROJECT_ID}"]`);
    expect((input.element as HTMLInputElement).value).toBe('졸업 논문');
    expect(input.attributes('aria-label')).toBe('폴더 이름');
    await input.setValue('학위 논문');
    await wrapper.get('form.pond-folder-rename').trigger('submit');
    await vi.waitFor(() => expect(wrapper.find(`[data-folder-rename="${SAMPLE_PROJECT_ID}"]`).exists()).toBe(false));
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([['PATCH', `/projects/${SAMPLE_PROJECT_ID}`, { title: '학위 논문' }]]);
    await vi.waitFor(() => expect(wrapper.get(`[data-folder-name="${SAMPLE_PROJECT_ID}"]`).text()).toBe('학위 논문'));
    // The group the to-dos are in is named after it too.
    expect(wrapper.get(`[data-canvas-group="${SAMPLE_PROJECT_ID}"]`).attributes('aria-label')).toBe('폴더 학위 논문');
  });

  it('Escape leaves the name as it was, and an unchanged name sends nothing (negative)', async () => {
    const { wrapper } = await mountCanvas();
    await wrapper.get(`[data-folder-name="${SAMPLE_PROJECT_ID}"]`).trigger('click');
    await wrapper.get(`[data-folder-rename="${SAMPLE_PROJECT_ID}"]`).setValue('버릴 이름');
    await wrapper.get(`[data-folder-rename="${SAMPLE_PROJECT_ID}"]`).trigger('keydown', { key: 'Escape' });
    expect(wrapper.find(`[data-folder-rename="${SAMPLE_PROJECT_ID}"]`).exists()).toBe(false);
    expect(wrapper.get(`[data-folder-name="${SAMPLE_PROJECT_ID}"]`).text()).toBe('졸업 논문');

    await wrapper.get(`[data-folder-name="${SAMPLE_PROJECT_ID}"]`).trigger('click');
    await wrapper.get('form.pond-folder-rename').trigger('submit');
    await flushPromises();
    expect(seen).toEqual([]);
  });

  it('folds to one object with its count, and opens again; which folders are folded is remembered', async () => {
    const { wrapper } = await mountCanvas();
    const fold = wrapper.get(`[data-folder-fold="${SAMPLE_PROJECT_ID}"]`);
    expect(fold.attributes('aria-label')).toBe('졸업 논문 폴더 접기');
    await fold.trigger('click');
    await flushPromises();
    const dish = wrapper.get(`[data-folder-dish="${SAMPLE_PROJECT_ID}"]`);
    expect(dish.attributes('data-folded')).toBe('true');
    const unfold = wrapper.get(`[data-folder-unfold="${SAMPLE_PROJECT_ID}"]`);
    expect(unfold.attributes('aria-label')).toBe('졸업 논문 폴더 펼치기, 할 일 2개');
    expect(unfold.findAll('span').map((part) => part.text()).filter((text) => text.length > 0)).toEqual(['졸업 논문', '2']);
    // What is in a folded folder is not on the surface (it is still in the list view, and counted).
    expect(wrapper.find(`[data-todo="${MONTH_TASK_THESIS_ID}"]`).exists()).toBe(false);
    expect(options(wrapper)).toHaveLength(6);
    expect(wrapper.get('[role="listbox"]').attributes('aria-label')).toBe('할 일 캔버스, 열린 할 일 8개');
    expect(storedMemory().folded).toEqual([SAMPLE_PROJECT_ID]);

    await unfold.trigger('click');
    await flushPromises();
    expect(wrapper.find(`[data-todo="${MONTH_TASK_THESIS_ID}"]`).exists()).toBe(true);
    expect(storedMemory().folded).toEqual([]);
  });

  it('a to-do dropped on a folded folder is filed into it', async () => {
    const { wrapper } = await mountCanvas();
    await wrapper.get(`[data-folder-fold="${SAMPLE_PROJECT_ID}"]`).trigger('click');
    await flushPromises();
    const id = seedTaskId();
    const folded = boxOf(wrapper, SAMPLE_PROJECT_ID);
    await drag(wrapper, id, { x: folded.left + 20, y: folded.top + 20 });
    await vi.waitFor(() => expect(task(id).projectId).toBe(SAMPLE_PROJECT_ID));
    await vi.waitFor(() => expect(wrapper.find(`[data-todo="${id}"]`).exists()).toBe(false));
    await vi.waitFor(() => expect(wrapper.get(`[data-folder-unfold="${SAMPLE_PROJECT_ID}"]`).text()).toContain('3'));
  });

  it('the folder’s menu: its to-dos to the plan flow, its page, and 폴더 없애기', async () => {
    const { wrapper } = await mountCanvas();
    const button = wrapper.get(`[data-folder-menu-button="${SAMPLE_PROJECT_ID}"]`);
    expect(button.attributes('aria-haspopup')).toBe('menu');
    expect(button.attributes('aria-expanded')).toBe('false');
    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('true');
    const menu = wrapper.get(`[data-folder-menu="${SAMPLE_PROJECT_ID}"]`);
    expect(menu.findAll('[role="menuitem"]').map((item) => item.text())).toEqual(['이 폴더를 계획에 넣기', '이름 바꾸기', '폴더 페이지 열기', '폴더 없애기']);
    // "이 폴더를 계획에 넣기": the same address a selection travels to.
    const ids = [MONTH_TASK_THESIS_ID, MONTH_TASK_REPORT_ID];
    const href = menu.get('[data-folder-plan]').attributes('href') ?? '';
    expect(href.startsWith('/plan/schedule?taskIds=')).toBe(true);
    expect(href.replace('/plan/schedule?taskIds=', '').split(',').sort()).toEqual([...ids].sort());
    expect(menu.get('[data-folder-open]').attributes('href')).toBe(`/projects/${SAMPLE_PROJECT_ID}`);

    await menu.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find(`[data-folder-menu="${SAMPLE_PROJECT_ID}"]`).exists()).toBe(false);
  });

  it('폴더 없애기 asks first, then empties the folder into the inbox and only then archives it', async () => {
    // A finished to-do in the folder as well: it goes to the inbox too.
    mockDb.tasks.set(MONTH_TASK_SUMMARY_ID, { ...task(MONTH_TASK_SUMMARY_ID), projectId: SAMPLE_PROJECT_ID });
    const { wrapper, pinia } = await mountCanvas();
    await wrapper.get(`[data-folder-menu-button="${SAMPLE_PROJECT_ID}"]`).trigger('click');
    await wrapper.get('[data-folder-remove]').trigger('click');
    const confirm = dialog('[data-remove-folder-dialog]');
    expect(confirm.getAttribute('role')).toBe('alertdialog');
    expect(confirm.textContent).toContain('“졸업 논문” 폴더를 없앨까요?');
    expect(confirm.textContent).toContain('안에 있는 할 일은 지우지 않고 인박스로 옮겨요.');
    // Nothing happens until it is confirmed.
    expect(seen).toEqual([]);

    (confirm.querySelector('[data-remove-folder-confirm]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mockDb.projects.get(SAMPLE_PROJECT_ID)?.archived).toBe(true));
    const order = mutations();
    const moves = [MONTH_TASK_THESIS_ID, MONTH_TASK_REPORT_ID, MONTH_TASK_SUMMARY_ID].map((id) => `PATCH /tasks/${id}`);
    expect(order.slice(0, 3).sort()).toEqual(moves.sort());
    expect(order.slice(3)).toEqual([`PATCH /projects/${SAMPLE_PROJECT_ID}`]);
    expect(seen[3]?.body).toEqual({ archived: true });
    expect(order.some((line) => line.startsWith('DELETE'))).toBe(false);

    // The dish leaves the canvas; its to-dos are on the open water.
    await vi.waitFor(() => expect(wrapper.findAll('[data-folder-dish]')).toHaveLength(0));
    await vi.waitFor(() => expect(todo(wrapper, MONTH_TASK_THESIS_ID).attributes('data-folder')).toBe('inbox'));
    expect(options(wrapper)).toHaveLength(8);
    expect(task(MONTH_TASK_SUMMARY_ID)).toMatchObject({ projectId: INBOX_PROJECT_ID, status: 'done' });
    expect(document.body.querySelector('[data-remove-folder-dialog]')).toBeNull();
    const toast = useToastStore(pinia).toasts;
    expect(toast.map((item) => item.message)).toEqual(['“졸업 논문” 폴더를 없앴어요. 안에 있던 할 일은 인박스에 있어요.']);
    expect(toast[0]?.action?.label).toBe('되돌리기');
  });

  it('되돌리기 brings the folder back first, then its to-dos', async () => {
    const { wrapper, pinia } = await mountCanvas();
    await wrapper.get(`[data-folder-menu-button="${SAMPLE_PROJECT_ID}"]`).trigger('click');
    await wrapper.get('[data-folder-remove]').trigger('click');
    (dialog('[data-remove-folder-dialog]').querySelector('[data-remove-folder-confirm]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(wrapper.findAll('[data-folder-dish]')).toHaveLength(0));
    seen.length = 0;

    const toast = useToastStore(pinia);
    toast.toasts[0]?.action?.handler();
    await vi.waitFor(() => expect(task(MONTH_TASK_THESIS_ID).projectId).toBe(SAMPLE_PROJECT_ID));
    await vi.waitFor(() => expect(task(MONTH_TASK_REPORT_ID).projectId).toBe(SAMPLE_PROJECT_ID));
    const order = mutations();
    expect(order[0]).toBe(`PATCH /projects/${SAMPLE_PROJECT_ID}`);
    expect(seen[0]?.body).toEqual({ archived: false });
    expect(order.slice(1).sort()).toEqual([`PATCH /tasks/${MONTH_TASK_REPORT_ID}`, `PATCH /tasks/${MONTH_TASK_THESIS_ID}`].sort());
    expect(mockDb.projects.get(SAMPLE_PROJECT_ID)?.archived).toBe(false);
    await vi.waitFor(() => expect(wrapper.findAll('[data-folder-dish]')).toHaveLength(1));
    await vi.waitFor(() => expect(todo(wrapper, MONTH_TASK_THESIS_ID).attributes('data-folder')).toBe(SAMPLE_PROJECT_ID));
    await vi.waitFor(() => expect(toast.toasts.map((item) => item.message)).toContain('“졸업 논문” 폴더를 되돌렸어요.'));
  });

  it('a folder that cannot be emptied stays, and is not archived (negative)', async () => {
    const { wrapper, pinia } = await mountCanvas();
    server.use(
      http.patch(`*/api/v1/tasks/${MONTH_TASK_REPORT_ID}`, () =>
        HttpResponse.json({ type: 'about:blank', title: 'x', status: 503, code: 'provider_unavailable', detail: 'x' }, { status: 503 }),
      ),
    );
    await wrapper.get(`[data-folder-menu-button="${SAMPLE_PROJECT_ID}"]`).trigger('click');
    await wrapper.get('[data-folder-remove]').trigger('click');
    (dialog('[data-remove-folder-dialog]').querySelector('[data-remove-folder-confirm]') as HTMLButtonElement).click();
    const toast = useToastStore(pinia);
    await vi.waitFor(() =>
      expect(toast.toasts.map((item) => item.message)).toEqual(['“졸업 논문” 폴더를 비우다 멈췄어요. 옮기지 못한 할 일이 있어 폴더는 그대로 뒀어요.']),
    );
    expect(toast.toasts[0]?.tone).toBe('error');
    expect(mockDb.projects.get(SAMPLE_PROJECT_ID)?.archived).toBe(false);
    expect(mutations().some((line) => line.startsWith('PATCH /projects'))).toBe(false);
    expect(wrapper.findAll('[data-folder-dish]')).toHaveLength(1);
    expect(task(MONTH_TASK_REPORT_ID).projectId).toBe(SAMPLE_PROJECT_ID);
  });

  it('cancelling the question leaves everything as it was (negative)', async () => {
    const { wrapper } = await mountCanvas();
    await wrapper.get(`[data-folder-menu-button="${SAMPLE_PROJECT_ID}"]`).trigger('click');
    await wrapper.get('[data-folder-remove]').trigger('click');
    const confirm = dialog('[data-remove-folder-dialog]');
    ([...confirm.querySelectorAll('button')].find((button) => button.textContent?.includes('취소')) as HTMLButtonElement).click();
    await nextTick();
    expect(document.body.querySelector('[data-remove-folder-dialog]')).toBeNull();
    expect(seen).toEqual([]);
    expect(wrapper.findAll('[data-folder-dish]')).toHaveLength(1);
  });
});

describe('offline: the surface can be arranged, but nothing is filed, finished or changed', () => {
  async function mountOffline(): Promise<Place> {
    const place = await mountCanvas();
    useOfflineStore(place.pinia).setOnline(false);
    await nextTick();
    return place;
  }

  it('says so, and a to-do dropped on a folder is not filed (negative)', async () => {
    const { wrapper } = await mountOffline();
    expect(wrapper.get('.offline-note').text()).toBe('오프라인 · 읽기 전용');
    const id = seedTaskId();
    const dish = boxOf(wrapper, SAMPLE_PROJECT_ID);
    await drag(wrapper, id, { x: dish.left + dish.width / 2, y: dish.top + dish.height / 2 + 20 });
    await flushPromises();
    expect(seen).toEqual([]);
    expect(task(id).projectId).toBe(INBOX_PROJECT_ID);
    expect(todo(wrapper, id).attributes('data-folder')).toBe('inbox');
    // It is drawn back out of the dish.
    expect(inDish(placeOf(wrapper, id), dish)).toBe(false);
  });

  it('moving a to-do on the open water still works: where things are is this device’s', async () => {
    const { wrapper } = await mountOffline();
    const id = seedTaskId();
    const before = placeOf(wrapper, id);
    await drag(wrapper, id, { x: 130, y: 570 });
    expect(placeOf(wrapper, id).text).not.toBe(before.text);
    await vi.waitFor(() => expect(storedMemory().places[id]).toBeDefined());
    expect(seen).toEqual([]);
  });

  it('the detail reads only: no rename, no deadline, no folder, no 완료, no 삭제 (negative)', async () => {
    const { wrapper } = await mountOffline();
    await click(wrapper, seedTaskId());
    const panel = card() as HTMLElement;
    expect(panel.querySelector('[data-todo-card-offline]')?.textContent).toBe('오프라인이라 지금은 고칠 수 없어요.');
    for (const selector of ['[data-todo-card-title]', '[data-todo-card-due-toggle]', '[data-todo-card-folder-select]', '[data-todo-card-complete]', '[data-todo-card-remove]', '[data-todo-card-focus]']) {
      expect((panel.querySelector(selector) as HTMLButtonElement).disabled, selector).toBe(true);
    }
    (panel.querySelector('[data-todo-card-complete]') as HTMLButtonElement).click();
    await flushPromises();
    expect(seen).toEqual([]);
    // Reading on is still possible.
    expect(panel.querySelector('[data-todo-card-open]')?.getAttribute('href')).toContain('/tasks/');
  });

  it('nothing is filed by the keyboard, no folder is made, renamed or removed (negative)', async () => {
    const { wrapper } = await mountOffline();
    const id = seedTaskId();
    await press(wrapper, id, 'v');
    expect(document.body.querySelector('[data-folder-picker]')).toBeNull();
    expect((wrapper.get('[data-new-folder]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.get(`[data-folder-name="${SAMPLE_PROJECT_ID}"]`).element as HTMLButtonElement).disabled).toBe(true);
    await click(wrapper, id, { shiftKey: true });
    expect((wrapper.get('[data-canvas-selection-complete]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.get('[data-canvas-selection-move]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get(`[data-folder-menu-button="${SAMPLE_PROJECT_ID}"]`).trigger('click');
    expect((wrapper.get('[data-folder-remove]').element as HTMLButtonElement).disabled).toBe(true);
    expect(seen).toEqual([]);
  });
});

describe('many, none, and newly arrived', () => {
  it('two hundred to-dos do not become noise: the most urgent are shown and the rest are one "N개 더"', async () => {
    seedCanvas(mockDb, { extra: 170 });
    const { wrapper } = await mountCanvas();
    const stage = wrapper.get('[data-todo-canvas]');
    expect(stage.attributes('data-density')).toBe('compact');
    const open = [...mockDb.tasks.values()].filter((item) => item.status !== 'done' && item.projectId === INBOX_PROJECT_ID).length;
    expect(open).toBeGreaterThan(180);
    const drawn = wrapper.findAll('[data-canvas-group="inbox"] [role="option"]').length;
    expect(drawn).toBeGreaterThan(40);
    expect(drawn).toBeLessThan(open);
    expect(wrapper.get('[data-canvas-more-button]').text()).toBe(`${open - drawn}개 더 보기`);
    expect(wrapper.get('[data-canvas-more]').text()).toContain('마감이 가까운 것부터 보여 드리고 있어요.');
    // The overdue one is among those shown.
    expect(wrapper.find(`[data-todo="${MONTH_TASK_ENGLISH_ID}"]`).exists()).toBe(true);

    const before = parseFloat((stage.element as HTMLElement).style.height);
    await wrapper.get('[data-canvas-more-button]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.findAll('[data-canvas-group="inbox"] [role="option"]')).toHaveLength(open));
    expect(parseFloat((stage.element as HTMLElement).style.height)).toBeGreaterThan(before);
    expect(wrapper.find('[data-canvas-more-button]').exists()).toBe(false);

    await wrapper.get('[data-canvas-less-button]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.findAll('[data-canvas-group="inbox"] [role="option"]')).toHaveLength(drawn));
  });

  it('a few to-dos float at full size, with nothing held back (negative)', async () => {
    const { wrapper } = await mountCanvas();
    expect(wrapper.get('[data-todo-canvas]').attributes('data-density')).toBe('airy');
    expect(wrapper.find('[data-canvas-more]').exists()).toBe(false);
    expect(wrapper.find('[data-canvas-less]').exists()).toBe(false);
  });

  it('an empty surface leads back a stage: the capture bar is the invitation, and its button the one filled', async () => {
    for (const id of [...mockDb.tasks.keys()]) mockDb.tasks.delete(id);
    const { wrapper, pinia } = await mountCanvas();
    const empty = wrapper.get('[data-canvas-empty]');
    expect(empty.text()).toContain('수면이 비어 있어요');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.find('[data-tasks-to-plan]').exists()).toBe(false);
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['할 일 담기']);
    const ui = useUiStore(pinia);
    const asked = ui.captureRequest;
    await wrapper.get('[data-canvas-capture]').trigger('click');
    expect(ui.captureRequest).toBe(asked + 1);
    expect(ui.captureMode).toBe('capture');
    // The folder is still there, empty.
    expect(wrapper.findAll('[data-folder-dish]')).toHaveLength(1);
  });

  it('a to-do put down while the canvas is open is seen arriving', async () => {
    const { wrapper, queryClient } = await mountCanvas();
    expect(wrapper.find('[data-state="arriving"]').exists()).toBe(false);
    const arrival: Task = { ...task(seedTaskId()), id: '01900000-0000-7000-8000-0000000009c1', title: '방금 담은 일', version: 1 };
    mockDb.tasks.set(arrival.id, arrival);
    mockDb.taskRevision += 1;
    // What the capture bar does when it has added something.
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    await vi.waitFor(() => expect(wrapper.find(`[data-todo="${arrival.id}"]`).exists()).toBe(true));
    expect(todo(wrapper, arrival.id).attributes('data-state')).toBe('arriving');
    expect(wrapper.get('[data-canvas-status]').text()).toBe('“방금 담은 일” 할 일이 떠올랐어요.');
    // It was given a place of its own, on top of nothing.
    const at = placeOf(wrapper, arrival.id);
    for (const id of options(wrapper).filter((item) => item !== arrival.id)) {
      const other = placeOf(wrapper, id);
      expect(Math.abs(other.x - at.x) > 20 || Math.abs(other.y - at.y) > 20).toBe(true);
    }
    await vi.waitFor(() => expect(todo(wrapper, arrival.id).attributes('data-state')).toBeUndefined(), { timeout: 3000 });
  });

  it('what was there when the canvas opened does not "arrive" (negative)', async () => {
    const { wrapper } = await mountCanvas();
    expect(wrapper.findAll('[data-state="arriving"]')).toHaveLength(0);
    expect(wrapper.get('[data-canvas-status]').text()).toBe('');
  });

  it('says so when the list cannot be read, and reads again on retry', async () => {
    let fail = true;
    server.use(
      http.get('*/api/v1/tasks', () =>
        fail ? HttpResponse.json({ type: 'about:blank', title: 'x', status: 403, code: 'forbidden', detail: 'x' }, { status: 403 }) : undefined,
      ),
    );
    const { wrapper } = await mountPlace();
    await vi.waitFor(() => expect(wrapper.text()).toContain('할 일을 불러오지 못했어요.'));
    expect(wrapper.find('[data-todo-canvas]').exists()).toBe(false);
    fail = false;
    const retry = wrapper.findAll('button').find((button) => button.text().includes('다시 시도'));
    await retry?.trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-todo-canvas]').exists()).toBe(true));
  });
});

describe('목록으로 보기: rows, for anyone who wants them', () => {
  it('a visible switch names the two views; 목록 shows the same to-dos as rows, folder by folder', async () => {
    const { wrapper, router } = await mountCanvas();
    const links = wrapper.findAll('[data-tasks-view-link]');
    expect(wrapper.get('.tasks-views').attributes('aria-label')).toBe('할 일 보기');
    expect(links.map((link) => [link.text(), link.attributes('aria-label'), link.attributes('aria-current')])).toEqual([
      ['캔버스', '캔버스로 보기', 'page'],
      ['목록', '목록으로 보기', undefined],
    ]);
    await wrapper.get('[data-tasks-view-link="list"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-tasks-list]').exists()).toBe(true));
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/tasks?view=list'));
    expect(wrapper.get('[data-tasks-place]').attributes('data-tasks-view')).toBe('list');
    expect(wrapper.find('[data-todo-canvas]').exists()).toBe(false);
    expect(wrapper.get('[data-tasks-view-link="list"]').attributes('aria-current')).toBe('page');

    // The inbox with its quick add, then the folder as a section of its own.
    await vi.waitFor(() => expect(wrapper.findAll('[data-inbox] li.task-item')).toHaveLength(7));
    expect(wrapper.find('[data-inbox] form.quick-add').exists()).toBe(true);
    expect(wrapper.findAll('h2.todo-list-title').map((heading) => heading.text())).toEqual(['인박스', '졸업 논문']);
    const folder = wrapper.get(`[data-list-folder="${SAMPLE_PROJECT_ID}"]`);
    expect(folder.findAll('li.task-item')).toHaveLength(2);
    expect(folder.get('[data-list-folder-link]').attributes('href')).toBe(`/projects/${SAMPLE_PROJECT_ID}`);
    expect(folder.get('[data-list-folder-count]').text()).toBe('열린 작업 2개');
    // One page heading still, and in the list the plan link is not the filled button: the quick add keeps that.
    expect(wrapper.findAll('h1').map((heading) => heading.text())).toEqual(['할 일']);
    expect(wrapper.get('[data-tasks-to-plan]').classes()).not.toContain('btn--primary');
    expect(wrapper.get('[data-tasks-to-plan]').attributes('href')).toBe('/plan/schedule');
  });

  it('the choice is remembered for this owner, and the address can still ask for the other', async () => {
    const first = await mountCanvas();
    await first.wrapper.get('[data-tasks-view-link="list"]').trigger('click');
    await vi.waitFor(() => expect(first.wrapper.find('[data-tasks-list]').exists()).toBe(true));
    expect(storedMemory().view).toBe('list');
    first.wrapper.unmount();
    mounted.length = 0;

    const again = await mountPlace('/tasks');
    expect(again.wrapper.get('[data-tasks-place]').attributes('data-tasks-view')).toBe('list');
    again.wrapper.unmount();
    mounted.length = 0;

    const asked = await mountPlace('/tasks?view=canvas');
    expect(asked.wrapper.get('[data-tasks-place]').attributes('data-tasks-view')).toBe('canvas');
    await asked.wrapper.get('[data-tasks-view-link="canvas"]').trigger('click');
    expect(storedMemory().view).toBe('canvas');
  });

  it('another owner starts on the canvas (negative)', async () => {
    localStorage.setItem(canvasMemoryKey(OWNER_B), serializeCanvasMemory({ ...EMPTY_CANVAS_MEMORY, view: 'list' }));
    const { wrapper } = await mountPlace('/tasks');
    expect(wrapper.get('[data-tasks-place]').attributes('data-tasks-view')).toBe('canvas');
  });

  it('a view it does not know is the canvas, and the old project list lands on it (negative)', async () => {
    const unknown = await mountPlace('/tasks?view=board');
    expect(unknown.wrapper.get('[data-tasks-place]').attributes('data-tasks-view')).toBe('canvas');
    unknown.wrapper.unmount();
    mounted.length = 0;
    const projects = await mountPlace('/tasks?view=projects');
    expect(projects.wrapper.get('[data-tasks-place]').attributes('data-tasks-view')).toBe('canvas');
  });

  it('a row is finished in the list and the folder section shows it done', async () => {
    const { wrapper } = await mountPlace('/tasks?view=list');
    const folder = await vi.waitFor(() => wrapper.get(`[data-list-folder="${SAMPLE_PROJECT_ID}"]`));
    await vi.waitFor(() => expect(folder.findAll('li.task-item')).toHaveLength(2));
    const complete = folder.findAll('button').find((button) => button.attributes('aria-label') === '실험 보고서 완료로 표시');
    await complete?.trigger('click');
    await vi.waitFor(() => expect(task(MONTH_TASK_REPORT_ID).status).toBe('done'));
    await vi.waitFor(() => expect(folder.get('[data-list-folder-count]').text()).toBe('열린 작업 1개'));
  });
});

describe('what the canvas remembers: owner-scoped storage only', () => {
  it('is a declared owner slot that keeps ids and numbers, and survives an owner change for that owner', () => {
    const slot = OWNER_STORAGE_MANIFEST.ownerSlots.todoCanvas;
    expect(slot).toMatchObject({ area: 'local', staleWrites: 'drop', onOwnerChange: 'preserve' });
    expect(canvasMemoryKey(OWNER_B)).toBe(`${slot.prefix}:${OWNER_B}`);
  });

  it('reads back what it wrote, rounded, for the owner who wrote it', () => {
    const binding = captureOwnerBinding();
    const memory = { places: { a: { u: 0.123456, v: 0.5 } }, folders: { f: { u: 1, v: 0 } }, folded: ['f'], view: 'list' as const };
    expect(writeCanvasMemory(binding, memory)).toBe(true);
    expect(readCanvasMemory(mockDb.user.id)).toEqual({ places: { a: { u: 0.1235, v: 0.5 } }, folders: { f: { u: 1, v: 0 } }, folded: ['f'], view: 'list' });
    expect(readCanvasMemory(OWNER_B)).toEqual(EMPTY_CANVAS_MEMORY);
  });

  it('a write under a stale owner binding stores nothing (negative)', () => {
    const binding = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'login');
    expect(writeCanvasMemory(binding, { ...EMPTY_CANVAS_MEMORY, view: 'list' })).toBe(false);
    expect(localStorage.getItem(canvasMemoryKey(OWNER_B))).toBeNull();
    expect(localStorage.getItem(canvasMemoryKey(mockDb.user.id))).toBeNull();
  });

  it('reads anything that is not a memory as an empty one (negative)', () => {
    expect(parseCanvasMemory(null)).toEqual(EMPTY_CANVAS_MEMORY);
    expect(parseCanvasMemory('not json')).toEqual(EMPTY_CANVAS_MEMORY);
    expect(parseCanvasMemory('[1,2]')).toEqual(EMPTY_CANVAS_MEMORY);
    expect(
      parseCanvasMemory(
        JSON.stringify({
          places: { ok: { u: 0.2, v: 0.8 }, far: { u: 4, v: 0 }, text: { u: 'a', v: 0 }, nan: { u: null, v: 1 }, bare: 3 },
          folders: 'no',
          folded: ['f', 7, null],
          view: 'grid',
        }),
      ),
    ).toEqual({ places: { ok: { u: 0.2, v: 0.8 } }, folders: {}, folded: ['f'], view: 'canvas' });
  });

  it('forgets what is no longer there, and never keeps more than its limit', () => {
    const memory = { places: { a: { u: 0.1, v: 0.1 }, gone: { u: 0.2, v: 0.2 } }, folders: { f: { u: 0.5, v: 0.5 }, old: { u: 0.1, v: 0.1 } }, folded: ['f', 'old'], view: 'canvas' as const };
    expect(pruneCanvasMemory(memory, { tasks: new Set(['a']), folders: new Set(['f']) })).toEqual({
      places: { a: { u: 0.1, v: 0.1 } },
      folders: { f: { u: 0.5, v: 0.5 } },
      folded: ['f'],
      view: 'canvas',
    });
    const many: Record<string, { u: number; v: number }> = {};
    for (let index = 0; index < CANVAS_MEMORY_LIMIT + 50; index += 1) many[`t${index}`] = { u: 0.5, v: 0.5 };
    const kept = parseCanvasMemory(serializeCanvasMemory({ ...EMPTY_CANVAS_MEMORY, places: many }));
    expect(Object.keys(kept.places)).toHaveLength(CANVAS_MEMORY_LIMIT);
    // The newest are the ones kept.
    expect(kept.places[`t${CANVAS_MEMORY_LIMIT + 49}`]).toBeDefined();
    expect(kept.places['t0']).toBeUndefined();
  });

  it('finished to-dos are forgotten when the canvas next writes', async () => {
    localStorage.setItem(
      canvasMemoryKey(mockDb.user.id),
      serializeCanvasMemory({ ...EMPTY_CANVAS_MEMORY, places: { [MONTH_TASK_SUMMARY_ID]: { u: 0.5, v: 0.5 }, 'long-gone': { u: 0.1, v: 0.1 } } }),
    );
    const { wrapper } = await mountCanvas();
    await drag(wrapper, TODAY_TASK_TWO_ID, { x: 150, y: 600 });
    await vi.waitFor(() => expect(storedMemory().places[TODAY_TASK_TWO_ID]).toBeDefined());
    expect(storedMemory().places[MONTH_TASK_SUMMARY_ID]).toBeUndefined();
    expect(storedMemory().places['long-gone']).toBeUndefined();
  });
});
