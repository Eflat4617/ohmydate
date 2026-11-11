import type {
  EstimationFeedback,
  SessionCreate,
  SessionEventRequest,
  SessionListQuery,
  SessionReviewRequest,
  WorkSession,
  WorkSessionPage,
} from '@ohmydate/contracts';
import {
  NotFoundError,
  VersionConflictError,
  epochMsToInstant,
  instantToEpochMs,
  type Clock,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { sessionStateConflict } from './daily-errors.js';

const MINUTE_MS = 60_000;
const FORWARD_CLOCK_TOLERANCE_MS = 2 * MINUTE_MS;
const STARTED_AT_LOOKBACK_MS = 24 * 60 * MINUTE_MS;

export interface WorkSessionRecord {
  readonly id: Id;
  readonly ownerId: Id;
  readonly taskId: Id;
  readonly blockId?: Id;
  readonly state: WorkSession['state'];
  readonly startedAt: Instant;
  readonly endedAt?: Instant;
  readonly focusedSec: number;
  readonly pausedSec: number;
  readonly clientId: string;
  readonly version: number;
}

export interface WorkSessionUpdate {
  readonly state: WorkSession['state'];
  readonly endedAt?: Instant;
  readonly focusedSec: number;
  readonly pausedSec: number;
  readonly now: Instant;
}

export interface SessionReviewResult {
  readonly taskId: Id;
  readonly estimatedP50: number;
  readonly actualFocusMin: number;
  readonly quality: EstimationFeedback['quality'];
  readonly sessionId: Id;
}

export interface WorkSessionStore {
  create(input: {
    readonly id: Id;
    readonly ownerId: Id;
    readonly taskId: Id;
    readonly blockId?: Id;
    readonly startedAt: Instant;
    readonly clientId: string;
    readonly now: Instant;
  }): Promise<WorkSessionRecord>;
  get(ownerId: Id, id: Id): Promise<WorkSessionRecord | null>;
  list(ownerId: Id, query: SessionListQuery): Promise<WorkSessionPage>;
  update(
    ownerId: Id,
    id: Id,
    expectedVersion: number,
    update: WorkSessionUpdate,
  ): Promise<WorkSessionRecord>;
  /**
   * Creates the review and estimation feedback in one transaction. Throws
   * `session_state_conflict` when a review already exists for the session.
   */
  createReview(input: {
    readonly reviewId: Id;
    readonly feedbackId: Id;
    readonly ownerId: Id;
    readonly sessionId: Id;
    readonly taskId: Id;
    readonly outcome: SessionReviewRequest['outcome'];
    readonly reasonChips: readonly SessionReviewRequest['reasonChips'][number][];
    readonly note?: string;
    readonly estimatedP50: number;
    readonly actualFocusMin: number;
    readonly quality: EstimationFeedback['quality'];
    readonly now: Instant;
  }): Promise<void>;
  getCurrentEstimateP50(ownerId: Id, taskId: Id): Promise<number>;
  sumCompletedFocusSec(ownerId: Id, taskId: Id): Promise<number>;
}

function toDto(record: WorkSessionRecord): WorkSession {
  return {
    id: record.id,
    taskId: record.taskId,
    ...(record.blockId === undefined ? {} : { blockId: record.blockId }),
    state: record.state,
    startedAt: record.startedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    focusedSec: record.focusedSec,
    pausedSec: record.pausedSec,
    clientId: record.clientId,
    version: record.version,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class SessionService {
  readonly #store: WorkSessionStore;
  readonly #clock: Clock;
  readonly #ids: import('@ohmydate/domain').IdGenerator;

  constructor(deps: {
    readonly store: WorkSessionStore;
    readonly clock: Clock;
    readonly ids: import('@ohmydate/domain').IdGenerator;
  }) {
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
  }

  async create(ownerId: Id, input: SessionCreate): Promise<WorkSession> {
    const now = this.#clock.now();
    const nowMs = instantToEpochMs(now);
    const rawStart = instantToEpochMs(input.clientStartedAt as Instant);
    const startedMs = clamp(
      rawStart,
      nowMs - STARTED_AT_LOOKBACK_MS,
      nowMs + FORWARD_CLOCK_TOLERANCE_MS,
    );
    const record = await this.#store.create({
      id: this.#ids.next(),
      ownerId,
      taskId: input.taskId as Id,
      ...(input.blockId === undefined ? {} : { blockId: input.blockId as Id }),
      startedAt: epochMsToInstant(startedMs),
      clientId: input.clientId,
      now,
    });
    return toDto(record);
  }

  async get(ownerId: Id, id: Id): Promise<WorkSession> {
    const record = await this.#store.get(ownerId, id);
    if (record === null) throw new NotFoundError('work session', id);
    return toDto(record);
  }

  async list(ownerId: Id, query: SessionListQuery): Promise<WorkSessionPage> {
    return this.#store.list(ownerId, query);
  }

  async pause(
    ownerId: Id,
    id: Id,
    input: SessionEventRequest,
    expectedVersion: Version,
  ): Promise<WorkSession> {
    return this.#transition(ownerId, id, 'pause', input.clientAt as Instant, expectedVersion);
  }

  async resume(
    ownerId: Id,
    id: Id,
    input: SessionEventRequest,
    expectedVersion: Version,
  ): Promise<WorkSession> {
    return this.#transition(ownerId, id, 'resume', input.clientAt as Instant, expectedVersion);
  }

  async complete(
    ownerId: Id,
    id: Id,
    input: SessionEventRequest,
    expectedVersion: Version,
  ): Promise<WorkSession> {
    return this.#transition(ownerId, id, 'complete', input.clientAt as Instant, expectedVersion);
  }

  async review(
    ownerId: Id,
    sessionId: Id,
    input: SessionReviewRequest,
    expectedVersion: Version,
  ): Promise<EstimationFeedback> {
    const session = await this.#store.get(ownerId, sessionId);
    if (session === null) throw new NotFoundError('work session', sessionId);
    if (session.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, session.version as Version);
    }
    if (session.state !== 'completed') {
      throw sessionStateConflict('only a completed session can be reviewed');
    }
    const estimatedP50 = await this.#store.getCurrentEstimateP50(ownerId, session.taskId);
    const totalFocusSec = await this.#store.sumCompletedFocusSec(ownerId, session.taskId);
    const actualFocusMin = Math.round(totalFocusSec / 60);
    const quality: EstimationFeedback['quality'] = estimateQuality(estimatedP50, actualFocusMin);
    const now = this.#clock.now();
    await this.#store.createReview({
      reviewId: this.#ids.next(),
      feedbackId: this.#ids.next(),
      ownerId,
      sessionId,
      taskId: session.taskId,
      outcome: input.outcome,
      reasonChips: [...input.reasonChips],
      ...(input.note === undefined ? {} : { note: input.note }),
      estimatedP50,
      actualFocusMin,
      quality,
      now,
    });
    return {
      taskId: session.taskId,
      estimatedP50,
      actualFocusMin,
      quality,
    };
  }

  async #transition(
    ownerId: Id,
    id: Id,
    action: 'pause' | 'resume' | 'complete',
    clientAt: Instant,
    expectedVersion: Version,
  ): Promise<WorkSession> {
    const current = await this.#store.get(ownerId, id);
    if (current === null) throw new NotFoundError('work session', id);
    if (current.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, current.version as Version);
    }
    const allowed =
      action === 'pause'
        ? current.state === 'active'
        : action === 'resume'
          ? current.state === 'paused'
          : current.state === 'active' || current.state === 'paused';
    if (!allowed) {
      throw sessionStateConflict(`${current.state} cannot ${action}`);
    }

    const now = this.#clock.now();
    const nowMs = instantToEpochMs(now);
    const startedMs = instantToEpochMs(current.startedAt);
    const cursorMs = startedMs + (current.focusedSec + current.pausedSec) * 1000;
    const rawMs = instantToEpochMs(clientAt);
    // M4-01R: out-of-range and out-of-order values are clamped to the nearest
    // accepted bound and recorded; only illegal state transitions are 409.
    const eventMs = Math.max(
      cursorMs,
      clamp(rawMs, startedMs, nowMs + FORWARD_CLOCK_TOLERANCE_MS),
    );
    const deltaSec = Math.floor((eventMs - cursorMs) / 1000);
    const focusedSec = current.focusedSec + (action === 'pause' || action === 'complete'
      ? (current.state === 'active' ? deltaSec : 0)
      : 0);
    const pausedSec = current.pausedSec + (action === 'resume' || action === 'complete'
      ? (current.state === 'paused' ? deltaSec : 0)
      : 0);
    const nextState = action === 'pause'
      ? 'paused'
      : action === 'resume'
        ? 'active'
        : 'completed';
    const record = await this.#store.update(ownerId, id, expectedVersion, {
      state: nextState,
      ...(action === 'complete' ? { endedAt: epochMsToInstant(eventMs) } : {}),
      focusedSec,
      pausedSec,
      now,
    });
    return toDto(record);
  }
}

/**
 * Documented quality rule: a completed session is an `outlier` when the
 * estimated P50 is known and actual focus is below half or above twice P50.
 * Unknown estimates (P50 = 0) are always `outlier` so learning skips them.
 */
export function estimateQuality(estimatedP50: number, actualFocusMin: number): EstimationFeedback['quality'] {
  if (estimatedP50 <= 0) return 'outlier';
  if (actualFocusMin < estimatedP50 / 2) return 'outlier';
  if (actualFocusMin > estimatedP50 * 2) return 'outlier';
  return 'ok';
}
