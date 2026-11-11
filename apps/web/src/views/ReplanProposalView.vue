<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { routerKey } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type PlanVersion,
  type ReplanProposal,
  type ScheduleBlock,
  type Task,
  type Violation,
} from '../api';
import ExplanationList from '../components/ExplanationList.vue';
import ReplanRequestButton from '../components/ReplanRequestButton.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import type { IconName } from '../components/ui/icons';
import { useReplanRequest } from '../composables/useReplanRequest';
import {
  deadlineSlackMinutes,
  plannedMinutes,
  proposalWindow,
  replanDiff,
  type BlockChangeKind,
  type TimedBlock,
} from '../domain/replan';
import { t, tp } from '../i18n';
import { browserTimeZone, formatDateTime, formatDateTimeRange, formatDuration, formatSignedDuration } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import {
  changeLabel,
  flagText,
  proposalStateLabel,
  reasonLabel,
  reasonShort,
  triggerBody,
  triggerLabel,
} from '../i18n/replan';
import { activePlanRevision, rememberActivePlan, rememberedActivePlan } from '../session/activePlan';
import { captureOwnerBinding, isOwnerBindingCurrent } from '../session/ownerEpoch';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';

/**
 * Replan proposal detail (M5-03, 05 §11, 06 §7, 08 §2.6). Shows why the
 * proposal exists, only the blocks it changes (locked blocks are listed as
 * unchanged), before/after metrics and the scheduler's original explanation.
 * Approve pins `If-Match: W/"availability:<n>"`; reject pins the proposal
 * version and explains the 24 h same-reason suppression first.
 */
const props = defineProps<{ id: string }>();

const DAY_MS = 24 * 60 * 60 * 1000;
const router = inject(routerKey, null);
const queryClient = useQueryClient();
const auth = useAuthStore();
const offline = useOfflineStore();
const sessionStore = useSessionStore();
const actions = new ActionStore();
const recompute = useReplanRequest();

const ownerKey = computed(() => sessionStore.ownerId ?? 'anonymous');
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());
const readOnly = computed(() => !offline.mutationsEnabled);

const proposalKey = computed(() => ['replan-proposal', props.id, ownerKey.value]);
const proposalQuery = useQuery({
  queryKey: proposalKey,
  queryFn: () => {
    const binding = captureOwnerBinding();
    return plannerClient.getReplanProposal(props.id, { signal: binding.signal });
  },
});
const proposal = computed<ReplanProposal | null>(() => proposalQuery.data.value ?? null);
const pending = computed(() => proposal.value?.state === 'pending');

