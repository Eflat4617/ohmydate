import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue';
import { AI_REQUEST_CLIENT_BOUND_MS, type IntakeInput, type IntakeSession } from '../api';
import { t } from '../i18n';
import type { OwnerBinding } from '../session/ownerEpoch';
import { deviceSlot, ownerSlot } from '../session/ownerStorage';

/**
 * FU-76: client state for one wizard step that waits for the AI.
 *
 * The record is mirrored to sessionStorage so a reload (or a dropped
 * connection) resumes the wait instead of re-submitting: a decomposition is
 * resumed by polling GET /intake-sessions/{id}; type detection (whose session
 * id is unknown until the create returns) by replaying the same
 * Idempotency-Key. Both are idempotent and never start a second, charged run.
 *
 * Owner isolation (ADR-023, FU-76R-1 H2): a record holds the user's private
 * input, so it lives under the VERIFIED owner's own key, is written only while
 * that owner's binding is current, is read back only for that same verified
 * owner (and only if it names that owner), and every record is removed on any
 * owner change or logout. The slot (session/ownerStorage.ts) enforces the
 * write rule and the removal; this module adds the "names that owner" check.
 */

export type AiWaitKind = 'type_detection' | 'decomposition';
export type AiWaitPhase = 'waiting' | 'slow' | 'overdue';

export interface PendingCreateForm {
  readonly title: string;
  readonly dueAt: string;
  readonly description: string;
  readonly fileName: string;
}

export interface PendingAiWait {
  readonly kind: AiWaitKind;
  /** Verified owner the wait belongs to; a wait without one is never persisted. */
  readonly ownerId?: string;
  /** Client epoch ms when the wait began (kept across reloads). */
  readonly startedAt: number;
  /** Known for decomposition waits (and for create once it returned). */
  readonly sessionId?: string;
  /** Create replay data: the exact body and key, plus the raw form for restoring inputs. */
  readonly create?: {
    readonly key: string;
    readonly input: IntakeInput;
    readonly form: PendingCreateForm;
  };
}

const slot = ownerSlot('aiWait');
const legacySlot = deviceSlot('legacyAiWait');

/** Owner-scoped storage: `${AI_WAIT_STORAGE_PREFIX}:${ownerId}`. */
export const AI_WAIT_STORAGE_PREFIX = 'ohmydate.intake.aiWait.v2';
/** Pre-FU-76R-1 unscoped key: never read, removed on sight. */
export const LEGACY_AI_WAIT_STORAGE_KEY = legacySlot.key;

export function aiWaitStorageKey(ownerId: string): string {
  return slot.keyFor(ownerId);
}
/** Copy says "보통 30초–1분": past one minute the panel says it is slower than usual. */
export const AI_WAIT_SLOW_AFTER_MS = 60_000;
/** Screen-reader updates: at 30 s, then once a minute (never every second). */
export const AI_WAIT_ANNOUNCE_FIRST_MS = 30_000;
export const AI_WAIT_ANNOUNCE_EVERY_MS = 60_000;
/** Polling cadence while resuming from the session state. */
export const AI_WAIT_POLL_MS = 3_000;
/** A stored record older than this is dropped instead of resumed. */
export const AI_WAIT_STORAGE_MAX_AGE_MS = 60 * 60 * 1000;
/** Requests that answer quickly never flash the panel. */
export const AI_WAIT_REVEAL_AFTER_MS = 700;

