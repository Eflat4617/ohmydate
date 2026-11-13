import {
  COMMITMENT_PARSE_LEFTOVER_MAX,
  type CommitmentDraft,
  type CommitmentDraftNote,
  type CommitmentParseRequest,
  type CommitmentParseResponse,
} from '@ohmydate/contracts';
import {
  ValidationFailedError,
  epochMsToInstant,
  instantToEpochMs,
  type Clock,
  type Id,
  type IdGenerator,
} from '@ohmydate/domain';
import {
  BudgetExceeded,
  COMMITMENT_PARSE_PROMPT,
  COMMITMENT_PARSE_SCHEMA_ID,
  DEFAULT_COMMITMENT_PARSE_MAX_OUTPUT_TOKENS,
  DEFAULT_COMMITMENT_PARSE_TIMEOUT_MS,
  LlmError,
  LlmTimeoutError,
  WEEKDAY_CODES,
  buildCommitmentParseInput,
  commitmentCalendar,
  runStructured,
  type BudgetGuard,
  type CommitmentParseItem,
  type CommitmentParseNow,
  type CommitmentParseOutput,
  type LlmPort,
  type PromptLimitOverrides,
  type PromptLimits,
  type WeekdayCode,
} from '@ohmydate/llm';
import { Temporal } from 'temporal-polyfill';
import { DailyProblemError } from '../daily-errors.js';
import { aiCallTotalTimeoutMs } from '../intake/ai-runs.js';
import { resolveOutputLanguage } from '../intake/output-language.js';
import type { AgentRunRepository, AgentRunStatus, OwnerLocaleSource } from '../intake/ports.js';
import { validateCommitment } from '../plan-service.js';

/**
 * CAL-02: natural-language commitment entry (`POST /commitments:parse`).
 *
 * The person writes what they have on ("다음 주 화요일 오후 3시에 치과"); the
 * model (commitment_parse@v1) returns LOCAL dates and times only, and this
 * use-case turns every item into a draft:
 *
 * - local date + time in the zone -> UTC instants through Temporal (DST gap:
 *   the next valid instant, fold: the first one; 08 §3), never `Date` math;
 * - no end time -> start + 60 min (`duration_defaulted`); a guessed date ->
 *   `date_assumed`; `weeklyDays` -> `FREQ=WEEKLY;BYDAY=…[;UNTIL=…]`
 *   (`repeats_weekly`);
 * - every item is validated AFTER the schema: a real calendar date, end after
 *   start, start at most 1 day in the past and at most 2 years ahead, plus the
 *   create-path bounds (`validateCommitment`). A failing item is dropped into
 *   `leftover`; it is never a 500.
 *
 * Nothing is written except the `agent_run` row (pending before the call,
 * settled after, spend-ledger linked through `agentRunId`). The drafts are a
 * proposal: the client adds each one through `POST /commitments`. The note,
 * the titles and the prompt are never logged or stored here.
 */

export const COMMITMENT_PARSE_PURPOSE = 'commitment_parse';
const PROMPT_ID_VERSION = `${COMMITMENT_PARSE_PROMPT.promptId}@${COMMITMENT_PARSE_PROMPT.version}`;
export const COMMITMENT_PARSE_LIMITS: PromptLimits = Object.freeze({
  maxOutputTokens: DEFAULT_COMMITMENT_PARSE_MAX_OUTPUT_TOKENS,
  timeoutMs: DEFAULT_COMMITMENT_PARSE_TIMEOUT_MS,
});
/** A draft must not start more than this long before now. */
const PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_MINUTES = 60;
const LEFTOVER_SEPARATOR = ' / ';
const LOCAL_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export interface CommitmentParseServiceOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly agentRuns: Pick<AgentRunRepository, 'recordRun' | 'completeRun'>;
  /** `null`: no provider configured -> 503 llm_unavailable, no run recorded. */
  readonly llm: LlmPort | null;
  readonly llmProvider?: string;
  readonly budgetGuard: BudgetGuard;
  /** Config limits; `commitment_parse` falls back to COMMITMENT_PARSE_LIMITS. */
  readonly promptLimits?: PromptLimitOverrides;
  /** The owner's locale for `outputLanguage` (ko-KR when missing/invalid). */
  readonly ownerLocales?: OwnerLocaleSource;
  /** The owner's availability zone, the default when the request names none. */
  readonly ownerZone: (ownerId: Id) => Promise<string>;
}