const blocksQuery = useQuery({
  queryKey: computed(() => ['replan-blocks', props.id, proposal.value?.version ?? 0, ownerKey.value]),
  queryFn: async () => {
    const value = proposal.value;
    if (value === null) throw new Error('proposal is not loaded');
    const binding = captureOwnerBinding();
    const span = proposalWindow(value.candidate.blocks, value.trigger.detectedAt);
    const items: ScheduleBlock[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await plannerClient.listScheduleBlocks({
        from: span.from,
        to: span.to,
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
        signal: binding.signal,
      });
      items.push(...result.items);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return items;
  },
  enabled: computed(() => pending.value),
});

const tasksQuery = useQuery({
  queryKey: computed(() => ['tasks', 'replan', ownerKey.value]),
  queryFn: async () => {
    const binding = captureOwnerBinding();
    const tasks: Task[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await plannerClient.listTasks({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      if (!isOwnerBindingCurrent(binding)) break;
      tasks.push(...result.items);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return tasks;
  },
});

const tasksById = computed(() => new Map((tasksQuery.data.value ?? []).map((task) => [task.id, task])));

function titleOf(taskId: string): string {
  return tasksById.value.get(taskId)?.title ?? t('replan.taskFallback');
}

/** Task titles for FU-62 coded explanation/violation parameters. */
const taskNames = computed<Record<string, string>>(() =>
  Object.fromEntries((tasksQuery.data.value ?? []).map((task) => [task.id, task.title])),
);

const diff = computed(() => {
  const value = proposal.value;
  const blocks = blocksQuery.data.value;
  if (value === null || !pending.value || blocks === undefined) return null;
  return replanDiff({
    candidateBlocks: value.candidate.blocks,
    currentBlocks: blocks,
    affectedTaskIds: value.trigger.affectedTaskIds,
    basePlanVersionId: value.basePlanVersionId,
    since: value.trigger.detectedAt,
  });
});

const dueByTask = computed(() => {
  const map = new Map<string, string>();
  const planTasks = diff.value?.planTaskIds;
  if (planTasks === undefined) return map;
  for (const taskId of planTasks) {
    const due = tasksById.value.get(taskId)?.dueAt;
    if (due !== undefined) map.set(taskId, due);
  }
  return map;
});

interface MetricRow {
  readonly key: string;
  readonly label: string;
  readonly now: string;
  readonly proposed: string;
}

function slackText(minutes: number | null): string {
  return minutes === null ? t('replan.slackNone') : formatDuration(minutes);
}

const metricRows = computed<MetricRow[]>(() => {
  const value = proposal.value;
  const current = diff.value;
  if (value === null || current === null) return [];
  const lockedBlocks: readonly TimedBlock[] = current.locked;
  const now: TimedBlock[] = [...current.before, ...lockedBlocks];
  const next: TimedBlock[] = [...value.candidate.blocks, ...lockedBlocks];
  const rows: MetricRow[] = [
    {
      key: 'slack',
      label: t('replan.slack'),
      now: slackText(deadlineSlackMinutes(now, dueByTask.value)),
      proposed: slackText(deadlineSlackMinutes(next, dueByTask.value)),
    },
    {
      key: 'planned',
      label: t('replan.planned'),
      now: formatDuration(plannedMinutes(now)),
      proposed: formatDuration(plannedMinutes(next)),
    },
  ];
  return rows;
});

const plannedDelta = computed(() => {
  const value = proposal.value;
  const current = diff.value;
  if (value === null || current === null) return 0;
  return plannedMinutes(value.candidate.blocks) - plannedMinutes(current.before);
});

const proposedForAffected = computed(() => {
  const value = proposal.value;
  if (value === null) return [];
  const affected = new Set(value.trigger.affectedTaskIds);
  return value.candidate.blocks
    .filter((block) => affected.has(block.taskId))
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
});

const affectedTitles = computed(() => {
  const value = proposal.value;
  if (value === null) return [];
  return [...new Set(value.trigger.affectedTaskIds)].map((taskId) => ({ taskId, title: titleOf(taskId) }));
});

function range(block: TimedBlock): string {
  return formatDateTimeRange(block.startAt, block.endAt, timeZone.value);
}

const CHANGE_ICONS: Record<BlockChangeKind, IconName> = {
  moved: 'reschedule',
  shrunk: 'shrink',
  extended: 'expand',
  added: 'plus',
  removed: 'close',
};
const CHANGE_TONES: Record<BlockChangeKind, 'info' | 'warn' | 'accent' | 'success' | 'danger'> = {
  moved: 'info',
  shrunk: 'warn',
  extended: 'accent',
  added: 'success',
  removed: 'danger',
};

const STATE_TONES = {
  pending: 'accent',
  approved: 'success',
  rejected: 'neutral',
  expired: 'offline',
  superseded: 'offline',
} as const;

const stateTone = computed(() => STATE_TONES[proposal.value?.state ?? 'pending']);

const readOnlyBody = computed(() => {
  const state = proposal.value?.state;
  return state === undefined || state === 'pending' ? '' : t(`replan.stateBody.${state}`);
});

const rememberedPlanId = computed(() => {
  void activePlanRevision.value;
  return rememberedActivePlan(sessionStore.ownerId);
});

const busy = ref<'approve' | 'reject' | 'refresh' | null>(null);
const announcement = ref('');
const actionError = ref<string | null>(null);
const notice = ref<string | null>(null);
const violations = ref<Violation[]>([]);
const approvedVersion = ref<PlanVersion | null>(null);
const conflictOpen = ref(false);
const rejectOpen = ref(false);
const rejectReason = ref('');
const rejectError = ref<string | null>(null);
const stateRegion = ref<HTMLElement | null>(null);

watch(
  () => props.id,
  () => {
    approvedVersion.value = null;
    notice.value = null;
    actionError.value = null;
    violations.value = [];
  },
);

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function announce(message: string): Promise<void> {
  announcement.value = '';
  await nextTick();
  announcement.value = message;
}

async function focusState(): Promise<void> {
  await nextTick();
  stateRegion.value?.focus();
}

async function refreshAll(): Promise<void> {
  await proposalQuery.refetch();
  if (pending.value) await blocksQuery.refetch();
}

async function invalidateSchedules(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['replan-proposals'] }),
    queryClient.invalidateQueries({ queryKey: ['today'] }),
    queryClient.invalidateQueries({ queryKey: ['today-schedule-blocks'] }),
    queryClient.invalidateQueries({ queryKey: ['schedule-blocks'] }),
  ]);
}

