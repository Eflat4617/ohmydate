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
} from '../../api';
import BlockLockToggle from '../BlockLockToggle.vue';
import DayTimetable from '../DayTimetable.vue';
import ProposalPreview from '../ProposalPreview.vue';
import ReplanRequestButton from '../ReplanRequestButton.vue';
import ReplanCard from '../replan/ReplanCard.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiField from '../ui/UiField.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiDeadlineFlag from '../ui/UiDeadlineFlag.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import { useDayAgenda } from '../../composables/usePlannerRange';
import { addDaysToDate, localParts, zonedWallClockToInstant } from '../../domain/time';
import { rememberFocusBlocks } from '../../composables/focusContext';
import { t, tp } from '../../i18n';
import { formatCivilDate, formatDuration, formatTime, formatTimeRange, minutesBetween } from '../../i18n/format';
import { errorMessage } from '../../i18n/problem';
import { riskReasonText } from '../../i18n/server';
import { localDateAt, useLayoutNow } from '../../layout/now';
import { isNotReady } from '../../platform/notReady';
import { useLayoutStore } from '../../stores/layout';
import { useOfflineStore } from '../../stores/offline';
import { useSessionStore } from '../../stores/session';
import { useToastStore } from '../../stores/toast';
import { focusClientId } from '../../session/clientId';
import { useLatestReplanPlan } from '../../composables/useLatestReplanPlan';
import { isBlockLockable, useBlockLock, type LockableBlock } from '../../composables/useBlockLock';
import {
  captureOwnerBinding,
  isOwnerBindingCurrent,
} from '../../session/ownerEpoch';
import {
  clearQuarantine,
  listQuarantine,
  quarantineRevision,
} from '../../session/quarantine';
import {
  flushFocusJournal,
  retryQuarantinedFocusEvents,
} from '../../session/focusQueue';

/**
 * 오늘 (HOLO-04, FLOW.md §2 ③): the day's blocks as cards, inside 개요. It was
 * a screen of its own; now "what do I do now" lives in one place. The next
 * block carries the lime mark and the page's one filled button, 집중 시작;
 * 수락 · 축소 · 재배치 · 잠금 are on each card; 오늘 약속 and 오늘 마감 sit under
 * the list and the day's time table beside it. With nothing planned it sends
 * the owner back a stage: 계획 세우기, or one task started right away.
 */
const props = withDefaults(
  defineProps<{
    /** Another part of the page holds its one filled button (개요's recap of the day): nothing here is filled. */
    quiet?: boolean;
  }>(),
  { quiet: false },
);

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

/*
 * CAL-01: what else is on today — the day's 약속 and the tasks due today
 * that are not done. Read-only, owner-keyed and fenced (usePlannerRange);
 * shown under the block list only when there is something to show.
 */
const agendaRange = computed(() => {
  const current = today.value;
  if (current === null) return null;
  return {
    from: zonedWallClockToInstant(current.date, 0, current.timeZone),
    to: zonedWallClockToInstant(addDaysToDate(current.date, 1), 0, current.timeZone),
  };
});
const agendaQuery = useDayAgenda(agendaRange);

const todayCommitments = computed(() => {
  const range = agendaRange.value;
  const agenda = agendaQuery.data.value;
  if (range === null || agenda === undefined) return [];
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  return agenda.commitments
    .flatMap((commitment) =>
      (commitment.occurrences ?? []).map((occurrence) => ({
        id: `${commitment.id}:${occurrence.startAt}`,
        title: commitment.title,
        startAt: occurrence.startAt,
        endAt: occurrence.endAt,
      })),
    )
    .filter((item) => Date.parse(item.startAt) < toMs && Date.parse(item.endAt) > fromMs)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
});