export interface DraftConversionContext {
  readonly timeZone: string;
  /** "now" as epoch milliseconds (from the injected Clock). */
  readonly nowMs: number;
}

export interface DraftConversion {
  readonly drafts: CommitmentDraft[];
  readonly leftover: string;
}

/** The owner's local "now" in `timeZone` (the prompt's `now`). */
export function localNowOf(nowMs: number, timeZone: string): CommitmentParseNow {
  const zoned = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(timeZone);
  return {
    date: zoned.toPlainDate().toString(),
    weekday: WEEKDAY_CODES[zoned.dayOfWeek - 1] as WeekdayCode,
    time: `${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`,
  };
}

class DroppedItem extends Error {}

function plainDate(value: string): Temporal.PlainDate {
  try {
    // ISO strings with an impossible day (2026-02-30) are rejected, never constrained.
    return Temporal.PlainDate.from(value, { overflow: 'reject' });
  } catch {
    throw new DroppedItem('not a calendar date');
  }
}

function plainTime(value: string): Temporal.PlainTime {
  const match = LOCAL_TIME.exec(value);
  if (match === null) throw new DroppedItem('not a wall-clock time');
  return new Temporal.PlainTime(Number(match[1]), Number(match[2]));
}

/** Wall clock in the zone -> instant (DST gap: forward; fold: the earlier instant). */
function zonedInstant(date: Temporal.PlainDate, time: Temporal.PlainTime, timeZone: string): Temporal.Instant {
  return date.toPlainDateTime(time).toZonedDateTime(timeZone, { disambiguation: 'compatible' }).toInstant();
}

function isoInstant(instant: Temporal.Instant): string {
  return epochMsToInstant(instant.epochMilliseconds);
}

function orderedDays(days: readonly WeekdayCode[]): WeekdayCode[] {
  const wanted = new Set(days);
  return WEEKDAY_CODES.filter((code) => wanted.has(code));
}

/** How the dropped item reads in `leftover`: its title and the model's date/time, no instant. */
function leftoverText(item: CommitmentParseItem): string {
  const when = [item.date, item.startTime].filter((part) => part !== null && part.length > 0).join(' ');
  const title = item.title.trim();
  if (when.length === 0) return title;
  return title.length === 0 ? `(${when})` : `${title} (${when})`;
}

