<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ActionStore,
  ApiError,
  plannerClient,
  uuidV7Key,
  type EstimationFeedback,
  type SessionCreate,
  type SessionReviewRequest,
  type WorkSession,
} from '../api';
import ReviewSheet from '../components/ReviewSheet.vue';
import FocusNextStep from '../components/focus/FocusNextStep.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiSpinner from '../components/ui/UiSpinner.vue';
import { focusContextFor, focusTaskTitle } from '../composables/focusContext';
import { markSessionReviewed } from '../layout/localSignals';
import { calmMode, setCalmMode } from '../composables/useCalmMode';
import { t, tp } from '../i18n';
import { browserTimeZone, formatDateTime, formatDuration, formatTimeRange, formatTimer, minutesBetween } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { focusClientId } from '../session/clientId';
import {
  enqueueFocusEvent,
  flushFocusJournal,
  retryQuarantinedFocusEvents,
  sendFocusEvent,
} from '../session/focusQueue';
import { sessionJournal, type FocusEventKind } from '../session/journal';
import { runOwnerBound } from '../session/ownerBound';
import {
  captureOwnerBinding,
  isOwnerBindingCurrent,
  type OwnerBinding,
} from '../session/ownerEpoch';
import {
  clearQuarantine,
  listQuarantine,
  quarantineRevision,
} from '../session/quarantine';

import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { useToastStore } from '../stores/toast';

const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const sessions = useSessionStore();
const toast = useToastStore();
const auth = useAuthStore();
/** A session without a remembered block says when it started, in the user's zone. */
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());

const sessionId = computed(() => String(route.params.sessionId ?? ''));
const isNew = computed(() => sessionId.value === 'new');
const remoteSession = ref<WorkSession | null>(null);
const loadState = ref<'idle' | 'loading' | 'missing'>('idle');
const session = computed<WorkSession | null>(
  () => sessions.get(sessionId.value) ?? remoteSession.value,
);

const now = ref(Date.now());
const operationsPending = ref(0);
let operationChain: Promise<void> = Promise.resolve();
const timerEl = ref<HTMLElement | null>(null);
const announcement = ref('');
const error = ref<string | null>(null);
const startBusy = ref(false);
const resumeOffer = ref(false);
const feedback = ref<EstimationFeedback | null>(null);
const reviewBusy = ref(false);
const reviewError = ref<string | null>(null);
const retryBusy = ref(false);
const actions = new ActionStore();
let timer: ReturnType<typeof setInterval> | null = null;

const displaySeconds = computed(() => {
  const current = session.value;
  if (current === null) return 0;
  if (current.state !== 'active') return current.focusedSec;
  const cursorMs =
    Date.parse(current.startedAt) + (current.focusedSec + current.pausedSec) * 1000;
  return current.focusedSec + Math.max(0, Math.floor((now.value - cursorMs) / 1000));
});
const displayTime = computed(() => formatTimer(displaySeconds.value));
const stateLabel = computed(() => {
  if (session.value === null) return t('focus.stateLoading');
  switch (session.value.state) {
    case 'active':
      return t('focus.stateActive');
    case 'paused':
      return t('focus.statePaused');
    default:
      return t('focus.stateCompleted');
  }
});
const stateTone = computed(() => {
  switch (session.value?.state) {
    case 'active':
      return 'accent' as const;
    case 'paused':
      return 'warn' as const;
    case 'completed':
      return 'success' as const;
    default:
      return 'neutral' as const;
  }
});
const context = computed(() => {
  const current = session.value;
  if (current === null) return null;
  return focusContextFor(sessions.ownerId, current.blockId, current.taskId);
});
/*
 * HOLO-02: the task's name, never its id. A session started on a block has
 * it in its context; one started on a bare task (타임 트래커) was given it by
 * the screen that started it; after a reload it is read from the task itself.
 */
