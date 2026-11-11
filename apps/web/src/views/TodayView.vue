<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type TodayBlock,
  type TodayProposal,
} from '../api';
import ProposalPreview from '../components/ProposalPreview.vue';
import { durationMinutes, formatClock, formatDay, formatSlack, localDateIso } from '../format';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { useToastStore } from '../stores/toast';
import { focusClientId } from '../session/clientId';

const router = useRouter();
const offline = useOfflineStore();
const sessionStore = useSessionStore();
const toast = useToastStore();
const actions = new ActionStore();

const date = localDateIso();
const todayQuery = useQuery({
  queryKey: ['today', date],
  queryFn: () => plannerClient.getToday(date),
});

const today = computed(() => todayQuery.data.value ?? null);
const blocks = computed(() => today.value?.blocks ?? []);
const isLoading = computed(() => todayQuery.isLoading.value);
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

const activeSession = computed(() => sessionStore.active);

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
}

async function acceptToday(blockIds?: string[]): Promise<void> {
  const current = today.value;
  if (current === null || readOnly.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const payload = { date: current.date, ...(blockIds === undefined ? {} : { blockIds }) };
    const action = actions.begin(`today:accept:${current.date}`, payload, samePayload, current.version);
    await plannerClient.acceptToday(action.payload, action.key, current.version);
    actions.settle(`today:accept:${current.date}`, action);
    toast.show('Today’s plan accepted.');
    await refresh();
  } catch (cause) {
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
  busy.value = true;
  error.value = null;
  try {
    const payload = { date: current.date, blockId: block.id, targetMin: shrinkTarget.value };
    const scope = `today:shrink:${block.id}`;
    const action = actions.begin(scope, payload, samePayload, current.version);
    proposal.value = await plannerClient.shrinkToday(action.payload, action.key, current.version);
    actions.settle(scope, action);
    shrinkingBlock.value = null;
  } catch (cause) {
    error.value = messageFor(cause);
  } finally {
    busy.value = false;
  }
}

async function reschedule(block: TodayBlock): Promise<void> {
  const current = today.value;
  if (current === null || readOnly.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const payload = { date: current.date, blockIds: [block.id] };
    const scope = `today:reschedule:${block.id}`;
    const action = actions.begin(scope, payload, samePayload, current.version);
    proposal.value = await plannerClient.rescheduleToday(action.payload, action.key, current.version);
    actions.settle(scope, action);
  } catch (cause) {
    error.value = messageFor(cause);
  } finally {
    busy.value = false;
  }
}

function proposalIfMatch(value: TodayProposal): string {
  const availability = (value as { availabilityVersion?: unknown }).availabilityVersion;
  if (typeof availability === 'number') return `W/"availability:${availability}"`;
  return `W/"${value.version}"`;
}

async function approveProposal(): Promise<void> {
  const value = proposal.value;
  if (value === null || readOnly.value || busy.value) return;
  busy.value = true;
  proposalError.value = null;
  const scope = `today:approve:${value.id}`;
  try {
    const action = actions.begin(scope, { proposalId: value.id }, samePayload);
    await plannerClient.approveTodayProposal(value.id, action.key, proposalIfMatch(value));
    actions.settle(scope, action);
    toast.show('Proposal approved. Your plan is updated.');
    proposal.value = null;
    await refresh();
  } catch (cause) {
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
  try {
    const payload = { taskId: block.taskId, blockId: block.id };
    const scope = `focus:start:${block.taskId}`;
    const action = actions.begin(scope, payload, samePayload);
    const session = await plannerClient.createSession(
      {
        taskId: block.taskId,
        blockId: block.id,
        clientStartedAt: new Date().toISOString(),
        clientId: focusClientId(),
      },
      action.key,
    );
    actions.settle(scope, action);
    sessionStore.remember(session);
    await router.push(`/focus/${session.id}`);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409 && cause.code === 'active_session_exists') {
      resumeOffer.value = true;
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
      <span>You have an active focus session saved on this device.</span>
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
        <li v-for="(block, index) in blocks" :key="block.id" class="today-card">
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