function convertItem(item: CommitmentParseItem, context: DraftConversionContext): CommitmentDraft {
  const title = item.title.trim();
  if (title.length === 0 || title.length > 200) throw new DroppedItem('title');
  const notes: CommitmentDraftNote[] = [];
  const zonedNow = Temporal.Instant.fromEpochMilliseconds(context.nowMs).toZonedDateTimeISO(context.timeZone);
  const today = zonedNow.toPlainDate();
  // "At most 2 years ahead": the same local wall clock two years from now.
  const latestZoned = zonedNow.add({ years: 2 });
  const latest = latestZoned.toPlainDate();
  let date = plainDate(item.date);

  let rrule: string | undefined;
  if (item.weeklyDays !== null && item.weeklyDays.length > 0) {
    const days = orderedDays(item.weeklyDays);
    // The first occurrence is the start: move forward to the first listed weekday.
    for (let step = 0; step < 7 && !days.includes(WEEKDAY_CODES[date.dayOfWeek - 1] as WeekdayCode); step += 1) {
      date = date.add({ days: 1 });
    }
    rrule = `FREQ=WEEKLY;BYDAY=${days.join(',')}`;
    if (item.untilDate !== null) {
      const until = plainDate(item.untilDate);
      if (Temporal.PlainDate.compare(until, date) < 0) throw new DroppedItem('until before start');
      rrule += `;UNTIL=${until.toString().replaceAll('-', '')}`;
    }
    notes.push('repeats_weekly');
  }
  if (item.dateWasGuessed) notes.push('date_assumed');

  if (Temporal.PlainDate.compare(date, today.subtract({ days: 1 })) < 0) throw new DroppedItem('past');
  if (Temporal.PlainDate.compare(date, latest) > 0) throw new DroppedItem('too far ahead');

  const base = {
    title,
    timeZone: context.timeZone,
    date: date.toString(),
    ...(rrule === undefined ? {} : { rrule }),
  };
  if (item.startTime === null) {
    // No time in the note: the client asks for it before the draft can be added.
    return { ...base, notes };
  }

  const start = zonedInstant(date, plainTime(item.startTime), context.timeZone);
  let end: Temporal.Instant;
  if (item.endTime === null) {
    end = start.add({ minutes: DEFAULT_DURATION_MINUTES });
    notes.unshift('duration_defaulted');
  } else {
    const endDate = item.endDate === null ? date : plainDate(item.endDate);
    end = zonedInstant(endDate, plainTime(item.endTime), context.timeZone);
  }
  if (Temporal.Instant.compare(end, start) <= 0) throw new DroppedItem('end not after start');
  if (start.epochMilliseconds < context.nowMs - PAST_TOLERANCE_MS) throw new DroppedItem('past');
  if (start.epochMilliseconds > latestZoned.epochMilliseconds) throw new DroppedItem('too far ahead');

  const startAt = isoInstant(start);
  const endAt = isoInstant(end);
  try {
    // The same bounds the create call enforces (interval, RRULE shape and COUNT).
    validateCommitment(
      { title, startAt, endAt, timeZone: context.timeZone, ...(rrule === undefined ? {} : { rrule }) },
      epochMsToInstant(context.nowMs),
    );
  } catch (error) {
    if (error instanceof ValidationFailedError) throw new DroppedItem('create bounds');
    throw error;
  }
  return { ...base, startAt, endAt, notes };
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Pure: schema-valid model output -> drafts + leftover (exported for tests).
 * Items keep their order; an item that fails validation is dropped and its
 * text appended to the leftover.
 */
export function draftsFromOutput(output: CommitmentParseOutput, context: DraftConversionContext): DraftConversion {
  const drafts: CommitmentDraft[] = [];
  const leftover: string[] = [];
  if (output.leftover.trim().length > 0) leftover.push(output.leftover.trim());
  for (const item of output.items) {
    try {
      drafts.push(convertItem(item, context));
    } catch (error) {
      if (!(error instanceof DroppedItem) && !(error instanceof RangeError)) throw error;
      const text = leftoverText(item);
      if (text.length > 0) leftover.push(text);
    }
  }
  return { drafts, leftover: truncate(leftover.join(LEFTOVER_SEPARATOR), COMMITMENT_PARSE_LEFTOVER_MAX) };
}

function unavailable(detail: string): DailyProblemError {
  return new DailyProblemError({ status: 503, code: 'llm_unavailable', title: 'LLM unavailable', detail });
}

function usageOf(error: unknown): { inputTokens: number; outputTokens: number; costUsd: number } {
  const usage = error instanceof LlmError ? error.usage : undefined;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costUsd: usage?.costUsd ?? 0,
  };
}

export class CommitmentParseService {
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #agentRuns: Pick<AgentRunRepository, 'recordRun' | 'completeRun'>;
  readonly #llm: LlmPort | null;
  readonly #llmProvider: string;
  readonly #budgetGuard: BudgetGuard;
  readonly #promptLimits: PromptLimitOverrides;
  readonly #ownerLocales: OwnerLocaleSource | undefined;
  readonly #ownerZone: (ownerId: Id) => Promise<string>;