const fetchedTitle = ref<string | null>(null);
const taskTitle = computed(() => {
  const current = session.value;
  if (current === null) return null;
  return context.value?.title ?? focusTaskTitle(sessions.ownerId, current.taskId) ?? fetchedTitle.value;
});
watch(
  () => (taskTitle.value === null ? (session.value?.taskId ?? null) : null),
  (taskId) => {
    if (taskId === null || !offline.online) return;
    const binding = captureOwnerBinding();
    plannerClient.getTask(taskId, { signal: binding.signal }).then(
      (task) => {
        if (isOwnerBindingCurrent(binding) && session.value?.taskId === taskId) fetchedTitle.value = task.title;
      },
      () => undefined,
    );
  },
  { immediate: true },
);
const plannedMinutes = computed(() => {
  const current = context.value;
  return current === null ? null : minutesBetween(current.startAt, current.endAt);
});
const progressPercent = computed(() => {
  const planned = plannedMinutes.value;
  if (planned === null || planned <= 0) return null;
  return Math.min(100, Math.round((displaySeconds.value / (planned * 60)) * 100));
});
const focusedMinutes = computed(() => Math.floor(displaySeconds.value / 60));
// Presentational only: the progress meter is ruled into ten-minute cells.
const progressCells = computed(() => Math.max(1, Math.ceil((plannedMinutes.value ?? 0) / 10)));

function toggleCalm(): void {
  setCalmMode(!calmMode.value);
}

// Calm mode only exists while the timer runs. Once the session is completed
// (or no longer loaded) leave it, so the review sheet and the post-review
// state keep "Back to Today" and the shell's navigation visible — otherwise
// touch users have no in-app way out (UI-POLISHR-1). Runs before render.
watch(
  () => session.value?.state ?? null,
  (state) => {
    if (calmMode.value && state !== 'active' && state !== 'paused') setCalmMode(false);
  },
);

const canPause = computed(() => session.value?.state === 'active');
const canResume = computed(() => session.value?.state === 'paused');
const canComplete = computed(
  () => session.value?.state === 'active' || session.value?.state === 'paused',
);
const showReview = computed(() => session.value?.state === 'completed');
const syncMessage = computed(() => sessions.syncMessage);
const syncTone = computed(() => sessions.syncState);
const quarantinedCount = computed(() => {
  void quarantineRevision.value;
  return listQuarantine(sessions.ownerId).length;
});

async function retryQuarantine(): Promise<void> {
  if (retryBusy.value) return;
  retryBusy.value = true;
  const binding = captureOwnerBinding();
  try {
    await retryQuarantinedFocusEvents({
      store: sessions,
      online: offline.online,
      binding,
    });
    if (offline.online && isOwnerBindingCurrent(binding)) {
      await flushFocusJournal({ store: sessions, online: true });
    }
  } finally {
    retryBusy.value = false;
  }
}

function dismissQuarantine(): void {
  clearQuarantine(sessions.ownerId);
}

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    tag === 'A' ||
    target.isContentEditable
  );
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      },
    );
  });
}

function scheduleOperation<T>(task: () => Promise<T>): Promise<T | undefined> {
  const binding: OwnerBinding = captureOwnerBinding();
  operationsPending.value += 1;
  const start = () => {
    if (binding.signal.aborted) return Promise.resolve(undefined);
    return abortable(task(), binding.signal);
  };
  const run = operationChain.then(start, start);
  operationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run
    .catch((cause: unknown) => {
      if (isAbortError(cause)) return undefined;
      throw cause;
    })
    .finally(() => {
      operationsPending.value = Math.max(0, operationsPending.value - 1);
    });
}

watch(
  () => Math.floor(displaySeconds.value / 60),
  (minutes, previous) => {
    if (session.value?.state !== 'active') return;
    if (minutes > 0 && minutes !== previous) {
      announcement.value = t('focus.announce', { duration: formatDuration(minutes) });
    }
  },
);

