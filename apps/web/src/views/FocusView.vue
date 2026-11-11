<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ActionStore,
  ApiError,
  plannerClient,
  uuidV7Key,
  type EstimationFeedback,
  type SessionReviewRequest,
  type WorkSession,
} from '../api';
import ReviewSheet from '../components/ReviewSheet.vue';
import { formatDuration } from '../format';
import { focusClientId } from '../session/clientId';
import {
  enqueueFocusEvent,
  flushFocusJournal,
  sendFocusEvent,
} from '../session/focusQueue';
import { sessionJournal, type FocusEventKind } from '../session/journal';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { useToastStore } from '../stores/toast';

const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const sessions = useSessionStore();
const toast = useToastStore();

const sessionId = computed(() => String(route.params.sessionId ?? ''));
const session = computed<WorkSession | null>(() => sessions.get(sessionId.value));
const isNew = computed(() => sessionId.value === 'new');

const elapsedBase = ref(0);
const anchor = ref<number | null>(null);
const now = ref(Date.now());
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

const displaySeconds = computed(
  () => elapsedBase.value + (anchor.value === null ? 0 : Math.max(0, Math.floor((now.value - anchor.value) / 1000))),
);
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

function secondsSinceAnchor(): number {
  if (anchor.value === null) return 0;
  return Math.max(0, Math.floor((Date.now() - anchor.value) / 1000));
}

function recomputeFromSession(): void {
  elapsedBase.value = session.value?.focusedSec ?? 0;
  anchor.value = session.value?.state === 'active' ? Date.now() : null;
  now.value = Date.now();
}

watch(
  () => session.value?.id,
  (id) => {
    if (id === undefined) return;
    recomputeFromSession();
  },
  { immediate: true },
);

watch(
  () => session.value?.state,
  (state) => {
    if (state === 'paused' || state === 'completed') anchor.value = null;
    if (state === 'active' && anchor.value === null) anchor.value = Date.now();
  },
);

watch(
  () => Math.floor(displaySeconds.value / 60),
  (minutes, previous) => {
    if (session.value?.state !== 'active') return;
    if (minutes > 0 && minutes !== previous) {
      announcement.value = `${minutes} minute${minutes === 1 ? '' : 's'} focused`;
    }
  },
);

async function syncPending(): Promise<void> {
  await flushFocusJournal({ store: sessions, online: offline.online });
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
  try {
    const blockId = typeof route.query.blockId === 'string' ? route.query.blockId : undefined;
    const payload = { taskId, ...(blockId === undefined ? {} : { blockId }) };
    const scope = `focus:start:${taskId}`;
    const action = actions.begin(scope, payload, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    const started = await plannerClient.createSession(
      {
        taskId,
        ...(blockId === undefined ? {} : { blockId }),
        clientStartedAt: new Date().toISOString(),
        clientId: focusClientId(),
      },
      action.key,
    );
    actions.settle(scope, action);
    sessions.remember(started);
    await router.replace(`/focus/${started.id}`);
  } catch (cause) {
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

async function perform(kind: FocusEventKind): Promise<void> {
  const current = session.value;
  if (current === null) return;
  if (kind === 'pause' && !canPause.value) return;
  if (kind === 'resume' && !canResume.value) return;
  if (kind === 'complete' && !canComplete.value) return;

  if (kind === 'pause' || kind === 'complete') {
    elapsedBase.value += secondsSinceAnchor();
    anchor.value = null;
  }
  if (kind === 'resume') anchor.value = Date.now();

  error.value = null;
  const mustQueue = !offline.online || sessions.pendingCount > 0;
  if (mustQueue) {
    await enqueueFocusEvent({ store: sessions, online: offline.online }, current, kind);
    if (offline.online) await syncPending();
    return;
  }

  const key = uuidV7Key();
  const clientAt = new Date().toISOString();
  try {
    const updated = await sendFocusEvent(plannerClient, {
      sessionId: current.id,
      kind,
      clientAt,
      idempotencyKey: key,
      expectedVersion: current.version,
    });
    sessions.update(updated);
    if (kind === 'pause') elapsedBase.value = updated.focusedSec;
    if (kind === 'resume') anchor.value = Date.now();
    if (kind === 'complete') {
      elapsedBase.value = updated.focusedSec;
      anchor.value = null;
    }
  } catch (cause) {
    if (cause instanceof ApiError) {
      error.value = cause.detail;
      recomputeFromSession();
      return;
    }
    await enqueueFocusEvent({ store: sessions, online: false, key, clientAt }, current, kind);
  }
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
  void startFromQuery().then(() => syncPending());
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

    <div v-if="resumeOffer && sessions.active" class="resume-banner">
      <span>A session is already running.</span>
      <button type="button" class="primary-action" @click="resumeActive">Resume the active session</button>
    </div>

    <div v-if="session === null && !isNew" class="error-panel">
      <p class="error-text" role="alert">This focus session is not saved on this device.</p>
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
          :disabled="!canPause"
          @click="perform('pause')"
        >
          Pause <kbd>space</kbd>
        </button>
        <button type="button" :disabled="!canResume" @click="perform('resume')">
          Resume <kbd>space</kbd>
        </button>
        <button type="button" :disabled="!canComplete" @click="perform('complete')">
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
