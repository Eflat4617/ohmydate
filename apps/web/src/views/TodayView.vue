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
import ProposalPreview from '../components/ProposalPreview.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { addDaysToDate, zonedWallClockToInstant } from '../domain/time';
import { rememberFocusBlocks } from '../composables/focusContext';
import { localDateIso } from '../format';
import { t, tp } from '../i18n';
import { formatCivilDate, formatDuration, formatTimeRange, minutesBetween } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { riskReasonText } from '../i18n/server';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import { useToastStore } from '../stores/toast';
import { focusClientId } from '../session/clientId';
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
const actions = new ActionStore();

const date = localDateIso();
const ownerId = computed(() => sessionStore.ownerId);
const todayQuery = useQuery({
  queryKey: computed(() => ['today', date, ownerId.value ?? 'anonymous']),
  queryFn: () => {
    const binding = captureOwnerBinding();
    return plannerClient.getToday(date, binding.signal);
  },
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
    await router.push(`/focus/${session.id}`);
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
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('today.title') }}</h1>
        <p v-if="today" class="page-lede today-date">
          {{ formatCivilDate(today.date) }}
          <span class="chip chip--slack badge--accent">
            {{ t('today.slackChip', { duration: formatDuration(today.slackMin) }) }}
          </span>
        </p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="readOnly" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
      </div>
    </header>

    <UiBanner v-if="activeSession" tone="accent" inline icon="clock" class="resume-banner" role="status">
      <span>{{ t('today.resumeWaiting') }}</span>
      <template #actions>
        <UiButton variant="primary" size="sm" icon="play" @click="resumeActive">{{ t('today.resumeSession') }}</UiButton>
      </template>
    </UiBanner>

    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
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

    <div v-if="isLoading" class="today-layout today-skeleton" aria-hidden="true">
      <div class="today-summary"><UiSkeleton variant="card" :count="1" :lines="2" /></div>
      <div class="today-list"><UiSkeleton variant="card" :count="2" :lines="3" /></div>
    </div>
    <UiBanner v-else-if="isError" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('today.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="refresh()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <div v-else-if="today" class="today-layout">
      <aside class="today-summary" aria-labelledby="today-summary-title">
        <UiCard class="today-meta">
          <h2 id="today-summary-title" class="eyebrow">{{ t('today.summaryTitle') }}</h2>
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
          <div class="today-risk">
            <ul class="chip-row" :aria-label="t('today.riskList')">
              <li class="chip badge" :class="[`chip--risk-${today.risk.level}`, `badge--${riskTone}`]">
                <span class="badge-dot" aria-hidden="true"></span>{{ t('risk.label', { level: riskLevel }) }}
              </li>
              <li
                v-for="reason in riskReasons"
                :key="reason.key"
                class="chip badge--wrap"
                :lang="reason.translated ? undefined : 'en'"
              >
                {{ reason.text }}
              </li>
            </ul>
          </div>
          <div class="card-footer">
            <UiButton block icon="check" :disabled="readOnly || busy" @click="acceptToday()">
              {{ t('today.acceptPlan') }}
            </UiButton>
          </div>
        </UiCard>
      </aside>

      <div class="today-list">
        <ul v-if="blocks.length > 0" class="today-blocks" :aria-label="t('today.blockList')">
          <UiCard
            v-for="(block, index) in blocks"
            :key="block.id"
            as="li"
            class="today-card"
            :class="{ 'today-card--next': block.id === nextBlockId }"
            :data-block-id="block.id"
          >
            <div class="today-card-main">
              <span class="today-index" aria-hidden="true">{{ index + 1 }}</span>
              <div class="today-card-text">
                <p v-if="block.id === nextBlockId" class="today-next-label eyebrow">{{ t('today.nextUp') }}</p>
                <h2 class="today-title">{{ block.title }}</h2>
                <p class="today-time">
                  <UiIcon name="clock" :size="16" />
                  <span class="tabular">{{ formatTimeRange(block.startAt, block.endAt, today.timeZone) }}</span>
                  · {{ formatDuration(minutesBetween(block.startAt, block.endAt)) }}
                </p>
              </div>
            </div>
            <ul class="chip-row" :aria-label="t('today.blockRisk')">
              <li class="chip chip--slack">{{ t('today.slackChip', { duration: formatDuration(today.slackMin) }) }}</li>
              <li class="chip" :class="[`chip--risk-${today.risk.level}`, `badge--${riskTone}`]">
                {{ t('risk.chip', { level: riskLevel }) }}
              </li>
            </ul>
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
              <UiButton icon="shrink" :disabled="readOnly || busy" @click="openShrink(block)">
                {{ t('today.shrink') }}
              </UiButton>
              <UiButton icon="reschedule" :disabled="readOnly || busy" @click="reschedule(block)">
                {{ t('today.reschedule') }}
              </UiButton>
            </div>
          </UiCard>
        </ul>
        <UiEmptyState v-else icon="today" :title="t('today.empty')">
          <template #actions>
            <RouterLink class="btn btn--secondary" to="/inbox">{{ t('today.openInbox') }}</RouterLink>
          </template>
        </UiEmptyState>
      </div>
    </div>

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
