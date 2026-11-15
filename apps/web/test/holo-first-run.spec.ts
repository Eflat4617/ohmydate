import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { HttpResponse, http } from 'msw';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plannerClient, type User } from '../src/api';
import AppShell from '../src/components/AppShell.vue';
import SetupCard from '../src/components/overview/SetupCard.vue';
import {
  FIRST_RUN_STEPS,
  firstRunKey,
  firstRunStates,
  readFirstRun,
  useFirstRun,
  writeFirstRun,
  type FirstRunRecord,
} from '../src/composables/firstRun';
import { mockDb } from '../src/mocks/db';
import { seedNewOwner } from '../src/mocks/first-run-seed';
import { seedGoogle } from '../src/mocks/google';
import { server } from '../src/mocks/server';
import { routes } from '../src/router';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';
import { OWNER_STORAGE_MANIFEST } from '../src/session/ownerStorage';
import { useLlmConsentStore } from '../src/stores/llmConsent';
import { useUiStore } from '../src/stores/ui';

/**
 * HOLO-04 처음 한 번 (FLOW.md §3): a new owner is met by a three-step guide —
 * when can you work, any fixed appointments, should the AI help — each step
 * skippable and resumable, ending in 담기. While it is not over 개요 keeps a
 * "시작 마무리" card; a returning owner never sees the guide.
 */
const OTHER_OWNER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b77';
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];

function shellRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: routes
      .filter((route) => typeof route.name === 'string')
      .map((route) => ({ path: route.path, name: route.name as string, component: Stub })),
  });
}

/** The settings route as the real server answers it: the consent the owner gave is stored. */
function settingsEndpoint(): { calls: { body: unknown; ifMatch: string | null }[] } {
  const calls: { body: unknown; ifMatch: string | null }[] = [];
  server.use(
    http.patch('*/api/v1/me/settings', async ({ request }) => {
      const body = (await request.json()) as { llm?: { consent?: { granted?: boolean } } };
      calls.push({ body, ifMatch: request.headers.get('If-Match') });
      const next: User = {
        ...mockDb.user,
        version: mockDb.user.version + 1,
        llm: { consent: { granted: body.llm?.consent?.granted === true, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } },
      };
      mockDb.user = next;
      return HttpResponse.json(next as unknown as Record<string, unknown>, { headers: { ETag: `W/"${next.version}"` } });
    }),
  );
  return { calls };
}

