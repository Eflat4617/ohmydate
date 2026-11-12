import { describe, expect, it } from 'vitest';
import {
  blockSeries,
  dayTimetable,
  timetableNow,
  TIMETABLE_DONE_SERIES,
  TIMETABLE_OTHER_SERIES,
} from '../src/domain/dayTimetable';

const ZONE = 'Asia/Seoul';
const DATE = '2026-11-14';

/** An instant from a Seoul wall-clock time (UTC+9, no DST). */
function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function runsAt(rows: ReturnType<typeof dayTimetable>, hour: number) {
  return rows.find((row) => row.hour === hour)?.runs ?? [];
}

describe('dayTimetable', () => {
  it('draws 06:00 to midnight when nothing starts earlier', () => {
    const rows = dayTimetable([], DATE, ZONE, null);
    expect(rows[0]?.hour).toBe(6);
    expect(rows.at(-1)?.hour).toBe(23);
    expect(rows).toHaveLength(18);
    expect(rows.every((row) => row.runs.length === 0)).toBe(true);
  });

  it('splits a block into one run per hour it covers, as fractions of the hour', () => {
    const rows = dayTimetable(
      [{ id: 'a', startAt: seoul(DATE, '19:00'), endAt: seoul(DATE, '20:30') }],
      DATE,
      ZONE,
      'a',
    );
    expect(runsAt(rows, 19)).toEqual([{ blockId: 'a', series: 0, from: 0, to: 1 }]);
    expect(runsAt(rows, 20)).toEqual([{ blockId: 'a', series: 0, from: 0, to: 0.5 }]);
    expect(runsAt(rows, 21)).toEqual([]);
  });

  it('keeps a start that is off the ten-minute grid where it really is', () => {
    const rows = dayTimetable(
      [{ id: 'a', startAt: seoul(DATE, '21:15'), endAt: seoul(DATE, '21:45') }],
      DATE,
      ZONE,
      null,
    );
    expect(runsAt(rows, 21)).toEqual([{ blockId: 'a', series: 1, from: 0.25, to: 0.75 }]);
  });

  it('starts the page earlier when a block starts before 06:00', () => {
    const rows = dayTimetable(
      [{ id: 'early', startAt: seoul(DATE, '04:30'), endAt: seoul(DATE, '05:00') }],
      DATE,
      ZONE,
      null,
    );
    expect(rows[0]?.hour).toBe(4);
    expect(runsAt(rows, 4)).toEqual([{ blockId: 'early', series: 1, from: 0.5, to: 1 }]);
  });

  it('clips a block that crosses midnight to the day shown', () => {
    const late = { id: 'late', startAt: seoul(DATE, '23:30'), endAt: seoul('2026-11-15', '00:30') };
    const tonight = dayTimetable([late], DATE, ZONE, null);
    expect(runsAt(tonight, 23)).toEqual([{ blockId: 'late', series: 1, from: 0.5, to: 1 }]);

    const tomorrow = dayTimetable([late], '2026-11-15', ZONE, null);
    expect(tomorrow[0]?.hour).toBe(0);
    expect(runsAt(tomorrow, 0)).toEqual([{ blockId: 'late', series: 1, from: 0, to: 0.5 }]);
  });

  it('leaves out blocks that are not on the day, run backwards or are not instants', () => {
    const rows = dayTimetable(
      [
        { id: 'yesterday', startAt: seoul('2026-11-13', '19:00'), endAt: seoul('2026-11-13', '20:00') },
        { id: 'tomorrow', startAt: seoul('2026-11-15', '09:00'), endAt: seoul('2026-11-15', '10:00') },
        { id: 'backwards', startAt: seoul(DATE, '20:00'), endAt: seoul(DATE, '19:00') },
        { id: 'empty', startAt: seoul(DATE, '10:00'), endAt: seoul(DATE, '10:00') },
        { id: 'broken', startAt: 'not-a-date', endAt: seoul(DATE, '12:00') },
      ],
      DATE,
      ZONE,
      null,
    );
    expect(rows).toHaveLength(18);
    expect(rows.flatMap((row) => row.runs)).toEqual([]);
  });
});

describe('blockSeries', () => {
  it('gives the next block series 0 and cycles the others in order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
    const series = blockSeries(ids, 'c');
    expect(series.get('c')).toBe(0);
    expect(['a', 'b', 'd', 'e', 'f'].map((id) => series.get(id))).toEqual([1, 2, 3, 1, 2]);
    expect(Math.max(...series.values())).toBe(TIMETABLE_OTHER_SERIES);
  });

  it('marks a finished block with the done series, unless it is somehow the next one', () => {
    const series = blockSeries(
      [
        { id: 'a', status: 'done' },
        { id: 'b', status: 'planned' },
        { id: 'c', status: 'done' },
      ],
      'c',
    );
    expect(series.get('a')).toBe(TIMETABLE_DONE_SERIES);
    expect(series.get('b')).toBe(1);
    expect(series.get('c')).toBe(0);
  });

  it('never hands out series 0 when no block is next', () => {
    const series = blockSeries([{ id: 'a' }, { id: 'b' }], null);
    expect([...series.values()]).toEqual([1, 2]);
  });
});

describe('timetableNow', () => {
  it('places now in its hour row as a fraction of the hour', () => {
    const now = Date.parse(seoul(DATE, '18:40'));
    expect(timetableNow(now, DATE, ZONE, 6)).toEqual({ hour: 18, at: 40 / 60 });
  });

  it('has no mark on another day, before the first row, or for a broken clock', () => {
    expect(timetableNow(Date.parse(seoul('2026-11-15', '09:00')), DATE, ZONE, 6)).toBeNull();
    expect(timetableNow(Date.parse(seoul(DATE, '05:10')), DATE, ZONE, 6)).toBeNull();
    expect(timetableNow(Number.NaN, DATE, ZONE, 6)).toBeNull();
  });
});
