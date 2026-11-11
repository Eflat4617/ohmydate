import { expandOccurrences, InvalidRRuleError, parseRRule } from '../src/application/rrule.js';

function commitment(startAt: string, endAt: string, rrule: string, timeZone = 'UTC') {
  return { startAt, endAt, timeZone, rrule };
}

describe('bounded RRULE adapter', () => {
  test('rejects unsupported parts and combinations', () => {
    for (const rrule of [
      'FREQ=DAILY;BYSETPOS=1',
      'FREQ=DAILY;BYMONTH=11',
      'FREQ=DAILY;BYHOUR=9',
      'FREQ=DAILY;BYDAY=MO',
      'FREQ=MONTHLY;BYDAY=1MO',
      'FREQ=MONTHLY;BYDAY=MO',
      'FREQ=WEEKLY;BYMONTHDAY=15',
      'FREQ=DAILY;WKST=SU',
      'FREQ=DAILY;COUNT=2;UNTIL=20261113T090000Z',
      'FREQ=HOURLY',
      'FREQ=WEEKLY;BYDAY=1MO',
    ]) {
      expect(() => parseRRule(rrule)).toThrow(InvalidRRuleError);
    }
  });

  test('accepts the documented subset', () => {
    expect(() => parseRRule('FREQ=DAILY;INTERVAL=2;COUNT=5')).not.toThrow();
    expect(() => parseRRule('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;WKST=MO')).not.toThrow();
    expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=15')).not.toThrow();
    expect(() => parseRRule('FREQ=YEARLY;UNTIL=20261231T000000Z')).not.toThrow();
  });

  test('UNTIL is inclusive for an instant', () => {
    const occurrences = expandOccurrences(
      commitment(
        '2026-11-11T09:00:00Z',
        '2026-11-11T10:00:00Z',
        'FREQ=DAILY;UNTIL=20261113T090000Z',
      ),
      '2026-11-11T00:00:00Z',
      '2026-11-15T00:00:00Z',
    );
    expect(occurrences.map((entry) => entry.startAt)).toEqual([
      '2026-11-11T09:00:00Z',
      '2026-11-12T09:00:00Z',
      '2026-11-13T09:00:00Z',
    ]);
  });

  test('DATE-form UNTIL means the end of that local day', () => {
    const occurrences = expandOccurrences(
      commitment(
        '2026-11-11T14:00:00Z',
        '2026-11-11T15:00:00Z',
        'FREQ=DAILY;UNTIL=20261113',
        'America/New_York',
      ),
      '2026-11-11T00:00:00Z',
      '2026-11-16T00:00:00Z',
    );
    expect(occurrences.map((entry) => entry.startAt)).toEqual([
      '2026-11-11T14:00:00Z',
      '2026-11-12T14:00:00Z',
      '2026-11-13T14:00:00Z',
    ]);
  });

  test('MONTHLY BYMONTHDAY selects the requested day', () => {
    const occurrences = expandOccurrences(
      commitment(
        '2026-11-02T09:00:00Z',
        '2026-11-02T10:00:00Z',
        'FREQ=MONTHLY;BYMONTHDAY=15',
      ),
      '2026-11-01T00:00:00Z',
      '2027-02-01T00:00:00Z',
    );
    expect(occurrences.map((entry) => entry.startAt)).toEqual([
      '2026-11-15T09:00:00Z',
      '2026-12-15T09:00:00Z',
      '2027-01-15T09:00:00Z',
    ]);
  });

  test('DST gap shifts forward and overlap chooses the first occurrence', () => {
    const gap = expandOccurrences(
      commitment(
        '2027-03-13T07:30:00Z',
        '2027-03-13T08:30:00Z',
        'FREQ=DAILY',
        'America/New_York',
      ),
      '2027-03-13T00:00:00Z',
      '2027-03-16T00:00:00Z',
    );
    expect(gap.map((entry) => entry.startAt)).toEqual([
      '2027-03-13T07:30:00Z',
      '2027-03-14T07:30:00Z',
      '2027-03-15T06:30:00Z',
    ]);

    const overlap = expandOccurrences(
      commitment(
        '2026-10-31T05:30:00Z',
        '2026-10-31T06:30:00Z',
        'FREQ=DAILY',
        'America/New_York',
      ),
      '2026-10-31T00:00:00Z',
      '2026-11-03T00:00:00Z',
    );
    expect(overlap.map((entry) => entry.startAt)).toEqual([
      '2026-10-31T05:30:00Z',
      '2026-11-01T05:30:00Z',
      '2026-11-02T06:30:00Z',
    ]);
  });

  test('rejects a recurrence that starts more than ten years before the range', () => {
    expect(() =>
      expandOccurrences(
        commitment(
          '2000-01-01T09:00:00Z',
          '2000-01-01T10:00:00Z',
          'FREQ=YEARLY',
        ),
        '2026-01-01T00:00:00Z',
        '2026-12-01T00:00:00Z',
      ),
    ).toThrow(InvalidRRuleError);
  });
});