async function approve(): Promise<void> {
  const value = proposal.value;
  if (value === null || !pending.value || readOnly.value || busy.value !== null) return;
  const binding = captureOwnerBinding();
  busy.value = 'approve';
  actionError.value = null;
  notice.value = null;
  violations.value = [];
  const scope = `replan:approve:${value.id}`;
  const action = actions.begin(scope, { id: value.id }, samePayload, value.availabilityVersion);
  try {
    const version = await plannerClient.approveReplanProposal(
      value.id,
      action.key,
      value.availabilityVersion,
      binding.signal,
    );
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    rememberActivePlan(binding.ownerId, version.planId);
    approvedVersion.value = version;
    await refreshAll();
    await invalidateSchedules();
    await announce(t('replan.approved'));
    await focusState();
  } catch (cause) {
    const transient =
      cause instanceof ApiError && (cause.code === 'approval_in_progress' || cause.code === 'idempotency_in_progress');
    if (cause instanceof ApiError && !transient) actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    if (cause instanceof ApiError && cause.status === 412) {
      conflictOpen.value = true;
    } else if (cause instanceof ApiError && cause.code === 'proposal_state_conflict') {
      await refreshAll();
      notice.value = t('replan.stateChanged');
      await announce(t('replan.stateChanged'));
      await focusState();
    } else if (cause instanceof ApiError && cause.code === 'constraint_violation') {
      violations.value = cause.problem?.violations ?? [];
      actionError.value = errorMessage(cause);
    } else {
      actionError.value = errorMessage(cause, t('replan.approveError'));
    }
  } finally {
    busy.value = null;
  }
}

function openReject(): void {
  if (!pending.value || readOnly.value || busy.value !== null) return;
  rejectReason.value = '';
  rejectError.value = null;
  rejectOpen.value = true;
}

const rejectUntil = computed(() => formatDateTime(Date.now() + DAY_MS, timeZone.value));