function syncPending(): Promise<void> {
  return scheduleOperation(async () => {
    await flushFocusJournal({ store: sessions, online: offline.online });
  }).then(() => undefined);
}

async function startFromQuery(): Promise<void> {
  if (!isNew.value || startBusy.value) return;
  const taskId = typeof route.query.taskId === 'string' ? route.query.taskId : null;
  if (taskId === null) {
    error.value = t('focus.chooseTask');
    return;
  }
  if (!offline.online) {
    error.value = t('focus.startOffline');
    return;
  }
  startBusy.value = true;
  error.value = null;
  const binding = captureOwnerBinding();
  const scope = `focus:start:${taskId}`;
  let action = actions.peek<SessionCreate>(scope);
  try {
    const blockId = typeof route.query.blockId === 'string' ? route.query.blockId : undefined;
    const input: SessionCreate =
      action?.payload ?? {
        taskId,
        ...(blockId === undefined ? {} : { blockId }),
        clientStartedAt: new Date().toISOString(),
        clientId: focusClientId(),
      };
    action = actions.begin(scope, input, samePayload);
    const started = await plannerClient.createSession(
      action.payload,
      action.key,
      binding.signal,
    );
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) {
      sessions.remember(started, binding);
      return;
    }
    sessions.remember(started);
    await router.replace(`/focus/${started.id}`);
  } catch (cause) {
    if (action !== undefined && cause instanceof ApiError) actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    if (cause instanceof ApiError && cause.status === 409 && cause.code === 'active_session_exists') {
      resumeOffer.value = true;
      error.value = t('focus.activeExists');
    } else {
      error.value = errorMessage(cause, t('focus.startFailed'));
    }
  } finally {
    startBusy.value = false;
  }
}

async function restoreSession(): Promise<void> {
  if (isNew.value) return;
  const binding = captureOwnerBinding();
  loadState.value = 'idle';
  const local = sessions.get(sessionId.value);
  if (local !== null) {
    if (!offline.online || sessions.pendingCount > 0) return;
    try {
      const fresh = await plannerClient.getSession(local.id, {
        fresh: true,
        signal: binding.signal,
      });
      if (!isOwnerBindingCurrent(binding)) {
        if (fresh.version >= local.version) sessions.remember(fresh, binding);
        return;
      }
      if (fresh.version >= local.version) {
        sessions.update(fresh);
        remoteSession.value = fresh;
      }
    } catch (cause) {
      if (!isOwnerBindingCurrent(binding)) return;
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 403)) {
        sessions.forget(local.id);
        remoteSession.value = null;
        loadState.value = 'missing';
        error.value = t('focus.unavailable');
        return;
      }
      error.value = errorMessage(cause, t('focus.refreshFailed'));
    }
    return;
  }
  if (!offline.online) {
    loadState.value = 'missing';
    return;
  }
  loadState.value = 'loading';
  try {
    const fresh = await plannerClient.getSession(sessionId.value, {
      fresh: true,
      signal: binding.signal,
    });
    if (!isOwnerBindingCurrent(binding)) {
      sessions.remember(fresh, binding);
      return;
    }
    remoteSession.value = fresh;
    sessions.remember(fresh);
    loadState.value = 'idle';
  } catch (cause) {
    if (!isOwnerBindingCurrent(binding)) return;
    loadState.value = 'missing';
    error.value =
      cause instanceof ApiError && (cause.status === 404 || cause.status === 403)
        ? t('focus.unavailable')
        : errorMessage(cause, t('focus.loadFailed'));
  }
}

