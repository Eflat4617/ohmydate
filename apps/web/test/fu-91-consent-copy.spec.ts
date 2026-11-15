/**
 * FU-91: the AI consent copy states exactly what is masked, a dismissed consent
 * dialog stays closed for the rest of the browser session (per owner) but
 * returns when an AI action starts, and the wizard's type-detection reasons
 * carry the language they are actually written in.
 *
 * The redaction pin imports packages/llm/src/privacy.ts directly (the web app
 * does not depend on @ohmydate/llm): if privacy.ts gains or loses a kind, the
 * mirror in apps/web/src/i18n/redaction.ts and the consent copy built from it
 * must change with it, and this file fails until they do.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent, nextTick } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { redact, type RedactionKind } from '../../../packages/llm/src/privacy.js';
import { createPlannerClient, newActionId, plannerClient, type User } from '../src/api';
import AppShell from '../src/components/AppShell.vue';
import LlmDisclosure from '../src/components/LlmDisclosure.vue';
import { t } from '../src/i18n';
import { ko } from '../src/i18n/messages/ko';
import { MASKED_KINDS, maskedKindsText, type MaskedKind } from '../src/i18n/redaction';
import { detectionReasonLang, detectionReasonText, ownerTextLang } from '../src/i18n/server';
import { createUuidV7, mockDb } from '../src/mocks/db';
import { adoptActiveOwner, clearOwnerResetPending } from '../src/session/ownerEpoch';
import { sessionJournal } from '../src/session/journal';
import { useAuthStore } from '../src/stores/auth';
import { useLlmConsentStore } from '../src/stores/llmConsent';
import LlmSettingsView from '../src/components/settings/AiSettings.vue';
import PlanView from '../src/views/PlanView.vue';

// ── 1. The disclosure names exactly what privacy.ts masks ────────────────────

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time half of the pin: the web mirror and RedactionKind are the same set. */
const MIRRORS_REDACTION_KIND: Same<MaskedKind, RedactionKind> = true;

/** One synthetic value per kind; every one must be masked by the real redactor. */
const SAMPLES: Readonly<Record<MaskedKind, string>> = {
  email: 'planner.sample@example.test',
  phone: '010-1234-5678',
  rrn: '900101-1234567',
  api_key: 'sk-FAKEFAKEFAKE0000',
};

const MASKING_COPY =
  '보내기 전에 이메일·전화번호·주민등록번호·API 키처럼 보이는 값을 자동으로 가려요. ' +
  '형식을 바꿔 쓴 값은 놓칠 수 있고, 이름·주소·계좌번호 같은 다른 개인정보는 가리지 않아요.';

describe('consent copy matches the real redaction scope (FU-91)', () => {
  it('mirrors RedactionKind: the real redactor masks one sample of every listed kind, in report order', () => {
    expect(MIRRORS_REDACTION_KIND).toBe(true);
    const text = MASKED_KINDS.map((kind) => SAMPLES[kind]).join(' / ');
    const result = redact(text);
    expect(result.report.map((entry) => entry.kind)).toEqual([...MASKED_KINDS]);
    for (const kind of MASKED_KINDS) expect(result.text).not.toContain(SAMPLES[kind]);
  });

  it('negative: account numbers are not masked by privacy.ts, so the copy must not say they are', () => {
    for (const account of ['국민은행 123456-01-123456', '카카오뱅크 3333-01-1234567']) {
      const result = redact(account);
      expect(result.report).toEqual([]);
      expect(result.text).toBe(account);
    }
    // The only place 계좌번호 may appear is the "not masked" clause.
    const [masked = '', notMasked = ''] = t('llm.disclosure.maskingValue', { kinds: maskedKindsText() }).split('가려요.');
    expect(masked).not.toContain('계좌');
    expect(notMasked).toContain('계좌번호');
    expect(notMasked).toContain('가리지 않아요');
  });

  it('builds the kind list only from MASKED_KINDS: the catalog template names no kind itself', () => {
    expect(Object.keys(ko.llm.disclosure.kinds).sort()).toEqual([...MASKED_KINDS].sort());
    const template = ko.llm.disclosure.maskingValue.split('가려요.')[0] ?? '';
    expect(template).toContain('{kinds}');
    for (const label of Object.values(ko.llm.disclosure.kinds)) expect(template).not.toContain(label);
    expect(ko.notes.editor.llm.masking).toContain('{kinds}');
  });

  it('renders the exact masking copy in the shared disclosure (consent dialog and AI 설정)', () => {
    const wrapper = mount(LlmDisclosure);
    // Pinned text: change it only together with packages/llm/src/privacy.ts.
    expect(wrapper.text()).toContain(MASKING_COPY);
    expect(wrapper.text()).not.toContain('계좌번호 형식은 가려서');
    // What is sent includes AI-allowed notes linked to the plan (M6-03).
    expect(wrapper.text()).toContain('‘AI에 보내기 허용’을 켜고 이 계획에 연결한 노트');
    wrapper.unmount();
  });
});

