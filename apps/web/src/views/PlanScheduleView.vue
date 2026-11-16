<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type Plan,
  type PlanBlock,
  type PlanCandidate,
  type PlanVersion,
  type PreviewEditResponse,
  type Violation,
} from '../api';
import ExplanationList from '../components/ExplanationList.vue';
import ReplanRequestButton from '../components/ReplanRequestButton.vue';
import CandidateCards, { type CandidateCard } from '../components/plan/CandidateCards.vue';
import PlanCommitmentStep from '../components/plan/PlanCommitmentStep.vue';
import PlanFlowHeader from '../components/plan/PlanFlowHeader.vue';
import PlanNextStep from '../components/plan/PlanNextStep.vue';
import ProposalItemCard from '../components/plan/ProposalItemCard.vue';
import PlannerItemCard from '../components/planner/PlannerItemCard.vue';
import WeekGrid from '../components/planner/WeekGrid.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiDeadlineFlag from '../components/ui/UiDeadlineFlag.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { forgetPlanFlow } from '../composables/planFlowMemory';
import { useBlockLock } from '../composables/useBlockLock';
import { useGoogleIntegration } from '../composables/useGoogleCalendar';
import { useTaskDirectory } from '../composables/useOverview';
import { usePlannerCard } from '../composables/usePlannerCard';
import { readCommitments, readScheduleBlocks, retryTransient, usePlannerRange } from '../composables/usePlannerRange';
import { usePickerGoals } from '../composables/usePlanScope';
import { projectHue, weekRange } from '../domain/overview';
import { blockIndexFromPath, policyLabel, policySummary } from '../domain/plan';
import {
  candidateDifference,
  candidateFigures,
  candidateLead,
  candidateRisk,
  dailyLoad,
  firstStartAt,
  horizonDates,
  loadWindow,
  sameBlocks,
  withBlock,
  type BlockInterval,
} from '../domain/planDraft';
import { addDaysToDate, localDateOf, startOfWeek, todayInZone } from '../domain/time';
import { buildWeekGrid, type WeekItem } from '../domain/weekGrid';
import { t } from '../i18n';
import I18nT from '../i18n/I18nT';
import { diversityNoteItemsText, type DiversityNoteItem } from '../i18n/diversity';
import { formatCivilDate, formatCivilDateRange, formatDate } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { blockErrorText, diversityNoteText, type ServerText } from '../i18n/server';
import { useLayoutNow } from '../layout/now';
import { ownerFenced, runOwnerBound, useOwnerKey } from '../session/ownerBound';
import { useOfflineStore } from '../stores/offline';

/**
 * 계획 세우기 · 일정안 → 확정 (HOLO-03A). One plan, in one of two looks that
 * are never alike:
 *
 *   고르는 중   the candidates side by side as cards (what each is, when it
 *              ends, how the load falls, how risky), one picked, and that one
 *              drawn on the week grid as PROPOSALS — dashed outlines among
 *              what is already confirmed (lime), the 약속 (cyan) and the
 *              deadlines. A proposal can be moved or resized; every edit is
 *              checked by the server before it can be confirmed. The one
 *              filled button is 이 일정으로 확정.
 *   확정됨      the hand-off card (what today now holds, 첫 블록 시작) and the
 *              confirmed blocks on the grid as what they are: approved.
 *
 * Nothing is real until 확정: a candidate is only ever a proposal, and only
 * the owner's press approves it (`If-Match` on the availability version, one
 * `Idempotency-Key` per approval). A 412 means the hours or the 약속 changed
 * meanwhile; the plan is then made again before it can be confirmed.
 */
const props = defineProps<{ id: string }>();

const route = useRoute();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const owner = useOwnerKey();
const now = useLayoutNow();
const actions = new ActionStore();

const planId = computed(() => props.id);
const sessionId = computed(() => {
  const value = route.query['session'];
  return typeof value === 'string' && value.length > 0 ? value : null;
});

// ── Lookups ────────────────────────────────────────────────────────────
const planQuery = useQuery({
  queryKey: computed(() => ['plan', planId.value]),
  queryFn: () => plannerClient.getPlan(planId.value, { fresh: true }),
  enabled: computed(() => planId.value.length > 0),
  retry: retryTransient,
});
const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability(),
});
const directory = useTaskDirectory();
const goalsQuery = usePickerGoals();
const google = useGoogleIntegration();

const plan = computed<Plan | null>(() => planQuery.data.value ?? null);
const missing = computed(() => planQuery.error.value instanceof ApiError && planQuery.error.value.status === 404);
const timeZone = computed(() => plan.value?.timeZone ?? availabilityQuery.data.value?.timeZone ?? 'UTC');
const today = computed(() => todayInZone(timeZone.value, now.value));

/** The plan's goal, when it was made from one (계획 세우기): its name is the page's title. */
const goalTitle = computed(() => {
  const scope = plan.value?.scope;
  if (scope === undefined || !('goalId' in scope)) return null;
  return goalsQuery.data.value?.items.find((goal) => goal.id === scope.goalId)?.title ?? null;
});