/** The in-progress rule (docs/blueprint/08 §2.3.1): the session still waits for an AI result. */
export function sessionAwaitsAi(session: IntakeSession): AiWaitKind | null {
  if (session.error !== undefined) return null;
  if (session.state === 'type_detection' && session.detectedType === undefined) return 'type_detection';
  if (session.state === 'decomposition' && !session.manual && session.draft === undefined) {
    return 'decomposition';
  }
  return null;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return t('aiWait.seconds', { seconds });
  if (seconds === 0) return t('aiWait.minutes', { minutes });
  return t('aiWait.minutesSeconds', { minutes, seconds });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the given verified owner's record, and only if it names that owner. */
export function readStoredAiWait(ownerId: string, nowMs: number = Date.now()): PendingAiWait | null {
  if (!slot.available()) return null;
  legacySlot.remove();
  const raw = slot.read(ownerId);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const drop = (): null => {
    slot.discard(ownerId);
    return null;
  };
  if (!isRecord(parsed)) return drop();
  const { kind, startedAt, sessionId, create } = parsed;
  if (parsed['ownerId'] !== ownerId) return drop();
  if (kind !== 'type_detection' && kind !== 'decomposition') return drop();
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return drop();
  if (nowMs - startedAt > AI_WAIT_STORAGE_MAX_AGE_MS) return drop();
  if (sessionId !== undefined && typeof sessionId !== 'string') return drop();
  if (create !== undefined) {
    if (!isRecord(create) || typeof create['key'] !== 'string' || !isRecord(create['input'])) return drop();
    if (!isRecord(create['form'])) return drop();
  }
  return parsed as unknown as PendingAiWait;
}

/** Into the record owner's own key, and only while that owner's binding is current. */
function writeStoredAiWait(record: PendingAiWait, binding: OwnerBinding | undefined): void {
  const ownerId = record.ownerId;
  if (ownerId === undefined || binding === undefined || binding.ownerId !== ownerId) return;
  // Storage full or blocked: the wait still works, it just cannot resume after a reload.
  slot.write(binding, JSON.stringify(record));
}

function removeStoredAiWait(record: PendingAiWait, binding: OwnerBinding | undefined): void {
  const ownerId = record.ownerId;
  if (ownerId === undefined || binding === undefined || binding.ownerId !== ownerId) return;
  slot.remove(binding);
}

/**
 * Every owner's AI-wait record (and the legacy unscoped one). ownerStorage
 * runs the same removal on any owner change (login, logout, another tab, /me
 * mismatch), synchronously, before a late continuation could read a record.
 */
export function clearStoredAiWaits(): void {
  slot.clearAllOwners();
  legacySlot.remove();
}

export interface AiWaitState {
  readonly pending: Ref<PendingAiWait | null>;
  readonly elapsedMs: ComputedRef<number>;
  readonly phase: ComputedRef<AiWaitPhase>;
  /** True once the wait has lasted long enough to show the panel. */
  readonly revealed: ComputedRef<boolean>;
  /** Polite live-region text; changes only at milestones. */
  readonly announcement: Ref<string>;
  readonly cancelling: Ref<boolean>;
  readonly connectionLost: Ref<boolean>;
  /**
   * `binding` is the owner binding the wait runs under; the record is
   * persisted only when it names a verified `ownerId` equal to that binding's.
   */
  start(
    record: PendingAiWait,
    options?: { readonly reveal?: 'now' | 'delayed'; readonly binding?: OwnerBinding },
  ): void;
  update(patch: Partial<PendingAiWait>): void;
  finish(outcome?: 'done' | 'cancelled' | 'silent'): void;
  /** Owner change: drop the in-memory wait without touching storage. */
  reset(): void;
}

export function useAiWait(clock: () => number = Date.now): AiWaitState {
  const pending = ref<PendingAiWait | null>(null);
  const now = ref(clock());
  const announcement = ref('');
  const cancelling = ref(false);
  const connectionLost = ref(false);
  const revealNow = ref(false);
  let binding: OwnerBinding | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastMilestone = 0;

  const elapsedMs = computed(() =>
    pending.value === null ? 0 : Math.max(0, now.value - pending.value.startedAt),
  );
  const phase = computed<AiWaitPhase>(() => {
    if (elapsedMs.value >= AI_REQUEST_CLIENT_BOUND_MS) return 'overdue';
    if (elapsedMs.value >= AI_WAIT_SLOW_AFTER_MS) return 'slow';
    return 'waiting';
  });
  const revealed = computed(
    () => pending.value !== null && (revealNow.value || elapsedMs.value >= AI_WAIT_REVEAL_AFTER_MS),
  );

  function titleFor(kind: AiWaitKind): string {
    return kind === 'decomposition' ? t('aiWait.decompositionTitle') : t('aiWait.typeDetectionTitle');
  }

  function milestoneFor(elapsed: number): number {
    if (elapsed < AI_WAIT_ANNOUNCE_FIRST_MS) return 0;
    if (elapsed < AI_WAIT_ANNOUNCE_EVERY_MS) return AI_WAIT_ANNOUNCE_FIRST_MS;
    return Math.floor(elapsed / AI_WAIT_ANNOUNCE_EVERY_MS) * AI_WAIT_ANNOUNCE_EVERY_MS;
  }

  function stopTimer(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function tick(): void {
    now.value = clock();
    const current = pending.value;
    if (current === null) return;
    const milestone = milestoneFor(elapsedMs.value);
    if (milestone > lastMilestone) {
      lastMilestone = milestone;
      const time = formatElapsed(milestone);
      announcement.value =
        milestone >= AI_WAIT_SLOW_AFTER_MS
          ? t('aiWait.live.slow', { time })
          : t('aiWait.live.progress', { time });
    }
  }

  function start(
    record: PendingAiWait,
    options: { readonly reveal?: 'now' | 'delayed'; readonly binding?: OwnerBinding } = {},
  ): void {
    pending.value = record;
    binding = options.binding;
    writeStoredAiWait(record, binding);
    cancelling.value = false;
    connectionLost.value = false;
    revealNow.value = options.reveal !== 'delayed';
    now.value = clock();
    lastMilestone = milestoneFor(Math.max(0, now.value - record.startedAt));
    if (revealNow.value) announcement.value = titleFor(record.kind);
    stopTimer();
    timer = setInterval(tick, 1_000);
  }

  // A delayed wait announces itself once it is actually shown.
  watch(revealed, (shown, before) => {
    if (shown && !before && !revealNow.value && pending.value !== null) {
      announcement.value = titleFor(pending.value.kind);
    }
  });

  function update(patch: Partial<PendingAiWait>): void {
    if (pending.value === null) return;
    const next = { ...pending.value, ...patch, ownerId: pending.value.ownerId } as PendingAiWait;
    pending.value = next;
    writeStoredAiWait(next, binding);
  }

  function clearState(): void {
    stopTimer();
    pending.value = null;
    binding = undefined;
    cancelling.value = false;
    connectionLost.value = false;
    revealNow.value = false;
  }

  function finish(outcome: 'done' | 'cancelled' | 'silent' = 'done'): void {
    const wasShown = revealed.value;
    const current = pending.value;
    const owner = binding;
    clearState();
    if (current !== null) removeStoredAiWait(current, owner);
    if (outcome === 'cancelled') announcement.value = t('aiWait.live.cancelled');
    else if (outcome === 'done' && wasShown) announcement.value = t('aiWait.live.done');
  }

  function reset(): void {
    clearState();
    announcement.value = '';
  }

  onScopeDispose(stopTimer);

  return {
    pending,
    elapsedMs,
    phase,
    revealed,
    announcement,
    cancelling,
    connectionLost,
    start,
    update,
    finish,
    reset,
  };
}
