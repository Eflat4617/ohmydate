/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../src/components/AppShell.vue';
import DisplaySettings from '../src/components/settings/DisplaySettings.vue';
import { CHOSEN_NAME_MAX, cleanChosenName, displayNameFor, initialOf } from '../src/domain/displayName';
import { setLayoutClock } from '../src/layout/clock';
import { mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { DESKTOP_BUILD_MODE } from '../src/platform/mode';
import { routes } from '../src/router';
import { chosenNameKey, readChosenName, resetChosenNameForTests, useChosenName, writeChosenName } from '../src/session/chosenName';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner, captureOwnerBinding, injectOwnerReload, installPageSeal, ownerChanged, resetPageSealForTests } from '../src/session/ownerEpoch';
import { OWNER_STORAGE_MANIFEST } from '../src/session/ownerStorage';
import { useAuthStore } from '../src/stores/auth';
import OverviewView from '../src/views/OverviewView.vue';

/**
 * HOLO-07 (e): the owner chooses what the app calls them. The account has no
 * name field and the server is not asked for one, so the name is typed once
 * on a device (설정 › 화면), kept there per owner, and read by the greeting,
 * the account chip and the avatar's initial. Empty means what it always
 * meant: the part of the e-mail address before the `@`.
 *
 * Every name here is made up. The mock's owner is planner@example.test; its
 * day is 2026-11-14 (Sat) 18:40 in Asia/Seoul.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const OWNER_A = mockDb.user.id;
const OWNER_B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02';
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];
const requests: string[] = [];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, OWNER_A);
  adoptActiveOwner(OWNER_A, 'bootstrap');
  resetChosenNameForTests();
  setLayoutClock({ now: () => NOW });
  requests.length = 0;
  server.events.on('request:start', ({ request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
  });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  server.events.removeAllListeners();
  resetChosenNameForTests();
  setLayoutClock(null);
  vi.unstubAllEnvs();
  adoptActiveOwner(null, 'bootstrap');
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('the rules of a chosen name', () => {
  it('is trimmed, and every run of white space inside it is one space', () => {
    expect(cleanChosenName('  가람  ')).toBe('가람');
    expect(cleanChosenName('한   별')).toBe('한 별');
    expect(cleanChosenName('한\t\n별')).toBe('한 별');
    // No-break and ideographic spaces are white space too.
    expect(cleanChosenName(' 한　별 ')).toBe('한 별');
  });

  it('is at most thirty characters, counted as a person counts them: a longer one is cut there, not refused', () => {
    expect(CHOSEN_NAME_MAX).toBe(30);
    expect(cleanChosenName('가'.repeat(30))).toBe('가'.repeat(30));
    expect(cleanChosenName('가'.repeat(31))).toBe('가'.repeat(30));
    expect(cleanChosenName('a'.repeat(200))).toHaveLength(30);
    // Characters outside the basic plane are one each (two UTF-16 units): thirty stay thirty.
    const stars = '🌟'.repeat(31);
    expect([...cleanChosenName(stars)]).toHaveLength(30);
    expect(cleanChosenName(stars)).toBe('🌟'.repeat(30));
    // The cut never leaves a space at the end.
    expect(cleanChosenName(`${'나'.repeat(29)} 다라`)).toBe('나'.repeat(29));
  });

  it('holds no control characters, and what looks like markup is only its letters', () => {
    expect(cleanChosenName('가\u0000람\u001b')).toBe('가람');
    expect(cleanChosenName('<b>가람</b>')).toBe('<b>가람</b>');
  });

  it('nothing, white space, or something that is not text is no name (negative)', () => {
    for (const none of ['', '   ', '\n\t', '\u0000', null, undefined, 7, {}, ['가람'], true]) {
      expect(cleanChosenName(none), JSON.stringify(none)).toBe('');
    }
  });

  it('the chosen name wins; without one it is the e-mail’s own part, and without that nobody is named', () => {
    expect(displayNameFor('가람', 'planner@example.test')).toBe('가람');
    expect(displayNameFor('', 'planner@example.test')).toBe('planner');
    // The desktop bundle has no address to fall back on.
    expect(displayNameFor('가람', null)).toBe('가람');
    expect(displayNameFor('', null)).toBe('');
    expect(initialOf(displayNameFor('가람', 'planner@example.test'))).toBe('가');
    expect(initialOf(displayNameFor('', 'planner@example.test'))).toBe('P');
  });
});

describe('kept on this device, for this owner only', () => {
  it('is a declared owner slot that holds the name and nothing else', () => {
    expect(OWNER_STORAGE_MANIFEST.ownerSlots.chosenName).toMatchObject({
      area: 'local',
      prefix: 'ohmydate.owner.name',
      staleWrites: 'drop',
      onOwnerChange: 'preserve',
    });
    expect(useChosenName().setName('  한   별 ')).toBe('한 별');
    expect(chosenNameKey(OWNER_A)).toBe(`ohmydate.owner.name:${OWNER_A}`);
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBe('한 별');
    expect(useChosenName().name.value).toBe('한 별');
  });

  it('a name that is too long is stored cut (the rule is "cut", not "refuse")', () => {
    expect(useChosenName().setName('다'.repeat(45))).toBe('다'.repeat(30));
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBe('다'.repeat(30));
  });

  it('emptied, it is taken away: nothing is left in storage and the e-mail’s part is the name again', () => {
    const controls = useChosenName();
    controls.setName('가람');
    expect(controls.setName('   ')).toBe('');
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBeNull();
    expect(controls.name.value).toBe('');
    expect(displayNameFor(controls.name.value, mockDb.user.email)).toBe('planner');
  });

  it('comes back on a fresh page for the same owner', () => {
    useChosenName().setName('가람');
    resetChosenNameForTests();
    expect(useChosenName().name.value).toBe('가람');
  });

  it('another owner on the same device never sees it (negative)', () => {
    const controls = useChosenName();
    controls.setName('가람');
    expect(readChosenName(OWNER_B)).toBe('');
    expect(localStorage.getItem(chosenNameKey(OWNER_B))).toBeNull();
    // Another user signs in on this page: no name of theirs, so none at all…
    adoptActiveOwner(OWNER_B, 'bootstrap');
    expect(controls.name.value).toBe('');
    // …and what they choose is theirs alone.
    expect(useChosenName().setName('새벽')).toBe('새벽');
    expect(readChosenName(OWNER_A)).toBe('가람');
    adoptActiveOwner(OWNER_A, 'bootstrap');
    expect(controls.name.value).toBe('가람');
  });

  it('an owner change between the gesture and the write drops the write (negative)', () => {
    const controls = useChosenName();
    const stale = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'bootstrap');
    expect(writeChosenName(stale, '가람')).toBeNull();
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBeNull();
    expect(localStorage.getItem(chosenNameKey(OWNER_B))).toBeNull();
    expect(controls.name.value).toBe('');
    // The controls a screen took for the first owner are that owner's for good: after the
    // owner came back (a new sign-in) they still store nothing; a new screen's do.
    adoptActiveOwner(OWNER_A, 'bootstrap');
    expect(controls.setName('가람')).toBeNull();
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBeNull();
    expect(useChosenName().setName('가람')).toBe('가람');
    // Taking a name away under a stale binding removes nothing either.
    const old = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'bootstrap');
    expect(writeChosenName(old, '')).toBeNull();
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBe('가람');
  });

  it('what was put into storage by hand is made fit again when read (negative)', () => {
    localStorage.setItem(chosenNameKey(OWNER_A), `  ${'라'.repeat(80)}\u0000 `);
    expect(readChosenName(OWNER_A)).toBe('라'.repeat(30));
  });

  it('goes nowhere: no request when it is set, and only the screens that show it read it', () => {
    useChosenName().setName('가람');
    expect(requests).toEqual([]);
    const source = readFileSync(resolve(__dirname, '../src/session/chosenName.ts'), 'utf8');
    expect(source).toContain("ownerSlot('chosenName')");
    // No storage API of its own, no client, no log.
    expect(/\b(localStorage|sessionStorage|indexedDB|fetch|plannerClient|console)\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);

    const readers: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|vue)$/.test(entry) && /session\/chosenName['"]/.test(readFileSync(path, 'utf8'))) readers.push(path.replace(/^.*\/src\//, 'src/'));
      }
    };
    walk(resolve(__dirname, '../src'));
    // The greeting, the account chip, the field that sets it, and the entry that reads it first:
    // nothing that talks to the API or builds what the AI reads.
    expect(readers.sort()).toEqual(['src/components/TopBar.vue', 'src/components/settings/DisplaySettings.vue', 'src/main.ts', 'src/views/OverviewView.vue']);
  });
});

describe('설정 › 화면 › 이름', () => {
  async function mountDisplay(): Promise<VueWrapper> {
    const pinia = createPinia();
    await useAuthStore(pinia).ensureOwnerConfirmed();
    const wrapper = mount(DisplaySettings, { global: { plugins: [pinia] }, attachTo: document.body });
    mounted.push(wrapper);
    await nextTick();
    return wrapper;
  }

  const field = (wrapper: VueWrapper) => wrapper.get<HTMLInputElement>('[data-display-name-input]');
  const save = (wrapper: VueWrapper) => wrapper.get<HTMLButtonElement>('[data-display-name-save]');

  it('is one labelled field, showing what the app calls the owner while nothing is chosen', async () => {
    const wrapper = await mountDisplay();
    const card = wrapper.get('[data-display-name]');
    expect(card.get('h3').text()).toBe('이름');
    expect(card.get('label').text()).toBe('앱이 나를 부르는 이름');
    expect(card.get('label').attributes('for')).toBe(field(wrapper).attributes('id'));
    expect(field(wrapper).element.value).toBe('');
    expect(field(wrapper).attributes('placeholder')).toBe('planner');
    expect(card.get(`#${field(wrapper).attributes('aria-describedby') ?? ''}`).text()).toBe(
      '개요의 인사와 계정 표시에 써요. 30자까지, 이 기기에만 저장돼요. 비워 두면 이메일 앞부분으로 불러요.',
    );
    // Nothing to save yet.
    expect(save(wrapper).element.disabled).toBe(true);
    expect(wrapper.findAll('[data-display-name-input]')).toHaveLength(1);
  });

  it('saves on submit, says so, shows the name as it was kept, and sends nothing', async () => {
    const wrapper = await mountDisplay();
    await field(wrapper).setValue(`   ${'하'.repeat(34)}  `);
    expect(save(wrapper).element.disabled).toBe(false);
    await wrapper.get('[data-display-name] form').trigger('submit');
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBe('하'.repeat(30));
    // The field shows the cut name, not what was typed.
    expect(field(wrapper).element.value).toBe('하'.repeat(30));
    expect(wrapper.get('[role="status"]').text()).toBe(`이제 ‘${'하'.repeat(30)}’님이라고 부를게요.`);
    expect(wrapper.get('[data-display-name-saved]').text()).toBe('저장했어요');
    expect(save(wrapper).element.disabled).toBe(true);
    expect(requests.filter((request) => !request.startsWith('GET '))).toEqual([]);

    // Typing again takes the note away until it is saved again.
    await field(wrapper).setValue('가람');
    expect(wrapper.find('[data-display-name-saved]').exists()).toBe(false);
  });

  it('emptied and saved, the name is taken away', async () => {
    useChosenName().setName('가람');
    const wrapper = await mountDisplay();
    expect(field(wrapper).element.value).toBe('가람');
    await field(wrapper).setValue('');
    await wrapper.get('[data-display-name] form').trigger('submit');
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBeNull();
    expect(wrapper.get('[role="status"]').text()).toBe('이름을 지웠어요.');
  });

  it('white space alone is nothing to save (negative)', async () => {
    const wrapper = await mountDisplay();
    await field(wrapper).setValue('    ');
    expect(save(wrapper).element.disabled).toBe(true);
    await wrapper.get('[data-display-name] form').trigger('submit');
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBeNull();
  });

  it('when another user signed in, the old screen’s field saves nothing and shows what is in effect (negative)', async () => {
    // As on the real page: an owner change seals it until the hard reload (ADR-023).
    installPageSeal();
    injectOwnerReload(() => undefined);
    try {
      const wrapper = await mountDisplay();
      await field(wrapper).setValue('가람');
      expect(ownerChanged(OWNER_A, OWNER_B, 'login')).toBe(true);
      await wrapper.get('[data-display-name] form').trigger('submit');
      await nextTick();
      expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBeNull();
      expect(localStorage.getItem(chosenNameKey(OWNER_B))).toBeNull();
      expect(wrapper.find('[data-display-name-saved]').exists()).toBe(false);
      // Not the name the previous user was typing.
      expect(field(wrapper).element.value).toBe('');
      expect(useChosenName().name.value).toBe('');
    } finally {
      resetPageSealForTests();
      injectOwnerReload(null);
    }
  });

  it('the same without a sealed page: the field of the first owner’s screen writes nothing into the next owner’s storage (negative)', async () => {
    const wrapper = await mountDisplay();
    await field(wrapper).setValue('가람');
    adoptActiveOwner(OWNER_B, 'bootstrap');
    await wrapper.get('[data-display-name] form').trigger('submit');
    await nextTick();
    expect(localStorage.getItem(chosenNameKey(OWNER_A))).toBeNull();
    expect(localStorage.getItem(chosenNameKey(OWNER_B))).toBeNull();
    // Nothing is said about a save that did not happen.
    expect(wrapper.get('[role="status"]').text()).toBe('');
    expect(wrapper.find('[data-display-name-saved]').exists()).toBe(false);
    expect(useChosenName().name.value).toBe('');
  });

  it('the desktop bundle, which has no address, says what an empty name means there', async () => {
    vi.stubEnv('MODE', DESKTOP_BUILD_MODE);
    const wrapper = await mountDisplay();
    expect(field(wrapper).attributes('placeholder')).toBe('부를 이름');
    expect(wrapper.get('#display-name-help').text()).toContain('비워 두면 이름 없이 인사해요.');
    expect(wrapper.get('#display-name-help').text()).not.toContain('이메일');
  });
});

describe('the greeting, the account chip and the avatar follow the name at once', () => {
  function router(): Router {
    return createRouter({
      history: createMemoryHistory(),
      routes: routes.filter((route) => typeof route.name === 'string').map((route) => ({ path: route.path, name: route.name as string, component: Stub })),
    });
  }

  async function mountOverview(): Promise<VueWrapper> {
    const target = router();
    await target.push('/overview');
    const pinia = createPinia();
    await useAuthStore(pinia).ensureOwnerConfirmed();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
    const wrapper = mount(OverviewView, { global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], target] as never }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('[data-greeting]').exists()).toBe(true));
    return wrapper;
  }

  async function mountShell(): Promise<VueWrapper> {
    const target = router();
    await target.push('/settings/display');
    await target.isReady();
    const wrapper = mount(AppShell, {
      global: { plugins: [createPinia(), target, VueQueryPlugin] },
      slots: { default: () => h('h1', 'screen') },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.find('.app-shell:not(.app-shell--loading)').exists()).toBe(true);
    });
    return wrapper;
  }

  const chip = (wrapper: VueWrapper) => wrapper.get('[data-user-menu]');

  it('개요 greets by the chosen name the moment it is set, and by the e-mail’s part again when it is taken away', async () => {
    const wrapper = await mountOverview();
    expect(wrapper.get('[data-greeting]').text()).toBe('planner님, 좋은 저녁이에요');
    useChosenName().setName('가람');
    await nextTick();
    expect(wrapper.get('[data-greeting]').text()).toBe('가람님, 좋은 저녁이에요');
    useChosenName().setName('');
    await nextTick();
    expect(wrapper.get('[data-greeting]').text()).toBe('planner님, 좋은 저녁이에요');
  });

  it('the top bar’s account chip and avatar initial change with it, on a screen that was already open', async () => {
    const wrapper = await mountShell();
    expect(chip(wrapper).attributes('aria-label')).toBe('planner 계정 메뉴');
    expect(wrapper.get('.topbar-avatar').text()).toBe('P');
    useChosenName().setName('가람');
    await nextTick();
    expect(chip(wrapper).attributes('aria-label')).toBe('가람 계정 메뉴');
    expect(wrapper.get('.topbar-avatar').text()).toBe('가');
    expect(wrapper.get('.topbar-user-name').text()).toBe('가람');
    // The address in the menu is still the address: the name is not written over it.
    await chip(wrapper).trigger('click');
    expect(wrapper.get('#topbar-user-menu .menu-note').text()).toBe('planner@example.test');
  });

  it('a name that looks like markup is shown as its letters, and makes no element (negative)', async () => {
    useChosenName().setName('<img src=x onerror=alert(1)>');
    const wrapper = await mountOverview();
    const heading = wrapper.get('[data-greeting]');
    expect(heading.text()).toBe('<img src=x onerror=alert(1)>님, 좋은 저녁이에요');
    expect(heading.element.children).toHaveLength(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('another owner’s screen is not greeted by the first owner’s name (negative)', async () => {
    useChosenName().setName('가람');
    const wrapper = await mountOverview();
    expect(wrapper.get('[data-greeting]').text()).toBe('가람님, 좋은 저녁이에요');
    adoptActiveOwner(OWNER_B, 'bootstrap');
    await nextTick();
    expect(wrapper.get('[data-greeting]').text()).not.toContain('가람');
  });

  it('the desktop bundle, which names nobody by default, greets by the chosen name — and names nobody again without one', async () => {
    vi.stubEnv('MODE', DESKTOP_BUILD_MODE);
    const wrapper = await mountOverview();
    expect(wrapper.get('[data-greeting]').text()).toBe('좋은 저녁이에요');
    useChosenName().setName('새벽');
    await nextTick();
    expect(wrapper.get('[data-greeting]').text()).toBe('새벽님, 좋은 저녁이에요');
    useChosenName().setName('');
    await nextTick();
    expect(wrapper.get('[data-greeting]').text()).toBe('좋은 저녁이에요');
  });
});