// ── 고르는 중 / 확정됨 ─────────────────────────────────────────────────
/** A confirmed plan is being compared again ("다른 일정안으로 바꾸기"). */
const choosing = ref(false);
const active = computed(() => plan.value?.status === 'active' && plan.value.currentVersionId !== undefined);
const confirmed = computed(() => active.value && !choosing.value);

/** The blocks this plan put on the calendar when it was confirmed, over its whole period. */
const ownBlocksQuery = useQuery({
  queryKey: computed(() => ['plan-own-blocks', owner.value, planId.value, plan.value?.currentVersionId ?? 'none']),
  queryFn: ({ queryKey }) =>
    ownerFenced(String(queryKey[1]), async (binding) => {
      const current = plan.value;
      if (current === null || current.currentVersionId === undefined) return [];
      const page = await readScheduleBlocks(binding, { from: current.horizon.start, to: current.horizon.end });
      return page.items.filter((block) => block.planVersionId === current.currentVersionId && block.status !== 'superseded');
    }),
  enabled: computed(() => active.value),
  retry: retryTransient,
});
const approvedVersion = ref<PlanVersion | null>(null);
const ownBlocks = computed(() => {
  const fromApproval = approvedVersion.value;
  const blocks = fromApproval !== null && fromApproval.id === plan.value?.currentVersionId ? fromApproval.blocks : (ownBlocksQuery.data.value ?? []);
  return [...blocks].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
});

// ── The candidate that is picked, and the draft of its blocks ──────────
const selectedCandidateId = ref<string | null>(null);
watch(
  plan,
  (value) => {
    if (value === null) return;
    if (!value.candidates.some((candidate) => candidate.id === selectedCandidateId.value)) {
      selectedCandidateId.value = value.candidates[0]?.id ?? null;
    }
  },
  { immediate: true },
);
const selectedCandidate = computed<PlanCandidate | null>(
  () => plan.value?.candidates.find((candidate) => candidate.id === selectedCandidateId.value) ?? null,
);

const draftBlocks = ref<PlanBlock[]>([]);
const dirty = ref(false);
const previewResult = ref<PreviewEditResponse | null>(null);
const previewError = ref<string | null>(null);
const blockErrors = ref<Record<number, ServerText>>({});
const previewing = ref(false);
const approving = ref(false);
const regenerating = ref(false);
const message = ref('');
const actionError = ref<string | null>(null);
const stale = ref(false);
const approveViolations = ref<Violation[]>([]);

function resetDraft(): void {
  draftBlocks.value = selectedCandidate.value?.blocks.map((block) => ({ ...block })) ?? [];
  dirty.value = false;
  previewResult.value = null;
  previewError.value = null;
  blockErrors.value = {};
  approveViolations.value = [];
  previewing.value = false;
}

// A plan revision the draft was not made from (a lock, a regeneration, an
// edit elsewhere) starts the draft over: it could not be confirmed as it was.
watch([() => plan.value?.id, () => plan.value?.version, selectedCandidateId], () => resetDraft(), { immediate: true });

watch(selectedCandidateId, () => {
  stale.value = false;
  actionError.value = null;
});

const errorIndexes = computed(() =>
  Object.keys(blockErrors.value)
    .map((key) => Number(key))
    .filter((index) => Number.isFinite(index)),
);
const previewViolations = computed<Violation[]>(() => previewResult.value?.violations ?? []);
const hasProblems = computed(
  () => errorIndexes.value.length > 0 || previewViolations.value.length > 0 || approveViolations.value.length > 0,
);

// ── Locks of confirmed blocks (FU-71) ──────────────────────────────────
// A lock of this plan's block moves its revision, so the plan is re-read
// with the blocks. Edits and locks never run over each other (FU-86): while
// the draft is edited a lock waits, and while a lock is out an edit is held.
const lock = useBlockLock({
  refresh: () => Promise.all([rangeQuery.refetch(), planQuery.refetch(), active.value ? ownBlocksQuery.refetch() : null]),
});
const lockDisabled = computed(() => !offline.mutationsEnabled || dirty.value || approving.value);
const calendarEditable = computed(
  () => !confirmed.value && offline.mutationsEnabled && !approving.value && !regenerating.value && !lock.anyPending.value,
);
/** Shown (and announced) only to someone it concerns: after an edit was held while a lock was out. */
const lockHoldShown = ref(false);

function noticeLockHold(): void {
  if (lock.anyPending.value) lockHoldShown.value = true;
}

watch(lock.anyPending, (saving) => {
  if (!saving) lockHoldShown.value = false;
});

// ── The week on show ───────────────────────────────────────────────────
const weekStart = ref('');
/** The owner moved the week: the page no longer jumps to where the blocks are. */
let weekTouched = false;

function weekOfFirst(blocks: readonly BlockInterval[]): string | null {
  const first = firstStartAt(blocks);
  return first === null ? null : startOfWeek(localDateOf(first, timeZone.value));
}