interface Shell {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

async function mountShell(path = '/overview', pinia: Pinia = createPinia()): Promise<Shell> {
  const router = shellRouter();
  await router.push(path);
  await router.isReady();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  // 개요's own card, as the page renders it beside the shell's guide.
  const Page = defineComponent({
    setup() {
      const guide = useFirstRun();
      return () => h(SetupCard, { guide });
    },
  });
  const wrapper = mount(AppShell, {
    global: { plugins: [pinia, router, [VueQueryPlugin, { queryClient }]] as never },
    slots: { default: () => h(Page) },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await vi.waitFor(async () => {
    await flushPromises();
    expect(wrapper.find('.app-shell:not(.app-shell--loading)').exists()).toBe(true);
  });
  return { wrapper, router, pinia };
}

const guide = () => document.querySelector<HTMLElement>('[data-first-run]');
const guideStep = () => guide()?.getAttribute('data-first-run-step') ?? null;
const inGuide = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const found = guide()?.querySelector<T>(selector) ?? null;
  if (found === null) throw new Error(`not in the guide: ${selector}`);
  return found;
};

function newOwner(): void {
  seedGoogle(mockDb, 'disconnected');
  seedNewOwner(mockDb);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  adoptActiveOwner(null, 'bootstrap');
  document.body.innerHTML = '';
});

// ── What is left to do ──────────────────────────────────────────────────────

describe('시작 안내 — which steps are left (composables/firstRun.ts)', () => {
  const base = { record: null, ruleCount: 0, commitmentCount: 0, calendarConnected: false, aiUndecided: true };

  it('a step is done when the owner’s own data says so, wherever it was set', () => {
    expect(firstRunStates(base)).toEqual({ hours: 'todo', commitments: 'todo', ai: 'todo' });
    expect(firstRunStates({ ...base, ruleCount: 5 }).hours).toBe('done');
    expect(firstRunStates({ ...base, commitmentCount: 1 }).commitments).toBe('done');
    // A connected calendar answers "any fixed appointments" by itself.
    expect(firstRunStates({ ...base, calendarConnected: true }).commitments).toBe('done');
    // Any answer to the AI question — or a build that needs none — is an answer.
    expect(firstRunStates({ ...base, aiUndecided: false }).ai).toBe('done');
  });

  it('a skipped step is not asked again by the guide, but data wins over a skip', () => {
    const record: FirstRunRecord = { seen: true, skipped: ['hours', 'ai'], ended: false };
    expect(firstRunStates({ ...base, record })).toEqual({ hours: 'skipped', commitments: 'todo', ai: 'skipped' });
    expect(firstRunStates({ ...base, record, ruleCount: 3 }).hours).toBe('done');
  });

  it('says it does not know yet instead of guessing (negative)', () => {
    expect(firstRunStates({ ...base, ruleCount: null, commitmentCount: null })).toEqual({
      hours: 'unknown',
      commitments: 'unknown',
      ai: 'todo',
    });
  });

  it('keeps only step names and flags, per owner, through the owner-scoped storage', () => {
    const owner = mockDb.user.id;
    expect(readFirstRun(owner)).toBeNull();
    expect(writeFirstRun(captureOwnerBinding(), { seen: true, skipped: ['commitments', 'commitments'], ended: false })).toBe(true);
    expect(JSON.parse(localStorage.getItem(firstRunKey(owner)) ?? '{}')).toEqual({ seen: true, skipped: ['commitments'], ended: false });
    expect(firstRunKey(owner)).toBe(`ohmydate.firstRun:${owner}`);
    expect(readFirstRun(OTHER_OWNER)).toBeNull();
    expect(OWNER_STORAGE_MANIFEST.ownerSlots.firstRun).toMatchObject({ area: 'local', staleWrites: 'drop', onOwnerChange: 'preserve' });
    expect(FIRST_RUN_STEPS).toEqual(['hours', 'commitments', 'ai']);
  });

  it('reads junk as nothing, drops step names it does not know, and a stale binding writes nothing (negative)', () => {
    const owner = mockDb.user.id;
    localStorage.setItem(firstRunKey(owner), '{not json');
    expect(readFirstRun(owner)).toBeNull();
    localStorage.setItem(firstRunKey(owner), JSON.stringify({ seen: 'yes', skipped: ['hours', 'everything', 3], ended: 1 }));
    expect(readFirstRun(owner)).toEqual({ seen: false, skipped: ['hours'], ended: false });
    localStorage.removeItem(firstRunKey(owner));

    const stale = captureOwnerBinding();
    adoptActiveOwner(OTHER_OWNER, 'bootstrap');
    expect(writeFirstRun(stale, { seen: true, skipped: [], ended: true })).toBe(false);
    expect(localStorage.getItem(firstRunKey(owner))).toBeNull();
    expect(localStorage.getItem(firstRunKey(OTHER_OWNER))).toBeNull();
  });
});

// ── The guide ───────────────────────────────────────────────────────────────

describe('시작 안내 — a new owner is met by three steps', () => {
  it('opens by itself on the first step, as glass, and holds the consent dialog back', async () => {
    newOwner();
    const { pinia } = await mountShell();
    await vi.waitFor(() => expect(guide()).not.toBeNull());
    expect(guideStep()).toBe('hours');
    expect(guide()?.classList.contains('glass')).toBe(true);
    expect(guide()?.getAttribute('role')).toBe('dialog');
    expect(inGuide('h2').textContent).toBe('언제 일할 수 있나요?');
    const steps = [...(guide()?.querySelectorAll('.first-run-step') ?? [])];
    expect(steps.map((step) => step.querySelector('.first-run-step-name')?.textContent)).toEqual(['일할 수 있는 시간', '고정된 일정', 'AI 도움']);
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual(['step', null, null]);
    // The AI question is the guide's third step, not a second dialog on top of the first (negative).
    expect(useLlmConsentStore(pinia).open).toBe(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    // The record says it has been shown: it will not open by itself again.
    expect(readFirstRun(mockDb.user.id)).toEqual({ seen: true, skipped: [], ended: false });
    // One filled button, inert until hours are picked.
    const filled = [...(guide()?.querySelectorAll('.btn--primary') ?? [])];
    expect(filled).toHaveLength(1);
    expect(filled[0]?.hasAttribute('disabled')).toBe(true);
  });

  it('walks hours → appointments → AI → 담기, saving each answer the way the screens do', async () => {
    newOwner();
    const settings = settingsEndpoint();
    const put = vi.spyOn(plannerClient, 'putAvailability');
    const { pinia } = await mountShell();
    await vi.waitFor(() => expect(guideStep()).toBe('hours'));

    // 1 — a preset, then 저장하고 다음: the hours go out with the version that was read.
    const before = mockDb.availabilityVersion;
    await vi.waitFor(() => expect(inGuide<HTMLInputElement>('[data-preset]').disabled).toBe(false));
    inGuide<HTMLInputElement>('[data-preset]').click();
    await nextTick();
    const next = () => inGuide<HTMLButtonElement>('[data-first-run-next]');
    expect(next().textContent?.trim()).toBe('저장하고 다음');
    await vi.waitFor(() => expect(next().disabled).toBe(false));
    next().click();
    await vi.waitFor(() => expect(guideStep()).toBe('commitments'));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0].rules.length).toBeGreaterThan(0);
    expect(String(put.mock.calls[0]?.[1])).toMatch(/^[0-9a-f-]{36}$/);
    expect(put.mock.calls[0]?.[2]).toBe(before);
    expect(mockDb.availability.rules.length).toBeGreaterThan(0);
    // The first step is ticked.
    expect(inGuide('.first-run-step').getAttribute('data-first-run-state')).toBe('done');

    // 2 — nothing to add: 다음.
    expect(inGuide('h2').textContent).toBe('고정된 일정이 있나요?');
    expect(inGuide('[data-plan-commitment-add]')).not.toBeNull();
    next().click();
    await vi.waitFor(() => expect(guideStep()).toBe('ai'));

    // 3 — what is sent, on one screen; AI 도움 켜기 gives consent through the account's own setting.
    expect(inGuide('[data-first-run-ai]').textContent).toContain('마스킹은 최선 노력이에요');
    expect(next().textContent?.trim()).toBe('AI 도움 켜기');
    next().click();
    await vi.waitFor(() => expect(guideStep()).toBe('ready'));
    expect(settings.calls).toEqual([{ body: { llm: { consent: { granted: true } } }, ifMatch: expect.stringMatching(/^W\//) }]);
    expect(useLlmConsentStore(pinia).needed).toBe(false);

    // The ending is the first stage of the loop.
    expect(inGuide('h2').textContent).toBe('준비됐어요');
    expect(next().textContent?.trim()).toBe('첫 할 일 담기');
    const ui = useUiStore(pinia);
    next().click();
    await vi.waitFor(() => expect(guide()).toBeNull());
    expect(ui.captureRequest).toBe(1);
    expect(readFirstRun(mockDb.user.id)?.ended).toBe(true);
    // And the consent dialog has nothing left to ask.
    expect(document.querySelector('[role="dialog"]:not([data-capture-sheet])')).toBeNull();
  });

  it('every step can be skipped: nothing is sent, and the AI question is not asked again right behind it (negative)', async () => {
    newOwner();
    const settings = settingsEndpoint();
    const put = vi.spyOn(plannerClient, 'putAvailability');
    const { pinia } = await mountShell();
    await vi.waitFor(() => expect(guideStep()).toBe('hours'));
    const skip = () => inGuide<HTMLButtonElement>('[data-first-run-skip]');
    expect(skip().textContent?.trim()).toBe('건너뛰기');
    skip().click();
    await vi.waitFor(() => expect(guideStep()).toBe('commitments'));
    skip().click();
    await vi.waitFor(() => expect(guideStep()).toBe('ai'));
    expect(skip().textContent?.trim()).toBe('나중에');
    skip().click();
    await vi.waitFor(() => expect(guideStep()).toBe('ready'));
    expect(put).not.toHaveBeenCalled();
    expect(settings.calls).toEqual([]);
    expect(mockDb.availability.rules).toEqual([]);
    expect(readFirstRun(mockDb.user.id)?.skipped).toEqual(['hours', 'commitments', 'ai']);

    inGuide<HTMLButtonElement>('[data-first-run-next]').click();
    await vi.waitFor(() => expect(guide()).toBeNull());
    await flushPromises();
    // Still undecided, but "나중에" was an answer for now: no consent dialog pops up behind the guide.
    expect(useLlmConsentStore(pinia).undecided).toBe(true);
    expect(useLlmConsentStore(pinia).open).toBe(false);
  });

  it('a save that lost to another change says so and stays on the step (negative)', async () => {
    newOwner();
    server.use(
      http.put('*/api/v1/availability', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Precondition Failed', status: 412, code: 'availability_changed', detail: 'stale' },
          { status: 412, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    await mountShell();
    await vi.waitFor(() => expect(guideStep()).toBe('hours'));
    await vi.waitFor(() => expect(inGuide<HTMLInputElement>('[data-preset]').disabled).toBe(false));
    inGuide<HTMLInputElement>('[data-preset]').click();
    await nextTick();
    await vi.waitFor(() => expect(inGuide<HTMLButtonElement>('[data-first-run-next]').disabled).toBe(false));
    inGuide<HTMLButtonElement>('[data-first-run-next]').click();
    await vi.waitFor(() => expect(guide()?.querySelector('[data-first-run-error]')).not.toBeNull());
    expect(inGuide('[data-first-run-error]').textContent).toContain('다른 곳에서 가용 시간이 바뀌었어요');
    expect(guideStep()).toBe('hours');
    expect(mockDb.availability.rules).toEqual([]);
  });
});

describe('시작 마무리 — 개요 keeps the rest while the guide is not over', () => {
  it('closing midway keeps what was done; the card resumes at the first step still open', async () => {
    newOwner();
    const { wrapper } = await mountShell();
    await vi.waitFor(() => expect(guideStep()).toBe('hours'));
    inGuide<HTMLButtonElement>('[data-first-run-skip]').click();
    await vi.waitFor(() => expect(guideStep()).toBe('commitments'));
    inGuide<HTMLButtonElement>('[data-first-run-close]').click();
    await vi.waitFor(() => expect(guide()).toBeNull());

    const card = await vi.waitFor(() => wrapper.get('[data-setup-card]'));
    expect(card.get('h2').text()).toBe('시작 마무리');
    expect(card.text()).toContain('2가지가 남았어요');
    expect(card.findAll('[data-setup-step]').map((step) => [step.attributes('data-setup-step'), step.attributes('data-setup-state')])).toEqual([
      ['hours', 'skipped'],
      ['commitments', 'todo'],
      ['ai', 'todo'],
    ]);
    // It is not the page's filled button.
    expect(card.find('.btn--primary').exists()).toBe(false);

    await card.get('[data-setup-resume]').trigger('click');
    await vi.waitFor(() => expect(guideStep()).toBe('commitments'));
  });

  it('“나중에 할게요” ends it for good: no card, and no guide on the next visit', async () => {
    newOwner();
    const first = await mountShell();
    await vi.waitFor(() => expect(guideStep()).toBe('hours'));
    inGuide<HTMLButtonElement>('[data-first-run-close]').click();
    await vi.waitFor(() => expect(guide()).toBeNull());
    await first.wrapper.get('[data-setup-later]').trigger('click');
    await nextTick();
    expect(first.wrapper.find('[data-setup-card]').exists()).toBe(false);
    expect(readFirstRun(mockDb.user.id)?.ended).toBe(true);
    first.wrapper.unmount();
    mounted.length = 0;

    // The next visit: still no hours, but the owner ended it.
    const second = await mountShell();
    await flushPromises();
    await nextTick();
    expect(guide()).toBeNull();
    expect(second.wrapper.find('[data-setup-card]').exists()).toBe(false);
  });
});

describe('시작 안내 — a returning owner never sees it', () => {
  it('does not open for an owner whose hours are set, and shows no card when nothing is left (negative)', async () => {
    // The default mock owner: hours set, 약속 seeded, no AI consent needed.
    const { wrapper } = await mountShell();
    await flushPromises();
    await nextTick();
    expect(guide()).toBeNull();
    expect(wrapper.find('[data-setup-card]').exists()).toBe(false);
    // Nothing was written for them either.
    expect(readFirstRun(mockDb.user.id)).toBeNull();
  });

  it('leaves the consent dialog alone for them: it still opens by itself for an undecided owner', async () => {
    mockDb.user = { ...mockDb.user, llmProvider: 'deepseek', llm: {} };
    const { pinia } = await mountShell();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(guide()).toBeNull();
    expect(useLlmConsentStore(pinia).open).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('AI');
  });

  it('one owner’s record is not another’s: the next owner on this device is asked themselves', async () => {
    newOwner();
    writeFirstRun(captureOwnerBinding(), { seen: true, skipped: [], ended: true });
    expect(readFirstRun(OTHER_OWNER)).toBeNull();
    // The first owner: ended, so nothing opens even with no hours.
    await mountShell();
    await flushPromises();
    expect(guide()).toBeNull();
  });
});
