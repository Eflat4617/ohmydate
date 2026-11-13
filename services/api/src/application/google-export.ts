import type { GoogleIntegrationSettings } from '@ohmydate/contracts';
import { isIanaTimeZone, type Instant } from '@ohmydate/domain';
import { Temporal } from 'temporal-polyfill';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { ExportLocalKind, ExportSource, GoogleEventWrite } from './google-calendar-ports.js';
import { cutTitle, isKorean } from './google-import.js';

/**
 * CAL-03 export rules (OhMyDate -> the app's own "OhMyDate" calendar), pure.
 *
 * What leaves the machine: task titles and block times, manual 약속 titles,
 * times and repeat rules, and the per-day summary built from those. Never
 * notes, descriptions, goal text or imported (google) 약속.
 *
 * - blocks: approved, non-superseded blocks with status planned/done (skipped
 *   and moved blocks are not reminders) inside now − 1 day .. now + N days;
 * - manual 약속: one event each, a repeating one as a recurring event
 *   (`recurrence: ["RRULE:…"]` + `start.timeZone`);
 * - daily summary (setting `dailySummary`): ONE 10-minute "오늘 할 일 N개"
 *   event per local day that has exported blocks, starting at the owner's day
 *   start (availability `dayStartLocal`, owner time zone) or at the day's
 *   first block if that is earlier. Its popup fires at its own start; the
 *   description lists the blocks' local times and titles.
 * - reminders: `useDefault=false` + one popup `reminderMinutes` before (none
 *   when null) — this is what makes the phone remind the user.
 *
 * Event ids are deterministic base32hex (Calendar API: a-v, 0-9, 5..1024
 * chars): `b`/`c` + the uuid's 32 hex digits, `s` + YYYYMMDD.
 */

export const SUMMARY_MINUTES = 10;
const MINUTE_MS = 60_000;
const DESCRIPTION_MAX = 4_000;

export interface DesiredEvent {
  readonly kind: ExportLocalKind;
  readonly localKey: string;
  readonly eventId: string;
  readonly body: GoogleEventWrite;
  readonly fingerprint: string;
  /** Null for a recurring event (never ages out). */
  readonly endsAt: Instant | null;
}

export function exportEventId(kind: ExportLocalKind, localKey: string): string {
  if (kind === 'summary') return `s${localKey.replace(/-/gu, '')}`;
  const hex = localKey.replace(/-/gu, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(hex)) throw new Error('export key must be a uuid');
  return `${kind === 'block' ? 'b' : 'c'}${hex}`;
}

export function fingerprintOf(calendarId: string, body: GoogleEventWrite): string {
  return sha256Hex(canonicalJson({ calendarId, body }));
}

function reminders(minutes: number | null): GoogleEventWrite['reminders'] {
  return {
    useDefault: false,
    overrides: minutes === null ? [] : [{ method: 'popup', minutes }],
  };
}

function zoneOf(value: string): string {
  return isIanaTimeZone(value) ? value : 'UTC';
}

function localParts(instant: string, zone: string): { date: string; time: string } {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  return {
    date: zoned.toPlainDate().toString(),
    time: zoned.toPlainTime().toString({ smallestUnit: 'minute' }),
  };
}

function iso(ms: number): Instant {
  return new Date(ms).toISOString() as Instant;
}

export function summaryTitle(count: number, locale: string): string {
  return isKorean(locale) ? `오늘 할 일 ${String(count)}개` : `Today: ${String(count)} ${count === 1 ? 'task' : 'tasks'}`;
}

export function taskFallbackTitle(locale: string): string {
  return isKorean(locale) ? '할 일' : 'Task';
}

export interface DesiredEventsInput {
  readonly source: ExportSource;
  /** Provider titles (preferred), then the planner title cache, then a neutral title. */
  readonly taskTitles: ReadonlyMap<string, string>;
  readonly settings: GoogleIntegrationSettings;
  readonly calendarId: string;
}

export function desiredEvents(input: DesiredEventsInput): DesiredEvent[] {
  const { source, settings, calendarId } = input;
  const ownerZone = zoneOf(source.timeZone);
  const fallback = taskFallbackTitle(source.locale);
  const titleOf = (taskId: string): string =>
    cutTitle(input.taskTitles.get(taskId) ?? source.cachedTaskTitles.get(taskId), fallback);
  const result: DesiredEvent[] = [];
  const add = (kind: ExportLocalKind, localKey: string, body: GoogleEventWrite, endsAt: Instant | null) => {
    result.push({
      kind,
      localKey,
      eventId: exportEventId(kind, localKey),
      body,
      fingerprint: fingerprintOf(calendarId, body),
      endsAt,
    });
  };

  const blocks = source.blocks.filter((block) => block.status === 'planned' || block.status === 'done');
  if (settings.exportBlocks) {
    for (const block of blocks) {
      add(
        'block',
        block.id,
        {
          summary: titleOf(block.taskId),
          start: { dateTime: block.startAt, timeZone: ownerZone },
          end: { dateTime: block.endAt, timeZone: ownerZone },
          reminders: reminders(settings.reminderMinutes),
          transparency: 'opaque',
          status: 'confirmed',
        },
        block.endAt,
      );
    }
  }

  if (settings.exportCommitments) {
    for (const commitment of source.commitments) {
      const zone = zoneOf(commitment.timeZone);
      add(
        'commitment',
        commitment.id,
        {
          summary: cutTitle(commitment.title, fallback),
          start: { dateTime: commitment.startAt, timeZone: zone },
          end: { dateTime: commitment.endAt, timeZone: zone },
          ...(commitment.rrule === null ? {} : { recurrence: [`RRULE:${commitment.rrule}`] }),
          reminders: reminders(settings.reminderMinutes),
          transparency: 'opaque',
          status: 'confirmed',
        },
        commitment.rrule === null ? commitment.endAt : null,
      );
    }
  }

  if (settings.dailySummary && blocks.length > 0) {
    const days = new Map<string, typeof blocks>();
    for (const block of blocks) {
      const { date } = localParts(block.startAt, ownerZone);
      const list = days.get(date) ?? [];
      list.push(block);
      days.set(date, list);
    }
    for (const [date, dayBlocks] of [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const sorted = [...dayBlocks].sort(
        (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || (a.id < b.id ? -1 : 1),
      );
      const first = sorted[0];
      if (first === undefined) continue;
      const dayStartMs = Temporal.PlainDateTime.from(`${date}T${source.dayStartLocal}`)
        .toZonedDateTime(ownerZone, { disambiguation: 'compatible' })
        .epochMilliseconds;
      const startMs = Math.min(dayStartMs, Date.parse(first.startAt));
      const endMs = startMs + SUMMARY_MINUTES * MINUTE_MS;
      const lines = sorted.map((block) => {
        const start = localParts(block.startAt, ownerZone).time;
        const end = localParts(block.endAt, ownerZone).time;
        return `${start}–${end} ${titleOf(block.taskId)}`;
      });
      let description = lines.join('\n');
      if (description.length > DESCRIPTION_MAX) description = `${description.slice(0, DESCRIPTION_MAX - 1)}…`;
      add(
        'summary',
        date,
        {
          summary: summaryTitle(sorted.length, source.locale),
          description,
          start: { dateTime: iso(startMs), timeZone: ownerZone },
          end: { dateTime: iso(endMs), timeZone: ownerZone },
          reminders: reminders(settings.reminderMinutes === null ? null : 0),
          transparency: 'transparent',
          status: 'confirmed',
        },
        iso(endMs),
      );
    }
  }
  return result;
}
