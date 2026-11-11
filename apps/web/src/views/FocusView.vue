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
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiSpinner from '../components/ui/UiSpinner.vue';
import { focusContextFor } from '../composables/focusContext';
import { calmMode, setCalmMode } from '../composables/useCalmMode';
import { durationMinutes, formatClock, formatDuration } from '../format';
import { focusClientId } from '../session/clientId';
import {
  enqueueFocusEvent,
  flushFocusJournal,
  retryQuarantinedFocusEvents,
  sendFocusEvent,
} from '../session/focusQueue';
import { sessionJournal, type FocusEventKind } from '../session/journal';
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

import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { useToastStore } from '../stores/toast';

const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const sessions = useSessionStore();
const toast = useToastStore();

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
const displayTime = computed(() => formatDuration(displaySeconds.value));
const stateLabel = computed(() => {
  if (session.value === null) return 'Loading session';
  switch (session.value.state) {
    case 'active':
      return 'Focusing';
    case 'paused':
      return 'Paused';
    default:
      return 'Completed';
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
const plannedMinutes = computed(() => {
  const current = context.value;
  return current === null ? null : durationMinutes(current.startAt, current.endAt);
});
const progressPercent = computed(() => {
  const planned = plannedMinutes.value;
  if (planned === null || planned <= 0) return null;
  return Math.min(100, Math.round((displaySeconds.value / (planned * 60)) * 100));
});
const focusedMinutes = computed(() => Math.floor(displaySeconds.value / 60));

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
      announcement.value = `${minutes} minute${minutes === 1 ? '' : 's'} focused`;
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
    error.value = 'Choose a task or block before starting a focus session.';
    return;
  }
  if (!offline.online) {
    error.value = 'Start focus while online. Offline session events are still recorded once a session is running.';
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
      error.value = 'An active focus session already exists.';
    } else {
      error.value = cause instanceof ApiError ? cause.detail : 'Could not start the focus session.';
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
        error.value = 'This focus session is not available.';
        return;
      }
      error.value = cause instanceof ApiError ? cause.detail : 'Could not refresh the focus session.';
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
        ? 'This focus session is not available.'
        : cause instanceof ApiError
          ? cause.detail
          : 'Could not load this focus session. Check the link and try again.';
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
        error.value = cause.detail;
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
    reviewError.value = 'Connect to the network to upload your review.';
    return;
  }
  if (sessions.pendingCount > 0) {
    await syncPending();
  }
  const ready = session.value;
  if (ready === null) return;
  reviewBusy.value = true;
  reviewError.value = null;
  const scope = `focus:review:${ready.id}`;
  try {
    const action = actions.begin(scope, review, (left, right) => JSON.stringify(left) === JSON.stringify(right), ready.version);
    feedback.value = await plannerClient.reviewSession(ready.id, action.payload, action.key, ready.version);
    actions.settle(scope, action);
    toast.show('Review saved. Estimation feedback updated.');
  } catch (cause) {
    reviewError.value = cause instanceof ApiError ? cause.detail : 'Could not save the review.';
  } finally {
    reviewBusy.value = false;
  }
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
  void router.push('/today');
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
        `${count} focus event${count === 1 ? '' : 's'} saved on this device. Uploading automatically when you reconnect.`,
      );
    }
  },
);
</script>

