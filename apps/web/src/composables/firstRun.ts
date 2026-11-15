import { computed, ref, type ComputedRef } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient } from '../api';
import { addDaysToDate, todayInZone, zonedWallClockToInstant } from '../domain/time';
import { browserTimeZone } from '../i18n/format';
import { useLayoutNow } from '../layout/now';
import { ownerFenced, useOwnerKey } from '../session/ownerBound';
import { captureOwnerBinding, type OwnerBinding } from '../session/ownerEpoch';
import { ownerSlot } from '../session/ownerStorage';
import { useLlmConsentStore } from '../stores/llmConsent';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import { useGoogleIntegration } from './useGoogleCalendar';
import { readCommitments, retryTransient } from './usePlannerRange';

/**
 * 처음 한 번 (HOLO-04, FLOW.md §3): the three-step start guide — when can you
 * work, any fixed appointments, should the AI help — and who still needs it.
 *
 * A step is **done** when the owner's own data says so (hours are set, a 약속
 * exists or a calendar is connected, the AI question has an answer), whoever
 * set it and wherever. It is **skipped** when the owner said "건너뛰기" here;
 * a skipped step is asked again at the moment it is needed (the plan flow's
 * own inline steps), never from a settings screen. The guide is over when no
 * step is left to do, or when the owner ended it.
 *
 * What is kept on the device is only that — which steps were skipped, and
 * whether it was ended — per owner, through the owner-scoped storage module
 * (slot `firstRun`). A returning owner never sees the guide again.
 */
export const FIRST_RUN_STEPS = ['hours', 'commitments', 'ai'] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];
export type FirstRunStepState = 'done' | 'skipped' | 'todo' | 'unknown';

export interface FirstRunRecord {
  /** The guide has been on screen at least once on this device. */
  readonly seen: boolean;
  readonly skipped: readonly FirstRunStep[];
  /** The owner ended it (finished its last step, or said "나중에 할게요"). */
  readonly ended: boolean;
}

/** How far ahead "do you have any fixed appointments" looks (the plan flow's own window). */
const COMMITMENT_DAYS = 28;

const slot = ownerSlot('firstRun');
/** Browser storage is not reactive: bumped on every write so readers look again. */
const revision = ref(0);

export function firstRunKey(ownerId: string | null): string {
  return slot.keyFor(ownerId);
}

function isStep(value: unknown): value is FirstRunStep {
  return typeof value === 'string' && (FIRST_RUN_STEPS as readonly string[]).includes(value);
}

/** What this device knows of the owner's start guide; null when it has never been shown here. */
export function readFirstRun(ownerId: string | null): FirstRunRecord | null {
  if (ownerId === null) return null;
  const raw = slot.read(ownerId);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return {
      seen: record['seen'] === true,
      skipped: Array.isArray(record['skipped']) ? record['skipped'].filter(isStep) : [],
      ended: record['ended'] === true,
    };
  } catch {
    return null;
  }
}

/** Into the binding's owner namespace, only while that binding is current (ADR-023). */
export function writeFirstRun(binding: OwnerBinding, record: FirstRunRecord): boolean {
  if (binding.ownerId === null) return false;
  const result = slot.write(binding, JSON.stringify({ seen: record.seen, skipped: [...new Set(record.skipped)], ended: record.ended }));
  revision.value += 1;
  return result !== 'stale' && result !== 'sealed';
}

const EMPTY: FirstRunRecord = { seen: false, skipped: [], ended: false };

/** The state of each step from what is known; `unknown` while its data has not answered. */
export function firstRunStates(input: {
  readonly record: FirstRunRecord | null;
  /** Weekly rules of the owner's available hours; null while not known. */
  readonly ruleCount: number | null;
  /** 약속 in the coming weeks; null while not known. */
  readonly commitmentCount: number | null;
  readonly calendarConnected: boolean;
  /** The AI question still has no answer (the provider needs consent and none was given or refused). */
  readonly aiUndecided: boolean;
}): Record<FirstRunStep, FirstRunStepState> {
  const skipped = new Set(input.record?.skipped ?? []);
  const of = (step: FirstRunStep, done: boolean | null): FirstRunStepState => {
    if (done === true) return 'done';
    if (skipped.has(step)) return 'skipped';
    return done === null ? 'unknown' : 'todo';
  };
  return {
    hours: of('hours', input.ruleCount === null ? null : input.ruleCount > 0),
    commitments: of(
      'commitments',
      input.calendarConnected ? true : input.commitmentCount === null ? null : input.commitmentCount > 0,
    ),
    ai: of('ai', !input.aiUndecided),
  };
}

const NOTHING_LEFT: Record<FirstRunStep, FirstRunStepState> = { hours: 'done', commitments: 'done', ai: 'done' };