// ── 3. Dismissing the consent dialog ─────────────────────────────────────────

const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
      { path: '/settings/ai', name: 'ai-settings', component: Stub },
      { path: '/plan', name: 'plan', component: PlanView },
      { path: '/plan/schedule', name: 'plan-scope', component: Stub },
      { path: '/plan/schedule/:id', name: 'plan-schedule', component: Stub },
      { path: '/plan/:sessionId', name: 'plan-session', component: PlanView, props: true },
    ],
  });
}

function deepseekOwner(label: string, extra: Partial<User> = {}): User {
  return {
    ...mockDb.user,
    id: createUuidV7(),
    email: `${label}-${Date.now().toString(36)}@example.test`,
    llmProvider: 'deepseek',
    locale: 'ko-KR',
    version: 1,
    ...extra,
  };
}

/** Sign in, or (same owner again) the reload's bootstrap: `/me` answers `current`. */
async function signIn(pinia: Pinia, current: User): Promise<void> {
  vi.spyOn(plannerClient, 'login').mockResolvedValue();
  vi.spyOn(plannerClient, 'getMe').mockResolvedValue(current);
  await useAuthStore(pinia).login(current.email, 'pw');
}

async function reload(current: User): Promise<Pinia> {
  const pinia = createPinia();
  vi.spyOn(plannerClient, 'getMe').mockResolvedValue(current);
  await useAuthStore(pinia).loadCurrent();
  return pinia;
}

/** PATCH /me/settings as the API applies a consent answer. */
function consentEndpoint(current: () => User, set: (next: User) => void) {
  return vi.spyOn(plannerClient, 'updateMySettings').mockImplementation(async (patch) => {
    const granted = patch.llm?.consent?.granted === true;
    const next: User = {
      ...current(),
      version: current().version + 1,
      llm: { consent: { granted, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } },
    };
    set(next);
    return next;
  });
}

const Host = defineComponent({
  components: { AppShell, RouterView },
  template: '<AppShell><RouterView /></AppShell>',
});

async function mountShell(pinia: Pinia, path = '/overview'): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = testRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(Host, {
    global: { plugins: [pinia, router, VueQueryPlugin] },
    attachTo: document.body,
  });
  await flushPromises();
  await nextTick();
  return { wrapper, router };
}

const TITLE = 'AI 계획 도움을 쓸까요?';

function dialogShown(): boolean {
  return document.body.textContent?.includes(TITLE) === true;
}