/** Where the schedule on show begins: its own confirmed blocks, else the picked candidate, else the period's start. */
const homeWeek = computed(() => {
  const value = plan.value;
  if (value === null) return '';
  const shown = confirmed.value ? ownBlocks.value : (selectedCandidate.value?.blocks ?? []);
  return weekOfFirst(shown) ?? weekOfFirst(value.candidates[0]?.blocks ?? []) ?? startOfWeek(localDateOf(value.horizon.start, value.timeZone));
});

watch(
  homeWeek,
  (week) => {
    if (week.length > 0 && (!weekTouched || weekStart.value.length === 0)) weekStart.value = week;
  },
  { immediate: true },
);

const weekEnd = computed(() => (weekStart.value.length === 0 ? '' : addDaysToDate(weekStart.value, 6)));
const range = computed(() => (weekStart.value.length === 0 ? null : weekRange(weekStart.value, timeZone.value)));
const rangeQuery = usePlannerRange(range);
const rangeData = computed(() => rangeQuery.data.value ?? null);

const rangeText = computed(() =>
  weekStart.value.length === 0
    ? ''
    : formatCivilDateRange(weekStart.value, weekEnd.value, {
        weekday: false,
        year: weekStart.value.slice(0, 4) !== today.value.slice(0, 4),
      }),
);

function showWeek(start: string): void {
  if (start.length === 0 || start === weekStart.value) return;
  weekTouched = true;
  weekStart.value = start;
  message.value = t('planSchedule.weekAnnounce', { range: rangeText.value });
}

// ── The grid ───────────────────────────────────────────────────────────
const showEarly = ref(false);

const gridTasks = computed(() => rangeData.value?.tasks ?? [...(directory.data.value?.tasks.values() ?? [])]);

/** What is already confirmed. While candidates are compared, this plan's own confirmed blocks give way to them. */
const gridBlocks = computed(() => {
  const all = rangeData.value?.blocks ?? [];
  const own = plan.value?.currentVersionId;
  return confirmed.value || own === undefined ? all : all.filter((block) => block.planVersionId !== own);
});

const grid = computed(() =>
  buildWeekGrid({
    start: weekStart.value.length === 0 ? startOfWeek(today.value) : weekStart.value,
    timeZone: timeZone.value,
    today: today.value,
    nowMs: now.value,
    blocks: gridBlocks.value,
    commitments: rangeData.value?.commitments ?? [],
    tasks: gridTasks.value,
    showEarly: showEarly.value,
    proposals: confirmed.value
      ? []
      : draftBlocks.value.map((block, index) => ({ index, ...block, invalid: blockErrors.value[index] !== undefined })),
    availability: availabilityQuery.data.value ?? null,
  }),
);

const weekHasSchedule = computed(() =>
  grid.value.days.some((day) => (confirmed.value ? day.counts.block > 0 : day.counts.proposal > 0)),
);

// ── The detail card ────────────────────────────────────────────────────
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
// The item went away (another week, another candidate): so does its card.
watch(openItem, (item) => {
  if (item === null && card.openKey.value !== null) card.close();
});

const openProject = computed(() => {
  const projectId = openItem.value?.projectId ?? null;
  if (projectId === null) return null;
  const project = directory.data.value?.projects.get(projectId);
  if (project === undefined) return null;
  return { title: project.kind === 'inbox' ? t('nav.inbox') : project.title, hue: projectHue(project.id) };
});

function setCard(instance: Element | ComponentPublicInstance | null): void {
  const element: unknown = instance !== null && '$el' in instance ? instance.$el : instance;
  card.card.value = element instanceof HTMLElement ? element : null;
}

function refreshCalendar(): Promise<unknown> {
  return Promise.all([rangeQuery.refetch(), planQuery.refetch()]);
}

const taskNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const task of gridTasks.value) map[task.id] = task.title;
  return map;
});

// ── Editing the picked candidate ───────────────────────────────────────
function applyEdit(item: WeekItem, next: BlockInterval): void {
  if (item.proposalIndex === null) return;
  if (!calendarEditable.value) {
    noticeLockHold();
    return;
  }
  const edited = withBlock(draftBlocks.value, item.proposalIndex, next);
  // A block put back where it was is the schedule as it was made: nothing to check or to undo.
  if (sameBlocks(edited, selectedCandidate.value?.blocks ?? [])) {
    clearPreviewTimer();
    previewToken += 1;
    resetDraft();
  } else {
    draftBlocks.value = edited;
    dirty.value = true;
  }
  // The open card follows its block.
  if (card.openKey.value !== null) void nextTick(card.place);
}

function mapProblemErrors(errors: Array<{ path: string; message: string }> | undefined): Record<number, ServerText> {
  const mapped: Record<number, ServerText> = {};
  for (const error of errors ?? []) {
    const index = blockIndexFromPath(error.path);
    if (index !== null) mapped[index] = blockErrorText(error.message);
  }
  return mapped;
}

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewToken = 0;

function clearPreviewTimer(): void {
  if (previewTimer !== null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
}

watch(
  draftBlocks,
  () => {
    if (!dirty.value) return;
    blockErrors.value = {};
    previewError.value = null;
    clearPreviewTimer();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      void runPreview();
    }, 350);
  },
  { deep: true },
);

