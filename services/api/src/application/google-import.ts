import { isIanaTimeZone, type Instant } from '@ohmydate/domain';
import { Temporal } from 'temporal-polyfill';
import type {
  GoogleEventResource,
  ImportChanges,
  ImportedCommitmentRow,
  ImportedCommitmentValues,
  ImportedDayEventRow,
  ImportedDayEventValues,
} from './google-calendar-ports.js';

/**
 * CAL-03 import rules (Google -> OhMyDate), pure and deterministic.
 *
 * - timed event (`start.dateTime`) -> 약속 (commitment_event, source google),
 *   start floored / end ceiled to the minute (the scheduler works in minutes;
 *   rounding outward never shrinks busy time);
 * - all-day event (`start.date`) -> calendar_day_event, blocks nothing;
 * - skipped: cancelled, declined by the user, transparent ("한가함"),
 *   working-location entries and zero-length or malformed times.
 * Titles are cut to 200 characters (code points); an empty title becomes a
 * neutral fixed title in the owner's language. Descriptions, attendees and
 * locations are never read into a row.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const TITLE_MAX = 200;

export interface ImportWindow {
  readonly timeMin: Instant;
  readonly timeMax: Instant;
}

/** Listing window: now − 1 day .. now + `days` days (Google: exclusive bounds). */
export function importWindow(now: Instant, days: number): ImportWindow {
  const nowMs = Date.parse(now);
  return {
    timeMin: new Date(nowMs - DAY_MS).toISOString() as Instant,
    timeMax: new Date(nowMs + days * DAY_MS).toISOString() as Instant,
  };
}

export function isKorean(locale: string): boolean {
  return locale.toLowerCase().startsWith('ko');
}

export function neutralEventTitle(locale: string): string {
  return isKorean(locale) ? '(제목 없음)' : '(No title)';
}

/** Trimmed, at most 200 code points, never empty. */
export function cutTitle(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? '').replace(/\s+/gu, ' ').trim();
  if (trimmed.length === 0) return fallback;
  const points = Array.from(trimmed);
  return points.length <= TITLE_MAX ? trimmed : points.slice(0, TITLE_MAX).join('').trimEnd();
}

export type SkipReason =
  | 'cancelled'
  | 'declined'
  | 'transparent'
  | 'working_location'
  | 'zero_length'
  | 'malformed';

export type ClassifiedEvent =
  | { readonly kind: 'timed'; readonly values: ImportedCommitmentValues }
  | { readonly kind: 'day'; readonly values: ImportedDayEventValues }
  | { readonly kind: 'skip'; readonly reason: SkipReason };

export interface ClassifyContext {
  readonly calendarTimeZone: string | null;
  readonly ownerTimeZone: string;
  readonly locale: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function validDate(value: string | undefined): value is string {
  if (value === undefined || !DATE.test(value)) return false;
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' });
    return true;
  } catch {
    return false;
  }
}

export function classifyEvent(event: GoogleEventResource, context: ClassifyContext): ClassifiedEvent {
  if (typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 1_024) {
    return { kind: 'skip', reason: 'malformed' };
  }
  if (event.status === 'cancelled') return { kind: 'skip', reason: 'cancelled' };
  if (event.transparency === 'transparent') return { kind: 'skip', reason: 'transparent' };
  if (event.eventType === 'workingLocation') return { kind: 'skip', reason: 'working_location' };
  const self = event.attendees?.find((attendee) => attendee.self === true);
  if (self?.responseStatus === 'declined') return { kind: 'skip', reason: 'declined' };

  const title = cutTitle(event.summary, neutralEventTitle(context.locale));
  const etag =
    typeof event.etag === 'string' && event.etag.length > 0 && event.etag.length <= 256
      ? event.etag
      : null;

  const startDateTime = event.start?.dateTime;
  const endDateTime = event.end?.dateTime;
  if (startDateTime !== undefined) {
    const startMs = Date.parse(startDateTime);
    const endMs = endDateTime === undefined ? Number.NaN : Date.parse(endDateTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return { kind: 'skip', reason: 'malformed' };
    }
    const flooredStart = Math.floor(startMs / MINUTE_MS) * MINUTE_MS;
    const ceiledEnd = Math.ceil(endMs / MINUTE_MS) * MINUTE_MS;
    if (endMs <= startMs || ceiledEnd <= flooredStart) return { kind: 'skip', reason: 'zero_length' };
    const zone = [event.start?.timeZone, context.calendarTimeZone, context.ownerTimeZone].find(
      (candidate): candidate is string => isIanaTimeZone(candidate),
    );
    return {
      kind: 'timed',
      values: {
        externalEventId: event.id,
        etag,
        title,
        startAt: new Date(flooredStart).toISOString() as Instant,
        endAt: new Date(ceiledEnd).toISOString() as Instant,
        timeZone: zone ?? 'UTC',
      },
    };
  }

  const startDate = event.start?.date;
  const endDate = event.end?.date;
  if (!validDate(startDate)) return { kind: 'skip', reason: 'malformed' };
  const end = validDate(endDate) ? endDate : Temporal.PlainDate.from(startDate).add({ days: 1 }).toString();
  if (end <= startDate) return { kind: 'skip', reason: 'zero_length' };
  return {
    kind: 'day',
    values: { externalEventId: event.id, etag, title, startDate, endDate: end },
  };
}

