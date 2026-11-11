import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import App from '../src/App.vue';
import {
  createPlannerClient,
  newActionId,
  plannerClient,
  type IntakeSession,
} from '../src/api';
import { zonedWallClockToInstant } from '../src/domain/time';
import PlanningWizardView from '../src/views/PlanningWizardView.vue';

function Stub() {
  return defineComponent({ template: '<div />' });
}

async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await nextTick();
}

async function seedManualSession(title: string, firstStep: string): Promise<IntakeSession> {
  const client = createPlannerClient();
  const created = await client.createIntakeSession(
    { title, dueAt: '2026-11-30T18:00:00.000Z' },
    newActionId('create'),
  );
  const manual = await client.enterManualIntakeMode(
    created.id,
    newActionId('manual'),
    created.version,
  );
  const draft = manual.draft;
  if (draft === undefined) throw new Error('manual session has no draft');
  const steps = draft.steps.map((step, index) =>
    index === 0 ? { ...step, title: firstStep, deliverable: `${firstStep} deliverable` } : step,
  );
  await client.updateIntakeDraft(
    manual.id,
    { steps },
    newActionId('draft'),
    manual.version,
  );
  return client.getIntakeSession(manual.id, { fresh: true });
}

function appRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/inbox', name: 'inbox', component: Stub() },
      { path: '/plan/new', name: 'plan-new', component: PlanningWizardView },
      { path: '/plan/:sessionId', name: 'plan-session', component: PlanningWizardView, props: true },
      { path: '/:pathMatch(.*)*', redirect: '/inbox' },
    ],
  });
}

describe('wizard session isolation (M23-UIR-1 HIGH)', () => {
  it('never shows or saves session A draft after navigating to B or /plan/new', async () => {
    const sessionA = await seedManualSession('세션 A', 'A 전용 단계');
    const sessionB = await seedManualSession('세션 B', 'B 전용 단계');
    const spy = vi.spyOn(plannerClient, 'updateIntakeDraft');

    const pinia = createPinia();
    const router = appRouter();
    const wrapper = mount(App, {
      global: { plugins: [pinia, router, VueQueryPlugin] },
      attachTo: document.body,
    });

    await router.push(`/plan/${sessionA.id}`);
    await router.isReady();
    await settle();
    await vi.waitFor(() => {
      expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', 'A 전용 단계');
    });

    await router.push(`/plan/${sessionB.id}`);
    await settle();
    await vi.waitFor(() => {
      expect(wrapper.get('#step-title-s1').element).toHaveProperty('value', 'B 전용 단계');
    });
    expect(wrapper.text()).not.toContain('A 전용 단계');

    await router.push('/plan/new');
    await settle();
    await vi.waitFor(() => {
      expect(wrapper.get('#wizard-title').element).toHaveProperty('value', '');
    });
    expect(wrapper.find('#step-title-s1').exists()).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    wrapper.unmount();
  });
});

describe('DST wall-clock conversion (08 §3)', () => {
  it('shifts a nonexistent spring-forward time forward by the gap', () => {
    expect(zonedWallClockToInstant('2026-03-08', 2 * 60 + 30, 'America/New_York')).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('resolves an ambiguous fall-back time to the first occurrence', () => {
    expect(zonedWallClockToInstant('2026-11-01', 1 * 60 + 30, 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });
});
