<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  availabilityEtagForVersion,
  plannerClient,
  type SessionCreate,
  type TodayBlock,
  type TodayProposal,
} from '../api';
import ProposalPreview from '../components/ProposalPreview.vue';
import { addDaysToDate, zonedWallClockToInstant } from '../domain/time';
import { durationMinutes, formatClock, formatDay, formatSlack, localDateIso } from '../format';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { useToastStore } from '../stores/toast';
import { focusClientId } from '../session/clientId';
import {
  captureOwnerBinding,
  isOwnerBindingCurrent,
} from '../session/ownerEpoch';

const router = useRouter();
const offline = useOfflineStore();
const sessionStore = useSessionStore();
const toast = useToastStore();
const actions = new ActionStore();

const date = localDateIso();
const ownerId = computed(() => sessionStore.ownerId);
const todayQuery = useQuery({
  queryKey: computed(() => ['today', date, ownerId.value ?? 'anonymous']),
  queryFn: () => plannerClient.getToday(date),
});

const today = computed(() => todayQuery.data.value ?? null);

const scheduleQuery = useQuery({
  queryKey: computed(() => [
    'today-schedule-blocks',
    today.value?.date ?? date,
    today.value?.timeZone ?? 'UTC',
    ownerId.value ?? 'anonymous',
  ]),
  queryFn: async () => {
    const current = today.value;
    if (current === null) throw new Error('Today is not loaded');
    return plannerClient.listScheduleBlocks({
      from: zonedWallClockToInstant(current.date, 0, current.timeZone),
      to: zonedWallClockToInstant(addDaysToDate(current.date, 1), 0, current.timeZone),
      limit: 100,
    });
  },
  enabled: computed(() => today.value !== null),
});

const resumableQuery = useQuery({
  queryKey: computed(() => ['sessions', 'resumable', ownerId.value ?? 'anonymous']),
  queryFn: async () => {
    const binding = captureOwnerBinding();
    const active = await plannerClient.listSessions({ state: 'active', limit: 1 });
    let session = active.items[0] ?? null;
    if (session === null) {
      const paused = await plannerClient.listSessions({ state: 'paused', limit: 1 });
      session = paused.items[0] ?? null;
    }
    return { ownerId: binding.ownerId, session };
  },
  enabled: computed(() => offline.online),
});

watch(
  resumableQuery.data,
  (result) => {
    if (result === undefined || result.session === null) return;
    if (result.ownerId !== sessionStore.ownerId) return;
    sessionStore.remember(result.session);
  },
  { immediate: true },
);

const blocks = computed<TodayBlock[]>(() => {
  const current = today.value;
  if (current === null) return [];
  const schedule = scheduleQuery.data.value;
  if (schedule === undefined || scheduleQuery.isError.value) return current.blocks;
  const enrichment = new Map(
    schedule.items
      .filter((block) => block.status !== 'superseded')
      .map((block) => [block.id, block]),
  );
  return current.blocks.map((block) => {
    const approved = enrichment.get(block.id);
    return approved === undefined
      ? block
      : {
          ...block,
          startAt: approved.startAt,
          endAt: approved.endAt,
          status: approved.status,
        };
  });
});

const isLoading = computed(
  () => todayQuery.isLoading.value || (today.value !== null && scheduleQuery.isLoading.value),
);
const isError = computed(() => todayQuery.isError.value);
const readOnly = computed(() => !offline.mutationsEnabled);

const error = ref<string | null>(null);
const startingBlockId = ref<string | null>(null);
const resumeOffer = ref(false);
const shrinkingBlock = ref<TodayBlock | null>(null);
const shrinkTarget = ref(25);
const busy = ref(false);
const proposal = ref<TodayProposal | null>(null);
const proposalError = ref<string | null>(null);

const activeSession = computed(() => {
  const fromQuery =
    resumableQuery.data.value?.ownerId === sessionStore.ownerId
      ? resumableQuery.data.value.session
      : null;
  return sessionStore.active ?? fromQuery ?? null;
});

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError) return cause.detail;
  if (cause instanceof Error) return cause.message;
  return 'Something went wrong. Please try again.';
}

async function refresh(): Promise<void> {
  await todayQuery.refetch();
  if (today.value !== null) await scheduleQuery.refetch();
}