/**
 * Rows Google no longer returns are removed only inside the listed window
 * shrunk by one day on each side, so a zone-dependent edge never deletes a
 * row Google would still list. Rows older than the window are left alone.
 */
export interface RemovalWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly fromDate: string;
  readonly toDate: string;
}

export function removalWindow(window: ImportWindow, ownerTimeZone: string): RemovalWindow {
  const fromMs = Date.parse(window.timeMin) + DAY_MS;
  const toMs = Date.parse(window.timeMax) - DAY_MS;
  const zone = isIanaTimeZone(ownerTimeZone) ? ownerTimeZone : 'UTC';
  const localDate = (ms: number): string =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate().toString();
  return { fromMs, toMs, fromDate: localDate(fromMs), toDate: localDate(toMs) };
}

function sameCommitment(row: ImportedCommitmentRow, values: ImportedCommitmentValues): boolean {
  return (
    row.title === values.title &&
    Date.parse(row.startAt) === Date.parse(values.startAt) &&
    Date.parse(row.endAt) === Date.parse(values.endAt) &&
    row.timeZone === values.timeZone
  );
}

function sameDayEvent(row: ImportedDayEventRow, values: ImportedDayEventValues): boolean {
  return (
    row.title === values.title && row.startDate === values.startDate && row.endDate === values.endDate
  );
}

/**
 * Diff, not rewrite: unchanged rows are untouched (no version bump), changed
 * rows are updated, rows missing from a COMPLETE listing are removed inside
 * the removal window. A truncated listing (`complete=false`) removes nothing.
 */
export function diffCommitments(
  existing: readonly ImportedCommitmentRow[],
  incoming: readonly ImportedCommitmentValues[],
  window: RemovalWindow,
  complete: boolean,
): ImportChanges<ImportedCommitmentRow, ImportedCommitmentValues> {
  const byEvent = new Map(existing.map((row) => [row.externalEventId, row]));
  const seen = new Set<string>();
  const create: ImportedCommitmentValues[] = [];
  const update: { row: ImportedCommitmentRow; values: ImportedCommitmentValues }[] = [];
  for (const values of incoming) {
    if (seen.has(values.externalEventId)) continue;
    seen.add(values.externalEventId);
    const row = byEvent.get(values.externalEventId);
    if (row === undefined) create.push(values);
    else if (!sameCommitment(row, values)) update.push({ row, values });
  }
  const remove = complete
    ? existing.filter(
        (row) =>
          !seen.has(row.externalEventId) &&
          Date.parse(row.endAt) > window.fromMs &&
          Date.parse(row.startAt) < window.toMs,
      )
    : [];
  return { create, update, remove };
}

export function diffDayEvents(
  existing: readonly ImportedDayEventRow[],
  incoming: readonly ImportedDayEventValues[],
  window: RemovalWindow,
  complete: boolean,
): ImportChanges<ImportedDayEventRow, ImportedDayEventValues> {
  const byEvent = new Map(existing.map((row) => [row.externalEventId, row]));
  const seen = new Set<string>();
  const create: ImportedDayEventValues[] = [];
  const update: { row: ImportedDayEventRow; values: ImportedDayEventValues }[] = [];
  for (const values of incoming) {
    if (seen.has(values.externalEventId)) continue;
    seen.add(values.externalEventId);
    const row = byEvent.get(values.externalEventId);
    if (row === undefined) create.push(values);
    else if (!sameDayEvent(row, values)) update.push({ row, values });
  }
  const remove = complete
    ? existing.filter(
        (row) =>
          !seen.has(row.externalEventId) &&
          row.endDate > window.fromDate &&
          row.startDate < window.toDate,
      )
    : [];
  return { create, update, remove };
}

/** Default import selection for a calendar the owner has not seen before. */
export function defaultSelected(entry: {
  readonly googleCalendarId: string;
  readonly accessRole: string;
  readonly name: string;
}): boolean {
  // A leftover export calendar (disconnect with removeExported=false) is
  // owned by the user but must never be imported back as busy time.
  if (entry.name === EXPORT_CALENDAR_NAME) return false;
  return (
    entry.accessRole === 'owner' || entry.googleCalendarId.endsWith('#holiday@group.v.calendar.google.com')
  );
}

export const EXPORT_CALENDAR_NAME = 'OhMyDate';