/** Ask the server whether the edited blocks still hold (the same validator that guards 확정). */
async function runPreview(): Promise<void> {
  const activePlan = plan.value;
  const candidate = selectedCandidate.value;
  if (activePlan === null || candidate === null || !dirty.value) return;
  // The debounce can fire after the connection drops; never queue a mutation offline.
  if (!offline.mutationsEnabled) {
    previewing.value = false;
    return;
  }
  const token = ++previewToken;
  previewing.value = true;
  previewError.value = null;
  const blocks = draftBlocks.value.map((block) => ({ ...block }));
  const scope = `plan:${activePlan.id}:${candidate.id}:preview`;
  const action = actions.begin(scope, { blocks }, (left, right) => JSON.stringify(left) === JSON.stringify(right), activePlan.version);
  // Owner isolation (ADR-023): preview, approve and regenerate run under the
  // owner who started them; after a user switch their answers change nothing.
  await runOwnerBound(
    function* (ownerScope) {
      try {
        const result = yield* ownerScope.wait(
          plannerClient.previewCandidateEdit(activePlan.id, candidate.id, blocks, action.key, activePlan.version),
        );
        if (token !== previewToken) return;
        previewResult.value = result;
        blockErrors.value = {};
        approveViolations.value = [];
      } catch (cause) {
        if (token !== previewToken) return;
        if (cause instanceof ApiError && cause.status === 422 && cause.code === 'validation_failed') {
          blockErrors.value = mapProblemErrors(cause.problem?.errors);
          previewResult.value = null;
          previewError.value = Object.keys(blockErrors.value).length === 0 ? errorMessage(cause) : null;
        } else if (cause instanceof ApiError && cause.status === 422 && cause.code === 'constraint_violation') {
          previewResult.value = { feasible: false, violations: cause.problem?.violations ?? [], deficitMin: 0 };
          blockErrors.value = {};
        } else {
          previewResult.value = null;
          previewError.value = errorMessage(cause, t('planSchedule.validateError'));
        }
      }
    },
    {
      onSettled: () => {
        if (token === previewToken) previewing.value = false;
      },
    },
  );
}

function resetEdits(): void {
  resetDraft();
  message.value = t('planSchedule.editsReset');
}

function selectCandidate(id: string): void {
  selectedCandidateId.value = id;
}

// ── 확정 ────────────────────────────────────────────────────────────────
const nextStep = ref<InstanceType<typeof PlanNextStep> | null>(null);

async function approve(): Promise<void> {
  const activePlan = plan.value;
  const candidate = selectedCandidate.value;
  if (activePlan === null || candidate === null) return;
  if (!offline.mutationsEnabled || approving.value) return;
  approving.value = true;
  actionError.value = null;
  approveViolations.value = [];
  message.value = '';
  const edited = dirty.value ? draftBlocks.value.map((block) => ({ ...block })) : undefined;
  const scope = `plan:${activePlan.id}:${candidate.id}:approve`;
  const action = actions.begin(
    scope,
    { editedBlocks: edited ?? null },
    (left, right) => JSON.stringify(left) === JSON.stringify(right),
    activePlan.availabilityVersion,
  );
  await runOwnerBound(
    function* (ownerScope) {
      try {
        const version = yield* ownerScope.wait(
          plannerClient.approveCandidate(activePlan.id, candidate.id, action.key, activePlan.availabilityVersion, edited),
        );
        actions.settle(scope, action);
        approvedVersion.value = version;
        dirty.value = false;
        stale.value = false;
        choosing.value = false;
        weekTouched = false;
        card.close();
        // Confirmed: no longer unfinished business (planFlowMemory).
        forgetPlanFlow(ownerScope.binding, 'plan', activePlan.id);
        // What today, the planner and 개요 show has changed.
        void queryClient.invalidateQueries({ queryKey: ['today'] });
        void queryClient.invalidateQueries({ queryKey: ['today-schedule-blocks'] });
        yield* ownerScope.wait(Promise.all([planQuery.refetch(), queryClient.invalidateQueries({ queryKey: ['planner-range'] })]));
        yield* ownerScope.wait(nextTick());
        nextStep.value?.$el?.focus?.();
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 412 && cause.code === 'availability_changed') {
          actions.settle(scope, action);
          stale.value = true;
          yield* ownerScope.wait(planQuery.refetch());
          return;
        }
        if (cause instanceof ApiError && cause.status === 422 && cause.code === 'constraint_violation') {
          approveViolations.value = cause.problem?.violations ?? [];
          actionError.value = errorMessage(cause);
          return;
        }
        if (cause instanceof ApiError && cause.status === 422 && cause.code === 'validation_failed') {
          blockErrors.value = mapProblemErrors(cause.problem?.errors);
          actionError.value = Object.keys(blockErrors.value).length === 0 ? errorMessage(cause) : t('planSchedule.outsidePlan');
          return;
        }
        actionError.value = errorMessage(cause, t('planSchedule.approveError'));
      }
    },
    {
      onSettled: () => {
        approving.value = false;
      },
    },
  );
}