function bodyButton(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

function pressEscapeOnDialog(): void {
  const dialog = [...document.body.querySelectorAll('[role="dialog"]')].find((item) =>
    item.textContent?.includes(TITLE),
  );
  if (dialog === undefined) throw new Error('consent dialog not found');
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

function consentMarker(ownerId: string): string | null {
  return sessionStorage.getItem(`ohmydate.llm.consentPrompt:${ownerId}`);
}

describe('consent dialog dismissal is remembered per owner for the session (FU-91)', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    adoptActiveOwner(null, 'bootstrap');
    clearOwnerResetPending();
    sessionJournal.setOwner(null);
    await sessionJournal.clear(null);
    document.body.innerHTML = '';
  });

  it('opens on the first load; Escape closes it without recording an answer and a reload keeps it closed', async () => {
    const user = deepseekOwner('dismiss');
    const settings = vi.spyOn(plannerClient, 'updateMySettings');
    const pinia = createPinia();
    await signIn(pinia, user);
    const first = await mountShell(pinia);
    await vi.waitFor(() => expect(dialogShown()).toBe(true));

    pressEscapeOnDialog();
    await vi.waitFor(() => expect(dialogShown()).toBe(false));
    expect(settings).not.toHaveBeenCalled();
    expect(useAuthStore(pinia).user?.llm?.consent).toBeUndefined();
    expect(consentMarker(user.id)).toBe('1');
    first.wrapper.unmount();

    const reloaded = await reload(user);
    expect(useAuthStore(reloaded).confirmed).toBe(true);
    const again = await mountShell(reloaded);
    expect(dialogShown()).toBe(false);
    expect(useLlmConsentStore(reloaded).needed).toBe(true);
    again.wrapper.unmount();
  });

  it('negative: another owner signing in on this browser is asked again', async () => {
    const first = deepseekOwner('owner-a');
    const pinia = createPinia();
    await signIn(pinia, first);
    const shell = await mountShell(pinia);
    await vi.waitFor(() => expect(dialogShown()).toBe(true));
    pressEscapeOnDialog();
    await vi.waitFor(() => expect(dialogShown()).toBe(false));
    shell.wrapper.unmount();

    const second = deepseekOwner('owner-b');
    const next = createPinia();
    await signIn(next, second);
    // The owner change cleared every owner's marker (onOwnerChange: 'clear').
    expect(consentMarker(first.id)).toBeNull();
    const other = await mountShell(next);
    await vi.waitFor(() => expect(dialogShown()).toBe(true));
    other.wrapper.unmount();
  });

  it('reopens for an AI action after a dismissal and lets it continue once answered', async () => {
    let user = deepseekOwner('ask');
    const pinia = createPinia();
    await signIn(pinia, user);
    const auth = useAuthStore(pinia);
    consentEndpoint(
      () => auth.user ?? user,
      (next) => {
        user = next;
      },
    );
    const shell = await mountShell(pinia);
    await vi.waitFor(() => expect(dialogShown()).toBe(true));
    pressEscapeOnDialog();
    await vi.waitFor(() => expect(dialogShown()).toBe(false));

    const store = useLlmConsentStore(pinia);
    let answered = false;
    const asking = store.askBeforeAi().then(() => {
      answered = true;
    });
    await vi.waitFor(() => expect(dialogShown()).toBe(true));
    expect(answered).toBe(false);

    bodyButton('직접 작성 모드로 쓰기').click();
    await asking;
    expect(answered).toBe(true);
    expect(dialogShown()).toBe(false);
    expect(auth.user?.llm?.consent?.granted).toBe(false);

    // An explicit 직접 작성 answer is not asked again; AI 설정 is where it changes.
    await store.askBeforeAi();
    await nextTick();
    expect(dialogShown()).toBe(false);
    shell.wrapper.unmount();
  });

  it('negative: with no dialog host mounted an AI action is never held up', async () => {
    const pinia = createPinia();
    await signIn(pinia, deepseekOwner('no-host'));
    await expect(useLlmConsentStore(pinia).askBeforeAi()).resolves.toBeUndefined();
    expect(useLlmConsentStore(pinia).open).toBe(true);
    expect(useLlmConsentStore(pinia).requested).toBe(false);
  });

  it('AI 설정 still offers consent after a dismissal', async () => {
    const user = deepseekOwner('settings');
    const pinia = createPinia();
    await signIn(pinia, user);
    const shell = await mountShell(pinia);
    await vi.waitFor(() => expect(dialogShown()).toBe(true));
    pressEscapeOnDialog();
    await vi.waitFor(() => expect(dialogShown()).toBe(false));
    shell.wrapper.unmount();

    const settings = mount(LlmSettingsView, { global: { plugins: [pinia] }, attachTo: document.body });
    await flushPromises();
    await vi.waitFor(() => expect(settings.text()).toContain('AI 계획 도움 켜기'));
    expect(settings.text()).toContain(MASKING_COPY);
    settings.unmount();
  });

  // HOLO-03A (FLOW §2): 계획 세우기 asks for consent right in its goal card —
  // the same disclosure, not the dialog and not a settings screen.
  it('starting a plan after a dismissal asks in the goal card first, then creates the session with the answer', async () => {
    let user = deepseekOwner('plan');
    const pinia = createPinia();
    await signIn(pinia, user);
    const auth = useAuthStore(pinia);
    consentEndpoint(
      () => auth.user ?? user,
      (next) => {
        user = next;
      },
    );
    const create = vi.spyOn(plannerClient, 'createIntakeSession');
    const { wrapper } = await mountShell(pinia, '/plan');
    await vi.waitFor(() => expect(dialogShown()).toBe(true));
    pressEscapeOnDialog();
    await vi.waitFor(() => expect(dialogShown()).toBe(false));
    // Undecided: the card says it will ask once.
    expect(wrapper.get('[data-plan-goal] [data-ai]').attributes('data-ai')).toBe('ask');
    expect(wrapper.find('[data-plan-consent]').exists()).toBe(false);

    await wrapper.get('#plan-goal-title').setValue('논문 요약');
    await wrapper.get('[data-plan-goal]').trigger('submit');
    await vi.waitFor(() => expect(wrapper.find('[data-plan-consent]').exists()).toBe(true));
    expect(create).not.toHaveBeenCalled();
    // Asked in place: no dialog, and what is sent is disclosed in the same words.
    expect(dialogShown()).toBe(false);
    expect(wrapper.get('[data-plan-consent]').text()).toContain(MASKING_COPY);
    expect(document.activeElement).toBe(wrapper.get('[data-plan-consent]').element);
    // One filled button while it is asked: the answer that goes on with the AI.
    expect(wrapper.findAll('[data-plan-goal] .btn--primary').map((item) => item.text())).toEqual(['AI 도움 받고 시작']);

    await wrapper.get('[data-plan-consent-allow]').trigger('click');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(auth.user?.llm?.consent?.granted).toBe(true);
    expect(dialogShown()).toBe(false);
    wrapper.unmount();
  });

  it('“AI 없이 시작” records the refusal and starts the plan without the AI', async () => {
    let user = deepseekOwner('plan-manual');
    const pinia = createPinia();
    await signIn(pinia, user);
    const auth = useAuthStore(pinia);
    consentEndpoint(
      () => auth.user ?? user,
      (next) => {
        user = next;
      },
    );
    const create = vi.spyOn(plannerClient, 'createIntakeSession');
    sessionStorage.setItem(`ohmydate.llm.consentPrompt:${user.id}`, '1');
    const { wrapper } = await mountShell(pinia, '/plan');
    await wrapper.get('#plan-goal-title').setValue('논문 요약');
    await wrapper.get('[data-plan-goal]').trigger('submit');
    await vi.waitFor(() => expect(wrapper.find('[data-plan-consent]').exists()).toBe(true));
    expect(create).not.toHaveBeenCalled();

    await wrapper.get('[data-plan-consent-manual]').trigger('click');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(auth.user?.llm?.consent?.granted).toBe(false);
    wrapper.unmount();
  });

  it('negative: after an explicit 직접 작성 answer a plan starts without asking again; AI 도움 켜기 asks without starting anything', async () => {
    let user = deepseekOwner('manual', {
      llm: { consent: { granted: false, at: '2026-11-12T09:00:00.000Z', provider: 'deepseek' } },
    });
    const pinia = createPinia();
    await signIn(pinia, user);
    const auth = useAuthStore(pinia);
    consentEndpoint(
      () => auth.user ?? user,
      (next) => {
        user = next;
      },
    );
    const create = vi.spyOn(plannerClient, 'createIntakeSession');
    // Already answered this session: the dialog does not open by itself either.
    sessionStorage.setItem(`ohmydate.llm.consentPrompt:${user.id}`, '1');
    const { wrapper } = await mountShell(pinia, '/plan');
    expect(dialogShown()).toBe(false);
    // The card says the AI is off, and offers to turn it on right there.
    expect(wrapper.get('[data-plan-goal] [data-ai]').attributes('data-ai')).toBe('off');

    await wrapper.get('[data-plan-ai-on]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-plan-consent]').exists()).toBe(true));
    // No goal typed yet: turning the AI on is all the answer does.
    await wrapper.get('[data-plan-consent-allow]').trigger('click');
    await vi.waitFor(() => expect(auth.user?.llm?.consent?.granted).toBe(true));
    await vi.waitFor(() => expect(wrapper.find('[data-plan-consent]').exists()).toBe(false));
    expect(create).not.toHaveBeenCalled();
    expect(wrapper.get('[data-plan-goal] [data-ai]').attributes('data-ai')).toBe('on');
    wrapper.unmount();

    // Declined and left declined: starting asks nothing.
    const declined = deepseekOwner('declined', {
      llm: { consent: { granted: false, at: '2026-11-12T09:00:00.000Z', provider: 'deepseek' } },
    });
    const second = createPinia();
    await signIn(second, declined);
    sessionStorage.setItem(`ohmydate.llm.consentPrompt:${declined.id}`, '1');
    const again = await mountShell(second, '/plan');
    await again.wrapper.get('#plan-goal-title').setValue('논문 요약');
    await again.wrapper.get('[data-plan-goal]').trigger('submit');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(again.wrapper.find('[data-plan-consent]').exists()).toBe(false);
    expect(dialogShown()).toBe(false);
    again.wrapper.unmount();
  });
});

