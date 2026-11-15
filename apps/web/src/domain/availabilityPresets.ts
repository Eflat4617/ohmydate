/**
 * "언제 일할 수 있나요?" (HOLO-03A, FLOW §2): the quick answers 계획 세우기
 * offers when the owner has not set any available hours yet. A preset is a
 * stretch of the day on some weekdays; picking it paints those hours as 작업
 * time, taking it back clears them. The weekly rules stay the one model
 * (domain/availabilityGrid.ts), so what is picked here is exactly what the
 * 가용 시간 screen shows later.
 */
import type { AvailabilityRule } from '../api';
import { dayIntervals, intervalsToRules, paintInterval, replaceDayRules } from './availabilityGrid';

export interface AvailabilityPreset {
  readonly id: 'weekdayEvening' | 'weekendAfternoon' | 'weekdayDay';
  /** ISO weekdays, Monday = 1. */
  readonly weekdays: readonly number[];
  /** Minutes since local midnight. */
  readonly startMin: number;
  readonly endMin: number;
}

export const AVAILABILITY_PRESETS: readonly AvailabilityPreset[] = [
  { id: 'weekdayEvening', weekdays: [1, 2, 3, 4, 5], startMin: 19 * 60, endMin: 22 * 60 },
  { id: 'weekendAfternoon', weekdays: [6, 7], startMin: 13 * 60, endMin: 18 * 60 },
  { id: 'weekdayDay', weekdays: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 18 * 60 },
];

function painted(rules: readonly AvailabilityRule[], preset: AvailabilityPreset, kind: 'work' | null): AvailabilityRule[] {
  let next = [...rules];
  for (const weekday of preset.weekdays) {
    const intervals = paintInterval(dayIntervals(next, weekday), preset.startMin, preset.endMin, kind);
    next = replaceDayRules(next, weekday, intervalsToRules(weekday, intervals));
  }
  return next;
}

/** The rules with the preset's hours available (as 작업 time) on each of its weekdays. */
export function applyPreset(rules: readonly AvailabilityRule[], preset: AvailabilityPreset): AvailabilityRule[] {
  return painted(rules, preset, 'work');
}

/** The rules with the preset's hours cleared on each of its weekdays. */
export function removePreset(rules: readonly AvailabilityRule[], preset: AvailabilityPreset): AvailabilityRule[] {
  return painted(rules, preset, null);
}

/** Every hour of the preset is available on every one of its weekdays. */
export function presetActive(rules: readonly AvailabilityRule[], preset: AvailabilityPreset): boolean {
  return preset.weekdays.every((weekday) => {
    let covered = preset.startMin;
    for (const interval of dayIntervals(rules, weekday)) {
      if (interval.start > covered) break;
      if (interval.end > covered) covered = interval.end;
      if (covered >= preset.endMin) return true;
    }
    return covered >= preset.endMin;
  });
}