async function confirmReject(): Promise<void> {
  const value = proposal.value;
  if (value === null || !pending.value || readOnly.value || busy.value !== null) return;
  const binding = captureOwnerBinding();
  busy.value = 'reject';
  rejectError.value = null;
  notice.value = null;
  const reason = rejectReason.value.trim();
  const payload = { id: value.id, ...(reason.length > 0 ? { reason } : {}) };
  const scope = `replan:reject:${value.id}`;
  const action = actions.begin(scope, payload, samePayload, value.version);
  try {
    const updated = await plannerClient.rejectReplanProposal(
      value.id,
      action.key,
      value.version,
      reason.length > 0 ? reason : undefined,
      binding.signal,
    );
    actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    queryClient.setQueryData(proposalKey.value, updated);
    rejectOpen.value = false;
    await queryClient.invalidateQueries({ queryKey: ['replan-proposals'] });
    await announce(t('replan.rejected'));
    await focusState();
  } catch (cause) {
    if (cause instanceof ApiError) actions.settle(scope, action);
    if (!isOwnerBindingCurrent(binding)) return;
    if (cause instanceof ApiError && (cause.status === 412 || cause.code === 'proposal_state_conflict')) {
      rejectOpen.value = false;
      await refreshAll();
      const message = cause.status === 412 ? t('replan.versionChanged') : t('replan.stateChanged');
      notice.value = message;
      await announce(message);
      await focusState();
    } else {
      rejectError.value = errorMessage(cause, t('replan.rejectError'));
    }
  } finally {
    busy.value = null;
  }
}

async function refreshAfterConflict(): Promise<void> {
  busy.value = 'refresh';
  try {
    await refreshAll();
  } finally {
    busy.value = null;
    conflictOpen.value = false;
  }
}

async function recomputeAfterConflict(): Promise<void> {
  const value = proposal.value;
  const planId = rememberedPlanId.value;
  if (value === null || planId === null) return;
  const created = await recompute.request(planId, {
    reason: value.trigger.reason,
    affectedTaskIds: value.trigger.affectedTaskIds,
  });
  if (created === null) return;
  conflictOpen.value = false;
  await queryClient.invalidateQueries({ queryKey: ['replan-proposals'] });
  if (router !== null) await router.push(`/replan/${created.id}`);
}

function closeConflict(): void {
  conflictOpen.value = false;
  recompute.reset();
}
</script>