// ── 4. Type-detection reasons carry their real language ──────────────────────

describe('type-detection reason lang (FU-91)', () => {
  const llmText = detectionReasonText('제목과 결과물이 기존 보고서 템플릿과 비슷해요');
  const legacyCode = detectionReasonText('no_similar_template');
  const translated = detectionReasonText('tag_jaccard=0.500');

  it('omits lang for AI text in the UI language and for reasons this client translated', () => {
    if (llmText === null || translated === null) throw new Error('unexpected hidden reason');
    expect(detectionReasonLang('제목과 결과물이 기존 보고서 템플릿과 비슷해요', llmText, 'ko-KR')).toBeUndefined();
    expect(detectionReasonLang('제목과 결과물이 기존 보고서 템플릿과 비슷해요', llmText, 'ko')).toBeUndefined();
    expect(detectionReasonLang('tag_jaccard=0.500', translated, 'en')).toBeUndefined();
  });

  it("tags AI text with the owner's locale when it is not the UI language", () => {
    if (llmText === null) throw new Error('unexpected hidden reason');
    expect(detectionReasonLang('Similar to your report template', llmText, 'en')).toBe('en');
    expect(detectionReasonLang('Similar to your report template', llmText, 'en_US')).toBe('en-US');
    expect(detectionReasonLang('既存のテンプレートに近い', llmText, 'ja-JP')).toBe('ja-JP');
  });

  it('keeps lang="en" only for the legacy English fallback (an untranslated server code)', () => {
    if (legacyCode === null) throw new Error('unexpected hidden reason');
    expect(legacyCode.translated).toBe(false);
    expect(detectionReasonLang('no_similar_template', legacyCode, 'ko-KR')).toBe('en');
    expect(detectionReasonLang('no_similar_template', legacyCode, 'ja-JP')).toBe('en');
  });

  it('negative: a missing, malformed or non-language locale falls back like the API (Korean), never to en', () => {
    for (const locale of [undefined, null, '', 'x', 'not a locale!', 'und', 'zxx', 'qaa-ZZ', 'a'.repeat(40)]) {
      expect(ownerTextLang(locale)).toBeUndefined();
    }
  });

  it('renders AI reasons without lang="en" for a Korean owner and tags the legacy code', async () => {
    localStorage.clear();
    sessionStorage.clear();
    adoptActiveOwner(null, 'bootstrap');
    const pinia = createPinia();
    await signIn(pinia, deepseekOwner('reasons', { llmProvider: 'fake', locale: 'ko-KR' }));
    // The mock's similar-type answer, plus the server's untranslated code.
    const created = await createPlannerClient().createIntakeSession({ title: '보고서 작성' }, newActionId('create'));
    const record = mockDb.intakeSessions.get(created.id);
    if (record?.detectedType === undefined) throw new Error('no detected type');
    record.detectedType = { ...record.detectedType, reasons: [...record.detectedType.reasons, 'no_similar_template'] };

    const { wrapper } = await mountShell(pinia, `/plan/${created.id}`);
    await vi.waitFor(() => expect(wrapper.text()).toContain('no_similar_template'));
    const chips = wrapper.findAll('.plan-type-reasons li');
    const ai = chips.filter((chip) => chip.text() !== 'no_similar_template');
    const legacy = chips.filter((chip) => chip.text() === 'no_similar_template');
    expect(ai.map((chip) => chip.text())).toContain('태그: 보고서');
    for (const chip of ai) expect(chip.attributes('lang')).toBeUndefined();
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.attributes('lang')).toBe('en');
    wrapper.unmount();
  });
});
