import { createPlannerClient, newActionId } from '../src/api';
import CommitmentsView from '../src/views/CommitmentsView.vue';
import { expandOccurrences } from '../src/domain/rrule';
import { localParts } from '../src/domain/time';
import { SEED_COMMITMENT_ID, mockDb } from '../src/mocks/db';
import { mountWithPlugins, settle } from './planning-test-utils';

describe('weekly rrule expansion', () => {
  it('expands weekly BYDAY rules in the commitment time zone', () => {
    const occurrences = expandOccurrences(
      {
        startAt: '2026-11-04T00:00:00.000Z',
        endAt: '2026-11-04T01:00:00.000Z',
        timeZone: 'Asia/Seoul',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      },
      '2026-11-01T00:00:00.000Z',
      '2026-11-16T00:00:00.000Z',
    );

    expect(occurrences.map((occurrence) => localParts(occurrence.startAt, 'Asia/Seoul').date)).toEqual([
      '2026-11-04',
      '2026-11-09',
      '2026-11-11',
    ]);
    for (const occurrence of occurrences) {
      expect(localParts(occurrence.startAt, 'Asia/Seoul').minutes).toBe(9 * 60);
    }
  });

  it('keeps the local wall clock across a DST transition', () => {
    const occurrences = expandOccurrences(
      {
        startAt: '2026-10-26T13:00:00.000Z',
        endAt: '2026-10-26T14:00:00.000Z',
        timeZone: 'America/New_York',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      },
      '2026-10-26T00:00:00.000Z',
      '2026-11-10T00:00:00.000Z',
    );
    expect(occurrences).toHaveLength(3);
    for (const occurrence of occurrences) {
      const parts = localParts(occurrence.startAt, 'America/New_York');
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(0);
    }
    expect(occurrences[0]?.startAt).toBe('2026-10-26T13:00:00.000Z');
    expect(occurrences[2]?.startAt).toBe('2026-11-09T14:00:00.000Z');
  });
});

describe('commitment handlers', () => {
  it('returns expanded occurrences and bumps availability_version on writes', async () => {
    const client = createPlannerClient();
    const before = mockDb.availabilityVersion;
    const page = await client.listCommitments({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-16T00:00:00.000Z',
    });
    const seeded = page.items.find((item) => item.id === SEED_COMMITMENT_ID);
    expect(seeded?.occurrences?.length).toBeGreaterThan(0);

    const created = await client.createCommitment(
      {
        title: 'Weekly writing',
        startAt: '2026-11-05T10:00:00.000Z',
        endAt: '2026-11-05T11:00:00.000Z',
        timeZone: 'Asia/Seoul',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
      },
      newActionId('commitment-create'),
    );
    expect(created.version).toBe(1);
    expect(mockDb.availabilityVersion).toBe(before + 1);

    const updated = await client.updateCommitment(
      created.id,
      { title: 'Weekly writing (edited)' },
      newActionId('commitment-update'),
      created.version,
    );
    expect(updated.version).toBe(2);
    expect(mockDb.availabilityVersion).toBe(before + 2);

    await client.deleteCommitment(created.id, newActionId('commitment-delete'), updated.version);
    expect(mockDb.commitments.has(created.id)).toBe(false);
    expect(mockDb.availabilityVersion).toBe(before + 3);
  });
});

describe('commitment editor', () => {
  it('shows an occurrence preview for a weekly preset', async () => {
    const wrapper = mountWithPlugins(CommitmentsView);
    await settle();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('팀 회의');
    });

    await wrapper.get('#commitment-from').setValue('2026-11-01');
    await wrapper.get('#commitment-to').setValue('2026-11-15');
    await wrapper.get('#commitment-title').setValue('Weekly study');
    await wrapper.get('#commitment-start').setValue('2026-11-04T09:00');
    await wrapper.get('#commitment-end').setValue('2026-11-04T10:00');
    await wrapper.get('#commitment-rrule').setValue('FREQ=WEEKLY;BYDAY=MO,WE');
    await settle();

    await vi.waitFor(() => {
      const preview = wrapper.findAll('.occurrence-list li').map((item) => item.text());
      expect(preview.some((line) => line.includes('11월 4일 (수) 오전 9:00~10:00'))).toBe(true);
      expect(preview.some((line) => line.includes('11월 9일 (월) 오전 9:00~10:00'))).toBe(true);
    });

    wrapper.unmount();
  });
});