async function acceptToday(blockIds?: string[]): Promise<void> {
  const current = today.value;
  if (current === null || readOnly.value || busy.value) return;
  const binding = captureOwnerBinding();
  busy.value = true;
  error.value = null;
  try {
    const payload = { date: current.date, ...(blockIds === undefined ? {} : { blockIds }) };
    const action = actions.begin(`today:accept:${current.date}`, payload, samePayload, current.version);
    await plannerClient.acceptToday(action.payload, action.key, current.version);
    actions.settle(`today:accept:${current.date}`, action);
    if (!isOwnerBindingCurrent(binding)) return;
    toast.show('Today’s plan accepted.');
    await refresh();
  } catch (cause) {
    if (!isOwnerBindingCurrent(binding)) return;
    error.value = messageFor(cause);
  } finally {
    busy.value = false;
  }
}

function openShrink(block: TodayBlock): void {
  if (readOnly.value) return;
  shrinkingBlock.value = block;
  shrinkTarget.value = Math.max(1, Math.min(durationMinutes(block.startAt, block.endAt), 30));
  proposalError.value = null;
}

async function previewShrink(): Promise<void> {
  const current = today.value;
  const block = shrinkingBlock.value;
  if (current === null || block === null || readOnly.value || busy.value) return;
  const binding = captureOwnerBinding();
  busy.value = true;
  error.value = null;
  try {
    const payload = { date: current.date, blockId: block.id, targetMin: shrinkTarget.value };
    const scope = `today:shrink:${block.id}`;
    const action = actions.begin(scope, payload, samePayload, current.version);
    const result = await plannerClient.shrinkToday(action.payload, action.key, current.version);
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    proposal.value = result;
    shrinkingBlock.value = null;
  } catch (cause) {
    if (!isOwnerBindingCurrent(binding)) return;
    error.value = messageFor(cause);
  } finally {
    busy.value = false;
  }
}

async function reschedule(block: TodayBlock): Promise<void> {
  const current = today.value;
  if (current === null || readOnly.value || busy.value) return;
  const binding = captureOwnerBinding();
  busy.value = true;
  error.value = null;
  try {
    const payload = { date: current.date, blockIds: [block.id] };
    const scope = `today:reschedule:${block.id}`;
    const action = actions.begin(scope, payload, samePayload, current.version);
    const result = await plannerClient.rescheduleToday(action.payload, action.key, current.version);
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    proposal.value = result;
  } catch (cause) {
    if (!isOwnerBindingCurrent(binding)) return;
    error.value = messageFor(cause);
  } finally {
    busy.value = false;
  }
}

function proposalIfMatch(value: TodayProposal): string {
  return availabilityEtagForVersion(value.availabilityVersion);
}

async function approveProposal(): Promise<void> {
  const value = proposal.value;
  if (value === null || readOnly.value || busy.value) return;
  const binding = captureOwnerBinding();
  busy.value = true;
  proposalError.value = null;
  const scope = `today:approve:${value.id}`;
  try {
    const action = actions.begin(scope, { proposalId: value.id }, samePayload);
    await plannerClient.approveTodayProposal(value.id, action.key, proposalIfMatch(value));
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    toast.show('Proposal approved. Your plan is updated.');
    proposal.value = null;
    await refresh();
  } catch (cause) {
    if (!isOwnerBindingCurrent(binding)) return;
    if (cause instanceof ApiError && cause.status === 412) {
      proposalError.value = 'This proposal is stale. Review the latest plan and propose again.';
      proposal.value = null;
      await refresh();
    } else {
      proposalError.value = messageFor(cause);
    }
  } finally {
    busy.value = false;
  }
}

async function startFocus(block: TodayBlock): Promise<void> {
  if (readOnly.value || startingBlockId.value !== null) return;
  startingBlockId.value = block.id;
  error.value = null;
  resumeOffer.value = false;
  const binding = captureOwnerBinding();
  const scope = `focus:start:${block.taskId}`;
  let action = actions.peek<SessionCreate>(scope);
  try {
    const input: SessionCreate =
      action?.payload ?? {
        taskId: block.taskId,
        blockId: block.id,
        clientStartedAt: new Date().toISOString(),
        clientId: focusClientId(),
      };
    action = actions.begin(scope, input, samePayload);
    const session = await plannerClient.createSession(action.payload, action.key);
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) {
      sessionStore.remember(session, binding);
      return;
    }
    sessionStore.remember(session);
    await router.push(`/focus/${session.id}`);
  } catch (cause) {
    if (action !== undefined && cause instanceof ApiError) actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    if (cause instanceof ApiError && cause.status === 409 && cause.code === 'active_session_exists') {
      resumeOffer.value = true;
      await resumableQuery.refetch();
      if (activeSession.value === null) {
        error.value = 'An active focus session already exists. Finish or resume it before starting another.';
      }
    } else {
      error.value = messageFor(cause);
    }
  } finally {
    startingBlockId.value = null;
  }
}

