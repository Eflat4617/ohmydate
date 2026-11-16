import {
  formatCivilDate,
  formatCivilDateRange,
  formatCivilMonthDay,
  formatCivilWeekday,
  formatDate,
  formatDateTime,
  formatDateTimeRange,
  formatDuration,
  formatHour,
  formatPercent,
  formatSignedDuration,
  formatTime,
  formatTimeRange,
  formatTimer,
  formatUsd,
  minutesBetween,
} from '../src/i18n/format';

const SEOUL = 'Asia/Seoul';
const NEW_YORK = 'America/New_York';

describe('formatDuration (shared minutes formatter)', () => {
  it('reads hours and minutes the Korean way', () => {
    expect(formatDuration(90)).toBe('1시간 30분');
    expect(formatDuration(35)).toBe('35분');
    expect(formatDuration(60)).toBe('1시간');
    expect(formatDuration(120)).toBe('2시간');
    expect(formatDuration(1439)).toBe('23시간 59분');
  });

  it('renders zero as 0분 with no sign', () => {
    expect(formatDuration(0)).toBe('0분');
    expect(formatDuration(-0)).toBe('0분');
    expect(formatSignedDuration(0)).toBe('0분');
  });

  it('switches to days and hours from one day on, rounding to the hour', () => {
    expect(formatDuration(1440)).toBe('1일');
    expect(formatDuration(11 * 1440 + 10 * 60)).toBe('11일 10시간');
    expect(formatDuration(11 * 1440 + 10 * 60 + 29)).toBe('11일 10시간');
    expect(formatDuration(11 * 1440 + 10 * 60 + 31)).toBe('11일 11시간');
    // 23h 59.6m rounds up to a whole day instead of "23시간 60분".
    expect(formatDuration(1439.6)).toBe('1일');
  });

  it('prefixes negative values with U+2212 and positive signed values with +', () => {
    expect(formatDuration(-35)).toBe('−35분');
    expect(formatDuration(-90)).toBe('−1시간 30분');
    expect(formatSignedDuration(-35)).toBe('−35분');
    expect(formatSignedDuration(11 * 1440 + 10 * 60)).toBe('+11일 10시간');
    expect(formatSignedDuration(-(2 * 1440 + 3 * 60))).toBe('−2일 3시간');
  });

  it('keeps sub-minute values visible and signed instead of rounding them to 0분', () => {
    expect(formatDuration(0.4)).toBe('1분 미만');
    expect(formatSignedDuration(0.5)).toBe('+1분 미만');
    expect(formatSignedDuration(-0.4)).toBe('−1분 미만');
    expect(formatDuration(30.4)).toBe('30분');
    expect(formatDuration(30.6)).toBe('31분');
  });

  it('never prints NaN or Infinity (negative)', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatSignedDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('date and time formatters (Intl, user time zone)', () => {
  it('formats a date as 11월 14일 (토) and a time as 오후 7:00 in the user zone', () => {
    expect(formatDate('2026-11-14T10:00:00.000Z', SEOUL)).toBe('11월 14일 (토)');
    expect(formatTime('2026-11-14T10:00:00.000Z', SEOUL)).toBe('오후 7:00');
    expect(formatTime('2026-11-13T15:30:00.000Z', SEOUL)).toBe('오전 12:30');
    expect(formatTime('2026-11-14T03:05:00.000Z', SEOUL)).toBe('오후 12:05');
    expect(formatDateTime('2026-11-14T10:00:00.000Z', SEOUL)).toBe('11월 14일 (토) 오후 7:00');
  });

  it('uses the given zone, not the machine zone, for the calendar date', () => {
    // 2026-11-14 23:30 UTC is already Sunday morning in Seoul but still Saturday in New York.
    expect(formatDate('2026-11-14T23:30:00.000Z', SEOUL)).toBe('11월 15일 (일)');
    expect(formatDate('2026-11-14T23:30:00.000Z', NEW_YORK)).toBe('11월 14일 (토)');
  });

  it('adds the year on request and formats civil dates without zone conversion', () => {
    expect(formatDate('2026-11-14T10:00:00.000Z', SEOUL, { year: true })).toBe('2026년 11월 14일 (토)');
    expect(formatCivilDate('2026-11-14')).toBe('11월 14일 (토)');
    expect(formatCivilDate('2026-11-14', { year: true })).toBe('2026년 11월 14일 (토)');
    expect(formatCivilMonthDay('2026-11-14')).toBe('11월 14일');
    expect(formatCivilWeekday('2026-11-16')).toBe('월');
  });

  it('collapses the repeated day period in a same-day range', () => {
    expect(formatTimeRange('2026-11-14T10:00:00.000Z', '2026-11-14T11:30:00.000Z', SEOUL)).toBe('오후 7:00~8:30');
    expect(formatTimeRange('2026-11-14T01:30:00.000Z', '2026-11-14T04:30:00.000Z', SEOUL)).toBe(
      '오전 10:30~오후 1:30',
    );
    expect(formatDateTimeRange('2026-11-14T10:00:00.000Z', '2026-11-14T11:30:00.000Z', SEOUL)).toBe(
      '11월 14일 (토) 오후 7:00~8:30',
    );
  });

  it('puts the date on both ends when a range crosses local midnight', () => {
    expect(formatTimeRange('2026-11-14T14:00:00.000Z', '2026-11-14T16:00:00.000Z', SEOUL)).toBe(
      '11월 14일 (토) 오후 11:00~11월 15일 (일) 오전 1:00',
    );
    expect(formatDateTimeRange('2026-11-14T14:00:00.000Z', '2026-11-14T16:00:00.000Z', SEOUL)).toBe(
      '11월 14일 (토) 오후 11:00~11월 15일 (일) 오전 1:00',
    );
  });

  it('formats a civil week range with the year on the first date only', () => {
    expect(formatCivilDateRange('2026-11-16', '2026-11-22')).toBe('11월 16일 (월) ~ 11월 22일 (일)');
    expect(formatCivilDateRange('2026-11-16', '2026-11-22', { year: true })).toBe(
      '2026년 11월 16일 (월) ~ 11월 22일 (일)',
    );
  });

  it('labels calendar hours with the day period', () => {
    expect(formatHour(0)).toBe('오전 12시');
    expect(formatHour(9)).toBe('오전 9시');
    expect(formatHour(13)).toBe('오후 1시');
  });

  it('rejects an invalid instant and leaves a malformed civil date untouched (negative)', () => {
    expect(() => formatTime('not-a-date', SEOUL)).toThrow(RangeError);
    expect(() => formatTimeRange('2026-11-14T10:00:00.000Z', 'nope', SEOUL)).toThrow(RangeError);
    expect(formatCivilDate('2026/11/14')).toBe('2026/11/14');
  });
});

describe('DST days', () => {
  it('skips the spring-forward gap in America/New_York (2026-03-08)', () => {
    expect(formatTime('2026-03-08T06:59:00.000Z', NEW_YORK)).toBe('오전 1:59');
    expect(formatTime('2026-03-08T07:00:00.000Z', NEW_YORK)).toBe('오전 3:00');
    // One real hour reads 1:30–3:30 on the wall clock.
    expect(formatTimeRange('2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z', NEW_YORK)).toBe(
      '오전 1:30~3:30',
    );
    expect(formatDuration(minutesBetween('2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z'))).toBe('1시간');
    // The local day itself is 23 hours long.
    expect(formatDuration(minutesBetween('2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'))).toBe('23시간');
  });

  it('repeats the fall-back hour (2026-11-01) and counts a 25-hour day', () => {
    // 05:30Z is 1:30 EDT and 06:30Z is 1:30 EST: same wall clock, one real hour apart.
    expect(formatTime('2026-11-01T05:30:00.000Z', NEW_YORK)).toBe('오전 1:30');
    expect(formatTime('2026-11-01T06:30:00.000Z', NEW_YORK)).toBe('오전 1:30');
    expect(formatTimeRange('2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z', NEW_YORK)).toBe(
      '오전 1:30~1:30',
    );
    expect(formatDate('2026-11-01T05:30:00.000Z', NEW_YORK)).toBe('11월 1일 (일)');
    expect(formatDuration(minutesBetween('2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'))).toBe('1일 1시간');
  });
});

describe('numbers, money and the timer', () => {
  it('shows USD with two to four decimals', () => {
    expect(formatUsd(0.2)).toBe('$0.20');
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(0.0035)).toBe('$0.0035');
    expect(formatUsd(0.123456)).toBe('$0.1235');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('formats ratios as percentages', () => {
    expect(formatPercent(0.925)).toBe('92.5%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.5, 0)).toBe('50%');
  });

  it('keeps the focus timer as a clock and never goes negative', () => {
    expect(formatTimer(0)).toBe('00:00');
    expect(formatTimer(25 * 60 + 7)).toBe('25:07');
    expect(formatTimer(3723)).toBe('1:02:03');
    expect(formatTimer(-5)).toBe('00:00');
  });

  it('never reports negative elapsed minutes (negative)', () => {
    expect(minutesBetween('2026-11-14T11:00:00.000Z', '2026-11-14T10:00:00.000Z')).toBe(0);
  });
});

describe('a time of day says 오전/오후 itself, whatever the engine knows (HOLO-06)', () => {
  // The desktop shell runs on a WebKit engine whose locale data has the Korean
  // months and weekdays but not the day periods: asked for a Korean time it
  // answers "PM 7:00". The engine below does the same. The formatters are
  // imported fresh under it, so nothing they cached with the real one helps.
  const RealDateTimeFormat = Intl.DateTimeFormat;

  class NoKoreanDayPeriods extends RealDateTimeFormat {
    override formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
      return super
        .formatToParts(date)
        .map((part) => (part.type === 'dayPeriod' ? { ...part, value: part.value === '오전' ? 'AM' : 'PM' } : part));
    }

    override format(date?: Date | number): string {
      return this.formatToParts(date)
        .map((part) => part.value)
        .join('');
    }
  }

  async function underThatEngine(run: (format: typeof import('../src/i18n/format')) => void): Promise<void> {
    Intl.DateTimeFormat = NoKoreanDayPeriods as typeof Intl.DateTimeFormat;
    vi.resetModules();
    try {
      run(await import('../src/i18n/format'));
    } finally {
      Intl.DateTimeFormat = RealDateTimeFormat;
      vi.resetModules();
    }
  }

  afterEach(() => {
    Intl.DateTimeFormat = RealDateTimeFormat;
  });

  it('the engine in this test really answers "PM 7:00" (or the checks below would prove nothing)', () => {
    const asked = { hour: 'numeric', minute: '2-digit', timeZone: SEOUL } as const;
    const instant = new Date('2026-11-14T10:00:00.000Z');
    expect(new RealDateTimeFormat('ko-KR', asked).format(instant)).toBe('오후 7:00');
    expect(new NoKoreanDayPeriods('ko-KR', asked).format(instant)).toBe('PM 7:00');
    expect(new NoKoreanDayPeriods('ko-KR', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 5, 9)))).toBe('AM 9시');
  });

  it('a time, a date with a time, an hour label and a range never read "PM 7:00"', async () => {
    await underThatEngine((format) => {
      expect(format.formatTime('2026-11-14T10:00:00.000Z', SEOUL)).toBe('오후 7:00');
      expect(format.formatTime('2026-11-14T00:05:00.000Z', SEOUL)).toBe('오전 9:05');
      expect(format.formatDateTime('2026-11-06T09:00:00.000Z', SEOUL)).toBe('11월 6일 (금) 오후 6:00');
      expect(format.formatHour(9)).toBe('오전 9시');
      expect(format.formatHour(19)).toBe('오후 7시');
      expect(format.formatTimeRange('2026-11-14T10:00:00.000Z', '2026-11-14T11:30:00.000Z', SEOUL)).toBe('오후 7:00~8:30');
      expect(format.formatTimeRange('2026-11-14T01:30:00.000Z', '2026-11-14T04:30:00.000Z', SEOUL)).toBe('오전 10:30~오후 1:30');
      expect(format.formatDateTimeRange('2026-11-14T10:00:00.000Z', '2026-11-14T11:30:00.000Z', SEOUL)).toBe(
        '11월 14일 (토) 오후 7:00~8:30',
      );
      // The other zone's wall clock, not the machine's.
      expect(format.formatTime('2026-11-14T10:00:00.000Z', NEW_YORK)).toBe('오전 5:00');
      expect(format.formatClock('2026-11-14T10:00:00.000Z', SEOUL)).toBe('19:00');
    });
  });

  it('noon and midnight keep their Korean reading: there is no 0시 and no 24시 (negative)', async () => {
    await underThatEngine((format) => {
      expect(format.formatTime('2026-11-13T15:00:00.000Z', SEOUL)).toBe('오전 12:00');
      expect(format.formatTime('2026-11-14T03:00:00.000Z', SEOUL)).toBe('오후 12:00');
      expect(format.formatHour(0)).toBe('오전 12시');
      expect(format.formatHour(12)).toBe('오후 12시');
      expect(format.formatHour(24)).toBe('오전 12시');
      expect(format.formatClock('2026-11-13T15:00:00.000Z', SEOUL)).toBe('00:00');
    });
    // The real engine reads the same, so nothing on screen changed where the data is there.
    expect(formatTime('2026-11-13T15:00:00.000Z', SEOUL)).toBe('오전 12:00');
    expect(formatHour(12)).toBe('오후 12시');
    expect(formatHour(24)).toBe('오전 12시');
  });
});
