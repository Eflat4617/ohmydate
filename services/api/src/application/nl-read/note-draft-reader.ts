import {
  ValidationFailedError,
  instantToEpochMs,
  type Clock,
  type Id,
  type IdGenerator,
} from '@ohmydate/domain';
import {
  BudgetExceeded,
  LlmError,
  LlmTimeoutError,
  WEEKDAY_CODES,
  commitmentCalendar,
  runStructured,
  type BudgetGuard,
  type CommitmentParseInputBundle,
  type CommitmentParseInputRequest,
  type CommitmentParseNow,
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

/**
 * CAL-02 / CAL-05: "read a short note with the LLM into drafts", shared by
 * `POST /commitments:parse` (commitment_parse@v1) and `POST /tasks:parse`
 * (task_parse@v1). One prompt-agnostic lifecycle:
 *
 * - the note is trimmed (all spaces -> 422 before any call); the zone is the
 *   request's or the owner's default; `now` and `calendar` are computed here
 *   from the injected Clock, so the model never does calendar arithmetic;
 * - no provider -> 503 llm_unavailable and no run;
 * - an `agent_run` row exists (pending) before the call and is settled after
 *   it (succeeded / failed / budget_exceeded / cancelled); the spend ledger
 *   links to it through `agentRunId`;
 * - failures map to 503 llm_unavailable / budget_exceeded (never stored for
 *   idempotency by the route, so the same key can retry);
 * - the schema-valid output goes through the prompt's own pure `convert`.
 *
 * Nothing else is written. The note, titles and prompt are never logged or
 * stored here (the run keeps only counts of masked values).
 */

/** The owner's local "now" in `timeZone` (the prompts' `now`). */
export function localNowOf(nowMs: number, timeZone: string): CommitmentParseNow {
  const zoned = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(timeZone);
  return {
    date: zoned.toPlainDate().toString(),
    weekday: WEEKDAY_CODES[zoned.dayOfWeek - 1] as WeekdayCode,
    time: `${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`,
  };
}

const LOCAL_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** A model's local `YYYY-MM-DD`, or null when it is not a real calendar date (2026-02-30 is rejected, never constrained). */
export function parseLocalDate(value: string): Temporal.PlainDate | null {
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' });
  } catch {
    return null;
  }
}

/** A model's local 24-hour `HH:mm`, or null (24:30 is not a time). */
export function parseLocalTime(value: string): Temporal.PlainTime | null {
  const match = LOCAL_TIME.exec(value);
  if (match === null) return null;
  return new Temporal.PlainTime(Number(match[1]), Number(match[2]));
}

/** Wall clock in the zone -> instant (DST gap: forward; fold: the earlier instant; 08 §3). */
export function zonedWallClockInstant(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZone: string,
): Temporal.Instant {
  return date.toPlainDateTime(time).toZonedDateTime(timeZone, { disambiguation: 'compatible' }).toInstant();
}

/** Cut `text` to `max` characters (code points), marking the cut with "…". */
export function truncateText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

export interface DraftConversionContext {
  readonly timeZone: string;
  /** "now" as epoch milliseconds (from the injected Clock). */
  readonly nowMs: number;
}

/** What differs between the readers: the prompt, its schema and how its output becomes drafts. */
export interface NoteReaderSpec<TOutput, TResult> {
  readonly prompt: { readonly promptId: string; readonly version: string };
  readonly schemaId: string;
  /** `agent_run.purpose`. */
  readonly purpose: string;
  /** Limits used when the configuration has none for this prompt. */
  readonly defaultLimits: PromptLimits;
  /** What the person enters by hand when the AI cannot read ("commitment", "task"); problem details only. */
  readonly subject: string;
  buildInput(request: CommitmentParseInputRequest): CommitmentParseInputBundle;
  /** Pure: schema-valid output -> the response body. */
  convert(output: TOutput, context: DraftConversionContext): TResult;
}