<template>
  <section class="page page--wide replan-page">
    <header class="page-header">
      <div class="page-heading">
        <p class="breadcrumb">
          <RouterLink to="/replan"><UiIcon name="arrow-left" :size="16" />{{ t('replan.back') }}</RouterLink>
        </p>
        <h1>{{ proposal ? triggerLabel(proposal.trigger.kind) : t('replan.title') }}</h1>
        <p v-if="proposal" class="page-lede replan-meta">
          <span>{{ t('replan.createdAt', { time: formatDateTime(proposal.createdAt, timeZone) }) }}</span>
          <span v-if="pending">{{ t('replan.expiresAt', { time: formatDateTime(proposal.expiresAt, timeZone) }) }}</span>
        </p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="proposal" :tone="stateTone" dot size="lg" data-proposal-state>
          {{ proposalStateLabel(proposal.state) }}
        </UiBadge>
        <UiBadge v-if="readOnly" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
      </div>
    </header>

    <p class="status-region status-note" role="status" aria-live="polite">{{ announcement }}</p>

    <div v-if="proposalQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('replan.loading') }}</p>
      <UiSkeleton variant="card" :count="2" :lines="3" />
    </div>
    <UiBanner v-else-if="proposalQuery.isError.value || proposal === null" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('replan.detailLoadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="proposalQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <template v-else>
      <div ref="stateRegion" class="replan-state" tabindex="-1">
        <UiBanner v-if="!pending" tone="info" :title="t('replan.readOnly')" class="replan-readonly" data-readonly>
          <p>{{ readOnlyBody }}</p>
          <template v-if="proposal.state === 'approved'" #actions>
            <RouterLink class="btn btn--primary btn--sm" to="/today">{{ t('replan.openToday') }}</RouterLink>
          </template>
        </UiBanner>
        <UiBanner v-if="notice" tone="warn" inline>{{ notice }}</UiBanner>
      </div>

      <div class="replan-layout">
        <UiCard class="replan-why" aria-labelledby="replan-why-title">
          <h2 id="replan-why-title" class="card-title">{{ t('replan.why') }}</h2>
          <p>{{ triggerBody(proposal.trigger.kind) }}</p>
          <ul class="chip-row" :aria-label="t('replan.why')">
            <li class="chip badge--info">{{ reasonLabel(proposal.trigger.reason) }}</li>
          </ul>
          <div v-if="affectedTitles.length > 0" class="replan-affected">
            <h3 class="eyebrow">{{ t('replan.affected') }}</h3>
            <ul class="plain-list">
              <li v-for="entry in affectedTitles" :key="entry.taskId">{{ entry.title }}</li>
            </ul>
          </div>
          <UiBanner
            v-for="flag in proposal.candidate.flags"
            :key="flag"
            tone="warn"
            inline
            class="replan-flag"
            :data-flag="flag"
          >
            {{ flagText(flag) }}
          </UiBanner>
        </UiCard>

        <UiCard class="replan-metrics" aria-labelledby="replan-metrics-title">
          <h2 id="replan-metrics-title" class="card-title">{{ t('replan.metricsTitle') }}</h2>
          <table v-if="metricRows.length > 0" class="replan-metrics-table">
            <caption class="visually-hidden">{{ t('replan.metricsTable') }}</caption>
            <thead>
              <tr>
                <th scope="col">{{ t('replan.colMetric') }}</th>
                <th scope="col">{{ t('replan.colNow') }}</th>
                <th scope="col">{{ t('replan.colProposed') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in metricRows" :key="row.key" :data-metric="row.key">
                <th scope="row">{{ row.label }}</th>
                <td class="tabular">{{ row.now }}</td>
                <td class="tabular">
                  {{ row.proposed }}
                  <span v-if="row.key === 'planned' && plannedDelta !== 0" class="muted">
                    ({{ formatSignedDuration(plannedDelta) }})
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="metricRows.length > 0" class="field-help">{{ t('replan.slackHelp') }}</p>
          <dl class="kv-list replan-kv">
            <dt>{{ t('replan.changed') }}</dt>
            <dd class="tabular" data-metric="changed">
              {{ t('replan.changedValue', { count: proposal.candidate.changedBlocks, bound: proposal.candidate.bound }) }}
            </dd>
            <template v-if="proposal.candidate.metrics.deficitMin > 0">
              <dt>{{ t('replan.deficit') }}</dt>
              <dd class="tabular">{{ formatDuration(proposal.candidate.metrics.deficitMin) }}</dd>
            </template>
          </dl>
        </UiCard>

        <section class="replan-diff" aria-labelledby="replan-diff-title">
          <template v-if="pending">
            <div class="section-head">
              <h2 id="replan-diff-title" class="h2">{{ t('replan.diffTitle') }}</h2>
              <p class="muted">{{ t('replan.diffLede') }}</p>
            </div>
            <div v-if="blocksQuery.isLoading.value" aria-hidden="true">
              <UiSkeleton variant="lines" :count="3" />
            </div>
            <UiBanner v-else-if="blocksQuery.isError.value" tone="error">
              <p class="error-text" role="alert">{{ t('replan.loadError') }}</p>
              <template #actions>
                <UiButton size="sm" icon="sync" @click="blocksQuery.refetch()">{{ t('common.retry') }}</UiButton>
              </template>
            </UiBanner>
            <template v-else-if="diff">
              <ul v-if="diff.changes.length > 0" class="replan-changes" :aria-label="t('replan.diffList')">
                <li
                  v-for="(change, index) in diff.changes"
                  :key="`${change.taskId}-${index}`"
                  class="replan-change"
                  :data-change="change.kind"
                  :data-task-id="change.taskId"
                >
                  <div class="replan-change-head">
                    <UiBadge :tone="CHANGE_TONES[change.kind]">
                      <UiIcon :name="CHANGE_ICONS[change.kind]" :size="14" />{{ changeLabel(change.kind) }}
                    </UiBadge>
                    <span class="replan-change-title">{{ titleOf(change.taskId) }}</span>
                  </div>
                  <dl class="replan-change-times">
                    <div v-if="change.before" class="replan-change-time replan-change-time--before">
                      <dt>{{ t('replan.before') }}</dt>
                      <dd><del class="tabular">{{ range(change.before) }}</del></dd>
                    </div>
                    <div v-if="change.after" class="replan-change-time replan-change-time--after">
                      <dt>{{ t('replan.after') }}</dt>
                      <dd><ins class="tabular">{{ range(change.after) }}</ins></dd>
                    </div>
                  </dl>
                </li>
              </ul>
              <p v-else class="muted replan-diff-empty">{{ t('replan.diffEmpty') }}</p>

              <div v-if="diff.locked.length > 0" class="replan-locked">
                <h3 class="h3">{{ t('replan.lockedTitle') }}</h3>
                <ul class="replan-locked-list" :aria-label="t('replan.lockedList')">
                  <li v-for="block in diff.locked" :key="block.id" :data-block-id="block.id" data-locked>
                    <UiBadge tone="outline"><UiIcon name="lock" :size="14" />{{ t('replan.locked') }}</UiBadge>
                    <span class="replan-change-title">{{ titleOf(block.taskId) }}</span>
                    <span class="tabular muted">{{ range(block) }}</span>
                  </li>
                </ul>
              </div>
              <p v-if="diff.unchangedCount > 0" class="muted replan-unchanged">
                {{ tp('replan.unchanged', diff.unchangedCount) }}
              </p>
            </template>
          </template>
          <template v-else>
            <div class="section-head">
              <h2 id="replan-diff-title" class="h2">{{ t('replan.proposedTitle') }}</h2>
              <p class="muted">{{ t('replan.proposedLede') }}</p>
            </div>
            <ul v-if="proposedForAffected.length > 0" class="approved-schedule-list" :aria-label="t('replan.proposedList')">
              <li v-for="(block, index) in proposedForAffected" :key="`${block.taskId}-${index}`">
                <span class="approved-schedule-title">{{ titleOf(block.taskId) }}</span>
                <span class="approved-schedule-time">{{ range(block) }}</span>
              </li>
            </ul>
            <p v-else class="muted">{{ t('replan.diffEmpty') }}</p>
          </template>

          <!-- FU-62: coded items render in Korean; rows without items keep
               the original lines under "계산 근거 (원문)". -->
          <div v-if="proposal.candidate.explanation.length > 0" class="replan-explanation">
            <ExplanationList
              :lines="proposal.candidate.explanation"
              :items="proposal.candidate.explanationItems"
              :time-zone="timeZone"
              :task-names="taskNames"
            />
          </div>
        </section>

        <UiCard v-if="pending" class="replan-actions" aria-labelledby="replan-actions-title">
          <h2 id="replan-actions-title" class="visually-hidden">{{ t('replan.approve') }}</h2>
          <p class="muted">{{ t('replan.requestHelp') }}</p>
          <UiBanner v-if="actionError" tone="error" role="alert">
            <p>{{ actionError }}</p>
            <div v-if="violations.length > 0" class="replan-violations" :aria-label="t('replan.violations')" role="group">
              <ExplanationList :violations="violations" :time-zone="timeZone" :task-names="taskNames" />
            </div>
          </UiBanner>
          <div class="replan-action-buttons">
            <UiButton
              variant="primary"
              icon="check"
              :disabled="readOnly || busy !== null"
              :busy="busy === 'approve'"
              data-replan-approve
              @click="approve"
            >
              {{ busy === 'approve' ? t('replan.approving') : t('replan.approve') }}
            </UiButton>
            <UiButton
              variant="danger-ghost"
              icon="close"
              :disabled="readOnly || busy !== null"
              data-replan-reject
              @click="openReject"
            >
              {{ t('replan.reject') }}
            </UiButton>
          </div>
        </UiCard>
        <UiCard v-else-if="rememberedPlanId" class="replan-actions" aria-labelledby="replan-again-title">
          <h2 id="replan-again-title" class="card-title">{{ t('replan.request') }}</h2>
          <ReplanRequestButton :plan-id="rememberedPlanId" show-help />
        </UiCard>
      </div>
    </template>

    <UiDialog
      v-if="rejectOpen && proposal"
      labelledby="replan-reject-title"
      describedby="replan-reject-body"
      size="sm"
      as="section"
      class="replan-reject-dialog"
      :dismissible="busy === null"
      @close="rejectOpen = false"
    >
      <header class="dialog-header dialog-header--start">
        <span class="dialog-icon dialog-icon--warn"><UiIcon name="clock" :size="22" /></span>
        <div class="dialog-heading">
          <h2 id="replan-reject-title" class="dialog-title">{{ t('replan.rejectTitle') }}</h2>
          <p id="replan-reject-body" class="muted">
            {{ t('replan.rejectBody', { reason: reasonShort(proposal.trigger.reason), until: rejectUntil }) }}
            {{ proposal.trigger.reason === 'user_request' ? t('replan.rejectBodyUser') : t('replan.rejectBodyOther') }}
          </p>
        </div>
      </header>
      <UiField id="replan-reject-reason" :label="t('replan.rejectReason')">
        <textarea id="replan-reject-reason" v-model="rejectReason" rows="2" maxlength="500"></textarea>
      </UiField>
      <UiBanner v-if="rejectError" tone="error" role="alert">{{ rejectError }}</UiBanner>
      <div class="dialog-actions">
        <UiButton variant="ghost" :disabled="busy !== null" data-autofocus @click="rejectOpen = false">
          {{ t('common.cancel') }}
        </UiButton>
        <UiButton variant="danger" :disabled="busy !== null" :busy="busy === 'reject'" @click="confirmReject">
          {{ busy === 'reject' ? t('replan.rejecting') : t('replan.rejectConfirm') }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog
      v-if="conflictOpen && proposal"
      role="alertdialog"
      labelledby="replan-conflict-title"
      describedby="replan-conflict-body"
      as="section"
      class="replan-conflict-dialog"
      :dismissible="busy === null && !recompute.busy.value"
      @close="closeConflict"
    >
      <header class="dialog-header dialog-header--start">
        <span class="dialog-icon dialog-icon--warn"><UiIcon name="sync" :size="22" /></span>
        <div class="dialog-heading">
          <h2 id="replan-conflict-title" class="dialog-title">{{ t('replan.conflictTitle') }}</h2>
          <p id="replan-conflict-body" class="muted">
            {{ t('replan.conflictBody', { version: proposal.availabilityVersion }) }}
          </p>
        </div>
      </header>
      <p class="muted">{{ t('replan.conflictHelp') }}</p>
      <div role="status" aria-live="polite">
        <UiBanner v-if="recompute.error.value" tone="warn" icon="clock">
          <p>{{ recompute.error.value }}</p>
          <p v-if="recompute.hint.value" class="muted">{{ recompute.hint.value }}</p>
        </UiBanner>
      </div>
      <div class="dialog-actions dialog-actions--start">
        <UiButton
          variant="primary"
          icon="sync"
          data-autofocus
          :disabled="busy !== null || recompute.busy.value"
          :busy="busy === 'refresh'"
          @click="refreshAfterConflict"
        >
          {{ t('replan.conflictRefresh') }}
        </UiButton>
        <UiButton
          v-if="rememberedPlanId"
          icon="reschedule"
          :disabled="busy !== null || recompute.busy.value || readOnly"
          :busy="recompute.busy.value"
          @click="recomputeAfterConflict"
        >
          {{ t('replan.conflictRecompute') }}
        </UiButton>
        <UiButton variant="ghost" :disabled="busy !== null || recompute.busy.value" @click="closeConflict">
          {{ t('common.close') }}
        </UiButton>
      </div>
    </UiDialog>
  </section>
</template>