<template>
  <section
    class="page focus-page"
    :class="{ 'focus-page--calm': calmMode, [`focus-page--${session?.state ?? 'idle'}`]: true }"
    aria-labelledby="focus-heading"
  >
    <header class="page-header focus-header">
      <div class="page-heading">
        <h1 id="focus-heading">Focus</h1>
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
          Calm mode
        </UiButton>
        <UiButton variant="ghost" icon="arrow-left" class="focus-back" @click="goToday">Back to Today</UiButton>
      </div>
    </header>

    <UiBadge v-if="!offline.online" as="p" tone="offline" dot class="chip--offline focus-offline" role="status">
      Offline · timer keeps running locally
    </UiBadge>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <UiBanner
      v-if="quarantinedCount > 0"
      as="section"
      tone="warn"
      title="Focus events need attention"
      class="error-panel quarantine-notice"
      role="status"
    >
      <p class="error-text">
        {{ quarantinedCount }} saved focus event{{ quarantinedCount === 1 ? '' : 's' }} could not
        be replayed and {{ quarantinedCount === 1 ? 'was' : 'were' }} set aside on this device.
      </p>
      <template #actions>
        <UiButton size="sm" icon="sync" :disabled="retryBusy" :busy="retryBusy" @click="retryQuarantine">
          Retry upload
        </UiButton>
        <UiButton size="sm" variant="ghost" :disabled="retryBusy" @click="dismissQuarantine">Dismiss</UiButton>
      </template>
    </UiBanner>

    <UiBanner v-if="resumeOffer && sessions.active" tone="accent" inline class="resume-banner">
      <span>A session is already running.</span>
      <template #actions>
        <UiButton variant="primary" size="sm" icon="play" @click="resumeActive">Resume the active session</UiButton>
      </template>
    </UiBanner>

    <p v-if="loadState === 'loading'" class="loading-row"><UiSpinner /> Loading focus session…</p>
    <UiBanner
      v-else-if="session === null && !isNew && loadState === 'missing'"
      tone="error"
      class="error-panel"
    >
      <p class="error-text" role="alert">{{ error ?? 'This focus session is not available.' }}</p>
      <template #actions>
        <UiButton size="sm" icon="arrow-left" @click="goToday">Back to Today</UiButton>
      </template>
    </UiBanner>

    <template v-if="session">
      <div class="focus-stage">
        <div class="focus-task">
          <p class="focus-task-title">{{ context?.title ?? 'Focus session' }}</p>
          <p class="focus-task-meta">
            <template v-if="context">
              Planned {{ formatClock(context.startAt, context.timeZone) }}–{{ formatClock(context.endAt, context.timeZone) }}
              · {{ plannedMinutes }}m
            </template>
            <template v-else>
              Session for task <span class="mono">{{ session.taskId }}</span>
              <span v-if="session.blockId"> · block {{ session.blockId }}</span>
            </template>
          </p>
        </div>

        <div
          ref="timerEl"
          class="focus-timer"
          role="timer"
          aria-label="Focus timer"
          aria-atomic="true"
          tabindex="-1"
        >
          {{ displayTime }}
        </div>
        <p class="sr-only" aria-live="polite">{{ announcement }}</p>

        <div v-if="progressPercent !== null" class="focus-progress" aria-hidden="true">
          <div class="focus-progress-track">
            <div class="focus-progress-fill" :style="{ width: `${progressPercent}%` }"></div>
          </div>
          <p class="focus-progress-caption">{{ focusedMinutes }}m of {{ plannedMinutes }}m planned</p>
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
            Pause <kbd>space</kbd>
          </UiButton>
          <UiButton
            v-if="canResume || !canPause"
            :variant="canResume ? 'primary' : 'secondary'"
            size="lg"
            icon="play"
            :disabled="!canResume || operationsPending > 0"
            @click="perform('resume')"
          >
            Resume <kbd>space</kbd>
          </UiButton>
          <UiButton
            size="lg"
            icon="flag"
            :disabled="!canComplete || operationsPending > 0"
            @click="perform('complete')"
          >
            Complete <kbd>enter</kbd>
          </UiButton>
        </div>
        <UiButton
          v-if="session.state !== 'completed'"
          variant="ghost"
          size="sm"
          class="focus-timer-shortcut"
          @click="timerEl?.focus()"
        >
          Focus timer <kbd>f</kbd>
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

      <ReviewSheet
        v-if="showReview"
        :disabled="!offline.online"
        :busy="reviewBusy"
        :error="reviewError"
        :feedback="feedback"
        @submit="submitReview"
      />
    </template>

    <UiEmptyState
      v-if="isNew && session === null && !startBusy"
      icon="today"
      title="Choose a block on Today to start a focus session."
    >
      <template #actions>
        <RouterLink class="btn btn--secondary" to="/today">Open Today</RouterLink>
      </template>
    </UiEmptyState>
    <p v-if="startBusy" class="loading-row"><UiSpinner /> Starting focus session…</p>
  </section>
</template>