export interface NoteReaderOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly agentRuns: Pick<AgentRunRepository, 'recordRun' | 'completeRun'>;
  /** `null`: no provider configured -> 503 llm_unavailable, no run recorded. */
  readonly llm: LlmPort | null;
  readonly llmProvider?: string;
  readonly budgetGuard: BudgetGuard;
  /** Config limits; the reader's prompt falls back to the spec's defaults. */
  readonly promptLimits?: PromptLimitOverrides;
  /** The owner's locale for `outputLanguage` (ko-KR when missing/invalid). */
  readonly ownerLocales?: OwnerLocaleSource;
  /** The owner's zone, the default when the request names none. */
  readonly ownerZone: (ownerId: Id) => Promise<string>;
}

export interface NoteReadRequest {
  readonly text: string;
  readonly timeZone?: string;
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

export class NoteDraftReader<TOutput, TResult> {
  readonly #spec: NoteReaderSpec<TOutput, TResult>;
  readonly #promptIdVersion: string;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #agentRuns: Pick<AgentRunRepository, 'recordRun' | 'completeRun'>;
  readonly #llm: LlmPort | null;
  readonly #llmProvider: string;
  readonly #budgetGuard: BudgetGuard;
  readonly #promptLimits: PromptLimitOverrides;
  readonly #ownerLocales: OwnerLocaleSource | undefined;
  readonly #ownerZone: (ownerId: Id) => Promise<string>;

  constructor(spec: NoteReaderSpec<TOutput, TResult>, options: NoteReaderOptions) {
    this.#spec = spec;
    this.#promptIdVersion = `${spec.prompt.promptId}@${spec.prompt.version}`;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#agentRuns = options.agentRuns;
    this.#llm = options.llm;
    this.#llmProvider = options.llmProvider ?? 'fake';
    this.#budgetGuard = options.budgetGuard;
    const configured = options.promptLimits ?? {};
    this.#promptLimits = Object.freeze({
      ...configured,
      [spec.prompt.promptId]: configured[spec.prompt.promptId] ?? spec.defaultLimits,
    });
    this.#ownerLocales = options.ownerLocales;
    this.#ownerZone = options.ownerZone;
  }

  /** Wall-clock bound of one read (one attempt + one repair + slack): 50 s by default. */
  get totalTimeoutMs(): number {
    return aiCallTotalTimeoutMs(this.#spec.prompt.promptId, this.#promptLimits);
  }

  /**
   * Read `request.text` into drafts. `signal` aborts the model call (client
   * disconnect or shutdown): the run is settled `cancelled` and the request
   * fails as 503 llm_unavailable (not stored for idempotency, so it can retry).
   */
  async read(ownerId: Id, request: NoteReadRequest, signal?: AbortSignal): Promise<TResult> {
    const spec = this.#spec;
    const text = request.text.trim();
    if (text.length === 0) {
      throw new ValidationFailedError([{ path: '/text', message: 'text must contain more than spaces' }]);
    }
    const timeZone = request.timeZone ?? (await this.#ownerZone(ownerId));
    const nowMs = instantToEpochMs(this.#clock.now());
    const now = localNowOf(nowMs, timeZone);
    const llm = this.#llm;
    if (llm === null) throw unavailable(`no LLM provider is configured; enter the ${spec.subject} manually`);

    const locale = this.#ownerLocales === undefined ? undefined : await this.#ownerLocales.localeOf(ownerId);
    const bundle = spec.buildInput({
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
      purpose: spec.purpose,
      promptIdVersion: this.#promptIdVersion,
      model: 'unknown',
      provider: this.#llmProvider,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 0,
      status: 'pending',
      redactionReport: bundle.redactionReport,
    });

    let output: TOutput;
    try {
      const result = await runStructured(
        llm,
        {
          ...spec.prompt,
          input: bundle.input,
          schemaId: spec.schemaId,
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
      output = result.output as TOutput;
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
          detail: `the AI budget is used up; enter the ${spec.subject} manually`,
        });
      }
      if (error instanceof LlmTimeoutError) throw unavailable('the AI did not answer in time; enter it manually');
      if (error instanceof LlmError) throw unavailable('the AI could not read the note; enter it manually');
      throw error;
    }
    return spec.convert(output, { timeZone, nowMs });
  }
}