  constructor(options: CommitmentParseServiceOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#agentRuns = options.agentRuns;
    this.#llm = options.llm;
    this.#llmProvider = options.llmProvider ?? 'fake';
    this.#budgetGuard = options.budgetGuard;
    const configured = options.promptLimits ?? {};
    this.#promptLimits = Object.freeze({
      ...configured,
      commitment_parse: configured['commitment_parse'] ?? COMMITMENT_PARSE_LIMITS,
    });
    this.#ownerLocales = options.ownerLocales;
    this.#ownerZone = options.ownerZone;
  }

  /** Wall-clock bound of one read (one attempt + one repair + slack): 50 s by default. */
  get totalTimeoutMs(): number {
    return aiCallTotalTimeoutMs(COMMITMENT_PARSE_PROMPT.promptId, this.#promptLimits);
  }

  /**
   * Read `request.text` into drafts. `signal` aborts the model call (client
   * disconnect or shutdown): the run is settled `cancelled` and the request
   * fails as 503 llm_unavailable (not stored for idempotency, so it can retry).
   */
  async parse(ownerId: Id, request: CommitmentParseRequest, signal?: AbortSignal): Promise<CommitmentParseResponse> {
    const text = request.text.trim();
    if (text.length === 0) {
      throw new ValidationFailedError([{ path: '/text', message: 'text must contain more than spaces' }]);
    }
    const timeZone = request.timeZone ?? (await this.#ownerZone(ownerId));
    const nowMs = instantToEpochMs(this.#clock.now());
    const now = localNowOf(nowMs, timeZone);
    const llm = this.#llm;
    if (llm === null) throw unavailable('no LLM provider is configured; enter the commitment manually');

    const locale = this.#ownerLocales === undefined ? undefined : await this.#ownerLocales.localeOf(ownerId);
    const bundle = buildCommitmentParseInput({
      text,
      now,
      calendar: commitmentCalendar(now.date),
      timeZone,
      outputLanguage: resolveOutputLanguage(locale),
    });
    // The run exists (pending) before the call, like intake type detection.
    const runId = this.#ids.next();
    await this.#agentRuns.recordRun({
      id: runId,
      ownerId,
      purpose: COMMITMENT_PARSE_PURPOSE,
      promptIdVersion: PROMPT_ID_VERSION,
      model: 'unknown',
      provider: this.#llmProvider,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 0,
      status: 'pending',
      redactionReport: bundle.redactionReport,
    });

    let output: CommitmentParseOutput;
    try {
      const result = await runStructured(
        llm,
        {
          ...COMMITMENT_PARSE_PROMPT,
          input: bundle.input,
          schemaId: COMMITMENT_PARSE_SCHEMA_ID,
          ownerId,
          // Non-identifying provider session (hashed with the owner by the adapter).
          sessionKey: runId,
          agentRunId: runId,
        },
        {
          budgetGuard: this.#budgetGuard,
          estimatedCostUsd: 0,
          promptLimits: this.#promptLimits,
          totalTimeoutMs: this.totalTimeoutMs,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      await this.#agentRuns.completeRun(ownerId, runId, {
        model: result.model,
        provider: result.provider ?? this.#llmProvider,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        costUsd: result.usage.costUsd ?? 0,
        latencyMs: result.latencyMs,
        status: 'succeeded',
      });
      output = result.output as CommitmentParseOutput;
    } catch (error) {
      const cancelled = signal?.aborted === true;
      const status: Exclude<AgentRunStatus, 'pending'> = cancelled
        ? 'cancelled'
        : error instanceof BudgetExceeded
          ? 'budget_exceeded'
          : 'failed';
      const usage = usageOf(error);
      await this.#agentRuns.completeRun(ownerId, runId, {
        model: 'unknown',
        provider: this.#llmProvider,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costUsd: usage.costUsd,
        latencyMs: 0,
        status,
      });
      if (cancelled) throw unavailable('the read was cancelled before the answer arrived');
      if (error instanceof BudgetExceeded) {
        throw new DailyProblemError({
          status: 503,
          code: 'budget_exceeded',
          title: 'LLM budget exceeded',
          detail: 'the AI budget is used up; enter the commitment manually',
        });
      }
      if (error instanceof LlmTimeoutError) throw unavailable('the AI did not answer in time; enter it manually');
      if (error instanceof LlmError) throw unavailable('the AI could not read the note; enter it manually');
      throw error;
    }
    return draftsFromOutput(output, { timeZone, nowMs });
  }
}