async function perform(kind: FocusEventKind): Promise<void> {
  if (operationsPending.value > 0) return;
  const initial = session.value;
  if (initial === null) return;
  if (kind === 'pause' && initial.state !== 'active') return;
  if (kind === 'resume' && initial.state !== 'paused') return;
  if (kind === 'complete' && initial.state !== 'active' && initial.state !== 'paused') return;

  await scheduleOperation(async () => {
    const binding = captureOwnerBinding();
    const current = session.value;
    if (current === null) return;
    if (kind === 'pause' && current.state !== 'active') return;
    if (kind === 'resume' && current.state !== 'paused') return;
    if (kind === 'complete' && current.state !== 'active' && current.state !== 'paused') return;

    error.value = null;
    const mustQueue = !offline.online || sessions.pendingCount > 0;
    if (mustQueue) {
      await enqueueFocusEvent(
        { store: sessions, online: offline.online, binding },
        current,
        kind,
      );
      if (offline.online && isOwnerBindingCurrent(binding)) {
        await flushFocusJournal({ store: sessions, online: true });
      }
      return;
    }

    const key = uuidV7Key();
    const clientAt = new Date().toISOString();
    try {
      const updated = await sendFocusEvent(
        plannerClient,
        {
          sessionId: current.id,
          kind,
          clientAt,
          idempotencyKey: key,
          expectedVersion: current.version,
        },
        binding.signal,
      );
      sessions.update(updated, binding);
    } catch (cause) {
      if (cause instanceof ApiError) {
        if (!isOwnerBindingCurrent(binding)) return;
        error.value = errorMessage(cause);
        now.value = Date.now();
        return;
      }
      await enqueueFocusEvent(
        { store: sessions, online: false, key, clientAt, binding },
        current,
        kind,
      );
    }
  });
}

async function submitReview(review: SessionReviewRequest): Promise<void> {
  const current = session.value;
  if (current === null || reviewBusy.value) return;
  if (!offline.online) {
    reviewError.value = t('focus.reviewOffline');
    return;
  }
  // ADR-023: the submission runs under the owner who started it. A
  // continuation that resumes after a user switch writes nothing — not to the
  // screen, not to either owner's storage. reviewSession takes no AbortSignal;
  // `owner.wait` stops waiting for it instead (the request itself completes).
  await runOwnerBound(
    function* (owner) {
      if (sessions.pendingCount > 0) yield* owner.wait(syncPending());
      const ready = session.value;
      if (ready === null) return;
      reviewBusy.value = true;
      reviewError.value = null;
      const scope = `focus:review:${ready.id}`;
      try {
        const action = actions.begin(scope, review, (left, right) => JSON.stringify(left) === JSON.stringify(right), ready.version);
        const result = yield* owner.wait(plannerClient.reviewSession(ready.id, action.payload, action.key, ready.version));
        actions.settle(scope, action);
        feedback.value = result;
        // The layout's review prompt only counts sessions without a review; the
        // id goes into the namespace of the owner who submitted it.
        markSessionReviewed(owner.binding, ready.id);
        toast.show(t('focus.reviewSaved'));
      } catch (cause) {
        reviewError.value = errorMessage(cause, t('focus.reviewFailed'));
      }
    },
    {
      onSettled: () => {
        reviewBusy.value = false;
      },
    },
  );
}

function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;
  if (session.value === null) return;
  if (operationsPending.value > 0 && (event.code === 'Space' || event.key === 'Enter')) return;
  if (event.code === 'Space' || event.key === ' ') {
    if (!canPause.value && !canResume.value) return;
    event.preventDefault();
    void perform(canPause.value ? 'pause' : 'resume');
  } else if (event.key === 'Enter') {
    if (!canComplete.value) return;
    event.preventDefault();
    void perform('complete');
  } else if (event.key === 'f') {
    event.preventDefault();
    timerEl.value?.focus();
  } else if (event.key === 'Escape' && calmMode.value) {
    event.preventDefault();
    setCalmMode(false);
  }
}

function goToday(): void {
  void router.push('/overview');
}

function resumeActive(): void {
  const active = sessions.active;
  if (active !== null) void router.push(`/focus/${active.id}`);
}

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
  window.addEventListener('keydown', onKeydown);
  void scheduleOperation(async () => {
    await restoreSession();
    await startFromQuery();
    await flushFocusJournal({ store: sessions, online: offline.online });
  });
});

