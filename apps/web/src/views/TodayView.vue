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
  type Violation,
} from '../api';
import BlockLockToggle from '../components/BlockLockToggle.vue';
import DayTimetable from '../components/DayTimetable.vue';
import ProposalPreview from '../components/ProposalPreview.vue';
import ReplanBanner from '../components/ReplanBanner.vue';
import ReplanRequestButton from '../components/ReplanRequestButton.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { blockSeries } from '../domain/dayTimetable';
import { addDaysToDate, zonedWallClockToInstant } from '../domain/time';
import { rememberFocusBlocks } from '../composables/focusContext';
import { t, tp } from '../i18n';
import { formatCivilDate, formatDuration, formatTimeRange, minutesBetween } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { riskReasonText } from '../i18n/server';
import { localDateAt, useLayoutNow } from '../layout/now';
import { useLayoutStore } from '../stores/layout';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { useToastStore } from '../stores/toast';
import { focusClientId } from '../session/clientId';
import { useLatestReplanPlan } from '../composables/useLatestReplanPlan';
import { isBlockLockable, useBlockLock, type LockableBlock } from '../composables/useBlockLock';
import {
  captureOwnerBinding,
  isOwnerBindingCurrent,
} from '../session/ownerEpoch';
import {
  clearQuarantine,
  listQuarantine,
  quarantineRevision,
} from '../session/quarantine';
import {
  flushFocusJournal,
  retryQuarantinedFocusEvents,
} from '../session/focusQueue';

const router = useRouter();
const offline = useOfflineStore();
const sessionStore = useSessionStore();
const toast = useToastStore();
const layout = useLayoutStore();
const actions = new ActionStore();

// The current day follows the shared clock (M6-02R-1 L1): left open past
// midnight, Today asks for the new day. Same key as the layout's snapshot.
const now = useLayoutNow();
const date = computed(() => localDateAt(now.value));
const ownerId = computed(() => sessionStore.ownerId);
const todayQuery = useQuery({
  queryKey: computed(() => ['today', date.value, ownerId.value ?? 'anonymous']),
  queryFn: () => {
    const binding = captureOwnerBinding();
    return plannerClient.getToday(date.value, binding.signal);
  },
});

const today = computed(() => todayQuery.data.value ?? null);

const scheduleQuery = useQuery({
  queryKey: computed(() => [
    'today-schedule-blocks',
    today.value?.date ?? date.value,
    today.value?.timeZone ?? 'UTC',
    ownerId.value ?? 'anonymous',
  ]),
  queryFn: async () => {
    const current = today.value;
    if (current === null) throw new Error('Today is not loaded');
    const binding = captureOwnerBinding();
    return plannerClient.listScheduleBlocks({
      from: zonedWallClockToInstant(current.date, 0, current.timeZone),
      to: zonedWallClockToInstant(addDaysToDate(current.date, 1), 0, current.timeZone),
      limit: 100,
      signal: binding.signal,
    });
  },
  enabled: computed(() => today.value !== null),
});

