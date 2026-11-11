import { createPlannerClient, newActionId, plannerClient, type AvailabilityPut } from '../src/api';
import AvailabilityView from '../src/views/AvailabilityView.vue';
import { mockDb } from '../src/mocks/db';
import {
  buttonByText,
  mountWithPlugins,
  settle,
} from './planning-test-utils';

function putPayload(version: number, maxDailyFocusMin: number): AvailabilityPut {
  return {
    timeZone: 'Asia/Seoul',
    rules: [
      { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      { weekday: 2, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
    ],
    exceptions: [{ date: '2026-11-13', kind: 'off' }],
    prefs: {
      maxDailyFocusMin,
      breakAfterMin: 60,
      breakMin: 15,
      dayStartLocal: '08:00',
      dayEndLocal: '22:00',
      riskLevel: 'p50',
    },
  };
}

describe('availability API preconditions', () => {
  it('bumps the user-wide version and rejects a stale If-Match without storing it', async () => {
    const client = createPlannerClient();
    const current = await client.getAvailability({ fresh: true });
    const key = newActionId('availability');
    const updated = await client.putAvailability(putPayload(current.version, 240), key, current.version);

    expect(updated.version).toBe(current.version + 1);
    expect(mockDb.availabilityVersion).toBe(current.version + 1);

    const staleKey = newActionId('availability-stale');
    await expect(
      client.putAvailability(putPayload(current.version, 180), staleKey, current.version),
    ).rejects.toMatchObject({ status: 412, code: 'availability_changed' });
    expect(mockDb.idempotency.has(staleKey)).toBe(false);
    expect(mockDb.availability.prefs.maxDailyFocusMin).toBe(240);
  });
});

describe('availability editor', () => {
  it('keeps local edits when a 412 is merged from the server version', async () => {
    const wrapper = mountWithPlugins(AvailabilityView);
    await settle();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Weekly rules');
    });

    const localFocus = wrapper.get('#pref-max-focus');
    await localFocus.setValue('240');
    expect((localFocus.element as HTMLInputElement).value).toBe('240');

    const otherDevice = createPlannerClient();
    const current = await otherDevice.getAvailability({ fresh: true });
    await otherDevice.putAvailability(
      putPayload(current.version, 300),
      newActionId('other-availability'),
      current.version,
    );

    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Availability changed elsewhere');
    });

    expect((wrapper.get('#pref-max-focus').element as HTMLInputElement).value).toBe('240');
    await buttonByText(wrapper, 'Keep my changes and retry').trigger('click');
    await settle();
    expect(wrapper.text()).toContain('Your edits were kept');

    const save = wrapper.get('#availability-save');
    await save.trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Availability saved as version 3');
    });

    const reloaded = await plannerClient.getAvailability({ fresh: true });
    expect(reloaded.version).toBe(3);
    expect(reloaded.prefs.maxDailyFocusMin).toBe(240);

    wrapper.unmount();
  });
});
