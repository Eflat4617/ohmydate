<script setup lang="ts">
import { computed, inject, nextTick, ref, watch, type ComponentPublicInstance } from 'vue';
import { routerKey } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  isStoredFinalResult,
  plannerClient,
  type ReplanProposal,
  type ReplanReasonCode,
  type ReplanTriggerKind,
  type Violation,
} from '../api';
import BlockLockToggle from '../components/BlockLockToggle.vue';
import ExplanationList from '../components/ExplanationList.vue';
import ReplanRequestButton from '../components/ReplanRequestButton.vue';
import WeekGrid from '../components/planner/WeekGrid.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import type { IconName } from '../components/ui/icons';
import { useTaskDirectory } from '../composables/useOverview';
import { usePlannerCard } from '../composables/usePlannerCard';
import { readCommitments, retryTransient } from '../composables/usePlannerRange';
import { useReplanRequest } from '../composables/useReplanRequest';
import { weekRange } from '../domain/overview';
import { replanDiff, replanMarks, type BlockChangeKind, type TimedBlock } from '../domain/replan';
import { addDaysToDate, localDateOf, todayInZone } from '../domain/time';
import { buildWeekGrid, type WeekBlockInput, type WeekItem, type WeekProposalInput } from '../domain/weekGrid';
import { t, tp } from '../i18n';
import {
  browserTimeZone,
  formatCivilDateRange,
  formatDateTime,
  formatDateTimeRange,
  formatDuration,
  formatHoursAndMinutes,
  formatSignedDuration,
} from '../i18n/format';
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
import { useLayoutNow } from '../layout/now';
import { ownerFenced, runOwnerBound, useOwnerKey, type OwnerSteps } from '../session/ownerBound';
import { captureOwnerBinding } from '../session/ownerEpoch';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';

/**
 * 재계획 (HOLO-03A; M5-03, 05 §11, 06 §7, 08 §2.6): the one place where the
 * app's proposals to re-plan are looked at.
 *
 *   `/replan`       the newest proposal that waits — or, when none does, that
 *                   the plan is on track — beside the list of every proposal;
 *   `/replan/:id`   that proposal (개요's AI card, 오늘, 플래너 and the bell
 *                   land here).
 *
 * A proposal says why it came, what changes as numbers (전 → 후) and on the
 * week grid — where a block stood is a ghost, where it goes is a proposal,
 * what is locked or untouched stays as it is — and can be approved, rejected
 * or asked for again.
 *
 * The before side is the server's own snapshot (`proposal.before`, FU-70 /
 * M5-03R-1 H1); without one the comparison is declared unavailable instead of
 * guessed. Approve pins `If-Match: W/"availability:<n>"`; reject pins the
 * proposal version and explains the 24 h same-reason suppression first.
 * Nothing changes until the owner approves.
 */
const props = defineProps<{ id?: string }>();

const DAY_MS = 24 * 60 * 60 * 1000;
const router = inject(routerKey, null);
const queryClient = useQueryClient();
const auth = useAuthStore();
const offline = useOfflineStore();
const sessionStore = useSessionStore();
const now = useLayoutNow();
const actions = new ActionStore();
const recompute = useReplanRequest();

const ownerKey = computed(() => sessionStore.ownerId ?? 'anonymous');
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());
const today = computed(() => todayInZone(timeZone.value, now.value));
const readOnly = computed(() => !offline.mutationsEnabled);