/** Make the candidates again from the hours and the 약속 as they are now. */
async function regenerate(): Promise<void> {
  const activePlan = plan.value;
  if (activePlan === null || regenerating.value || !offline.mutationsEnabled) return;
  regenerating.value = true;
  actionError.value = null;
  const scope = `plan:${activePlan.id}:regenerate`;
  const action = actions.begin(scope, { planId: activePlan.id }, (left, right) => left.planId === right.planId, activePlan.version);
  await runOwnerBound(
    function* (ownerScope) {
      try {
        const updated = yield* ownerScope.wait(plannerClient.regeneratePlan(activePlan.id, action.key, activePlan.version));
        actions.settle(scope, action);
        queryClient.setQueryData(['plan', activePlan.id], updated);
        stale.value = false;
        message.value = t('planSchedule.regenerated');
        resetDraft();
      } catch (cause) {
        actionError.value = errorMessage(cause, t('planSchedule.regenerateError'));
        if (cause instanceof ApiError && cause.status === 412) yield* ownerScope.wait(planQuery.refetch());
      }
    },
    {
      onSettled: () => {
        regenerating.value = false;
      },
    },
  );
}

function chooseAgain(): void {
  choosing.value = true;
  weekTouched = false;
  card.close();
}

function backToConfirmed(): void {
  resetDraft();
  choosing.value = false;
  weekTouched = false;
  card.close();
}

watch(
  () => offline.mutationsEnabled,
  (enabled) => {
    if (enabled) return;
    // Drop queued and in-flight preview work; a stale response must not land.
    clearPreviewTimer();
    previewToken += 1;
    previewing.value = false;
  },
);

onUnmounted(() => {
  previewToken += 1;
  clearPreviewTimer();
});

// ── The cards ──────────────────────────────────────────────────────────
/** A strip never holds more days than read as bars. */
const STRIP_MAX_DAYS = 28;

function noteFor(candidate: {
  readonly diversityNote?: string | undefined;
  readonly diversityNoteItems?: readonly DiversityNoteItem[] | undefined;
}): ServerText | null {
  const coded = diversityNoteItemsText(candidate.diversityNoteItems);
  if (coded !== null) return { text: coded, translated: true };
  const note = candidate.diversityNote;
  return note === undefined || note.length === 0 ? null : diversityNoteText(note);
}

const comparison = computed(() => {
  const value = plan.value;
  if (value === null) return { cards: [] as CandidateCard[], from: null, to: null, max: 0 };
  const dates = horizonDates(value.horizon, value.timeZone);
  const figures = value.candidates.map((candidate) => candidateFigures(candidate, dates, value.timeZone));
  const loads = value.candidates.map((candidate) => dailyLoad(candidate.blocks, dates, value.timeZone));
  const window = loadWindow(loads, dates);
  const to = Math.min(window.to, window.from + STRIP_MAX_DAYS - 1);
  const pickedIndex = value.candidates.findIndex((candidate) => candidate.id === selectedCandidateId.value);
  const picked = figures[pickedIndex];
  const cards = value.candidates.map((candidate, index): CandidateCard => {
    const own = figures[index] ?? candidateFigures(candidate, dates, value.timeZone);
    return {
      id: candidate.id,
      policy: candidate.policy,
      label: policyLabel(candidate.policy),
      summary: policySummary(candidate.policy),
      figures: own,
      risk: candidateRisk(own),
      lead: candidateLead(index, figures),
      load: (loads[index] ?? []).slice(window.from, to + 1),
      difference: picked === undefined || index === pickedIndex ? null : candidateDifference(own, picked),
      note: noteFor(candidate),
    };
  });
  return {
    cards,
    from: dates[window.from] ?? null,
    to: dates[to] ?? null,
    max: Math.max(0, ...loads.flatMap((load) => load.slice(window.from, to + 1))),
  };
});

const pickedCard = computed(() => comparison.value.cards.find((item) => item.id === selectedCandidateId.value) ?? null);

/**
 * Why the picked candidate cannot be confirmed as it stands: it leaves work
 * unplaced, and the server refuses such a schedule. Said before the button is
 * pressed — unless the blocks were edited and the server found the result
 * holds (the check that guards 확정 itself).
 */
const cannotConfirm = computed(() => {
  const candidate = selectedCandidate.value;
  if (candidate === null || candidate.feasible) return false;
  return !(dirty.value && previewResult.value?.feasible === true);
});
const pickedLine = computed(() => {
  const picked = pickedCard.value;
  if (picked === null) return '';
  return picked.figures.finishDate === null
    ? t('planSchedule.pickedNoEnd', { policy: picked.label })
    : t('planSchedule.picked', { policy: picked.label, date: formatCivilDate(picked.figures.finishDate) });
});