function resumeActive(): void {
  const current = activeSession.value;
  if (current !== null) void router.push(`/focus/${current.id}`);
}
</script>

<template>
  <section class="page today-page">
    <header class="page-header">
      <div>
        <h1>Today</h1>
        <p v-if="today" class="muted">
          {{ formatDay(today.date) }}
          <span class="chip chip--slack">Slack {{ formatSlack(today.slackMin) }}</span>
        </p>
      </div>
      <span v-if="readOnly" class="chip chip--offline" role="status">Read-only while offline</span>
    </header>

    <div v-if="activeSession" class="resume-banner" role="status">
      <span>You have a focus session waiting to resume.</span>
      <button type="button" class="primary-action" @click="resumeActive">Resume session</button>
    </div>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div v-if="resumeOffer && activeSession" class="resume-banner">
      <span>A session is already running.</span>
      <button type="button" @click="resumeActive">Resume the active session</button>
    </div>

    <div v-if="isLoading" class="today-skeleton" aria-hidden="true">
      <div class="skeleton-card" />
      <div class="skeleton-card" />
    </div>
    <div v-else-if="isError" class="error-panel">
      <p class="error-text" role="alert">Could not load today’s plan.</p>
      <button type="button" @click="refresh()">Retry</button>
    </div>

    <template v-else-if="today">
      <div class="today-meta">
        <ul class="chip-row" aria-label="Risk and slack">
          <li class="chip" :class="`chip--risk-${today.risk.level}`">Risk: {{ today.risk.level }}</li>
          <li v-for="reason in today.risk.reasons" :key="reason" class="chip">
            {{ reason }}
          </li>
        </ul>
        <button type="button" :disabled="readOnly || busy" @click="acceptToday()">
          Accept plan
        </button>
      </div>

      <ul v-if="blocks.length > 0" class="today-blocks" aria-label="Today’s blocks">
        <li
          v-for="(block, index) in blocks"
          :key="block.id"
          class="today-card"
          :data-block-id="block.id"
        >
          <div class="today-card-main">
            <span class="today-index" aria-hidden="true">{{ index + 1 }}</span>
            <div>
              <h2 class="today-title">{{ block.title }}</h2>
              <p class="muted">
                {{ formatClock(block.startAt, today.timeZone) }}–{{ formatClock(block.endAt, today.timeZone) }}
                · {{ durationMinutes(block.startAt, block.endAt) }}m
              </p>
            </div>
          </div>
          <ul class="chip-row" aria-label="Block risk">
            <li class="chip chip--slack">Slack {{ formatSlack(today.slackMin) }}</li>
            <li class="chip" :class="`chip--risk-${today.risk.level}`">{{ today.risk.level }} risk</li>
          </ul>
          <div class="today-card-actions">
            <button
              type="button"
              class="primary-action"
              :disabled="readOnly || startingBlockId !== null"
              @click="startFocus(block)"
            >
              {{ startingBlockId === block.id ? 'Starting…' : 'Start focus' }}
            </button>
            <button type="button" :disabled="readOnly || busy" @click="openShrink(block)">
              Shrink
            </button>
            <button type="button" :disabled="readOnly || busy" @click="reschedule(block)">
              Reschedule
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="empty-state">
        Nothing scheduled today · pick something from the Inbox.
      </p>
    </template>

    <ProposalPreview
      v-if="proposal"
      :proposal="proposal"
      :today="today"
      :busy="busy"
      :disabled="readOnly"
      :error="proposalError"
      @approve="approveProposal"
      @cancel="proposal = null"
    />

    <div v-if="shrinkingBlock" class="dialog-backdrop" role="presentation">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="shrink-title">
        <h2 id="shrink-title">Shrink “{{ shrinkingBlock.title }}”</h2>
        <label for="shrink-minutes">New length in minutes</label>
        <input id="shrink-minutes" v-model.number="shrinkTarget" type="number" min="1" max="100000" />
        <div class="dialog-actions">
          <button type="button" class="primary-action" :disabled="busy || shrinkTarget < 1" @click="previewShrink">
            Preview shrink
          </button>
          <button type="button" :disabled="busy" @click="shrinkingBlock = null">Cancel</button>
        </div>
      </section>
    </div>
  </section>
</template>
