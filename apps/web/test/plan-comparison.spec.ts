import { HttpResponse, http } from 'msw';
import { createPlannerClient, newActionId, plannerClient, type Plan } from '../src/api';
import PlanComparisonView from '../src/views/PlanComparisonView.vue';
import { createUuidV7, mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import {
  buttonByText,
  mountWithPlugins,
  settle,
  testRouter,
} from './planning-test-utils';

const HORIZON = {
  start: '2026-11-11T00:00:00.000Z',
  end: '2026-11-25T00:00:00.000Z',
};

async function createPlan(): Promise<Plan> {
  const task = [...mockDb.tasks.values()][0];
  if (task === undefined) throw new Error('seed task missing');
  return createPlannerClient().createPlan(
    {
      scope: { taskIds: [task.id] },
      horizon: HORIZON,
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
    },
    newActionId('plan-create'),
  );
}

async function mountPlan(planId: string) {
  const router = testRouter();
  await router.push(`/plans/${planId}`);
  await router.isReady();
  const wrapper = mountWithPlugins(PlanComparisonView, { router });
  await settle();
  await vi.waitFor(() => {
    expect(wrapper.text()).toContain('Plan comparison');
    expect(wrapper.findAll('.candidate-card').length).toBeGreaterThan(0);
  });
  return wrapper;
}

function ensureTwoCandidates(plan: Plan): void {
  if (plan.candidates.length < 2) {
    const source = plan.candidates[0];
    if (source === undefined) throw new Error('plan has no candidate');
    const clone = structuredClone(source);
    clone.id = createUuidV7();
    clone.policy = 'balanced';
    plan.candidates.push(clone);
  }
}

describe('plan comparison rendering', () => {
  it('renders signed fractional slack, an infeasible card, explanation and diversity note', async () => {
    const created = await createPlan();
    const stored = mockDb.plans.get(created.id);
    if (stored === undefined) throw new Error('plan was not stored');
    ensureTwoCandidates(stored);
    const first = stored.candidates[0]!;
    const second = stored.candidates[1]!;
    first.metrics.minSlackMin = -0.5;
    first.feasible = false;
    first.deficitMin = 120;
    first.diversityNote = 'Only two distinct plans are possible with this availability.';
    first.explanation = ['Front-loads work before the first deadline.'];
    second.metrics.minSlackMin = 0.5;
    second.feasible = true;

    const wrapper = await mountPlan(created.id);

    expect(wrapper.text()).toContain('−0.5 min');
    expect(wrapper.text()).toContain('+0.5 min');
    expect(wrapper.text()).toContain('Infeasible');
    expect(wrapper.text()).toContain('Deficit: 120 min');
    expect(wrapper.text()).toContain('Front-loads work before the first deadline.');
    expect(wrapper.text()).toContain('Only two distinct plans are possible');

    wrapper.unmount();
  });
});

describe('plan editing preview API', () => {
  it('uses the scheduler validator and reports /blocks/<i> preflight errors', async () => {
    const plan = await createPlan();
    const candidate = plan.candidates.find((item) => item.feasible) ?? plan.candidates[0];
    if (candidate === undefined) throw new Error('candidate missing');
    const task = [...mockDb.tasks.values()][0];
    if (task === undefined) throw new Error('seed task missing');
    const client = createPlannerClient();

    const valid = await client.previewCandidateEdit(
      plan.id,
      candidate.id,
      candidate.blocks,
      newActionId('preview-valid'),
      plan.version,
    );
    expect(valid.feasible).toBe(true);

    const outsideAvailability = await client.previewCandidateEdit(
      plan.id,
      candidate.id,
      [
        {
          taskId: task.id,
          startAt: '2026-11-11T20:00:00.000Z',
          endAt: '2026-11-11T21:00:00.000Z',
        },
      ],
      newActionId('preview-h2'),
      plan.version,
    );
    expect(outsideAvailability.feasible).toBe(false);
    expect(outsideAvailability.violations.map((violation) => violation.code)).toContain('H2');

    await expect(
      client.previewCandidateEdit(
        plan.id,
        candidate.id,
        [
          {
            taskId: task.id,
            startAt: '2026-10-01T00:00:00.000Z',
            endAt: '2026-10-01T01:00:00.000Z',
          },
        ],
        newActionId('preview-preflight'),
        plan.version,
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      problem: { errors: [{ path: '/blocks/0' }] },
    });
  });
});

describe('plan editing preview', () => {
  it('shows H1 violations inline after a keyboard edit', async () => {
    const plan = await createPlan();
    server.use(
      http.post(/\/api\/v1\/plans\/.*\/candidates\/.*:preview-edit$/, () =>
        HttpResponse.json({
          feasible: false,
          violations: [{ code: 'H1', message: 'Blocks overlap each other.' }],
          deficitMin: 0,
        }),
      ),
    );

    const wrapper = await mountPlan(plan.id);
    await vi.waitFor(() => {
      expect(wrapper.findAll('.calendar-block').length).toBeGreaterThan(0);
    });
    const block = wrapper.findAll('.calendar-block')[0]!;
    await block.trigger('keydown', { key: 'ArrowDown' });

    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('Blocks overlap each other');
      },
      { timeout: 3_000 },
    );

    wrapper.unmount();
  });

  it('maps preview 422 errors to the right calendar block', async () => {
    const plan = await createPlan();
    server.use(
      http.post(/\/api\/v1\/plans\/.*\/candidates\/.*:preview-edit$/, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            code: 'validation_failed',
            detail: 'Edited blocks failed pre-flight validation',
            errors: [{ path: '/blocks/0', message: 'block lies outside the plan horizon' }],
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const wrapper = await mountPlan(plan.id);
    await vi.waitFor(() => {
      expect(wrapper.findAll('.calendar-block').length).toBeGreaterThan(0);
    });
    const firstBlock = wrapper.findAll('.calendar-block')[0]!;
    await firstBlock.trigger('keydown', { key: 'ArrowUp' });

    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('Block 1: block lies outside the plan horizon');
      },
      { timeout: 3_000 },
    );
    expect(wrapper.findAll('.calendar-block')[0]?.classes()).toContain('calendar-block--error');

    wrapper.unmount();
  });
});