onUnmounted(() => {
  setCalmMode(false);
  if (timer !== null) clearInterval(timer);
  window.removeEventListener('keydown', onKeydown);
});

watch(
  () => offline.online,
  (online) => {
    if (online) void syncPending();
  },
);
// Another session on the same screen (다음 블록 시작): what the last one's
// review earned is not this one's.
watch(sessionId, (next, previous) => {
  if (next === previous) return;
  feedback.value = null;
  reviewError.value = null;
  error.value = null;
  resumeOffer.value = false;
  fetchedTitle.value = null;
  remoteSession.value = null;
});
watch(
  () => sessions.ownerId,
  (owner, previous) => {
    if (owner === previous) return;
    remoteSession.value = null;
    feedback.value = null;
    error.value = null;
    loadState.value = 'idle';
    void scheduleOperation(async () => {
      await restoreSession();
      await flushFocusJournal({ store: sessions, online: offline.online });
    });
  },
);


watch(
  () => sessions.pendingCount,
  (count) => {
    if (count > 0 && !offline.online) {
      sessions.setSyncState(
        'offline',
        tp('sync.pendingOffline', count),
      );
    }
  },
);
</script>

<template>
  <section
    class="page focus-page"
    :class="{ 'focus-page--calm': calmMode, 'scheme-dark': calmMode, [`focus-page--${session?.state ?? 'idle'}`]: true }"
    aria-labelledby="focus-heading"
  >
    <header class="page-header focus-header">
      <div class="page-heading">
        <h1 id="focus-heading">{{ t('focus.title') }}</h1>
        <UiBadge as="p" :tone="stateTone" dot size="lg" class="focus-state">{{ stateLabel }}</UiBadge>
      </div>
      <div class="page-actions">
        <UiButton
          v-if="session && session.state !== 'completed'"
          variant="ghost"
          :icon="calmMode ? 'collapse' : 'expand'"
          :aria-pressed="calmMode ? 'true' : 'false'"
          @click="toggleCalm"
        >
          {{ t('focus.calm') }}
        </UiButton>
        <UiButton variant="ghost" icon="arrow-left" class="focus-back" @click="goToday">
          {{ t('focus.backToToday') }}
        </UiButton>
      </div>
    </header>

    <UiBadge v-if="!offline.online" as="p" tone="offline" dot class="chip--offline focus-offline" role="status">
      {{ t('focus.offline') }}
    </UiBadge>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <UiBanner
      v-if="quarantinedCount > 0"
      as="section"
      tone="warn"
      :title="t('quarantine.title')"
      class="error-panel quarantine-notice"
      role="status"
    >
      <p class="error-text">{{ tp('quarantine.body', quarantinedCount) }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" :disabled="retryBusy" :busy="retryBusy" @click="retryQuarantine">
          {{ t('quarantine.retry') }}
        </UiButton>
        <UiButton size="sm" variant="ghost" :disabled="retryBusy" @click="dismissQuarantine">
          {{ t('common.dismiss') }}
        </UiButton>
      </template>
    </UiBanner>

    <UiBanner v-if="resumeOffer && sessions.active" tone="accent" inline class="resume-banner">
      <span>{{ t('today.alreadyRunning') }}</span>
      <template #actions>
        <UiButton variant="primary" size="sm" icon="play" @click="resumeActive">{{ t('today.resumeActive') }}</UiButton>
      </template>
    </UiBanner>

    <p v-if="loadState === 'loading'" class="loading-row"><UiSpinner /> {{ t('focus.loading') }}</p>
    <UiBanner
      v-else-if="session === null && !isNew && loadState === 'missing'"
      tone="error"
      class="error-panel"
    >
      <p class="error-text" role="alert">{{ error ?? t('focus.unavailable') }}</p>
      <template #actions>
        <UiButton size="sm" icon="arrow-left" @click="goToday">{{ t('focus.backToToday') }}</UiButton>
      </template>
    </UiBanner>

    <template v-if="session">
      <div class="card focus-stage">
        <div class="focus-task">
          <p class="focus-task-title">
            <span class="focus-task-title-text">{{ taskTitle ?? t('focus.fallbackTitle') }}</span>
          </p>
          <p class="focus-task-meta">
            <template v-if="context">
              {{
                t('focus.planned', {
                  range: formatTimeRange(context.startAt, context.endAt, context.timeZone),
                  duration: formatDuration(plannedMinutes ?? 0),
                })
              }}
            </template>
            <template v-else>{{ t('focus.startedAt', { when: formatDateTime(session.startedAt, timeZone) }) }}</template>
          </p>
        </div>

        <div
          ref="timerEl"
          class="focus-timer"
          role="timer"
          :aria-label="t('focus.timer')"
          aria-atomic="true"
          tabindex="-1"
        >
          {{ displayTime }}
        </div>
        <p class="sr-only" aria-live="polite">{{ announcement }}</p>

        <div v-if="progressPercent !== null" class="focus-progress" aria-hidden="true">
          <div
            class="focus-progress-track meter"
            :style="{ '--value': progressPercent / 100, '--cells': progressCells }"
          >
            <div class="focus-progress-fill meter-fill"></div>
          </div>
          <p class="focus-progress-caption">
            {{
              t('focus.progress', {
                planned: formatDuration(plannedMinutes ?? 0),
                focused: formatDuration(focusedMinutes),
              })
            }}
          </p>
        </div>

        <div v-if="session.state !== 'completed'" class="focus-actions">
          <UiButton
            v-if="canPause || !canResume"
            variant="primary"
            size="lg"
            icon="pause"
            :disabled="!canPause || operationsPending > 0"
            @click="perform('pause')"
          >
            {{ t('focus.pause') }} <kbd>space</kbd>
          </UiButton>
          <UiButton
            v-if="canResume || !canPause"
            :variant="canResume ? 'primary' : 'secondary'"
            size="lg"
            icon="play"
            :disabled="!canResume || operationsPending > 0"
            @click="perform('resume')"
          >
            {{ t('focus.resume') }} <kbd>space</kbd>
          </UiButton>
          <UiButton
            size="lg"
            icon="flag"
            :disabled="!canComplete || operationsPending > 0"
            @click="perform('complete')"
          >
            {{ t('focus.complete') }} <kbd>enter</kbd>
          </UiButton>
        </div>
        <UiButton
          v-if="session.state !== 'completed'"
          variant="ghost"
          size="sm"
          class="focus-timer-shortcut"
          @click="timerEl?.focus()"
        >
          {{ t('focus.focusTimer') }} <kbd>f</kbd>
        </UiButton>

        <p
          v-if="syncMessage"
          class="focus-sync-status"
          :class="`focus-sync-status--${syncTone}`"
          role="status"
          aria-live="polite"
        >
          {{ syncMessage }}
        </p>
      </div>

      <!-- ④ → ⑤: once the review is in, the next step holds the filled button (FLOW §5). -->
      <FocusNextStep v-if="showReview && feedback" :finished-block-id="session.blockId ?? null" :feedback="feedback" />
      <ReviewSheet
        v-if="showReview"
        :disabled="!offline.online"
        :busy="reviewBusy"
        :error="reviewError"
        :submitted="feedback !== null"
        @submit="submitReview"
      />
    </template>

    <UiEmptyState
      v-if="isNew && session === null && !startBusy"
      icon="today"
      :title="t('focus.empty')"
    >
      <template #actions>
        <RouterLink class="btn btn--secondary" to="/overview">{{ t('focus.openToday') }}</RouterLink>
      </template>
    </UiEmptyState>
    <p v-if="startBusy" class="loading-row"><UiSpinner /> {{ t('focus.starting') }}</p>
  </section>
</template>
