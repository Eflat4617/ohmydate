/**
 * Date exceptions (쉼 / 추가) as readable text (FU-97): the summary line next
 * to each exception's inputs and the label of the 쉼 band in the week
 * calendar share these, so both say the same thing.
 */
import type { AvailabilityException } from '../api';
import { t } from '../i18n';
import { formatCivilDate } from '../i18n/format';

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/** The exception names a time of day (both ends; one end alone is invalid). */
export function exceptionHasTime(exception: AvailabilityException): boolean {
  return present(exception.startLocal) || present(exception.endLocal);
}

/** `10:00~18:00`, `하루 종일`, or a prompt when only one end is filled in. */
export function exceptionTimeText(exception: AvailabilityException): string {
  const hasStart = present(exception.startLocal);
  const hasEnd = present(exception.endLocal);
  if (!hasStart && !hasEnd) return t('availability.exceptionAllDay');
  if (!hasStart || !hasEnd) return t('availability.exceptionPartialTime');
  return t('format.timeRange', {
    start: (exception.startLocal ?? '').trim(),
    end: (exception.endLocal ?? '').trim(),
  });
}

/** `11월 14일 (토) · 쉼 · 10:00~18:00` (or `하루 종일`). */
export function exceptionSummary(exception: AvailabilityException): string {
  const date = exception.date.length === 0 ? t('availability.exceptionNoDate') : formatCivilDate(exception.date);
  const time = exceptionTimeText(exception);
  return exception.kind === 'off'
    ? t('availability.exceptionSummaryOff', { date, time })
    : t('availability.exceptionSummaryExtra', { date, time });
}