// ── Every proposal, newest first; the ones that wait on top ───────────
const listQuery = useQuery({
  queryKey: computed(() => ['replan-proposals', 'all', ownerKey.value]),
  queryFn: () => {
    const binding = captureOwnerBinding();
    return plannerClient.listReplanProposals({ limit: 50, signal: binding.signal });
  },
});
const items = computed(() =>
  [...(listQuery.data.value?.items ?? [])].sort((left, right) => {
    if ((left.state === 'pending') !== (right.state === 'pending')) return left.state === 'pending' ? -1 : 1;
    return right.createdAt.localeCompare(left.createdAt);
  }),
);
/** "재계획 요청" needs a plan: the one the newest proposal names (FU-70). Nothing is remembered on the device. */
const latestPlanId = computed(() => {
  const newest = [...(listQuery.data.value?.items ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return newest?.planId ?? null;
});

// ── The proposal on show ───────────────────────────────────────────────
/**
 * `/replan` names none: the newest that waits is taken up once, and then
 * stays on show for this visit — approving or rejecting it must end in its
 * own result (and the way to 오늘), not in "nothing waits".
 */
const adoptedId = ref<string | null>(null);
watch(
  [() => props.id, items, ownerKey],
  ([id, list, owner], previous) => {
    if (previous !== undefined && (previous[0] !== id || previous[2] !== owner)) adoptedId.value = null;
    if ((id === undefined || id.length === 0) && adoptedId.value === null) {
      adoptedId.value = list.find((item) => item.state === 'pending')?.id ?? null;
    }
  },
  { immediate: true },
);
/** The address names one; else the one taken up. */
const selectedId = computed(() => (props.id !== undefined && props.id.length > 0 ? props.id : adoptedId.value));

const proposalKey = computed(() => ['replan-proposal', selectedId.value ?? 'none', ownerKey.value]);
const proposalQuery = useQuery({
  queryKey: proposalKey,
  queryFn: () => {
    const binding = captureOwnerBinding();
    return plannerClient.getReplanProposal(selectedId.value ?? '', { signal: binding.signal });
  },
  enabled: computed(() => selectedId.value !== null),
});
const proposal = computed<ReplanProposal | null>(() => (selectedId.value === null ? null : (proposalQuery.data.value ?? null)));
const pending = computed(() => proposal.value?.state === 'pending');
const planId = computed(() => proposal.value?.planId ?? latestPlanId.value);

const directory = useTaskDirectory();

function titleOf(taskId: string): string {
  return directory.data.value?.tasks.get(taskId)?.title ?? t('replan.taskFallback');
}

/** Task titles for FU-62 coded explanation/violation parameters. */
const taskNames = computed<Record<string, string>>(() =>
  Object.fromEntries([...(directory.data.value?.tasks.values() ?? [])].map((task) => [task.id, task.title])),
);

const before = computed(() => proposal.value?.before ?? null);
const diff = computed(() => {
  const value = proposal.value;
  const snapshot = before.value;
  return value === null || snapshot === null ? null : replanDiff(snapshot.blocks, value.candidate.blocks);
});
const marks = computed(() => {
  const value = proposal.value;
  const snapshot = before.value;
  return value === null || snapshot === null ? null : replanMarks(snapshot.blocks, value.candidate.blocks);
});

// ── 전 → 후, as numbers ────────────────────────────────────────────────
interface Figure {
  readonly key: 'slack' | 'planned' | 'changed';
  readonly label: string;
  /** The value after approval: the card's number. */
  readonly after: string;
  /** What it is now; null when it cannot be compared (no snapshot). */
  readonly before: string | null;
  readonly delta: string | null;
}

/** Both sides come from the server with the same rules (06 §6); nothing is estimated here. */
const figures = computed<Figure[]>(() => {
  const value = proposal.value;
  if (value === null) return [];
  const snapshot = before.value;
  const metrics = value.candidate.metrics;
  const focusDelta = snapshot === null ? 0 : metrics.totalFocusMin - snapshot.metrics.totalFocusMin;
  const slackDelta = snapshot === null ? 0 : metrics.minSlackMin - snapshot.metrics.minSlackMin;
  return [
    {
      key: 'slack',
      label: t('replan.slack'),
      after: formatSignedDuration(metrics.minSlackMin),
      before: snapshot === null ? null : formatSignedDuration(snapshot.metrics.minSlackMin),
      delta: slackDelta === 0 ? null : formatSignedDuration(slackDelta),
    },
    {
      key: 'planned',
      label: t('replan.planned'),
      // Hours of work are counted in hours, never in days.
      after: formatHoursAndMinutes(metrics.totalFocusMin),
      before: snapshot === null ? null : formatHoursAndMinutes(snapshot.metrics.totalFocusMin),
      delta: focusDelta === 0 ? null : `${focusDelta < 0 ? '−' : '+'}${formatHoursAndMinutes(Math.abs(focusDelta))}`,
    },
    {
      key: 'changed',
      label: t('replan.changed'),
      after: tp('replan.blocks', value.candidate.changedBlocks),
      before: null,
      delta: null,
    },
  ];
});

/** Per affected deadline task: its slack in the before snapshot. */
const affectedSlack = computed(() => {
  const value = proposal.value;
  const snapshot = before.value;
  if (value === null || snapshot === null) return [];
  const affected = new Set(value.trigger.affectedTaskIds);
  return snapshot.metrics.taskSlack
    .filter((entry) => affected.has(entry.taskId))
    .map((entry) => ({ taskId: entry.taskId, title: titleOf(entry.taskId), slack: formatDuration(entry.slackMin) }));
});

/** Legacy proposals (no snapshot): only the candidate is known. */
const candidateBlocks = computed(() =>
  [...(proposal.value?.candidate.blocks ?? [])].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt)),
);