// ── 고정된 일정이 있나요? ──────────────────────────────────────────────
// Offered (never required) while candidates are compared and the plan's
// period holds no 약속 at all. One added here changes what the candidates
// were made from, so they are made again before 확정.
const commitmentsQuery = useQuery({
  queryKey: computed(() => ['plan-commitments', owner.value, plan.value?.horizon.start ?? 'none', plan.value?.horizon.end ?? 'none']),
  queryFn: ({ queryKey }) =>
    ownerFenced(String(queryKey[1]), async (binding) => {
      const page = await readCommitments(binding, { from: String(queryKey[2]), to: String(queryKey[3]) });
      return page.items.length;
    }),
  enabled: computed(() => plan.value !== null && !active.value),
  retry: retryTransient,
});
const askCommitments = ref(false);
watch(
  () => commitmentsQuery.data.value,
  (count) => {
    if (count === 0) askCommitments.value = true;
  },
  { immediate: true },
);
const offerGoogle = computed(() => {
  const status = google.data.value?.status;
  return status === 'disconnected' || status === 'needs_reauth';
});

function onCommitmentSaved(): void {
  stale.value = true;
  void rangeQuery.refetch();
}

// ── Head ───────────────────────────────────────────────────────────────
const title = computed(() => goalTitle.value ?? t('planSchedule.title'));
const lede = computed(() => {
  const value = plan.value;
  if (value === null) return null;
  return confirmed.value
    ? t('planSchedule.ledeConfirmed')
    : t('planSchedule.lede', { date: formatDate(value.createdAt, value.timeZone) });
});
const links = computed(() => (sessionId.value === null ? {} : { steps: `/plan/${sessionId.value}` }));
/** The plan is a goal's (계획 세우기 made its tasks): the earlier stages were gone through. */
const cameFromGoal = computed(() => {
  const scope = plan.value?.scope;
  return sessionId.value !== null || (scope !== undefined && 'goalId' in scope);
});
const scopeLink = computed(() => {
  const scope = plan.value?.scope;
  if (scope === undefined) return { name: 'plan-scope' };
  const query: Record<string, string> = 'goalId' in scope ? { goalId: scope.goalId } : { taskIds: scope.taskIds.join(',') };
  if (sessionId.value !== null) query['session'] = sessionId.value;
  return { name: 'plan-scope', query };
});

const firstOwn = computed(() => {
  const block = ownBlocks.value[0];
  return block === undefined ? null : { title: taskNames.value[block.taskId] ?? null, startAt: block.startAt };
});
</script>