const dueToday = computed(() => {
  const current = today.value;
  const agenda = agendaQuery.data.value;
  if (current === null || agenda === undefined) return [];
  return agenda.tasks
    .flatMap((task) =>
      task.status !== 'done' &&
      task.dueAt !== undefined &&
      Number.isFinite(Date.parse(task.dueAt)) &&
      localParts(task.dueAt, current.timeZone).date === current.date
        ? [{ id: task.id, title: task.title, dueAt: task.dueAt }]
        : [],
    )
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
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

// Presentational only: which card gets the "Next up" emphasis. The time is
// the app's clock as it was when the screen opened (never the device's own:
// the screens share one clock, and tests pin it).
const mountedAt = now.value;
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

// M5-03: "다시 맞추기 요청" targets the plan of the newest replan proposal (its
// server-provided planId, FU-70); Today itself carries no plan id.
const { planId: replanPlanId } = useLatestReplanPlan();

// An empty day has nothing to add up and nothing to accept: its figures and
// the 수락 button wait for blocks. The risk card stays while it has something
// to say or to offer — a risk above low or with a reason (an overdue task, a
// day past its limit), or a plan that can be asked to be re-planned (다시 맞추기
// 요청 lives on it, also on a day that plan has no block in).
const hasBlocks = computed(() => blocks.value.length > 0);
const riskShown = computed(
  () =>
    hasBlocks.value ||
    replanPlanId.value !== null ||
    (today.value !== null && (today.value.risk.level !== 'low' || riskReasons.value.length > 0)),
);

const isLoading = computed(
  () => todayQuery.isLoading.value || (today.value !== null && scheduleQuery.isLoading.value),
);
const isError = computed(() => todayQuery.isError.value);
// Desktop: the core does not serve today's plan yet — said calmly, with the way to what does work.
const notReady = computed(() => isNotReady(todayQuery.error.value));
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
  <section class="today-board today-page" aria-labelledby="today-board-title" data-today-board>
    <div class="today-layout">
    <div class="today-main">
      <header class="today-head">
        <div class="today-heading">
          <h2 id="today-board-title" class="today-heading-title">{{ t('today.title') }}</h2>
          <p v-if="today" class="today-date">{{ formatCivilDate(today.date) }}</p>
        </div>
        <div class="page-actions">
          <UiBadge v-if="readOnly" tone="offline" dot class="chip--offline" role="status">
            {{ t('common.readOnlyOffline') }}
          </UiBadge>
          <UiButton v-if="today && hasBlocks" icon="check" :disabled="readOnly || busy" data-today-accept @click="acceptToday()">
            {{ t('today.acceptPlan') }}
          </UiButton>
        </div>
      </header>

      <UiBanner v-if="activeSession" tone="accent" inline icon="clock" class="resume-banner" role="status">
        <span>{{ t('today.resumeWaiting') }}</span>
        <template #actions>
          <UiButton
            :variant="props.quiet ? 'secondary' : 'primary'"
            size="sm"
            icon="play"
            :data-primary="props.quiet ? undefined : 'resume'"
            @click="resumeActive"
          >
            {{ t('today.resumeSession') }}
          </UiButton>
        </template>
      </UiBanner>

      <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
      <UiBanner v-if="lockError" tone="error" role="alert" class="block-lock-error">{{ lockError }}</UiBanner>
      <ReplanCard />
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
      <UiBanner v-else-if="notReady" tone="info" inline role="status" data-not-ready>
        <span>{{ t('desktop.notReady.today') }}</span>
        <template #actions>
          <RouterLink class="btn btn--secondary btn--sm" to="/tasks">{{ t('desktop.notReady.openTasks') }}</RouterLink>
        </template>
      </UiBanner>
      <UiBanner v-else-if="isError" tone="error" class="error-panel">
        <p class="error-text" role="alert">{{ t('today.loadError') }}</p>
        <template #actions>
          <UiButton size="sm" icon="sync" @click="refresh()">{{ t('common.retry') }}</UiButton>
        </template>
      </UiBanner>

      <template v-else-if="today">
        <aside v-if="riskShown" class="today-summary" aria-labelledby="today-summary-title" data-today-summary>
          <h2 id="today-summary-title" class="visually-hidden">{{ t('today.summaryTitle') }}</h2>
          <dl v-if="hasBlocks" class="stat-grid today-stats">
            <div class="stat card card--compact today-stat">
              <dt>{{ t('today.slack') }}</dt>
              <dd class="stat-value">{{ formatDuration(today.slackMin) }}</dd>
            </div>
            <div class="stat card card--compact today-stat">
              <dt>{{ t('today.planned') }}</dt>
              <dd class="stat-value">{{ formatDuration(plannedMinutes) }}</dd>
            </div>
            <div class="stat card card--compact today-stat">
              <dt>{{ t('today.blocks') }}</dt>
              <dd class="stat-value">{{ blocks.length }}</dd>
            </div>
          </dl>
          <div class="card card--compact today-risk-card">
            <ul class="today-risk" :aria-label="t('today.riskList')">
              <li class="chip badge badge--lg" :class="[`chip--risk-${today.risk.level}`, `badge--${riskTone}`]">
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
          </div>
        </aside>

        <div class="today-list">
          <ul v-if="blocks.length > 0" class="today-blocks" :aria-label="t('today.blockList')">
            <li
              v-for="block in blocks"
              :key="block.id"
              class="card today-card"
              :class="{ 'today-card--next': block.id === nextBlockId, 'today-card--done': block.status === 'done' }"
              :data-block-id="block.id"
            >
              <div class="today-card-text">
                <p v-if="block.id === nextBlockId || block.status === 'done'" class="today-card-tags">
                  <UiBadge v-if="block.id === nextBlockId" tone="accent" class="today-next-label">{{ t('today.nextUp') }}</UiBadge>
                  <UiBadge v-if="block.status === 'done'" tone="success">{{ t('plan.blockStatus.done') }}</UiBadge>
                </p>
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
                </p>
              </div>
              <div class="today-card-actions">
                <!-- One filled button on the screen: starting the next block (or, while a
                     session waits, 세션 이어가기 in the banner above). -->
                <UiButton
                  :variant="block.id === nextBlockId && !activeSession && !props.quiet ? 'primary' : 'secondary'"
                  icon="play"
                  :disabled="readOnly || startingBlockId !== null"
                  :busy="startingBlockId === block.id"
                  :data-primary="block.id === nextBlockId && !activeSession && !props.quiet ? 'start' : undefined"
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
          <!-- Nothing planned: back a stage (FLOW §5). 계획 세우기 is the one filled
               button unless a session is waiting; one task can be started as it is. -->
          <UiEmptyState v-else icon="today" :title="t('today.empty')" class="card today-empty" data-today-empty>
            <p>{{ t('today.emptyBody') }}</p>
            <template #actions>
              <RouterLink
                class="btn"
                :class="activeSession || props.quiet ? 'btn--secondary' : 'btn--primary'"
                to="/plan"
                :data-primary="activeSession || props.quiet ? undefined : 'plan'"
              >
                <UiIcon name="plan" :size="18" class="btn-icon" />{{ t('today.makePlan') }}
              </RouterLink>
              <RouterLink class="btn btn--ghost" to="/focus" data-today-start-one>{{ t('today.startOne') }}</RouterLink>
            </template>
          </UiEmptyState>

          <div v-if="todayCommitments.length > 0 || dueToday.length > 0" class="today-agendas">
            <section
              v-if="todayCommitments.length > 0"
              class="card card--compact today-agenda"
              aria-labelledby="today-commitments-title"
              data-today-commitments
            >
              <header class="card-header today-agenda-head">
                <h2 id="today-commitments-title" class="card-title">{{ t('today.commitmentsTitle') }}</h2>
                <RouterLink to="/planner?view=day" class="icon-link" :aria-label="t('today.commitmentsLink')">
                  <UiIcon name="open" :size="16" />
                </RouterLink>
              </header>
              <ul class="today-agenda-list">
                <li v-for="item in todayCommitments" :key="item.id" class="today-agenda-item">
                  <span class="today-agenda-mark today-agenda-mark--commitment" aria-hidden="true"></span>
                  <span class="today-agenda-time tabular">{{ formatTimeRange(item.startAt, item.endAt, today.timeZone) }}</span>
                  <span class="today-agenda-title">{{ item.title }}</span>
                </li>
              </ul>
            </section>

            <section
              v-if="dueToday.length > 0"
              class="card card--compact today-agenda"
              aria-labelledby="today-due-title"
              data-today-due
            >
              <header class="card-header today-agenda-head">
                <h2 id="today-due-title" class="card-title">{{ t('today.dueTitle') }}</h2>
              </header>
              <ul class="today-agenda-list">
                <li v-for="task in dueToday" :key="task.id" class="today-agenda-item">
                  <UiDeadlineFlag class="today-agenda-mark today-agenda-mark--deadline" :size="13" />
                  <span class="today-agenda-time tabular">{{
                    t('today.dueAt', { time: formatTime(task.dueAt, today.timeZone) })
                  }}</span>
                  <RouterLink :to="`/tasks/${task.id}`" class="today-agenda-title">{{ task.title }}</RouterLink>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </template>
    </div>

    <DayTimetable
      v-if="today && !isLoading && !isError"
      class="card today-timetable"
      :blocks="blocks"
      :date="today.date"
      :time-zone="today.timeZone"
      :next-block-id="nextBlockId"
      :now-ms="now"
      :commitments="todayCommitments"
    />
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