/** The reason each trigger usually carries: said once, by the sentence under the title. */
const USUAL_REASON: Record<ReplanTriggerKind, ReplanReasonCode> = {
  deadline_risk: 'deadline_slack_negative',
  commitment_conflict: 'commitment_overlap',
  early_completion: 'early_completion_capacity',
  user_request: 'user_request',
};
/** A finer reason than the trigger's own (선행 관계가 바뀌었어요) is named beside it. */
const reasonNote = computed(() => {
  const trigger = proposal.value?.trigger;
  if (trigger === undefined || USUAL_REASON[trigger.kind] === trigger.reason) return null;
  return reasonLabel(trigger.reason);
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
// Lime is kept for what is confirmed or picked, so a longer block is plain.
const CHANGE_TONES: Record<BlockChangeKind, 'info' | 'warn' | 'neutral' | 'success' | 'danger'> = {
  moved: 'info',
  shrunk: 'warn',
  extended: 'neutral',
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

const readOnlyBody = computed(() => {
  const state = proposal.value?.state;
  return state === undefined || state === 'pending' ? '' : t(`replan.stateBody.${state}`);
});

// ── 전 → 후, on the week grid ──────────────────────────────────────────
const weekStart = ref('');
/**
 * Seven days from the day of the first change (or, without a comparison, of
 * the first proposed block): a block moved from Saturday to Monday is on one
 * screen, which a Monday-to-Sunday week would cut in two.
 */
const homeWeek = computed(() => {
  const first = marks.value?.firstChangeAt ?? marks.value?.kept[0]?.startAt ?? candidateBlocks.value[0]?.startAt ?? null;
  return first === null ? '' : localDateOf(first, timeZone.value);
});

watch(
  [homeWeek, selectedId],
  ([week]) => {
    weekStart.value = week;
  },
  { immediate: true },
);

const weekSpan = computed(() => (weekStart.value.length === 0 ? null : weekRange(weekStart.value, timeZone.value)));
// The 약속 of the days on show, for context (the one that caused a conflict is among them).
// Only 약속 are read: what changes comes from the proposal's own snapshot, never from a calendar window.
const fencedOwner = useOwnerKey();
const commitmentsQuery = useQuery({
  queryKey: computed(() => ['replan-commitments', fencedOwner.value, weekSpan.value?.from ?? 'none', weekSpan.value?.to ?? 'none']),
  queryFn: ({ queryKey }) =>
    ownerFenced(String(queryKey[1]), async (binding) => {
      const page = await readCommitments(binding, { from: String(queryKey[2]), to: String(queryKey[3]) });
      return page.items;
    }),
  enabled: computed(() => weekSpan.value !== null),
  retry: retryTransient,
});
const rangeText = computed(() =>
  weekStart.value.length === 0
    ? ''
    : formatCivilDateRange(weekStart.value, addDaysToDate(weekStart.value, 6), {
        weekday: false,
        year: weekStart.value.slice(0, 4) !== today.value.slice(0, 4),
      }),
);
const announcement = ref('');

function showWeek(start: string): void {
  if (start.length === 0 || start === weekStart.value) return;
  weekStart.value = start;
  announcement.value = t('replan.weekAnnounce', { range: rangeText.value });
}

const showEarly = ref(false);
/** An approved proposal's "after" is real now: it is drawn as blocks, never as a proposal. */
const applied = computed(() => proposal.value?.state === 'approved');

const grid = computed(() => {
  const found = marks.value;
  const kept: WeekBlockInput[] = (found?.kept ?? []).map((block) => ({ ...block }));
  // Without a snapshot only the proposed blocks are known: they are drawn as proposed, with no "what changed".
  const afters: WeekProposalInput[] =
    found === null
      ? candidateBlocks.value.map((block, index) => ({ index, taskId: block.taskId, startAt: block.startAt, endAt: block.endAt }))
      : found.afters.map((block) => ({ ...block }));
  const applyAfter = applied.value && found !== null;
  return buildWeekGrid({
    start: weekStart.value.length === 0 ? today.value : weekStart.value,
    timeZone: timeZone.value,
    today: today.value,
    nowMs: now.value,
    blocks: applyAfter
      ? [
          ...kept,
          ...afters.map((block) => ({
            id: `after-${block.index}`,
            taskId: block.taskId,
            startAt: block.startAt,
            endAt: block.endAt,
            status: 'planned',
          })),
        ]
      : kept,
    commitments: commitmentsQuery.data.value ?? [],
    // Titles only: the deadlines of other tasks are not this comparison's subject.
    tasks: [...(directory.data.value?.tasks.values() ?? [])].map((task) => ({ id: task.id, title: task.title, status: 'done' })),
    showEarly: showEarly.value,
    ghosts: found?.ghosts ?? [],
    proposals: applyAfter ? [] : afters,
  });
});

// ── The detail card of a mark on the grid (read-only) ──────────────────
const gridView = ref<InstanceType<typeof WeekGrid> | null>(null);
const frame = computed<HTMLElement | null>(() => gridView.value?.content ?? null);
const card = usePlannerCard({ frame, visible: () => gridView.value?.visibleRect() ?? null });
const openItem = computed<WeekItem | null>(() => {
  const key = card.openKey.value;
  if (key === null) return null;
  for (const day of grid.value.days) {
    const found = day.items.find((item) => item.key === key);
    if (found !== undefined) return found;
  }
  return null;
});
watch(openItem, (item) => {
  if (item === null && card.openKey.value !== null) card.close();
});

function setCard(instance: Element | ComponentPublicInstance | null): void {
  const element: unknown = instance !== null && '$el' in instance ? instance.$el : instance;
  card.card.value = element instanceof HTMLElement ? element : null;
}

function cardKind(item: WeekItem): string {
  if (item.kind === 'ghost') return t('replan.cardGhost');
  if (item.kind === 'proposal') return t('replan.cardAfter');
  if (item.kind === 'commitment') return t('month.detail.kind.commitment');
  return item.block?.locked === true ? t('planner.week.kind.blockLocked') : t('month.detail.kind.block');
}

function onCardKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  card.close({ restoreFocus: true });
}

// ── Approve, reject, ask again ─────────────────────────────────────────
const busy = ref<'approve' | 'reject' | 'refresh' | null>(null);
const liveMessage = ref('');
const actionError = ref<string | null>(null);
const notice = ref<string | null>(null);
const violations = ref<Violation[]>([]);
const conflictOpen = ref(false);
const rejectOpen = ref(false);
const rejectReason = ref('');
const rejectError = ref<string | null>(null);
const stateRegion = ref<HTMLElement | null>(null);

watch(selectedId, () => {
  notice.value = null;
  actionError.value = null;
  violations.value = [];
  card.close();
});

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Helpers of the owner-bound tasks below. They are generators: a task
// delegates to them with `yield*`, so their own waits are fenced like the
// task's — nothing is announced or focused for a user who signed in meanwhile.
function* announce(message: string): OwnerSteps<void> {
  liveMessage.value = '';
  yield nextTick();
  liveMessage.value = message;
}

function* focusState(): OwnerSteps<void> {
  yield nextTick();
  stateRegion.value?.focus();
}

function* refreshAll(): OwnerSteps<void> {
  yield Promise.all([proposalQuery.refetch(), listQuery.refetch()]);
}

function* invalidateSchedules(): OwnerSteps<void> {
  yield Promise.all([
    queryClient.invalidateQueries({ queryKey: ['replan-proposals'] }),
    queryClient.invalidateQueries({ queryKey: ['today'] }),
    queryClient.invalidateQueries({ queryKey: ['today-schedule-blocks'] }),
    queryClient.invalidateQueries({ queryKey: ['schedule-blocks'] }),
    queryClient.invalidateQueries({ queryKey: ['planner-range'] }),
  ]);
}

// Owner isolation (ADR-023): approve, reject and the conflict follow-ups run
// under the owner who started them (runOwnerBound). After a user switch
// nothing is cached, announced or navigated.
async function approve(): Promise<void> {
  const value = proposal.value;
  if (value === null || !pending.value || readOnly.value || busy.value !== null) return;
  busy.value = 'approve';
  actionError.value = null;
  notice.value = null;
  violations.value = [];
  const scope = `replan:approve:${value.id}`;
  const action = actions.begin(scope, { id: value.id }, samePayload, value.availabilityVersion);
  await runOwnerBound(
    function* (owner) {
      try {
        yield* owner.wait(plannerClient.approveReplanProposal(value.id, action.key, value.availabilityVersion, owner.signal));
        actions.settle(scope, action);
        yield* refreshAll();
        yield* invalidateSchedules();
        yield* announce(t('replan.approved'));
        yield* focusState();
      } catch (cause) {
        // 412 is not stored but the If-Match it pinned is now stale: the next try
        // carries a new availability version and therefore a new key (ActionStore).
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (cause instanceof ApiError && cause.status === 412) {
          conflictOpen.value = true;
        } else if (cause instanceof ApiError && cause.code === 'proposal_state_conflict') {
          yield* refreshAll();
          notice.value = t('replan.stateChanged');
          yield* announce(t('replan.stateChanged'));
          yield* focusState();
        } else if (cause instanceof ApiError && cause.code === 'constraint_violation') {
          violations.value = cause.problem?.violations ?? [];
          actionError.value = errorMessage(cause);
        } else {
          actionError.value = errorMessage(cause, t('replan.approveError'));
        }
      }
    },
    {
      onSettled: () => {
        busy.value = null;
      },
    },
  );
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
  busy.value = 'reject';
  rejectError.value = null;
  notice.value = null;
  const reason = rejectReason.value.trim();
  const payload = { id: value.id, ...(reason.length > 0 ? { reason } : {}) };
  const scope = `replan:reject:${value.id}`;
  const action = actions.begin(scope, payload, samePayload, value.version);
  const key = proposalKey.value;
  await runOwnerBound(
    function* (owner) {
      try {
        const updated = yield* owner.wait(
          plannerClient.rejectReplanProposal(value.id, action.key, value.version, reason.length > 0 ? reason : undefined, owner.signal),
        );
        actions.settle(scope, action);
        queryClient.setQueryData(key, updated);
        rejectOpen.value = false;
        yield* owner.wait(queryClient.invalidateQueries({ queryKey: ['replan-proposals'] }));
        yield* announce(t('replan.rejected'));
        yield* focusState();
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (cause instanceof ApiError && (cause.status === 412 || cause.code === 'proposal_state_conflict')) {
          rejectOpen.value = false;
          yield* refreshAll();
          const message = cause.status === 412 ? t('replan.versionChanged') : t('replan.stateChanged');
          notice.value = message;
          yield* announce(message);
          yield* focusState();
        } else {
          rejectError.value = errorMessage(cause, t('replan.rejectError'));
        }
      }
    },
    {
      onSettled: () => {
        busy.value = null;
      },
    },
  );
}

async function refreshAfterConflict(): Promise<void> {
  busy.value = 'refresh';
  await runOwnerBound(
    function* () {
      yield* refreshAll();
    },
    {
      onSettled: () => {
        busy.value = null;
        conflictOpen.value = false;
      },
    },
  );
}

async function recomputeAfterConflict(): Promise<void> {
  const value = proposal.value;
  if (value === null) return;
  await runOwnerBound(function* (owner) {
    const created = yield* owner.wait(
      recompute.request(value.planId, { reason: value.trigger.reason, affectedTaskIds: value.trigger.affectedTaskIds }),
    );
    if (created === null) return;
    conflictOpen.value = false;
    yield* owner.wait(queryClient.invalidateQueries({ queryKey: ['replan-proposals'] }));
    if (router !== null) yield* owner.wait(router.push(`/replan/${created.id}`));
  });
}

function closeConflict(): void {
  conflictOpen.value = false;
  recompute.reset();
}

const loading = computed(() => listQuery.isLoading.value || (selectedId.value !== null && proposalQuery.isLoading.value));
const loadFailed = computed(
  () => (selectedId.value !== null && (proposalQuery.isError.value || (!proposalQuery.isLoading.value && proposal.value === null))) ||
    (selectedId.value === null && listQuery.isError.value),
);
</script>

<template>
  <section class="page page--wide replan-page" data-replan>
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('replan.title') }}</h1>
        <p class="page-lede">{{ t('replan.lede') }}</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="readOnly" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
      </div>
    </header>

    <p class="visually-hidden" role="status" aria-live="polite" data-replan-live>{{ liveMessage }}</p>
    <p class="visually-hidden" role="status" aria-live="polite">{{ announcement }}</p>

    <div class="replan-layout">
      <div class="replan-main">
        <div v-if="loading" data-replan-loading>
          <p class="visually-hidden" role="status">{{ t('replan.loading') }}</p>
          <UiSkeleton variant="card" :count="2" :lines="3" />
        </div>
        <UiBanner v-else-if="loadFailed" tone="error" class="error-panel">
          <p class="error-text" role="alert">{{ selectedId === null ? t('replan.loadError') : t('replan.detailLoadError') }}</p>
          <template #actions>
            <UiButton size="sm" icon="sync" @click="selectedId === null ? listQuery.refetch() : proposalQuery.refetch()">
              {{ t('common.retry') }}
            </UiButton>
          </template>
        </UiBanner>

        <!-- Nothing waits: the plan is on track. -->
        <UiCard v-else-if="proposal === null" class="replan-none" data-replan-none>
          <UiEmptyState icon="check-circle" :title="t('replan.none.title')">
            <p>{{ latestPlanId ? t('replan.none.body') : t('replan.none.noPlan') }}</p>
            <template #actions>
              <ReplanRequestButton v-if="latestPlanId" :plan-id="latestPlanId" show-help />
              <RouterLink v-else class="btn btn--secondary" to="/plan">{{ t('replan.none.start') }}</RouterLink>
            </template>
          </UiEmptyState>
        </UiCard>

        <template v-else>
          <div ref="stateRegion" class="replan-state" tabindex="-1">
            <UiBanner
              v-if="!pending"
              :tone="proposal.state === 'approved' ? 'success' : 'offline'"
              :icon="proposal.state === 'approved' ? 'check-circle' : 'lock'"
              :title="proposal.state === 'approved' ? t('replan.approved') : t('replan.readOnly')"
              class="replan-readonly"
              data-readonly
            >
              <p v-if="proposal.state !== 'approved'">{{ readOnlyBody }}</p>
              <template v-if="proposal.state === 'approved'" #actions>
                <RouterLink class="btn btn--primary btn--sm" to="/today" data-replan-today>{{ t('replan.openToday') }}</RouterLink>
              </template>
            </UiBanner>
            <UiBanner v-if="notice" tone="warn" inline>{{ notice }}</UiBanner>
          </div>

          <!-- Why -->
          <UiCard class="replan-why" aria-labelledby="replan-why-title">
            <header class="replan-why-head">
              <div class="replan-why-heading">
                <p class="replan-why-label">{{ t('replan.why') }}</p>
                <h2 id="replan-why-title" class="replan-why-title" data-replan-trigger>{{ triggerLabel(proposal.trigger.kind) }}</h2>
              </div>
              <UiBadge :tone="STATE_TONES[proposal.state]" dot size="lg" data-proposal-state>
                {{ proposalStateLabel(proposal.state) }}
              </UiBadge>
            </header>
            <p class="replan-why-body">{{ triggerBody(proposal.trigger.kind) }}</p>
            <p class="replan-meta tabular">
              <span v-if="reasonNote" class="badge badge--info replan-reason" data-replan-reason>{{ reasonNote }}</span>
              <span>{{ t('replan.createdAt', { time: formatDateTime(proposal.createdAt, timeZone) }) }}</span>
              <span v-if="pending">{{ t('replan.expiresAt', { time: formatDateTime(proposal.expiresAt, timeZone) }) }}</span>
            </p>
            <div v-if="affectedTitles.length > 0" class="replan-affected">
              <h3 class="replan-affected-title">{{ t('replan.affected') }}</h3>
              <ul class="replan-affected-list">
                <li v-for="entry in affectedTitles" :key="entry.taskId" class="chip">{{ entry.title }}</li>
              </ul>
            </div>
            <UiBanner v-for="flag in proposal.candidate.flags" :key="flag" tone="warn" inline class="replan-flag" :data-flag="flag">
              {{ flagText(flag) }}
            </UiBanner>
          </UiCard>

          <!-- 전 → 후, as numbers -->
          <section class="replan-figures" :aria-label="t('replan.figures')" data-replan-figures>
            <UiCard v-for="figure in figures" :key="figure.key" compact class="replan-figure" :data-metric="figure.key">
              <p class="replan-figure-label">{{ figure.label }}</p>
              <p class="replan-figure-value">
                <span class="numeral" data-after>{{ figure.after }}</span>
                <span v-if="figure.delta" class="badge replan-figure-delta tabular" data-delta>{{ figure.delta }}</span>
              </p>
              <p v-if="figure.before !== null" class="replan-figure-before tabular">
                <span data-before>{{ t('replan.was', { value: figure.before }) }}</span>
              </p>
            </UiCard>
          </section>
          <p v-if="before" class="field-help replan-figures-help">
            {{ t('replan.slackHelp') }}
            <span class="tabular">{{ t('replan.snapshotAt', { time: formatDateTime(before.capturedAt, timeZone) }) }}</span>
          </p>
          <ul v-if="affectedSlack.length > 0" class="plain-list replan-task-slack" :aria-label="t('replan.taskSlackList')">
            <li v-for="entry in affectedSlack" :key="entry.taskId" :data-task-slack="entry.taskId">
              {{ t('replan.taskSlack', { title: entry.title, duration: entry.slack }) }}
            </li>
          </ul>
          <p v-if="proposal.candidate.metrics.deficitMin > 0" class="replan-deficit" data-replan-deficit>
            {{ t('replan.deficit') }} · <span class="tabular">{{ formatDuration(proposal.candidate.metrics.deficitMin) }}</span>
          </p>

          <!-- 전 → 후, on the grid -->
          <section v-if="weekStart.length > 0" class="plan-week replan-week" aria-labelledby="replan-week-title" :data-week-start="weekStart">
            <header class="plan-week-head">
              <h2 id="replan-week-title" class="plan-week-title tabular">{{ t('replan.week', { range: rangeText }) }}</h2>
              <div class="planner-nav" role="group" :aria-label="t('replan.weekNav')">
                <UiButton
                  size="sm"
                  icon="chevron-left"
                  icon-only
                  :aria-label="t('replan.previousWeek')"
                  data-replan-week-previous
                  @click="showWeek(addDaysToDate(weekStart, -7))"
                />
                <UiButton size="sm" :disabled="weekStart === homeWeek" data-replan-week-home @click="showWeek(homeWeek)">
                  {{ t('replan.changeWeek') }}
                </UiButton>
                <UiButton
                  size="sm"
                  icon="chevron-right"
                  icon-only
                  :aria-label="t('replan.nextWeek')"
                  data-replan-week-next
                  @click="showWeek(addDaysToDate(weekStart, 7))"
                />
              </div>
            </header>
            <WeekGrid
              ref="gridView"
              :grid="grid"
              :time-zone="timeZone"
              :label="t('replan.week', { range: rangeText })"
              :open-key="card.openKey.value"
              :show-early="showEarly"
              open-at="proposal"
              :scroll-key="`${proposal.id}:${proposal.state}`"
              @open="(item, element) => card.toggle(item.key, element)"
              @toggle-early="showEarly = !showEarly"
            >
              <template #card>
                <section
                  v-if="openItem"
                  :ref="setCard"
                  :key="openItem.key"
                  class="planner-card"
                  :class="`planner-card--${card.side.value}`"
                  :style="card.style.value"
                  role="dialog"
                  aria-modal="false"
                  aria-labelledby="planner-card-title"
                  aria-describedby="planner-card-when"
                  tabindex="-1"
                  :data-planner-card="openItem.kind"
                  @keydown="onCardKeydown"
                >
                  <header class="planner-card-head">
                    <p class="planner-card-tags">
                      <UiBadge tone="outline" data-planner-card-kind>{{ cardKind(openItem) }}</UiBadge>
                      <UiBadge v-if="openItem.change" :tone="CHANGE_TONES[openItem.change]">{{ changeLabel(openItem.change) }}</UiBadge>
                    </p>
                    <button
                      type="button"
                      class="btn btn--ghost btn--icon btn--sm planner-card-close"
                      :aria-label="t('common.close')"
                      data-planner-card-close
                      @click="card.close({ restoreFocus: true })"
                    >
                      <UiIcon name="close" :size="16" />
                    </button>
                  </header>
                  <h2 id="planner-card-title" class="planner-card-title">{{ openItem.title ?? t('replan.taskFallback') }}</h2>
                  <p id="planner-card-when" class="planner-card-when">
                    <UiIcon name="clock" :size="16" />
                    <span class="tabular">
                      {{ openItem.endAt === null ? '' : formatDateTimeRange(openItem.startAt, openItem.endAt, timeZone) }}
                    </span>
                  </p>
                  <p v-if="openItem.block?.locked" class="planner-card-note">{{ t('blockLock.readOnlyHint') }}</p>
                </section>
              </template>
            </WeekGrid>
            <ul class="planner-legend" :aria-label="t('replan.legend')">
              <li v-if="marks"><span class="planner-swatch planner-swatch--ghost" aria-hidden="true"></span>{{ t('replan.legendGhost') }}</li>
              <li v-if="applied">
                <span class="planner-swatch" aria-hidden="true"></span>{{ t('replan.legendAfterApproved') }}
              </li>
              <li v-else>
                <span class="planner-swatch planner-swatch--proposal" aria-hidden="true"></span>{{ t('replan.legendAfter') }}
              </li>
              <li v-if="marks && !applied">
                <span class="planner-swatch" aria-hidden="true"></span>{{ t('replan.legendBlock') }}
              </li>
              <li v-if="marks && marks.kept.some((block) => block.locked)">
                <UiIcon name="lock" :size="13" />{{ t('replan.legendLocked') }}
              </li>
              <li><span class="planner-swatch planner-swatch--commitment" aria-hidden="true"></span>{{ t('replan.legendCommitment') }}</li>
            </ul>
          </section>

          <!-- The decision sits under what was just looked at; the account in words follows. -->
          <UiCard v-if="pending" class="replan-actions" aria-labelledby="replan-actions-title">
            <h2 id="replan-actions-title" class="visually-hidden">{{ t('replan.approve') }}</h2>
            <UiBanner v-if="actionError" tone="error" role="alert">
              <p>{{ actionError }}</p>
              <div v-if="violations.length > 0" class="replan-violations" :aria-label="t('replan.violations')" role="group">
                <ExplanationList :violations="violations" :time-zone="timeZone" :task-names="taskNames" />
              </div>
            </UiBanner>
            <div class="replan-action-row">
              <p class="replan-action-help">{{ t('replan.decideHelp') }}</p>
              <div class="replan-action-buttons">
                <UiButton variant="danger-ghost" icon="close" :disabled="readOnly || busy !== null" data-replan-reject @click="openReject">
                  {{ t('replan.reject') }}
                </UiButton>
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
              </div>
            </div>
          </UiCard>
          <!-- 전 → 후, in words -->
          <UiCard class="replan-diff" aria-labelledby="replan-diff-title">
            <template v-if="diff && before">
              <h2 id="replan-diff-title" class="card-title"><UiIcon name="reschedule" :size="18" />{{ t('replan.diffTitle') }}</h2>
              <p class="replan-diff-lede">{{ t('replan.diffLede') }}</p>
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
              <p v-else class="replan-diff-empty">{{ t('replan.diffEmpty') }}</p>

              <div v-if="diff.locked.length > 0" class="replan-locked">
                <h3 class="replan-locked-title">{{ t('replan.lockedTitle') }}</h3>
                <ul class="replan-locked-list" :aria-label="t('replan.lockedList')">
                  <li v-for="block in diff.locked" :key="block.id" :data-block-id="block.id" data-locked>
                    <BlockLockToggle read-only :locked="true" />
                    <span class="replan-change-title">{{ titleOf(block.taskId) }}</span>
                    <span class="tabular replan-locked-time">{{ range(block) }}</span>
                  </li>
                </ul>
                <p class="field-help block-lock-hint">{{ t('blockLock.readOnlyHint') }}</p>
              </div>
              <p v-if="diff.unchangedCount > 0" class="replan-unchanged">{{ tp('replan.unchanged', diff.unchangedCount) }}</p>
            </template>
            <template v-else>
              <h2 id="replan-diff-title" class="card-title"><UiIcon name="reschedule" :size="18" />{{ t('replan.proposedTitle') }}</h2>
              <UiBanner tone="warn" class="replan-no-comparison" data-no-comparison>
                <p>{{ t('replan.noComparison') }}</p>
              </UiBanner>
              <ul v-if="candidateBlocks.length > 0" class="replan-proposed-list" :aria-label="t('replan.proposedList')">
                <li v-for="(block, index) in candidateBlocks" :key="`${block.taskId}-${index}`" data-proposed-block>
                  <span class="replan-change-title">{{ titleOf(block.taskId) }}</span>
                  <span class="tabular replan-locked-time">{{ range(block) }}</span>
                </li>
              </ul>
              <p v-else class="replan-diff-empty">{{ t('replan.diffEmpty') }}</p>
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
          </UiCard>


          <!-- A proposal that is settled: the plan can be asked for again. -->
          <div v-if="!pending && planId" class="replan-again" data-replan-again>
            <ReplanRequestButton :plan-id="planId" show-help />
          </div>
        </template>
      </div>

      <!-- Every proposal: the ones that wait first, then the history. -->
      <aside class="replan-side">
        <UiCard compact class="replan-list" aria-labelledby="replan-list-title" data-replan-list>
          <h2 id="replan-list-title" class="card-title"><UiIcon name="list" :size="18" />{{ t('replan.listTitle') }}</h2>
          <UiSkeleton v-if="listQuery.isLoading.value" variant="lines" :count="3" />
          <UiBanner v-else-if="listQuery.isError.value" tone="error" inline>
            <span role="alert">{{ t('replan.loadError') }}</span>
            <template #actions>
              <UiButton size="sm" icon="sync" @click="listQuery.refetch()">{{ t('common.retry') }}</UiButton>
            </template>
          </UiBanner>
          <p v-else-if="items.length === 0" class="replan-list-empty" data-replan-list-empty>{{ t('replan.listEmpty') }}</p>
          <ul v-else class="replan-items">
            <li
              v-for="item in items"
              :key="item.id"
              class="replan-item"
              :class="{ 'replan-item--past': item.state !== 'pending', 'replan-item--current': item.id === selectedId }"
              :data-proposal-id="item.id"
              :data-state="item.state"
            >
              <RouterLink
                class="replan-item-link"
                :to="`/replan/${item.id}`"
                :aria-current="item.id === selectedId ? 'true' : undefined"
              >
                <span class="replan-item-head">
                  <span class="replan-item-title">{{ triggerLabel(item.trigger.kind) }}</span>
                  <UiBadge :tone="STATE_TONES[item.state]">{{ proposalStateLabel(item.state) }}</UiBadge>
                </span>
                <span class="replan-item-meta tabular">
                  <span>{{ formatDateTime(item.createdAt, timeZone) }}</span>
                  <span v-if="item.state === 'pending'">{{ tp('replan.changedCount', item.candidate.changedBlocks) }}</span>
                </span>
              </RouterLink>
            </li>
          </ul>
          <p class="field-help replan-policy">{{ t('replan.policy') }}</p>
        </UiCard>
      </aside>
    </div>

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
          <p id="replan-conflict-body" class="muted">{{ t('replan.conflictBody') }}</p>
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
          v-if="proposal.planId"
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
