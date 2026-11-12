import type { AvailabilityRule } from '../src/api';
import {
  cellState,
  dayIntervals,
  dayIsOffGrid,
  dayTotals,
  earliestMinute,
  intervalsToRules,
  normaliseClockInput,
  paintSlots,
  parseClock,
  replaceDayRules,
  strokeKind,
  weekTotals,
} from '../src/domain/availabilityGrid';
import { formatHoursAndMinutes } from '../src/i18n/format';

const slot = (clock: string): number => (parseClock(clock) as number) / 30;

function paintDay(
  rules: readonly AvailabilityRule[],
  weekday: number,
  from: string,
  to: string,
  kind: 'work' | 'focus' | null,
): AvailabilityRule[] {
  const intervals = paintSlots(dayIntervals(rules, weekday), slot(from), slot(to), kind);
  return replaceDayRules(rules, weekday, intervalsToRules(weekday, intervals));
}

describe('availability grid: cells → rules', () => {
  it('merges contiguous same-kind cells into one rule per run', () => {
    let rules: AvailabilityRule[] = [];
    rules = paintDay(rules, 1, '09:00', '09:00', 'work');
    rules = paintDay(rules, 1, '09:30', '11:30', 'work');
    expect(rules).toEqual([{ weekday: 1, startLocal: '09:00', endLocal: '12:00', kind: 'work' }]);
  });

  it('splits a run where the kind changes or a cell is erased', () => {
    let rules: AvailabilityRule[] = [{ weekday: 2, startLocal: '09:00', endLocal: '17:00', kind: 'work' }];
    rules = paintDay(rules, 2, '10:00', '10:30', 'focus');
    rules = paintDay(rules, 2, '13:00', '13:00', null);
    expect(rules).toEqual([
      { weekday: 2, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
      { weekday: 2, startLocal: '10:00', endLocal: '11:00', kind: 'focus' },
      { weekday: 2, startLocal: '11:00', endLocal: '13:00', kind: 'work' },
      { weekday: 2, startLocal: '13:30', endLocal: '17:00', kind: 'work' },
    ]);
  });

  it("writes '24:00' for a run that reaches the last slot", () => {
    const rules = paintDay([], 5, '22:00', '23:30', 'work');
    expect(rules).toEqual([{ weekday: 5, startLocal: '22:00', endLocal: '24:00', kind: 'work' }]);
    expect(cellState(dayIntervals(rules, 5), 47)).toEqual({ kind: 'work', covered: 30, full: true });
  });

  it('never writes a 24:00 start or an empty rule (negative)', () => {
    const rules = paintDay([], 5, '23:30', '23:30', 'focus');
    expect(rules).toEqual([{ weekday: 5, startLocal: '23:30', endLocal: '24:00', kind: 'focus' }]);
    expect(paintDay(rules, 5, '23:30', '23:30', null)).toEqual([]);
  });

  it('reads overlapping rules as their union (focus wins) and emits non-overlapping rules once edited', () => {
    const overlapping: AvailabilityRule[] = [
      { weekday: 3, startLocal: '09:00', endLocal: '12:00', kind: 'work' },
      { weekday: 3, startLocal: '11:00', endLocal: '14:00', kind: 'work' },
      { weekday: 3, startLocal: '10:00', endLocal: '11:00', kind: 'focus' },
    ];
    expect(dayIntervals(overlapping, 3)).toEqual([
      { start: 540, end: 600, kind: 'work' },
      { start: 600, end: 660, kind: 'focus' },
      { start: 660, end: 840, kind: 'work' },
    ]);
    expect(dayTotals(overlapping, 3)).toEqual({ work: 240, focus: 60, total: 300 });
    expect(dayIsOffGrid(overlapping, 3)).toBe(true);

    const edited = paintDay(overlapping, 3, '16:00', '16:00', 'work');
    expect(edited).toEqual([
      { weekday: 3, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
      { weekday: 3, startLocal: '10:00', endLocal: '11:00', kind: 'focus' },
      { weekday: 3, startLocal: '11:00', endLocal: '14:00', kind: 'work' },
      { weekday: 3, startLocal: '16:00', endLocal: '16:30', kind: 'work' },
    ]);
    for (const [index, rule] of edited.entries()) {
      const next = edited[index + 1];
      if (next !== undefined) expect(rule.endLocal <= next.startLocal).toBe(true);
    }
  });

  it('keeps off-grid edges exactly and leaves other weekdays as the same objects', () => {
    const monday = { weekday: 1, startLocal: '09:15', endLocal: '17:45', kind: 'work' as const };
    const tuesday = { weekday: 2, startLocal: '08:10', endLocal: '12:05', kind: 'focus' as const };
    const friday = { weekday: 5, startLocal: '13:00', endLocal: '15:00', kind: 'work' as const };
    const rules = [monday, tuesday, friday];

    expect(dayIsOffGrid(rules, 1)).toBe(true);
    expect(dayIsOffGrid(rules, 5)).toBe(false);
    expect(cellState(dayIntervals(rules, 1), slot('09:00'))).toEqual({ kind: 'work', covered: 15, full: false });
    expect(cellState(dayIntervals(rules, 1), slot('17:30'))).toEqual({ kind: 'work', covered: 15, full: false });

    const edited = paintDay(rules, 1, '20:00', '20:00', 'focus');
    // Only the painted part changed; the 09:15 / 17:45 edges survive.
    expect(edited.filter((rule) => rule.weekday === 1)).toEqual([
      { weekday: 1, startLocal: '09:15', endLocal: '17:45', kind: 'work' },
      { weekday: 1, startLocal: '20:00', endLocal: '20:30', kind: 'focus' },
    ]);
    expect(edited[2]).toBe(tuesday);
    expect(edited[3]).toBe(friday);
  });

  it('painting a partially covered cell fills that whole cell', () => {
    const rules: AvailabilityRule[] = [{ weekday: 1, startLocal: '09:15', endLocal: '10:00', kind: 'work' }];
    expect(paintDay(rules, 1, '09:00', '09:00', 'work')).toEqual([
      { weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
    ]);
  });

  it('places a new weekday in weekday order and keeps the others in place', () => {
    const rules: AvailabilityRule[] = [
      { weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
      { weekday: 4, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
    ];
    expect(paintDay(rules, 2, '09:00', '09:00', 'work').map((rule) => rule.weekday)).toEqual([1, 2, 4]);
    expect(paintDay(rules, 7, '09:00', '09:00', 'work').map((rule) => rule.weekday)).toEqual([1, 4, 7]);
  });

  it('skips malformed rules instead of guessing (negative)', () => {
    const rules: AvailabilityRule[] = [
      { weekday: 1, startLocal: '9:00', endLocal: '10:00', kind: 'work' },
      { weekday: 1, startLocal: '11:00', endLocal: '11:00', kind: 'work' },
      { weekday: 1, startLocal: '12:00', endLocal: '24:30', kind: 'work' },
    ];
    expect(dayIntervals(rules, 1)).toEqual([]);
    expect(earliestMinute(rules)).toBeNull();
  });
});

describe('availability grid: brush strokes', () => {
  it('erases with the same brush on a full cell and paints otherwise', () => {
    const work = { kind: 'work' as const, covered: 30, full: true };
    const partial = { kind: 'work' as const, covered: 15, full: false };
    const empty = { kind: null, covered: 0, full: false };
    expect(strokeKind('work', work)).toBeNull();
    expect(strokeKind('focus', work)).toBe('focus');
    expect(strokeKind('work', partial)).toBe('work');
    expect(strokeKind('work', empty)).toBe('work');
    expect(strokeKind('erase', empty)).toBeNull();
  });
});

describe('availability grid: totals', () => {
  it('sums each day and the week, counting overlaps once', () => {
    const rules: AvailabilityRule[] = [
      { weekday: 1, startLocal: '09:00', endLocal: '13:30', kind: 'work' },
      { weekday: 1, startLocal: '12:00', endLocal: '13:30', kind: 'work' },
      { weekday: 2, startLocal: '10:00', endLocal: '12:00', kind: 'focus' },
      { weekday: 6, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
    ];
    expect(dayTotals(rules, 1).total).toBe(270);
    expect(formatHoursAndMinutes(dayTotals(rules, 1).total)).toBe('4시간 30분');
    expect(formatHoursAndMinutes(dayTotals(rules, 6).total)).toBe('24시간');
    expect(weekTotals(rules)).toEqual({ work: 270 + 1440, focus: 120, total: 270 + 1440 + 120 });
    expect(formatHoursAndMinutes(weekTotals(rules).total)).toBe('30시간 30분');
  });

  it('reads an empty day as 0분 and never rolls hours into days (negative)', () => {
    expect(dayTotals([], 3)).toEqual({ work: 0, focus: 0, total: 0 });
    expect(formatHoursAndMinutes(0)).toBe('0분');
    expect(formatHoursAndMinutes(40 * 60)).toBe('40시간');
    expect(formatHoursAndMinutes(40 * 60)).not.toContain('일');
  });
});

describe('clock input normalisation', () => {
  it('tidies short forms and keeps 24:00', () => {
    expect(normaliseClockInput('9')).toBe('09:00');
    expect(normaliseClockInput('930')).toBe('09:30');
    expect(normaliseClockInput('9:5')).toBe('09:05');
    expect(normaliseClockInput('24')).toBe('24:00');
    expect(normaliseClockInput(' 18:00 ')).toBe('18:00');
    expect(normaliseClockInput('')).toBe('');
  });

  it('leaves unreadable input as typed so validation can name it (negative)', () => {
    expect(normaliseClockInput('25:00')).toBe('25:00');
    expect(normaliseClockInput('24:30')).toBe('24:30');
    expect(normaliseClockInput('noon')).toBe('noon');
    expect(parseClock('24:30')).toBeNull();
    expect(parseClock('7:00')).toBeNull();
  });
});
