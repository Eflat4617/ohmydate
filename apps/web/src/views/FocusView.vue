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
import { formatDuration } from '../format';
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
  const binding = captureOwnerBinding();
  await retryQuarantinedFocusEvents({
    store: sessions,
    online: offline.online,
    binding,
  });
  if (offline.online && isOwnerBindingCurrent(binding)) {
    await flushFocusJournal({ store: sessions, online: true });
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
  <section class="page focus-page" aria-labelledby="focus-heading">
    <header class="page-header">
      <div>
        <h1 id="focus-heading">Focus</h1>
        <p class="muted">{{ stateLabel }}</p>
      </div>
      <button type="button" class="link-button" @click="goToday">Back to Today</button>
    </header>

    <p v-if="!offline.online" class="chip chip--offline" role="status">Offline · timer keeps running locally</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <section v-if="quarantinedCount > 0" class="error-panel quarantine-notice" role="status">
      <p class="error-text">
        {{ quarantinedCount }} saved focus event{{ quarantinedCount === 1 ? '' : 's' }} could not
        be replayed and {{ quarantinedCount === 1 ? 'was' : 'were' }} set aside on this device.
      </p>
      <div class="dialog-actions">
        <button type="button" @click="retryQuarantine">Retry upload</button>
        <button type="button" @click="dismissQuarantine">Dismiss</button>
      </div>
    </section>

    <div v-if="resumeOffer && sessions.active" class="resume-banner">
      <span>A session is already running.</span>
      <button type="button" class="primary-action" @click="resumeActive">Resume the active session</button>
    </div>

    <p v-if="loadState === 'loading'" class="muted">Loading focus session…</p>
    <div v-else-if="session === null && !isNew && loadState === 'missing'" class="error-panel">
      <p class="error-text" role="alert">{{ error ?? 'This focus session is not available.' }}</p>
      <button type="button" @click="goToday">Back to Today</button>
    </div>

    <template v-if="session">
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

      <p class="muted focus-task">
        Session for task <span class="mono">{{ session.taskId }}</span>
        <span v-if="session.blockId"> · block {{ session.blockId }}</span>
      </p>

      <div class="focus-actions">
        <button
          type="button"
          class="primary-action"
          :disabled="!canPause || operationsPending > 0"
          @click="perform('pause')"
        >
          Pause <kbd>space</kbd>
        </button>
        <button type="button" :disabled="!canResume || operationsPending > 0" @click="perform('resume')">
          Resume <kbd>space</kbd>
        </button>
        <button type="button" :disabled="!canComplete || operationsPending > 0" @click="perform('complete')">
          Complete <kbd>enter</kbd>
        </button>
        <button type="button" class="link-button" @click="timerEl?.focus()">Focus timer <kbd>f</kbd></button>
      </div>

      <p
        v-if="syncMessage"
        class="focus-sync-status"
        :class="`focus-sync-status--${syncTone}`"
        role="status"
        aria-live="polite"
      >
        {{ syncMessage }}
      </p>

      <ReviewSheet
        v-if="showReview"
        :disabled="!offline.online"
        :busy="reviewBusy"
        :error="reviewError"
        :feedback="feedback"
        @submit="submitReview"
      />
    </template>

    <p v-if="isNew && session === null && !startBusy" class="muted empty-state">
      Choose a block on Today to start a focus session.
    </p>
    <p v-if="startBusy" class="muted">Starting focus session…</p>
  </section>
</template>