/** The guide of an owner who ended it: over, with nothing to read or ask. */
function finishedFirstRun(): FirstRun {
  return {
    states: computed(() => NOTHING_LEFT),
    remaining: computed(() => []),
    finished: computed(() => true),
    wanted: computed(() => false),
    pending: computed(() => false),
    open: computed(() => false),
    start: () => undefined,
    close: () => undefined,
    skip: () => undefined,
    end: () => undefined,
  };
}

export interface FirstRun {
  readonly states: ComputedRef<Record<FirstRunStep, FirstRunStepState>>;
  /** Steps still to do, in order. */
  readonly remaining: ComputedRef<FirstRunStep[]>;
  /** Nothing is left: every step is done or skipped, or the owner ended it. */
  readonly finished: ComputedRef<boolean>;
  /** A new owner on this device: the guide should open by itself. */
  readonly wanted: ComputedRef<boolean>;
  /** Not known yet whether it is wanted (the owner's hours have not answered). */
  readonly pending: ComputedRef<boolean>;
  readonly open: ComputedRef<boolean>;
  start(): void;
  close(): void;
  skip(step: FirstRunStep): void;
  /** End it: nothing is asked again from here. */
  end(): void;
}

/**
 * The signed-in owner's start guide. Every read is owner-keyed (and fenced
 * where it pages); every write takes the binding of the press that caused it.
 */
export function useFirstRun(): FirstRun {
  const ui = useUiStore();
  const sessionStore = useSessionStore();
  // A returning owner who ended it reads nothing for it: no lookup is made at all.
  if (readFirstRun(sessionStore.ownerId)?.ended === true) return finishedFirstRun();
  const llmConsent = useLlmConsentStore();
  const offline = useOfflineStore();
  const owner = useOwnerKey();
  const now = useLayoutNow();

  const record = computed(() => {
    void revision.value;
    return readFirstRun(sessionStore.ownerId);
  });
  const ended = computed(() => record.value?.ended === true);
  // Nothing is decided, read or written before it is known who is signed in.
  const known = computed(() => sessionStore.ownerId !== null);

  // The same lookup (and cache entry) every screen that needs the owner's zone makes.
  const availability = useQuery({
    queryKey: ['availability'],
    queryFn: () => plannerClient.getAvailability(),
    enabled: known,
  });
  const google = useGoogleIntegration();

  const timeZone = computed(() => availability.data.value?.timeZone ?? browserTimeZone());
  const range = computed(() => {
    // Asked only while the guide still matters, and once the zone is known.
    if (ended.value || availability.data.value === undefined || !offline.online) return null;
    const today = todayInZone(timeZone.value, now.value);
    try {
      return {
        from: zonedWallClockToInstant(today, 0, timeZone.value),
        to: zonedWallClockToInstant(addDaysToDate(today, COMMITMENT_DAYS), 0, timeZone.value),
      };
    } catch {
      return null;
    }
  });
  const commitments = useQuery({
    queryKey: computed(() => ['plan-commitments', owner.value, range.value?.from ?? 'none', range.value?.to ?? 'none']),
    queryFn: ({ queryKey }) =>
      ownerFenced(String(queryKey[1]), async (binding) => {
        const page = await readCommitments(binding, { from: String(queryKey[2]), to: String(queryKey[3]) });
        return page.items.length;
      }),
    enabled: computed(() => range.value !== null),
    retry: retryTransient,
  });

  const states = computed(() =>
    firstRunStates({
      record: record.value,
      ruleCount: availability.data.value === undefined ? null : availability.data.value.rules.length,
      commitmentCount: commitments.data.value ?? null,
      calendarConnected: google.data.value?.status === 'connected',
      aiUndecided: llmConsent.undecided,
    }),
  );
  const remaining = computed(() => FIRST_RUN_STEPS.filter((step) => states.value[step] === 'todo'));
  const finished = computed(
    () => ended.value || FIRST_RUN_STEPS.every((step) => states.value[step] === 'done' || states.value[step] === 'skipped'),
  );
  // New here: never shown on this device, and no hours at all. An owner who already
  // set their hours is not new, whatever else is missing — the card on 개요 covers that.
  const pending = computed(
    () => record.value === null && (!known.value || (availability.data.value === undefined && !availability.isError.value)),
  );
  const wanted = computed(() => known.value && record.value === null && states.value.hours === 'todo');

  function save(next: Partial<FirstRunRecord>): void {
    writeFirstRun(captureOwnerBinding(), { ...(record.value ?? EMPTY), ...next });
  }

  function start(): void {
    if (!known.value) return;
    save({ seen: true });
    ui.setFirstRun(true);
  }

  function close(): void {
    ui.setFirstRun(false);
  }

  function skip(step: FirstRunStep): void {
    save({ seen: true, skipped: [...(record.value?.skipped ?? []), step] });
  }

  function end(): void {
    save({ seen: true, ended: true });
    ui.setFirstRun(false);
  }

  return {
    states,
    remaining,
    finished,
    wanted,
    pending,
    open: computed(() => ui.firstRunOpen),
    start,
    close,
    skip,
    end,
  };
}