<template>
  <section
    class="page page--wide plan-page plan-schedule"
    aria-labelledby="plan-heading"
    :data-plan-stage="confirmed ? 'confirmed' : 'schedule'"
  >
    <PlanFlowHeader
      :title="title"
      :lede="lede"
      :stage="confirmed ? 'confirmed' : 'schedule'"
      :finished="confirmed"
      :links="links"
      :skipped="cameFromGoal ? [] : ['goal', 'questions', 'steps']"
    >
      <template #actions>
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
      </template>
    </PlanFlowHeader>

    <p class="visually-hidden" role="status" aria-live="polite" data-plan-status>{{ message }}</p>
    <UiBanner v-if="actionError" tone="error" role="alert" data-plan-error>{{ actionError }}</UiBanner>
    <UiBanner v-if="lock.error.value" tone="error" role="alert" class="block-lock-error">{{ lock.error.value }}</UiBanner>

    <div v-if="planQuery.isLoading.value" data-plan-loading>
      <p class="visually-hidden" role="status">{{ t('planSchedule.loading') }}</p>
      <div class="plan-options plan-options--loading"><UiSkeleton variant="card" :count="3" :lines="4" /></div>
    </div>
    <UiCard v-else-if="missing" class="plan-missing" data-plan-missing>
      <UiEmptyState icon="compare" :title="t('planSchedule.missing')">
        <p>{{ t('planSchedule.missingBody') }}</p>
        <template #actions>
          <RouterLink class="btn btn--secondary" to="/plan">{{ t('planSchedule.startOver') }}</RouterLink>
        </template>
      </UiEmptyState>
    </UiCard>
    <UiBanner v-else-if="planQuery.isError.value || plan === null" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('planSchedule.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="planQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <template v-else>
      <!-- 확정됨: the hand-off. -->
      <PlanNextStep
        v-if="confirmed"
        ref="nextStep"
        :block-count="ownBlocks.length"
        :first="firstOwn"
        :time-zone="timeZone"
        tabindex="-1"
      />

      <!-- 고르는 중: the candidates and the one filled button. -->
      <template v-else>
        <CandidateCards
          :cards="comparison.cards"
          :selected-id="selectedCandidateId"
          :strip-from="comparison.from"
          :strip-to="comparison.to"
          :load-max="comparison.max"
          :disabled="approving || regenerating"
          @select="selectCandidate"
        />

        <UiBanner v-if="stale" tone="conflict" class="conflict-panel" role="alert" data-plan-stale>
          <p><strong>{{ t('planSchedule.staleTitle') }}</strong> {{ t('planSchedule.staleBody') }}</p>
        </UiBanner>

        <UiBanner v-else-if="cannotConfirm" id="plan-cannot-confirm" tone="warn" data-plan-cannot-confirm>
          {{ t('planSchedule.cannotConfirm') }}
        </UiBanner>

        <div class="plan-confirm" data-plan-confirm>
          <p class="plan-confirm-pick" data-plan-picked>{{ pickedLine }}</p>
          <div class="plan-confirm-actions">
            <UiButton v-if="active" variant="ghost" data-plan-back @click="backToConfirmed">
              {{ t('planSchedule.backToConfirmed') }}
            </UiButton>
            <RouterLink class="btn btn--ghost" :to="scopeLink" data-plan-change-scope>{{ t('planSchedule.changeScope') }}</RouterLink>
            <UiButton
              v-if="stale"
              variant="primary"
              icon="sync"
              :busy="regenerating"
              :disabled="!offline.mutationsEnabled || regenerating"
              data-plan-regenerate
              @click="regenerate"
            >
              {{ regenerating ? t('planSchedule.regenerating') : t('planSchedule.regeneratePlan') }}
            </UiButton>
            <template v-else>
              <UiButton
                variant="ghost"
                icon="sync"
                :busy="regenerating"
                :disabled="!offline.mutationsEnabled || regenerating || approving"
                data-plan-regenerate
                @click="regenerate"
              >
                {{ regenerating ? t('planSchedule.regenerating') : t('planSchedule.regenerate') }}
              </UiButton>
              <UiButton
                variant="primary"
                icon="check"
                :busy="approving"
                :disabled="
                  !offline.mutationsEnabled || approving || previewing || regenerating || selectedCandidate === null || cannotConfirm
                "
                :aria-describedby="cannotConfirm ? 'plan-cannot-confirm' : undefined"
                data-plan-approve
                @click="approve"
              >
                {{ approving ? t('planSchedule.approving') : t('planSchedule.approve') }}
              </UiButton>
            </template>
          </div>
        </div>
      </template>

      <!-- The week: proposals among what is confirmed, or the confirmed schedule itself. -->
      <section class="plan-week" aria-labelledby="plan-week-title" :data-week-start="weekStart">
        <header class="plan-week-head">
          <div class="plan-week-heading">
            <h2 id="plan-week-title" class="plan-week-title tabular">
              {{ confirmed ? t('planSchedule.weekConfirmed', { range: rangeText }) : t('planSchedule.week', { range: rangeText }) }}
            </h2>
            <UiBadge v-if="!confirmed" :tone="dirty ? 'warn' : 'neutral'" data-plan-draft-state>
              {{ dirty ? t('planSchedule.edited') : t('planSchedule.asMade') }}
            </UiBadge>
          </div>
          <div class="plan-week-tools">
            <UiButton v-if="!confirmed" size="sm" variant="ghost" :disabled="!dirty || approving" data-plan-reset @click="resetEdits">
              {{ t('planSchedule.resetEdits') }}
            </UiButton>
            <div class="planner-nav" role="group" :aria-label="t('planSchedule.weekNav')">
              <UiButton
                size="sm"
                icon="chevron-left"
                icon-only
                :aria-label="t('planSchedule.previousWeek')"
                data-plan-week-previous
                @click="showWeek(addDaysToDate(weekStart, -7))"
              />
              <UiButton size="sm" :disabled="weekStart === homeWeek" data-plan-week-home @click="showWeek(homeWeek)">
                {{ t('planSchedule.firstWeek') }}
              </UiButton>
              <UiButton
                size="sm"
                icon="chevron-right"
                icon-only
                :aria-label="t('planSchedule.nextWeek')"
                data-plan-week-next
                @click="showWeek(addDaysToDate(weekStart, 7))"
              />
            </div>
          </div>
        </header>

        <p v-if="rangeData !== null && !weekHasSchedule" class="planner-note" data-plan-week-empty>
          {{ t('planSchedule.weekEmpty') }}
        </p>

        <div class="plan-week-frame">
          <WeekGrid
            ref="gridView"
            :grid="grid"
            :time-zone="timeZone"
            :label="confirmed ? t('planSchedule.weekConfirmed', { range: rangeText }) : t('planSchedule.week', { range: rangeText })"
            :loading="rangeData === null && !rangeQuery.isError.value"
            :open-key="card.openKey.value"
            :show-early="showEarly"
            :editable="calendarEditable"
            :proposal-described-by="lockHoldShown ? 'plan-lock-hold' : undefined"
            :open-at="confirmed ? 'now' : 'proposal'"
            :scroll-key="`${selectedCandidateId ?? ''}:${confirmed ? 'c' : 'p'}`"
            @open="(item, element) => card.toggle(item.key, element)"
            @toggle-early="showEarly = !showEarly"
            @edit="applyEdit"
            @edit-blocked="noticeLockHold"
          >
            <template #card>
              <ProposalItemCard
                v-if="openItem && openItem.kind === 'proposal'"
                :ref="setCard"
                :key="openItem.key"
                :item="openItem"
                :time-zone="timeZone"
                :project="openProject"
                :side="card.side.value"
                :style="card.style.value"
                :editable="calendarEditable"
                :blocked-reason="lock.anyPending.value ? t('planSchedule.lockHold') : null"
                :problem="openItem.proposalIndex === null ? null : (blockErrors[openItem.proposalIndex]?.text ?? null)"
                @edit="(next) => openItem && applyEdit(openItem, next)"
                @close="(restoreFocus) => card.close({ restoreFocus })"
              />
              <PlannerItemCard
                v-else-if="openItem"
                :ref="setCard"
                :key="openItem.key"
                :item="openItem"
                :time-zone="timeZone"
                :now-ms="now"
                :project="openProject"
                :refresh="refreshCalendar"
                :side="card.side.value"
                :style="card.style.value"
                :lock="lock"
                :lock-disabled="lockDisabled"
                :lock-note="dirty ? t('planSchedule.lockWhileEditing') : null"
                @close="(restoreFocus) => card.close({ restoreFocus })"
              />
            </template>
          </WeekGrid>
          <!-- Always rendered (a live region must exist before its text changes);
               it floats over the grid, so showing it moves nothing (FU-86F). -->
          <p
            id="plan-lock-hold"
            class="block-lock-saving glass"
            :class="{ 'block-lock-saving--shown': lockHoldShown }"
            role="status"
            aria-live="polite"
          >
            <UiIcon v-if="lockHoldShown" name="info" :size="16" />
            <span>{{ lockHoldShown ? t('planSchedule.lockHold') : '' }}</span>
          </p>
        </div>

        <ul class="planner-legend" :aria-label="t('planSchedule.legend')" data-plan-legend>
          <li v-if="!confirmed">
            <span class="planner-swatch planner-swatch--proposal" aria-hidden="true"></span>{{ t('planSchedule.legendProposal') }}
          </li>
          <li><span class="planner-swatch planner-swatch--block" aria-hidden="true"></span>{{ t('planSchedule.legendBlock') }}</li>
          <li>
            <span class="planner-swatch planner-swatch--commitment" aria-hidden="true"></span>{{ t('planSchedule.legendCommitment') }}
          </li>
          <li><UiDeadlineFlag :size="13" />{{ t('planSchedule.legendDeadline') }}</li>
          <li><span class="planner-swatch planner-swatch--work" aria-hidden="true"></span>{{ t('planSchedule.legendAvailable') }}</li>
          <li><span class="planner-swatch planner-swatch--focus" aria-hidden="true"></span>{{ t('planSchedule.legendFocus') }}</li>
          <li><span class="planner-swatch planner-swatch--off" aria-hidden="true"></span>{{ t('planSchedule.legendOff') }}</li>
        </ul>
        <p v-if="!confirmed" class="plan-week-hint">
          <UiIcon name="info" :size="16" />
          <!-- A finger does not drag a block (WeekGrid): the phone is told the way that works there. -->
          <span class="plan-hint-fine">{{ t('planSchedule.hint') }}</span>
          <span class="plan-hint-coarse" data-plan-hint-touch>{{ t('planSchedule.hintTouch') }}</span>
        </p>
      </section>

      <template v-if="!confirmed">
        <div class="plan-problems" aria-live="polite" data-plan-problems>
          <p v-if="previewing" class="loading-row">{{ t('planSchedule.validating') }}</p>
          <UiBanner v-if="previewError" tone="error" role="alert">{{ previewError }}</UiBanner>
          <UiBanner v-if="hasProblems" tone="warn" :title="t('planSchedule.problems')" data-plan-violations>
            <ul v-if="errorIndexes.length > 0" class="violation-list">
              <li v-for="index in errorIndexes" :key="`block-error-${index}`" :data-block-error="index">
                <I18nT keypath="planSchedule.blockProblem" :params="{ index: index + 1 }">
                  <template #message>
                    <span :lang="blockErrors[index]?.translated ? undefined : 'en'">{{ blockErrors[index]?.text }}</span>
                  </template>
                </I18nT>
              </li>
            </ul>
            <ExplanationList :violations="previewViolations" :time-zone="timeZone" :task-names="taskNames" />
            <ExplanationList :violations="approveViolations" :time-zone="timeZone" :task-names="taskNames" />
          </UiBanner>
          <p v-else-if="dirty && !previewing && previewResult?.feasible" class="plan-valid" data-plan-valid>
            <UiIcon name="check-circle" :size="16" />{{ t('planSchedule.valid') }}
          </p>
        </div>

        <div class="plan-after">
          <UiCard v-if="selectedCandidate && selectedCandidate.explanation.length > 0" class="plan-why" data-plan-why>
            <ExplanationList
              :lines="selectedCandidate.explanation"
              :items="selectedCandidate.explanationItems"
              :time-zone="timeZone"
              :task-names="taskNames"
              :title="t('planSchedule.why')"
              open
            />
          </UiCard>
          <PlanCommitmentStep
            v-if="askCommitments && !active"
            :time-zone="timeZone"
            :date="today"
            :offer-google="offerGoogle"
            @saved="onCommitmentSaved"
          />
        </div>
      </template>

      <div v-else class="plan-confirmed-actions" data-plan-confirmed-actions>
        <UiButton variant="ghost" icon="compare" :disabled="!offline.mutationsEnabled" data-plan-choose @click="chooseAgain">
          {{ t('planSchedule.choose') }}
        </UiButton>
        <ReplanRequestButton :plan-id="plan.id" variant="ghost" />
      </div>
    </template>
  </section>
</template>