describe('plan approval API idempotency', () => {
  it('replays the same plan version for a retried Idempotency-Key', async () => {
    const plan = await createPlan();
    const candidate = plan.candidates.find((item) => item.feasible) ?? plan.candidates[0];
    if (candidate === undefined) throw new Error('candidate missing');
    const client = createPlannerClient();
    const key = newActionId('approve-retry');

    const first = await client.approveCandidate(
      plan.id,
      candidate.id,
      key,
      plan.availabilityVersion,
    );
    const replay = await client.approveCandidate(
      plan.id,
      candidate.id,
      key,
      plan.availabilityVersion,
    );

    expect(replay.id).toBe(first.id);
    expect([...mockDb.planVersions.values()]).toHaveLength(1);
  });
});

describe('plan approval', () => {
  it('sends only one approve request for a double click and shows the plan version', async () => {
    const plan = await createPlan();
    const realApprove = plannerClient.approveCandidate.bind(plannerClient);
    let calls = 0;
    const spy = vi
      .spyOn(plannerClient, 'approveCandidate')
      .mockImplementation(async (...args) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return realApprove(...args);
      });

    const wrapper = await mountPlan(plan.id);
    const feasibleCard = wrapper
      .findAll('.candidate-card')
      .find((card) => card.text().includes('Feasible'));
    if (feasibleCard !== undefined) {
      await feasibleCard.get('button').trigger('click');
      await settle();
    }

    const approve = buttonByText(wrapper, 'Approve this plan');
    await approve.trigger('click');
    await approve.trigger('click');

    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('Plan approved');
      },
      { timeout: 3_000 },
    );
    expect(calls).toBe(1);
    expect(wrapper.text()).toContain('Open Today');
    expect(wrapper.text()).toContain('Availability version');

    spy.mockRestore();
    wrapper.unmount();
  });

  it('supports a keyboard-only select and approve path', async () => {
    const plan = await createPlan();
    const wrapper = await mountPlan(plan.id);

    const card = wrapper.findAll('.candidate-card')[0]!;
    const select = card.get('button');
    await select.trigger('keydown', { key: 'Enter' });
    await settle();

    const approve = buttonByText(wrapper, 'Approve this plan');
    (approve.element as HTMLElement).focus();
    expect(document.activeElement).toBe(approve.element);
    await approve.trigger('keydown', { key: 'Enter' });

    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('Plan approved');
      },
      { timeout: 3_000 },
    );

    wrapper.unmount();
  });

  it('shows a 412 banner and regenerates against the latest availability', async () => {
    const plan = await createPlan();
    const other = createPlannerClient();
    const availability = await other.getAvailability({ fresh: true });
    await other.putAvailability(
      {
        timeZone: availability.timeZone,
        rules: availability.rules,
        exceptions: availability.exceptions,
        prefs: { ...availability.prefs, maxDailyFocusMin: 240 },
      },
      newActionId('availability-change'),
      availability.version,
    );

    const wrapper = await mountPlan(plan.id);
    await buttonByText(wrapper, 'Approve this plan').trigger('click');
    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('Availability changed elsewhere');
      },
      { timeout: 3_000 },
    );

    await buttonByText(wrapper, 'Regenerate plan').trigger('click');
    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('Plan regenerated against the latest availability');
      },
      { timeout: 5_000 },
    );

    const regenerated = mockDb.plans.get(plan.id);
    expect(regenerated?.version).toBeGreaterThan(plan.version);
    expect(regenerated?.availabilityVersion).toBe(availability.version + 1);
    expect(wrapper.text()).not.toContain('Availability changed elsewhere');

    wrapper.unmount();
  });
});
