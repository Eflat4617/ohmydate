/**
 * The recurrence oracle: inputs for the bounded RRULE adapter and what the
 * TypeScript reference (`services/api/src/application/rrule.ts`) answers for
 * them. The Rust port (`core/crates/recurrence`) replays a pack in
 * `cargo test` and must give the same answer for every record.
 *
 * The same seed and count give the same records on the same Node version.
 * `core/crates/recurrence/tests/oracle/README.md` says how packs are made.
 */
import { createRequire } from 'node:module';
import type { Temporal as TemporalTypes } from 'temporal-polyfill';
import {
  clipOccurrence,
  expandOccurrences,
  InvalidRRuleError,
  parseRRule,
} from '../../services/api/src/application/rrule.js';

// The polyfill is a dependency of the reference, not of this harness
// (tests-core is not a workspace package): load the reference's copy.
const load = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Temporal } = load('temporal-polyfill') as typeof import('temporal-polyfill');

export const FORMAT = 'ohmydate-recurrence-oracle';
export const FORMAT_VERSION = 1;

/** The committed sample: `core/crates/recurrence/tests/oracle/sample.jsonl`. */
export const SAMPLE = { seed: 20261116, count: 240 } as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- randomness

interface Random {
  next(): number;
  int(maxExclusive: number): number;
  between(min: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** mulberry32: small, seedable, the same stream on every platform. */
function random(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);
  return {
    next,
    int,
    between: (min, maxInclusive) => min + int(maxInclusive - min + 1),
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
    chance: (probability) => next() < probability,
  };
}

// -------------------------------------------------------------- the reference

/** Every rejection of the reference, by the start of its message. */
const ERROR_KINDS: readonly (readonly [string, string])[] = [
  ['Malformed RRULE part', 'malformed_part'],
  ['Unsupported RRULE part', 'unsupported_part'],
  ['Duplicate RRULE part', 'duplicate_part'],
  ['Unsupported RRULE FREQ', 'unsupported_freq'],
  ['RRULE INTERVAL must be', 'interval'],
  ['RRULE COUNT and UNTIL', 'count_and_until'],
  ['RRULE COUNT must be', 'count'],
  ['Unsupported RRULE UNTIL date', 'until_date'],
  ['Unsupported RRULE UNTIL instant', 'until_instant'],
  ['Unsupported RRULE UNTIL value', 'until_value'],
  ['RRULE BYDAY is only supported', 'byday_needs_weekly'],
  ['Unsupported RRULE BYDAY value', 'byday_value'],
  ['RRULE BYMONTHDAY is only supported', 'bymonthday_needs_monthly'],
  ['Unsupported RRULE BYMONTHDAY value', 'bymonthday_value'],
  ['RRULE WKST only supports', 'wkst'],
  ['occurrence range is not a valid interval', 'invalid_range'],
  ['occurrence range exceeds', 'range_too_long'],
  ['commitment interval is invalid', 'invalid_interval'],
  ['commitment expands to more than', 'too_many_occurrences'],
  ['commitment recurrence expansion exceeded', 'safety_bound'],
];

/** The stable name of a rejection. Anything else the reference throws is a defect of the pack. */
function errorKind(error: unknown): string {
  if (error instanceof InvalidRRuleError) {
    const kind = ERROR_KINDS.find(([start]) => error.message.startsWith(start))?.[1];
    if (kind !== undefined) return kind;
  }
  throw error;
}

export interface ParseRecord {
  readonly t: 'parse';
  readonly rrule: string;
  readonly rule?: {
    readonly freq: string;
    readonly interval: number;
    readonly count: number | null;
    readonly untilMs: number | null;
    readonly untilDate: string | null;
    readonly byDay: readonly number[];
    readonly byMonthDay: readonly number[];
  };
  readonly error?: string;
}

function parseRecord(rrule: string): ParseRecord {
  try {
    const rule = parseRRule(rrule);
    return {
      t: 'parse',
      rrule,
      rule: {
        freq: rule.freq,
        interval: rule.interval,
        count: rule.count ?? null,
        untilMs: rule.untilMs ?? null,
        untilDate: rule.untilDate ?? null,
        byDay: rule.byDay,
        byMonthDay: rule.byMonthDay,
      },
    };
  } catch (error) {
    return { t: 'parse', rrule, error: errorKind(error) };
  }
}

interface Commitment {
  readonly startAt: string;
  readonly endAt: string;
  readonly timeZone: string;
  readonly rrule?: string;
}

export interface ExpandRecord {
  readonly t: 'expand';
  readonly id: string;
  /** Where the case comes from: `test`, `hand`, `dst`, `seeded`, `lookback`, `once`. */
  readonly kind: string;
  readonly commitment: Commitment;
  readonly from: string;
  readonly to: string;
  readonly occurrences?: readonly (readonly [string, string])[];
  /** Occurrences whose wall time a clock change skipped (they moved forward). */
  readonly gaps?: number;
  /** Occurrences whose wall time happened twice (the first one is taken). */
  readonly overlaps?: number;
  readonly error?: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Counts the occurrences that fell on a skipped or a repeated wall time. */
function clockChanges(
  commitment: Commitment,
  starts: readonly string[],
): { gaps: number; overlaps: number } {
  let gaps = 0;
  let overlaps = 0;
  if (commitment.rrule === undefined) return { gaps, overlaps };
  const wall = Temporal.Instant.from(commitment.startAt)
    .toZonedDateTimeISO(commitment.timeZone)
    .toPlainTime();
  for (const start of starts) {
    const zoned = Temporal.Instant.from(start).toZonedDateTimeISO(commitment.timeZone);
    if (!zoned.toPlainTime().equals(wall)) {
      gaps += 1;
      continue;
    }
    const plain = zoned.toPlainDateTime();
    const earlier = plain.toZonedDateTime(commitment.timeZone, { disambiguation: 'earlier' });
    const later = plain.toZonedDateTime(commitment.timeZone, { disambiguation: 'later' });
    if (earlier.epochMilliseconds !== later.epochMilliseconds) overlaps += 1;
  }
  return { gaps, overlaps };
}

function expandRecord(
  id: string,
  kind: string,
  commitment: Commitment,
  from: string,
  to: string,
): ExpandRecord {
  try {
    const occurrences = expandOccurrences(commitment, from, to);
    return {
      t: 'expand',
      id,
      kind,
      commitment,
      from,
      to,
      occurrences: occurrences.map((entry) => [entry.startAt, entry.endAt] as const),
      ...clockChanges(
        commitment,
        occurrences.map((entry) => entry.startAt),
      ),
    };
  } catch (error) {
    return { t: 'expand', id, kind, commitment, from, to, error: errorKind(error) };
  }
}

export interface ClipRecord {
  readonly t: 'clip';
  readonly occurrence: readonly [string, string];
  readonly from: string;
  readonly to: string;
  readonly clipped: readonly [string, string] | null;
}

function clipRecord(startMs: number, endMs: number, fromMs: number, toMs: number): ClipRecord {
  const clipped = clipOccurrence(
    { startAt: iso(startMs), endAt: iso(endMs) },
    iso(fromMs),
    iso(toMs),
  );
  return {
    t: 'clip',
    occurrence: [iso(startMs), iso(endMs)],
    from: iso(fromMs),
    to: iso(toMs),
    clipped: clipped === null ? null : [clipped.startAt, clipped.endAt],
  };
}

// --------------------------------------------------------------------- zones

/** Zones without a clock change in the years the cases use. */
const STEADY_ZONES = ['UTC', 'Asia/Seoul', 'Asia/Kathmandu', 'America/Sao_Paulo'] as const;

/**
 * Zones whose clocks change: both hemispheres, a 30-minute change
 * (Lord Howe), a :45 offset (Chatham), changes at midnight (Havana,
 * Santiago) and the change that runs the other way around Ramadan
 * (Casablanca).
 */
const CHANGING_ZONES = [
  'America/New_York',
  'Europe/Berlin',
  'Europe/London',
  'Australia/Sydney',
  'Pacific/Auckland',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'America/Havana',
  'Africa/Casablanca',
] as const;

const ZONES: readonly string[] = [...STEADY_ZONES, ...CHANGING_ZONES];

interface Transition {
  readonly zone: string;
  readonly atMs: number;
  /** Offset change in milliseconds: positive skips wall time, negative repeats it. */
  readonly deltaMs: number;
}

function transitions(zone: string, fromYear: number, toYear: number): Transition[] {
  const found: Transition[] = [];
  const endMs = Date.UTC(toYear + 1, 0, 1);
  let cursor = Temporal.Instant.fromEpochMilliseconds(
    Date.UTC(fromYear, 0, 1),
  ).toZonedDateTimeISO(zone);
  for (;;) {
    const next = cursor.getTimeZoneTransition('next');
    if (next === null || next.epochMilliseconds >= endMs) return found;
    const before = next.subtract({ nanoseconds: 1 }).offsetNanoseconds;
    found.push({
      zone,
      atMs: next.epochMilliseconds,
      deltaMs: (next.offsetNanoseconds - before) / 1_000_000,
    });
    cursor = next;
  }
}

/** The instant of a wall-clock time in a zone, as the reference resolves it. */
function instantOf(
  zone: string,
  date: TemporalTypes.PlainDate,
  time: TemporalTypes.PlainTime,
): number {
  return date.toPlainDateTime(time).toZonedDateTime(zone).epochMilliseconds;
}

// --------------------------------------------------------------------- rules

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const INTERVALS = [1, 2, 3, 4, 5, 7, 10, 13, 26, 52, 100, 1000] as const;
const COUNTS = [1, 2, 3, 5, 10, 30, 100, 500, 1000, 2000] as const;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function untilInstant(ms: number): string {
  const date = new Date(ms);
  return (
    `${String(date.getUTCFullYear()).padStart(4, '0')}${two(date.getUTCMonth() + 1)}` +
    `${two(date.getUTCDate())}T${two(date.getUTCHours())}${two(date.getUTCMinutes())}` +
    `${two(date.getUTCSeconds())}Z`
  );
}

function untilDate(ms: number): string {
  return untilInstant(ms).slice(0, 8);
}

function shuffled<T>(prng: Random, items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = prng.int(index + 1);
    const held = copy[index] as T;
    copy[index] = copy[other] as T;
    copy[other] = held;
  }
  return copy;
}

/** A supported rule for a series that starts at `startMs` on day `startDay` of its month. */
function seededRule(prng: Random, startMs: number, startDay: number, frequency?: string): string {
  const freq = frequency ?? prng.pick(['DAILY', 'DAILY', 'WEEKLY', 'WEEKLY', 'WEEKLY', 'MONTHLY', 'MONTHLY', 'YEARLY']);
  const parts: string[] = [];
  if (prng.chance(0.4)) parts.push(`INTERVAL=${prng.pick(INTERVALS)}`);
  const end = prng.next();
  if (end < 0.3) {
    parts.push(`COUNT=${prng.chance(0.5) ? prng.pick(COUNTS) : prng.between(1, 60)}`);
  } else if (end < 0.55) {
    const untilMs = startMs + prng.between(-5, 400) * DAY + prng.int(DAY / 1000) * 1000;
    parts.push(`UNTIL=${prng.chance(0.6) ? untilInstant(untilMs) : untilDate(untilMs)}`);
  }
  if (freq === 'WEEKLY' && prng.chance(0.7)) {
    const days = Array.from({ length: prng.between(1, 5) }, () => prng.pick(WEEKDAYS));
    parts.push(`BYDAY=${days.join(',')}`);
  }
  if (freq === 'WEEKLY' && prng.chance(0.2)) parts.push('WKST=MO');
  if (freq === 'MONTHLY' && prng.chance(0.6)) {
    const days = Array.from({ length: prng.between(1, 4) }, () =>
      prng.pick([startDay, startDay, 1, 15, 28, 29, 30, 31, 31, prng.between(1, 31)]),
    );
    parts.push(`BYMONTHDAY=${days.join(',')}`);
  }
  const rule = [`FREQ=${freq}`, ...shuffled(prng, parts)].join(';');
  // The reference upper-cases names and values; a tenth of the rules ask it to.
  return prng.chance(0.1) ? rule.replace(/;.*/u, (rest) => rest.toLowerCase()) : rule;
}

// --------------------------------------------------------------- parse cases

/** Rules written by hand: every rejection, and the corners of the JavaScript string functions. */
const HAND_RULES: readonly string[] = [
  // rrule.test.ts
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
  'FREQ=DAILY;INTERVAL=2;COUNT=5',
  'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;WKST=MO',
  'FREQ=MONTHLY;BYMONTHDAY=15',
  'FREQ=YEARLY;UNTIL=20261231T000000Z',
  // parts
  '',
  ';',
  'FREQ',
  'FREQ=',
  '=DAILY',
  'FREQ=DAILY;',
  ';FREQ=DAILY',
  'FREQ=DAILY;;COUNT=2',
  'FREQ=DAILY;COUNT',
  'FREQ=DAILY;FREQ=DAILY',
  'FREQ=DAILY;freq=WEEKLY',
  'FREQ=DAILY;X=1;COUNT',
  'FREQ=DAILY;COUNT;X=1',
  'INTERVAL=2',
  'COUNT=2;FREQ=DAILY',
  'freq=daily',
  'Freq=Weekly;ByDay=mo,Su;Wkst=mo;Interval=3',
  'FREQ=DAILY=WEEKLY',
  'FREQ=DAILY;COUNT=3=9',
  'FREQ=DAILY;COUNT==3',
  'FREQ=DAILY;COUNT=3;=',
  'FREQ = DAILY',
  ' FREQ=DAILY',
  'FREQ=DAILY ',
  'FREQ= DAILY',
  'FREQ=SECONDLY',
  'FREQ=DAILY,WEEKLY',
  // Unicode upper-casing: dotless i, long s, sharp s, Kelvin sign.
  'FREQ=DAıLY',
  'FREQ=WEEKLY;BYDAY=ſA,ſU',
  'FREQ=DAILY;UNTıL=20261113',
  'FREQ=DAILY;ıNTERVAL=2',
  'FREQ=WEEKLY;WKſT=MO',
  'FREQ=WEEKLY;BYDAY=ß',
  'FREQ=WEEKLY',
  'FREQ=DAILY;COUNT=１２',
  // INTERVAL through parseInt
  'FREQ=DAILY;INTERVAL=1',
  'FREQ=DAILY;INTERVAL=1000',
  'FREQ=DAILY;INTERVAL=1001',
  'FREQ=DAILY;INTERVAL=0',
  'FREQ=DAILY;INTERVAL=-1',
  'FREQ=DAILY;INTERVAL=-0',
  'FREQ=DAILY;INTERVAL=',
  'FREQ=DAILY;INTERVAL=x',
  'FREQ=DAILY;INTERVAL= 7',
  'FREQ=DAILY;INTERVAL=7 ',
  'FREQ=DAILY;INTERVAL=\t7',
  'FREQ=DAILY;INTERVAL=　7',
  'FREQ=DAILY;INTERVAL= 7',
  'FREQ=DAILY;INTERVAL=﻿7',
  'FREQ=DAILY;INTERVAL=\u00857',
  'FREQ=DAILY;INTERVAL=​7',
  'FREQ=DAILY;INTERVAL=+7',
  'FREQ=DAILY;INTERVAL=++7',
  'FREQ=DAILY;INTERVAL=+ 7',
  'FREQ=DAILY;INTERVAL=--1',
  'FREQ=DAILY;INTERVAL=7days',
  'FREQ=DAILY;INTERVAL=1e3',
  'FREQ=DAILY;INTERVAL=2.9',
  'FREQ=DAILY;INTERVAL=007',
  'FREQ=DAILY;INTERVAL=0x10',
  'FREQ=DAILY;INTERVAL=1_000',
  'FREQ=DAILY;INTERVAL=99999999999999999999999999',
  'FREQ=DAILY;INTERVAL=-99999999999999999999999999',
  'FREQ=DAILY;INTERVAL=Infinity',
  'FREQ=DAILY;INTERVAL=1 ;COUNT=x',
  // COUNT
  'FREQ=DAILY;COUNT=1',
  'FREQ=DAILY;COUNT=2000',
  'FREQ=DAILY;COUNT=2001',
  'FREQ=DAILY;COUNT=0',
  'FREQ=DAILY;COUNT=-5',
  'FREQ=DAILY;COUNT=',
  'FREQ=DAILY;COUNT=many',
  'FREQ=DAILY;COUNT= 12abc',
  'FREQ=DAILY;COUNT=0;UNTIL=nonsense',
  'FREQ=DAILY;UNTIL=nonsense;COUNT=0',
  // UNTIL
  'FREQ=DAILY;UNTIL=20240229',
  'FREQ=DAILY;UNTIL=20230229',
  'FREQ=DAILY;UNTIL=19000229',
  'FREQ=DAILY;UNTIL=20000229',
  'FREQ=DAILY;UNTIL=00000229',
  'FREQ=DAILY;UNTIL=00000101',
  'FREQ=DAILY;UNTIL=99991231',
  'FREQ=DAILY;UNTIL=20261301',
  'FREQ=DAILY;UNTIL=20260001',
  'FREQ=DAILY;UNTIL=20260100',
  'FREQ=DAILY;UNTIL=20260431',
  'FREQ=DAILY;UNTIL=2026-11-13',
  'FREQ=DAILY;UNTIL=2026111',
  'FREQ=DAILY;UNTIL=202611130',
  'FREQ=DAILY;UNTIL=',
  'FREQ=DAILY;UNTIL=20261113T090000Z',
  'FREQ=DAILY;UNTIL=20261113t090000z',
  'FREQ=DAILY;UNTIL=20261113T090000',
  'FREQ=DAILY;UNTIL=20261113T0900Z',
  'FREQ=DAILY;UNTIL=20261113T090000Z ',
  'FREQ=DAILY;UNTIL=20261113T090000+0900',
  'FREQ=DAILY;UNTIL=20261113T090000.000Z',
  'FREQ=DAILY;UNTIL=20261231T235959Z',
  'FREQ=DAILY;UNTIL=20261399T999999Z',
  'FREQ=DAILY;UNTIL=20261232T246060Z',
  'FREQ=DAILY;UNTIL=20260231T000000Z',
  'FREQ=DAILY;UNTIL=20240231T000000Z',
  'FREQ=DAILY;UNTIL=20260431T120000Z',
  'FREQ=DAILY;UNTIL=20260013T090000Z',
  'FREQ=DAILY;UNTIL=20261100T090000Z',
  'FREQ=DAILY;UNTIL=20260000T000000Z',
  'FREQ=DAILY;UNTIL=00000101T000000Z',
  'FREQ=DAILY;UNTIL=99991231T235959Z',
  'FREQ=DAILY;UNTIL=20261113T240000Z',
  'FREQ=DAILY;UNTIL=20261113T236000Z',
  'FREQ=DAILY;UNTIL=20261113T235960Z',
  'FREQ=DAILY;UNTIL=２０２６１１１３',
  // BYDAY
  'FREQ=WEEKLY;BYDAY=SU,MO,MO,TU',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
  'FREQ=WEEKLY;BYDAY=',
  'FREQ=WEEKLY;BYDAY=MO,',
  'FREQ=WEEKLY;BYDAY=,MO',
  'FREQ=WEEKLY;BYDAY=MON',
  'FREQ=WEEKLY;BYDAY=M',
  'FREQ=WEEKLY;BYDAY=MO TU',
  'FREQ=WEEKLY;BYDAY= MO',
  'FREQ=WEEKLY;BYDAY=MO ',
  'FREQ=WEEKLY;BYDAY=-1SU',
  'FREQ=WEEKLY;BYDAY=XX',
  'FREQ=WEEKLY;BYDAY=mo,tu',
  'FREQ=YEARLY;BYDAY=MO',
  // BYMONTHDAY
  'FREQ=MONTHLY;BYMONTHDAY=31,1, 15,07,29x',
  'FREQ=MONTHLY;BYMONTHDAY=1',
  'FREQ=MONTHLY;BYMONTHDAY=31',
  'FREQ=MONTHLY;BYMONTHDAY=0',
  'FREQ=MONTHLY;BYMONTHDAY=32',
  'FREQ=MONTHLY;BYMONTHDAY=-1',
  'FREQ=MONTHLY;BYMONTHDAY=',
  'FREQ=MONTHLY;BYMONTHDAY=15,',
  'FREQ=MONTHLY;BYMONTHDAY=last',
  'FREQ=MONTHLY;BYMONTHDAY=1.5',
  'FREQ=MONTHLY;BYMONTHDAY=+31',
  'FREQ=DAILY;BYMONTHDAY=1',
  'FREQ=YEARLY;BYMONTHDAY=1',
  // WKST
  'FREQ=DAILY;WKST=MO',
  'FREQ=DAILY;WKST=mo',
  'FREQ=DAILY;WKST=',
  'FREQ=DAILY;WKST=MO,TU',
  // order of the checks
  'FREQ=HOURLY;INTERVAL=0;COUNT=0;UNTIL=x',
  'FREQ=DAILY;INTERVAL=0;COUNT=0;UNTIL=x',
  'FREQ=DAILY;COUNT=0;BYDAY=XX',
  'FREQ=DAILY;UNTIL=x;BYDAY=XX',
  'FREQ=DAILY;BYDAY=XX;BYMONTHDAY=99;WKST=SU',
  'FREQ=WEEKLY;BYDAY=XX;BYMONTHDAY=99;WKST=SU',
  'FREQ=MONTHLY;BYMONTHDAY=99;WKST=SU',
];

const MUTATION_TEXT = '=;,+- 0123456789TZAMOUNFREQxyıſ';
const MUTATION_PARTS = [
  ';COUNT=3',
  ';UNTIL=20261301',
  ';UNTIL=20270101T000000Z',
  ';BYDAY=MO',
  ';BYMONTHDAY=31',
  ';WKST=SU',
  ';WKST=MO',
  ';X=1',
  ';',
  '=',
  ';INTERVAL= 2',
  ';INTERVAL=0',
  ';BYMONTHDAY=31,',
  ';BYDAY=',
];

/** A supported rule with one to three random edits: most stop being rules, each in its own way. */
function mutatedRule(prng: Random): string {
  let rule = seededRule(prng, Date.UTC(2026, prng.int(12), prng.between(1, 28), 9), 15);
  for (let edits = prng.between(1, 3); edits > 0; edits -= 1) {
    const at = prng.int(rule.length + 1);
    const text = prng.pick([...MUTATION_TEXT]);
    switch (prng.int(6)) {
      case 0:
        rule = rule.slice(0, at) + rule.slice(at + 1);
        break;
      case 1:
        rule = rule.slice(0, at) + text + rule.slice(at);
        break;
      case 2:
        rule = rule.slice(0, at) + text + rule.slice(at + 1);
        break;
      case 3:
        rule = rule.slice(0, at) + rule.slice(at, at + 1) + rule.slice(at);
        break;
      case 4:
        rule += prng.pick(MUTATION_PARTS);
        break;
      default:
        rule = rule.slice(0, Math.max(at, 1));
    }
  }
  return rule;
}

// -------------------------------------------------------------- expand cases

interface Case {
  readonly id: string;
  readonly kind: string;
  readonly commitment: Commitment;
  readonly from: string;
  readonly to: string;
}

function commitment(
  startAt: string,
  endAt: string,
  rrule: string | undefined,
  timeZone = 'UTC',
): Commitment {
  return { startAt, endAt, timeZone, ...(rrule === undefined ? {} : { rrule }) };
}

/** The expansions of `services/api/test/rrule.test.ts`, and corners nothing seeded would find. */
function handCases(): Case[] {
  const cases: Case[] = [];
  const add = (
    kind: string,
    name: string,
    series: Commitment,
    from: string,
    to: string,
  ): void => {
    cases.push({ id: `${kind}-${name}`, kind, commitment: series, from, to });
  };
  const z = (text: string): string => iso(Date.parse(text));

  // rrule.test.ts, in its order.
  add('test', 'until-instant-inclusive',
    commitment(z('2026-11-11T09:00:00Z'), z('2026-11-11T10:00:00Z'), 'FREQ=DAILY;UNTIL=20261113T090000Z'),
    z('2026-11-11T00:00:00Z'), z('2026-11-15T00:00:00Z'));
  add('test', 'until-date-local-day',
    commitment(z('2026-11-11T14:00:00Z'), z('2026-11-11T15:00:00Z'), 'FREQ=DAILY;UNTIL=20261113', 'America/New_York'),
    z('2026-11-11T00:00:00Z'), z('2026-11-16T00:00:00Z'));
  add('test', 'monthly-bymonthday',
    commitment(z('2026-11-02T09:00:00Z'), z('2026-11-02T10:00:00Z'), 'FREQ=MONTHLY;BYMONTHDAY=15'),
    z('2026-11-01T00:00:00Z'), z('2027-02-01T00:00:00Z'));
  add('test', 'dst-gap',
    commitment(z('2027-03-13T07:30:00Z'), z('2027-03-13T08:30:00Z'), 'FREQ=DAILY', 'America/New_York'),
    z('2027-03-13T00:00:00Z'), z('2027-03-16T00:00:00Z'));
  add('test', 'dst-overlap',
    commitment(z('2026-10-31T05:30:00Z'), z('2026-10-31T06:30:00Z'), 'FREQ=DAILY', 'America/New_York'),
    z('2026-10-31T00:00:00Z'), z('2026-11-03T00:00:00Z'));
  add('test', 'fast-forward-yearly',
    commitment(z('2000-01-01T09:00:00Z'), z('2000-01-01T10:00:00Z'), 'FREQ=YEARLY'),
    z('2026-01-01T00:00:00Z'), z('2026-12-01T00:00:00Z'));
  add('test', 'fast-forward-weekly',
    commitment(z('2010-03-03T09:00:00Z'), z('2010-03-03T10:00:00Z'), 'FREQ=WEEKLY;BYDAY=WE'),
    z('2026-11-11T00:00:00Z'), z('2026-11-14T00:00:00Z'));
  add('test', 'until-before-range',
    commitment(z('2010-03-01T09:00:00Z'), z('2010-03-01T10:00:00Z'), 'FREQ=WEEKLY;UNTIL=20110301T000000Z'),
    z('2026-11-11T00:00:00Z'), z('2026-11-14T00:00:00Z'));
  add('test', 'count-after-fast-forward',
    commitment(z('2000-01-01T09:00:00Z'), z('2000-01-01T10:00:00Z'), 'FREQ=YEARLY;COUNT=30'),
    z('2026-01-01T00:00:00Z'), z('2026-12-01T00:00:00Z'));
  add('test', 'count-exhausted',
    commitment(z('2000-01-01T09:00:00Z'), z('2000-01-01T10:00:00Z'), 'FREQ=YEARLY;COUNT=26'),
    z('2026-01-01T00:00:00Z'), z('2026-12-01T00:00:00Z'));
  add('test', 'leap-day-yearly-count',
    commitment(z('2000-02-29T09:00:00Z'), z('2000-02-29T10:00:00Z'), 'FREQ=YEARLY;COUNT=10'),
    z('2028-02-28T00:00:00Z'), z('2028-03-01T00:00:00Z'));
  add('test', 'monthly-31-count',
    commitment(z('2026-01-31T09:00:00Z'), z('2026-01-31T10:00:00Z'), 'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=5'),
    z('2026-01-01T00:00:00Z'), z('2026-09-01T00:00:00Z'));

  // The window and the interval are judged before the rule.
  const daily = commitment(z('2026-11-11T09:00:00Z'), z('2026-11-11T10:00:00Z'), 'FREQ=DAILY');
  add('hand', 'window-empty', daily, z('2026-11-11T00:00:00Z'), z('2026-11-11T00:00:00Z'));
  add('hand', 'window-inverted', daily, z('2026-11-12T00:00:00Z'), z('2026-11-11T00:00:00Z'));
  add('hand', 'window-366-days', daily, z('2026-11-11T00:00:00Z'), z('2027-11-12T00:00:00Z'));
  add('hand', 'window-366-days-and-1ms', daily, z('2026-11-11T00:00:00Z'), z('2027-11-12T00:00:00.001Z'));
  add('hand', 'interval-empty',
    commitment(z('2026-11-11T09:00:00Z'), z('2026-11-11T09:00:00Z'), 'FREQ=DAILY'),
    z('2026-11-11T00:00:00Z'), z('2026-11-12T00:00:00Z'));
  add('hand', 'interval-inverted-without-rule',
    commitment(z('2026-11-11T09:00:00Z'), z('2026-11-11T08:00:00Z'), undefined),
    z('2026-11-11T00:00:00Z'), z('2026-11-12T00:00:00Z'));
  add('hand', 'window-inverted-and-rule-unsupported',
    commitment(z('2026-11-11T09:00:00Z'), z('2026-11-11T10:00:00Z'), 'FREQ=NEVER'),
    z('2026-11-12T00:00:00Z'), z('2026-11-11T00:00:00Z'));
  add('hand', 'rule-unsupported',
    commitment(z('2026-11-11T09:00:00Z'), z('2026-11-11T10:00:00Z'), 'FREQ=NEVER'),
    z('2026-11-11T00:00:00Z'), z('2026-11-12T00:00:00Z'));

  // The window is half-open, and so is an occurrence: touching is not overlap.
  add('hand', 'window-starts-where-an-occurrence-ends', daily,
    z('2026-11-12T10:00:00Z'), z('2026-11-15T09:00:00Z'));
  add('hand', 'window-starts-1ms-before-an-occurrence-ends', daily,
    z('2026-11-12T09:59:59.999Z'), z('2026-11-15T09:00:00.001Z'));
  add('hand', 'count-window-starts-where-an-occurrence-ends',
    commitment(z('2026-11-11T09:00:00Z'), z('2026-11-11T10:00:00Z'), 'FREQ=DAILY;COUNT=4'),
    z('2026-11-12T10:00:00Z'), z('2026-11-14T09:00:00Z'));

  // Printing: a fraction of a second stays, shortened.
  add('hand', 'fraction-250ms',
    commitment(z('2026-11-11T09:00:00.250Z'), z('2026-11-11T10:00:00.250Z'), 'FREQ=DAILY;COUNT=3'),
    z('2026-11-11T00:00:00Z'), z('2026-11-20T00:00:00Z'));
  add('hand', 'fraction-7ms-length-1ms',
    commitment(z('2026-11-11T09:00:00.007Z'), z('2026-11-11T09:00:00.008Z'), 'FREQ=WEEKLY'),
    z('2026-11-11T00:00:00Z'), z('2026-12-20T00:00:00Z'));
  add('hand', 'fraction-without-rule',
    commitment(z('2026-11-11T09:00:00.250Z'), z('2026-11-11T10:00:00Z'), undefined),
    z('2026-11-11T00:00:00Z'), z('2026-11-12T00:00:00Z'));

  // The caps.
  add('hand', 'too-many-overlapping',
    commitment(z('2020-01-01T00:00:00Z'), z('2026-01-01T00:00:00Z'), 'FREQ=DAILY'),
    z('2025-11-01T00:00:00Z'), z('2025-11-02T00:00:00Z'));
  add('hand', 'exactly-2000-overlapping',
    commitment(z('2020-01-01T00:00:00Z'), z('2026-01-01T00:00:00Z'), 'FREQ=DAILY'),
    iso(Date.parse('2020-01-01T00:00:00Z') + 1_999 * DAY), iso(Date.parse('2020-01-01T00:00:00Z') + 1_999 * DAY + 1));
  add('hand', 'count-2000-daily',
    commitment(z('2021-06-01T09:00:00Z'), z('2021-06-01T10:00:00Z'), 'FREQ=DAILY;COUNT=2000'),
    z('2026-11-01T00:00:00Z'), z('2026-12-20T00:00:00Z'));
  add('hand', 'safety-bound-long-and-old',
    commitment(z('1975-01-01T00:00:00Z'), z('2091-01-01T00:00:00Z'), 'FREQ=YEARLY'),
    z('2090-01-01T00:00:00Z'), z('2090-01-02T00:00:00Z'));
  add('hand', 'old-and-short-jumps',
    commitment(z('1975-01-01T00:00:00Z'), z('1975-01-01T01:00:00Z'), 'FREQ=YEARLY'),
    z('2090-01-01T00:00:00Z'), z('2090-01-02T00:00:00Z'));
  add('hand', 'lookback-exactly-ten-years',
    commitment(iso(Date.parse('2026-11-11T09:00:00Z') - 3_660 * DAY), iso(Date.parse('2026-11-11T10:00:00Z') - 3_660 * DAY), 'FREQ=WEEKLY'),
    z('2026-11-11T09:00:00Z'), z('2026-11-30T00:00:00Z'));
  add('hand', 'lookback-ten-years-and-1ms',
    commitment(iso(Date.parse('2026-11-11T09:00:00Z') - 3_660 * DAY - 1), iso(Date.parse('2026-11-11T10:00:00Z') - 3_660 * DAY), 'FREQ=WEEKLY'),
    z('2026-11-11T09:00:00Z'), z('2026-11-30T00:00:00Z'));
  add('hand', 'lookback-overlapping-tail',
    commitment(z('2010-01-04T22:00:00Z'), z('2010-01-06T04:00:00Z'), 'FREQ=WEEKLY;BYDAY=MO,TH', 'Europe/Berlin'),
    z('2026-11-10T00:00:00Z'), z('2026-11-10T06:00:00Z'));

  // Calendar corners.
  add('hand', 'monthly-on-the-31st',
    commitment(z('2026-01-31T09:00:00Z'), z('2026-01-31T10:00:00Z'), 'FREQ=MONTHLY'),
    z('2026-01-01T00:00:00Z'), z('2027-01-01T00:00:00Z'));
  add('hand', 'monthly-29-30-31-across-february',
    commitment(z('2027-01-29T09:00:00Z'), z('2027-01-29T10:00:00Z'), 'FREQ=MONTHLY;BYMONTHDAY=31,29,30,29'),
    z('2027-01-01T00:00:00Z'), z('2028-04-01T00:00:00Z'));
  add('hand', 'yearly-leap-day',
    commitment(z('2024-02-29T12:00:00Z'), z('2024-02-29T13:00:00Z'), 'FREQ=YEARLY'),
    z('2027-06-01T00:00:00Z'), z('2028-06-01T00:00:00Z'));
  add('hand', 'yearly-leap-day-every-third-year',
    commitment(z('2016-02-29T12:00:00Z'), z('2016-02-29T13:00:00Z'), 'FREQ=YEARLY;INTERVAL=3;COUNT=4'),
    z('2051-06-01T00:00:00Z'), z('2052-06-01T00:00:00Z'));
  add('hand', 'century-year-is-not-leap',
    commitment(z('2096-02-29T12:00:00Z'), z('2096-02-29T13:00:00Z'), 'FREQ=YEARLY;INTERVAL=4;COUNT=3'),
    z('2103-06-01T00:00:00Z'), z('2104-06-01T00:00:00Z'));
  add('hand', 'weekly-interval-counts-weeks-from-monday',
    commitment(z('2026-11-15T09:00:00Z'), z('2026-11-15T10:00:00Z'), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU'),
    z('2026-11-09T00:00:00Z'), z('2026-12-20T00:00:00Z'));
  add('hand', 'weekly-byday-before-start-in-first-week',
    commitment(z('2026-11-13T09:00:00Z'), z('2026-11-13T10:00:00Z'), 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4'),
    z('2026-11-09T00:00:00Z'), z('2026-12-20T00:00:00Z'));
  add('hand', 'weekly-start-day-not-in-byday',
    commitment(z('2026-11-11T09:00:00Z'), z('2026-11-11T10:00:00Z'), 'FREQ=WEEKLY;BYDAY=TU,TH'),
    z('2026-11-09T00:00:00Z'), z('2026-11-30T00:00:00Z'));
  add('hand', 'local-date-differs-from-utc-date',
    commitment(z('2026-11-10T15:30:00Z'), z('2026-11-10T16:30:00Z'), 'FREQ=WEEKLY;BYDAY=WE', 'Asia/Seoul'),
    z('2026-11-09T00:00:00Z'), z('2026-11-30T00:00:00Z'));
  add('hand', 'until-date-is-a-local-day',
    commitment(z('2026-11-10T15:30:00Z'), z('2026-11-10T16:30:00Z'), 'FREQ=DAILY;UNTIL=20261113', 'Pacific/Auckland'),
    z('2026-11-09T00:00:00Z'), z('2026-11-30T00:00:00Z'));
  add('hand', 'until-date-reaches-the-window-only-through-the-length',
    commitment(z('2026-11-10T22:00:00Z'), z('2026-11-12T22:00:00Z'), 'FREQ=DAILY;UNTIL=20261112'),
    z('2026-11-14T00:00:00Z'), z('2026-11-20T00:00:00Z'));
  add('hand', 'until-date-ended-before-the-window',
    commitment(z('2026-11-10T22:00:00Z'), z('2026-11-10T23:00:00Z'), 'FREQ=DAILY;UNTIL=20261112'),
    z('2026-11-14T00:00:00Z'), z('2026-11-20T00:00:00Z'));

  // Clock changes nothing seeded reaches.
  // Samoa skipped 30 December 2011 entirely: that day's occurrence lands on the 31st.
  add('hand', 'a-skipped-day',
    commitment(z('2011-12-27T20:00:00Z'), z('2011-12-27T21:00:00Z'), 'FREQ=DAILY', 'Pacific/Apia'),
    z('2011-12-27T00:00:00Z'), z('2012-01-03T00:00:00Z'));
  add('hand', 'a-skipped-day-count',
    commitment(z('2011-12-27T20:00:00Z'), z('2011-12-27T21:00:00Z'), 'FREQ=DAILY;COUNT=5', 'Pacific/Apia'),
    z('2011-12-27T00:00:00Z'), z('2012-01-03T00:00:00Z'));
  // The same series seen from a window more than ten years after its start:
  // the walk jumps to one day before the window, and that day of margin is
  // what still visits the skipped 30th (whose occurrence is inside the window).
  const apiaWall = Temporal.Instant.from('2000-12-27T20:00:00Z')
    .toZonedDateTimeISO('Pacific/Apia')
    .toPlainTime();
  const afterTheSkip = instantOf('Pacific/Apia', Temporal.PlainDate.from('2011-12-31'), apiaWall);
  add('hand', 'a-skipped-day-after-the-jump',
    commitment(z('2000-12-27T20:00:00Z'), z('2000-12-27T21:00:00Z'), 'FREQ=DAILY', 'Pacific/Apia'),
    iso(afterTheSkip + 30 * MINUTE), iso(afterTheSkip + 90 * MINUTE));
  // Midnight does not exist on the day Havana's clocks go forward.
  add('hand', 'midnight-in-a-gap',
    commitment(z('2026-03-05T05:00:00Z'), z('2026-03-05T06:00:00Z'), 'FREQ=DAILY', 'America/Havana'),
    z('2026-03-05T00:00:00Z'), z('2026-03-11T00:00:00Z'));
  // UNTIL as a local day that ends inside a repeated hour (Santiago falls back at midnight).
  add('hand', 'until-date-on-a-change-day',
    commitment(z('2026-04-01T02:30:00Z'), z('2026-04-01T03:00:00Z'), 'FREQ=DAILY;UNTIL=20260404', 'America/Santiago'),
    z('2026-04-01T00:00:00Z'), z('2026-04-10T00:00:00Z'));
  // A length longer than a day: occurrences overlap each other and the change.
  add('hand', 'long-occurrences-across-a-change',
    commitment(z('2026-10-23T22:30:00Z'), z('2026-10-25T01:30:00Z'), 'FREQ=DAILY', 'Europe/Berlin'),
    z('2026-10-24T00:00:00Z'), z('2026-10-27T00:00:00Z'));
  // A zone that had clock changes when the series began and has none now.
  add('hand', 'zone-that-stopped-changing',
    commitment(z('2018-10-20T02:30:00Z'), z('2018-10-20T03:30:00Z'), 'FREQ=WEEKLY', 'America/Sao_Paulo'),
    z('2018-10-20T00:00:00Z'), z('2019-03-01T00:00:00Z'));
  return cases;
}

/** For every clock change of a zone, series of each frequency whose wall time falls into it. */
function clockChangeCases(prng: Random, years: readonly [number, number], variants: number): Case[] {
  const cases: Case[] = [];
  for (const zone of CHANGING_ZONES) {
    for (const change of transitions(zone, years[0], years[1])) {
      const size = Math.abs(change.deltaMs);
      const after = Temporal.Instant.fromEpochMilliseconds(change.atMs).toZonedDateTimeISO(zone);
      // The wall-clock interval that is skipped (clocks forward) or happens
      // twice (clocks back), on the local date of the change.
      const first =
        change.deltaMs > 0
          ? after.toPlainDateTime().subtract({ milliseconds: size })
          : after.toPlainDateTime();
      for (const freq of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const) {
        for (let variant = 0; variant < variants; variant += 1) {
          const inside = first.add({ minutes: prng.int(size / MINUTE) });
          const day = inside.toPlainDate();
          const wall = inside.toPlainTime();
          let rule: string;
          let startDate: TemporalTypes.PlainDate;
          if (freq === 'DAILY') {
            const interval = prng.pick([1, 1, 2, 3]);
            startDate = day.subtract({ days: interval * prng.between(1, 4) });
            rule = interval === 1 ? 'FREQ=DAILY' : `FREQ=DAILY;INTERVAL=${interval}`;
          } else if (freq === 'WEEKLY') {
            startDate = day.subtract({ days: 7 * prng.between(1, 3) + prng.int(3) });
            rule = `FREQ=WEEKLY;BYDAY=${WEEKDAYS[day.dayOfWeek - 1]},${prng.pick(WEEKDAYS)}`;
          } else if (freq === 'MONTHLY') {
            startDate = day.subtract({ days: prng.between(35, 80) });
            rule = `FREQ=MONTHLY;BYMONTHDAY=${day.day}`;
          } else {
            startDate = day.subtract({ years: prng.between(1, 3) });
            rule = 'FREQ=YEARLY';
          }
          if (prng.chance(0.25)) rule += `;COUNT=${prng.between(3, 400)}`;
          const startMs = instantOf(zone, startDate, wall);
          const lengthMs = prng.pick([30 * MINUTE, HOUR, 90 * MINUTE, 3 * HOUR, 26 * HOUR]);
          const fromMs = change.atMs - prng.between(1, 3) * DAY - prng.int(HOUR);
          const toMs = change.atMs + prng.between(1, 4) * DAY + prng.int(HOUR);
          cases.push({
            id: `dst-${zone}-${iso(change.atMs).slice(0, 10)}-${freq.toLowerCase()}-${variant}`,
            kind: 'dst',
            commitment: commitment(iso(startMs), iso(startMs + lengthMs), rule, zone),
            from: iso(fromMs),
            to: iso(toMs),
          });
        }
      }
    }
  }
  return cases;
}

const LENGTHS = [
  5 * MINUTE, 30 * MINUTE, 30 * MINUTE, HOUR, HOUR, HOUR, 90 * MINUTE, 3 * HOUR,
  DAY, 26 * HOUR, 3 * DAY, 8 * DAY, 1, 45 * MINUTE + 30_000,
] as const;
const WINDOWS = [
  HOUR, DAY, DAY, 7 * DAY, 7 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 30 * DAY, 30 * DAY,
  90 * DAY, 200 * DAY, 366 * DAY,
] as const;

function seededCase(prng: Random, index: number): Case {
  const id = `seeded-${String(index).padStart(5, '0')}`;
  const zone = prng.pick(ZONES);
  const lookback = prng.chance(0.06);
  // A local date and wall time, resolved the way the reference resolves one.
  let date = Temporal.PlainDate.from({
    year: lookback ? prng.between(2004, 2014) : prng.between(2023, 2028),
    month: prng.between(1, 12),
    day: 1,
  });
  const shape = prng.next();
  if (shape < 0.2) date = date.with({ day: date.daysInMonth });
  else if (shape < 0.3) date = date.with({ day: Math.min(prng.between(28, 31), date.daysInMonth) });
  else if (shape < 0.35) date = Temporal.PlainDate.from({ year: prng.pick([2024, 2028]), month: 2, day: 29 });
  else date = date.with({ day: prng.between(1, date.daysInMonth) });
  const time = Temporal.PlainTime.from({
    hour: prng.pick([0, 0, 1, 2, 2, 3, 9, 12, 23, prng.int(24)]),
    minute: prng.pick([0, 0, 15, 30, 30, 45, prng.int(60)]),
    second: prng.chance(0.1) ? prng.int(60) : 0,
    millisecond: prng.chance(0.08) ? prng.int(1000) : 0,
  });
  const startMs = instantOf(zone, date, time);
  const lengthMs = prng.pick(LENGTHS);

  const once = !lookback && prng.chance(0.08);
  const rule = once ? undefined : seededRule(prng, startMs, date.day);
  const series = commitment(iso(startMs), iso(startMs + lengthMs), rule, zone);

  let windowMs: number = prng.pick(WINDOWS);
  let fromMs: number;
  if (once) {
    // Around the appointment, sometimes exactly touching it.
    fromMs = prng.pick([startMs - DAY, startMs, startMs + lengthMs, startMs + lengthMs - 1, startMs - windowMs]);
    if (prng.chance(0.2)) windowMs = startMs - fromMs;
  } else if (lookback) {
    fromMs = Date.UTC(prng.between(2026, 2027), prng.int(12), prng.between(1, 28), prng.int(24));
  } else {
    fromMs = startMs + prng.between(-10, 400) * DAY + prng.int(DAY / MINUTE) * MINUTE;
    const edge = prng.next();
    // A tenth of the windows start off the minute, and a tenth exactly
    // where an occurrence may end.
    if (edge < 0.1) fromMs += prng.int(MINUTE);
    else if (edge < 0.2) fromMs = startMs + lengthMs + prng.between(0, 30) * DAY;
  }
  const fault = prng.next();
  if (fault < 0.02) windowMs = -prng.int(DAY);
  else if (fault < 0.04) windowMs = 366 * DAY + 1 + prng.int(DAY);
  return {
    id,
    kind: once ? 'once' : lookback ? 'lookback' : 'seeded',
    commitment: series,
    from: iso(fromMs),
    to: iso(fromMs + windowMs),
  };
}

// ----------------------------------------------------------------------- pack

export interface PackOptions {
  readonly seed: number;
  /** Seeded expansions; twice as many mutated rules are parsed. */
  readonly count: number;
}

export interface Pack {
  readonly header: {
    readonly format: string;
    readonly formatVersion: number;
    readonly oracle: {
      readonly node: string;
      readonly tzdata: string;
      readonly seed: number;
      readonly count: number;
    };
  };
  readonly records: readonly (ParseRecord | ExpandRecord | ClipRecord)[];
}

/** Builds a pack: every input and what the reference answers for it. */
export function buildPack(options: PackOptions): Pack {
  const prng = random(options.seed);
  const records: (ParseRecord | ExpandRecord | ClipRecord)[] = [];

  for (const rrule of HAND_RULES) records.push(parseRecord(rrule));
  for (let index = 0; index < options.count * 2; index += 1) {
    records.push(parseRecord(mutatedRule(prng)));
  }

  // The sample covers the clock changes of two years; a large pack, ten.
  const large = options.count > SAMPLE.count;
  const cases = [
    ...handCases(),
    ...clockChangeCases(prng, large ? [2020, 2030] : [2026, 2027], large ? 3 : 1),
    ...Array.from({ length: options.count }, (_, index) => seededCase(prng, index)),
  ];
  for (const entry of cases) {
    records.push(expandRecord(entry.id, entry.kind, entry.commitment, entry.from, entry.to));
  }

  const base = Date.UTC(2026, 10, 11, 9);
  for (let index = 0; index < 40; index += 1) {
    const start = base + prng.between(-3, 3) * HOUR + prng.int(4) * 250;
    const end = start + prng.between(0, 5) * HOUR + prng.int(3);
    const from = base + prng.between(-4, 4) * HOUR + prng.int(4) * 250;
    records.push(clipRecord(start, end, from, from + prng.between(0, 6) * HOUR));
  }

  return {
    header: {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      oracle: {
        node: process.version,
        tzdata: process.versions.tz ?? 'unknown',
        seed: options.seed,
        count: options.count,
      },
    },
    records,
  };
}

/**
 * A pack as text: the header line, then one record per line. The text is
 * ASCII — rules hold characters such as U+0085 that some tools take for a
 * line break — so every other character is written as a `\u` escape.
 */
export function packText(pack: Pack): string {
  const line = (value: unknown): string =>
    JSON.stringify(value).replace(
      /[\u007f-\uffff]/gu,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  return `${[pack.header, ...pack.records].map(line).join('\n')}\n`;
}