const resumableQuery = useQuery({
  queryKey: computed(() => ['sessions', 'resumable', ownerId.value ?? 'anonymous']),
  queryFn: async () => {
    const binding = captureOwnerBinding();
    const active = await plannerClient.listSessions({
      state: 'active',
      limit: 1,
      signal: binding.signal,
    });
    let session = active.items[0] ?? null;
    if (session === null) {
      const paused = await plannerClient.listSessions({
        state: 'paused',
        limit: 1,
        signal: binding.signal,
      });
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
    // A cached answer from before a pause/complete must not overwrite the
    // newer copy this device already has (it would resurrect a finished
    // session as active, M6-02).
    const known = sessionStore.get(result.session.id);
    if (known !== null && known.version > result.session.version) return;
    sessionStore.remember(result.session);
  },
  { immediate: true },
);

/**
 * A Today block plus its approved row (FU-71): `lock` is null until
 * `GET /schedule-blocks` has the block, so the lock toggle only ever sends the
 * version the server reported.
 */
type TodayCardBlock = TodayBlock & { readonly lock: LockableBlock | null };

const blocks = computed<TodayCardBlock[]>(() => {
  const current = today.value;
  if (current === null) return [];
  const schedule = scheduleQuery.data.value;
  if (schedule === undefined || scheduleQuery.isError.value) {
    return current.blocks.map((block) => ({ ...block, lock: null }));
  }
  const enrichment = new Map(
    schedule.items
      .filter((block) => block.status !== 'superseded')
      .map((block) => [block.id, block]),
  );
  return current.blocks.map((block) => {
    const approved = enrichment.get(block.id);
    return approved === undefined
      ? { ...block, lock: null }
      : {
          ...block,
          startAt: approved.startAt,
          endAt: approved.endAt,
          status: approved.status,
          lock: {
            id: approved.id,
            locked: approved.locked,
            version: approved.version,
            status: approved.status,
            startAt: approved.startAt,
          },
        };
  });
});

// Presentational only: lets Focus show the task title / planned length.
watch(
  blocks,
  (list) => {
    const current = today.value;
    if (current !== null && list.length > 0) rememberFocusBlocks(sessionStore.ownerId, list, current.timeZone);
  },
  { immediate: true },
);

// Presentational only: which card gets the "Next up" emphasis.
const mountedAt = Date.now();
const nextBlockId = computed(() => {
  const next = blocks.value.find(
    (block) => block.status !== 'done' && block.status !== 'skipped' && Date.parse(block.endAt) > mountedAt,
  );
  return next?.id ?? null;
});
// Presentational only: a row and its run on the day timetable share a highlighter.
const seriesByBlock = computed(() => blockSeries(blocks.value, nextBlockId.value));
const plannedMinutes = computed(() =>
  blocks.value.reduce((sum, block) => sum + minutesBetween(block.startAt, block.endAt), 0),
);
const riskLevel = computed(() => (today.value === null ? '' : t(`risk.level.${today.value.risk.level}`)));
const riskReasons = computed(() => {
  const titles = new Map(blocks.value.map((block) => [block.taskId, block.title]));
  return (today.value?.risk.reasons ?? []).map((reason) => ({
    key: reason,
    ...riskReasonText(reason, (taskId) => titles.get(taskId)),
  }));
});
const riskTone = computed(() => {
  switch (today.value?.risk.level) {
    case 'high':
      return 'danger' as const;
    case 'medium':
      return 'warn' as const;
    default:
      return 'success' as const;
  }
});

// M5-03: "재계획 요청" targets the plan of the newest replan proposal (its
// server-provided planId, FU-70); Today itself carries no plan id.
const { planId: replanPlanId } = useLatestReplanPlan();

const isLoading = computed(
  () => todayQuery.isLoading.value || (today.value !== null && scheduleQuery.isLoading.value),
);
const isError = computed(() => todayQuery.isError.value);
const readOnly = computed(() => !offline.mutationsEnabled);

// FU-71: a lock moves the plan revision (Today.version), so both reads refresh.
const {
  displayLocked,
  isPending: lockPending,
  toggle: toggleLock,
  error: lockError,
} = useBlockLock({
  refresh: () => Promise.all([todayQuery.refetch(), scheduleQuery.refetch()]),
});

function blockLocked(block: TodayCardBlock): boolean {
  return block.lock !== null && displayLocked(block.lock);
}

function canToggleLock(block: TodayCardBlock): boolean {
  return block.lock !== null && isBlockLockable(block.lock, now.value);
}

const error = ref<string | null>(null);
const startingBlockId = ref<string | null>(null);
const resumeOffer = ref(false);
const shrinkingBlock = ref<TodayBlock | null>(null);
const shrinkTarget = ref(25);
const busy = ref(false);
const proposal = ref<TodayProposal | null>(null);
const proposalError = ref<string | null>(null);
const proposalViolations = ref<Violation[]>([]);
// Findings belong to one approval attempt of one proposal (FU-62).
watch(proposal, () => {
  proposalViolations.value = [];
});
const retryBusy = ref(false);

const quarantinedCount = computed(() => {
  void quarantineRevision.value;
  return listQuarantine(sessionStore.ownerId).length;
});

async function retryQuarantine(): Promise<void> {
  if (retryBusy.value) return;
  retryBusy.value = true;
  const binding = captureOwnerBinding();
  try {
    await retryQuarantinedFocusEvents({
      store: sessionStore,
      online: offline.online,
      binding,
    });
    if (offline.online && isOwnerBindingCurrent(binding)) {
      await flushFocusJournal({ store: sessionStore, online: true });
    }
  } finally {
    retryBusy.value = false;
  }
}

function dismissQuarantine(): void {
  clearQuarantine(sessionStore.ownerId);
}

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
  return errorMessage(cause);
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
    await plannerClient.acceptToday(
      action.payload,
      action.key,
      current.version,
      binding.signal,
    );
    actions.settle(`today:accept:${current.date}`, action);
    if (!isOwnerBindingCurrent(binding)) return;
    toast.show(t('today.accepted'));
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
  shrinkTarget.value = Math.max(1, Math.min(minutesBetween(block.startAt, block.endAt), 30));
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
    const result = await plannerClient.shrinkToday(
      action.payload,
      action.key,
      current.version,
      binding.signal,
    );
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
    const result = await plannerClient.rescheduleToday(
      action.payload,
      action.key,
      current.version,
      binding.signal,
    );
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
  proposalViolations.value = [];
  const scope = `today:approve:${value.id}`;
  try {
    const action = actions.begin(scope, { proposalId: value.id }, samePayload);
    await plannerClient.approveTodayProposal(
      value.id,
      action.key,
      proposalIfMatch(value),
      binding.signal,
    );
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    toast.show(t('today.proposalApproved'));
    proposal.value = null;
    await refresh();
  } catch (cause) {
    if (!isOwnerBindingCurrent(binding)) return;
    if (cause instanceof ApiError && cause.status === 412) {
      proposalError.value = t('today.proposalStale');
      proposal.value = null;
      await refresh();
    } else {
      proposalError.value = messageFor(cause);
      if (cause instanceof ApiError && cause.code === 'constraint_violation') {
        proposalViolations.value = cause.problem?.violations ?? [];
      }
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
    const session = await plannerClient.createSession(
      action.payload,
      action.key,
      binding.signal,
    );
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) {
      sessionStore.remember(session, binding);
      return;
    }
    sessionStore.remember(session);
    // M6-02: with automatic layout switching the layout itself moves to this
    // session's focus page (and offers undo); otherwise open it directly.
    if (!layout.sessionStarted(session.id)) await router.push(`/focus/${session.id}`);
  } catch (cause) {
    if (action !== undefined && cause instanceof ApiError) actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    if (cause instanceof ApiError && cause.status === 409 && cause.code === 'active_session_exists') {
      resumeOffer.value = true;
      await resumableQuery.refetch();
      if (activeSession.value === null) {
        error.value = t('today.activeExists');
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
  <section class="page page--wide today-page">
    <div class="today-main">
      <header class="page-header">
        <div class="page-heading">
          <h1>{{ t('today.title') }}</h1>
          <p v-if="today" class="page-lede today-date">{{ formatCivilDate(today.date) }}</p>
        </div>
        <div class="page-actions">
          <UiBadge v-if="readOnly" tone="offline" dot class="chip--offline" role="status">
            {{ t('common.readOnlyOffline') }}
          </UiBadge>
          <UiButton v-if="today" icon="check" :disabled="readOnly || busy" @click="acceptToday()">
            {{ t('today.acceptPlan') }}
          </UiButton>
        </div>
      </header>

      <UiBanner v-if="activeSession" tone="accent" inline icon="clock" class="resume-banner" role="status">
        <span>{{ t('today.resumeWaiting') }}</span>
        <template #actions>
          <UiButton variant="primary" size="sm" icon="play" @click="resumeActive">{{ t('today.resumeSession') }}</UiButton>
        </template>
      </UiBanner>

      <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
      <UiBanner v-if="lockError" tone="error" role="alert" class="block-lock-error">{{ lockError }}</UiBanner>
      <ReplanBanner />
      <UiBanner v-if="resumeOffer && activeSession" tone="info" inline class="resume-banner">
        <span>{{ t('today.alreadyRunning') }}</span>
        <template #actions>
          <UiButton size="sm" @click="resumeActive">{{ t('today.resumeActive') }}</UiButton>
        </template>
      </UiBanner>

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

      <div v-if="isLoading" class="today-skeleton" aria-hidden="true">
        <UiSkeleton variant="lines" :lines="2" />
        <UiSkeleton variant="card" :count="2" :lines="2" />
      </div>
      <UiBanner v-else-if="isError" tone="error" class="error-panel">
        <p class="error-text" role="alert">{{ t('today.loadError') }}</p>
        <template #actions>
          <UiButton size="sm" icon="sync" @click="refresh()">{{ t('common.retry') }}</UiButton>
        </template>
      </UiBanner>

      <template v-else-if="today">
        <aside class="today-summary" aria-labelledby="today-summary-title">
          <h2 id="today-summary-title" class="visually-hidden">{{ t('today.summaryTitle') }}</h2>
          <dl class="stat-grid">
            <div class="stat">
              <dt>{{ t('today.slack') }}</dt>
              <dd class="stat-value">{{ formatDuration(today.slackMin) }}</dd>
            </div>
            <div class="stat">
              <dt>{{ t('today.planned') }}</dt>
              <dd class="stat-value">{{ formatDuration(plannedMinutes) }}</dd>
            </div>
            <div class="stat">
              <dt>{{ t('today.blocks') }}</dt>
              <dd class="stat-value">{{ blocks.length }}</dd>
            </div>
          </dl>
          <ul class="today-risk" :aria-label="t('today.riskList')">
            <li class="chip badge" :class="[`chip--risk-${today.risk.level}`, `badge--${riskTone}`]">
              {{ t('risk.label', { level: riskLevel }) }}
            </li>
            <li
              v-for="reason in riskReasons"
              :key="reason.key"
              class="today-risk-reason"
              :lang="reason.translated ? undefined : 'en'"
            >
              {{ reason.text }}
            </li>
          </ul>
          <ReplanRequestButton v-if="replanPlanId" :plan-id="replanPlanId" variant="ghost" size="sm" />
        </aside>

        <div class="today-list">
          <ul v-if="blocks.length > 0" class="today-blocks" :aria-label="t('today.blockList')">
            <li
              v-for="(block, index) in blocks"
              :key="block.id"
              class="today-card"
              :class="[{ 'today-card--next': block.id === nextBlockId }, `tt-series--${seriesByBlock.get(block.id) ?? 1}`]"
              :data-block-id="block.id"
            >
              <span class="today-index tabular" aria-hidden="true">{{ index + 1 }}</span>
              <div class="today-card-text">
                <h2 :id="`today-block-${block.id}-title`" class="today-title">
                  <span class="today-title-text">{{ block.title }}</span>
                </h2>
                <p class="today-time">
                  <span :id="`today-block-${block.id}-time`" class="tabular">{{
                    formatTimeRange(block.startAt, block.endAt, today.timeZone)
                  }}</span>
                  <span class="today-duration tabular">{{
                    formatDuration(minutesBetween(block.startAt, block.endAt))
                  }}</span>
                  <span v-if="block.id === nextBlockId" class="today-next-label">{{ t('today.nextUp') }}</span>
                </p>
              </div>
              <div class="today-card-actions">
                <UiButton
                  variant="primary"
                  icon="play"
                  :disabled="readOnly || startingBlockId !== null"
                  :busy="startingBlockId === block.id"
                  @click="startFocus(block)"
                >
                  {{ startingBlockId === block.id ? t('today.starting') : t('today.startFocus') }}
                </UiButton>
                <!-- A locked block cannot be shrunk or moved (422 otherwise, 06 §7). -->
                <UiButton icon="shrink" :disabled="readOnly || busy || blockLocked(block)" @click="openShrink(block)">
                  {{ t('today.shrink') }}
                </UiButton>
                <UiButton icon="reschedule" :disabled="readOnly || busy || blockLocked(block)" @click="reschedule(block)">
                  {{ t('today.reschedule') }}
                </UiButton>
                <BlockLockToggle
                  v-if="block.lock && canToggleLock(block)"
                  :locked="displayLocked(block.lock)"
                  :pending="lockPending(block.id)"
                  :disabled="readOnly"
                  :described-by="`today-block-${block.id}-title today-block-${block.id}-time`"
                  @toggle="toggleLock(block.lock)"
                />
                <BlockLockToggle v-else-if="block.lock" read-only :locked="block.lock.locked" />
              </div>
            </li>
          </ul>
          <UiEmptyState v-else icon="today" :title="t('today.empty')">
            <template #actions>
              <RouterLink class="btn btn--secondary" to="/inbox">{{ t('today.openInbox') }}</RouterLink>
            </template>
          </UiEmptyState>
        </div>
      </template>
    </div>

    <DayTimetable
      v-if="today && !isLoading && !isError"
      class="today-timetable"
      :blocks="blocks"
      :date="today.date"
      :time-zone="today.timeZone"
      :next-block-id="nextBlockId"
      :now-ms="now"
    />

    <ProposalPreview
      v-if="proposal"
      :proposal="proposal"
      :today="today"
      :busy="busy"
      :disabled="readOnly"
      :error="proposalError"
      :violations="proposalViolations"
      @approve="approveProposal"
      @cancel="proposal = null"
    />

    <UiDialog
      v-if="shrinkingBlock"
      labelledby="shrink-title"
      size="sm"
      as="section"
      :dismissible="!busy"
      @close="shrinkingBlock = null"
    >
      <header class="dialog-heading">
        <h2 id="shrink-title" class="dialog-title">{{ t('today.shrinkTitle', { title: shrinkingBlock.title }) }}</h2>
        <p class="muted">{{ t('today.shrinkLede') }}</p>
      </header>
      <UiField id="shrink-minutes" :label="t('today.shrinkMinutes')">
        <input id="shrink-minutes" v-model.number="shrinkTarget" type="number" min="1" max="100000" data-autofocus />
      </UiField>
      <div class="dialog-actions">
        <UiButton variant="ghost" :disabled="busy" @click="shrinkingBlock = null">{{ t('common.cancel') }}</UiButton>
        <UiButton variant="primary" :disabled="busy || shrinkTarget < 1" :busy="busy" @click="previewShrink">
          {{ t('today.shrinkPreview') }}
        </UiButton>
      </div>
    </UiDialog>
  </section>
</template>
