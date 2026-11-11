import PlanNewView from '../src/views/PlanNewView.vue';
import { mockDb } from '../src/mocks/db';
import {
  buttonByText,
  mountWithPlugins,
  settle,
  testRouter,
} from './planning-test-utils';

describe('new plan route', () => {
  it('creates a plan from taskIds in the query and navigates to the comparison', async () => {
    const task = [...mockDb.tasks.values()][0];
    if (task === undefined) throw new Error('seed task missing');
    const router = testRouter();
    await router.push(`/plans/new?taskIds=${task.id}`);
    await router.isReady();

    const wrapper = mountWithPlugins(PlanNewView, { router });
    await settle();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('새 일정안');
    });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('작업 1개');
    });

    const generate = buttonByText(wrapper, '후보 만들기');
    await generate.trigger('click');

    await vi.waitFor(
      () => {
        expect(router.currentRoute.value.name).toBe('plan');
      },
      { timeout: 5_000 },
    );
    expect(mockDb.plans.size).toBe(1);

    wrapper.unmount();
  });
});
