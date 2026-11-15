<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type AvailabilityPut,
  type AvailabilityRule,
  type GoalSummary,
  type PlanCreate,
  type Task,
} from '../api';
import PlanAvailabilityStep from '../components/plan/PlanAvailabilityStep.vue';
import PlanCommitmentStep from '../components/plan/PlanCommitmentStep.vue';
import PlanFlowHeader from '../components/plan/PlanFlowHeader.vue';
import TaskScopePicker from '../components/plan/TaskScopePicker.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { rememberPlanFlow } from '../composables/planFlowMemory';
import { useGoogleIntegration } from '../composables/useGoogleCalendar';
import { PLAN_POLICIES, horizonOf, usePlanCreate, type PlanPolicy } from '../composables/usePlanCreate';
import { readCommitments, retryTransient } from '../composables/usePlannerRange';
import { usePickerGoals, usePickerTasks } from '../composables/usePlanScope';
import { policyLabel, policySummary } from '../domain/plan';
import { defaultHorizonDates } from '../domain/planDraft';
import {
  PICKER_GOAL_PAGES,
  PICKER_PAGE_SIZE,
  PICKER_TASK_PAGES,
  groupPickerTasks,
  isSchedulable,
  selectedTaskIdsInOrder,
  selectionSummary,
  type PickerGroup,
} from '../domain/planPicker';
import { addDaysToDate, localDateOf, todayInZone, zonedWallClockToInstant } from '../domain/time';
import { t, tp } from '../i18n';
import { browserTimeZone, formatCivilDateRange, formatNumber } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { useLayoutNow } from '../layout/now';
import { ownerFenced, runOwnerBound, useOwnerKey, waitStep, type OwnerSteps } from '../session/ownerBound';
import { useOfflineStore } from '../stores/offline';

/**
 * 계획 세우기 · 일정안 만들기 (HOLO-03A): what goes into the three schedules.
 *
 * It answers three things, each only when it has to be asked:
 *   무엇을     the tasks — a plan's own (`?goalId`), ones picked elsewhere
 *              (`?taskIds`), or picked here, grouped by the plan they belong to;
 *   언제       the hours the owner can work. Asked right here when none are
 *              set (FLOW §2: nobody is sent to a settings screen to get
 *              ready), and saved with the same press that makes the plan;
 *   고정된 일정  offered, never required, when the owner has no 약속.
 * The period and the ways of laying the work out have good defaults and stay
 * folded under "기간과 방식".
 *
 * The one filled button is 일정안 만들기: the next step of the flow.
 */
const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const owner = useOwnerKey();
const now = useLayoutNow();
const planCreate = usePlanCreate();
const actions = new ActionStore();

// ── What came with the address ─────────────────────────────────────────
function queryText(name: string): string | null {
  const value = route.query[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const goalId = computed(() => queryText('goalId'));
const sessionId = computed(() => queryText('session'));
const queryTaskIds = computed(() => {
  const value = route.query['taskIds'];
  const parts = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return parts
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
});
const hasGivenScope = computed(() => goalId.value !== null || queryTaskIds.value.length > 0);

// ── Lookups ────────────────────────────────────────────────────────────
const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability(),
});
const tasksQuery = usePickerTasks();
const goalsQuery = usePickerGoals();
const google = useGoogleIntegration();

const availability = computed(() => availabilityQuery.data.value ?? null);
const timeZone = computed(() => availability.value?.timeZone ?? browserTimeZone());
const today = computed(() => todayInZone(timeZone.value, now.value));

const tasks = computed<readonly Task[]>(() => tasksQuery.data.value?.items ?? []);
const goals = computed<readonly GoalSummary[]>(() => goalsQuery.data.value?.items ?? []);
const tasksCapped = computed(() => tasksQuery.data.value?.truncated === true);
const goalsCapped = computed(() => goalsQuery.data.value?.truncated === true);
/** Grouping waits for the goals, unless they failed: then everything is "기타 작업". */
const pickerLoading = computed(() => tasksQuery.isPending.value || goalsQuery.isPending.value);
const groups = computed<PickerGroup[]>(() => groupPickerTasks(goals.value, tasks.value));
const tasksById = computed(() => new Map(tasks.value.map((task) => [task.id, task])));

/** The `?goalId` scope's goal, once the goal list has it. */
const scopeGoal = computed(() => (goalId.value === null ? null : (goals.value.find((goal) => goal.id === goalId.value) ?? null)));

/** What the address asked for, by id: the given tasks, or the goal's tasks that are still open. */
const givenTaskIds = computed<string[]>(() => {
  if (queryTaskIds.value.length > 0) return queryTaskIds.value;
  const goal = scopeGoal.value;
  if (goal === null) return [];
  const open = new Set(tasks.value.filter(isSchedulable).map((task) => task.id));
  return goal.taskIds.filter((taskId) => open.has(taskId));
});

// ── What is picked ─────────────────────────────────────────────────────
/** The picker is on show: always without a given scope, on request with one. */
const picking = ref(false);
const selected = ref<ReadonlySet<string>>(new Set());
const showPicker = computed(() => !hasGivenScope.value || picking.value);
const selectedIds = computed(() => selectedTaskIdsInOrder(groups.value, selected.value));

/** "다른 작업 고르기": the picker opens with what the address asked for already picked. */
function openPicker(): void {
  selected.value = new Set(givenTaskIds.value);
  picking.value = true;
}

/** The scope a plan is made from: the goal itself while it is untouched, else the picked tasks. */
function buildScope(): PlanCreate['scope'] {
  if (!showPicker.value) {
    if (queryTaskIds.value.length > 0) return { taskIds: queryTaskIds.value };
    if (goalId.value !== null) return { goalId: goalId.value };
  }
  return { taskIds: selectedIds.value };
}

const scopeTaskIds = computed(() => (showPicker.value ? selectedIds.value : givenTaskIds.value));
const hasScope = computed(() => (showPicker.value ? selectedIds.value.length > 0 : hasGivenScope.value));

const scopeSummary = computed(() => {
  if (!showPicker.value) {
    if (queryTaskIds.value.length > 0) return tp('planScope.scopeTasks', queryTaskIds.value.length);
    const goal = scopeGoal.value;
    return goal === null
      ? t('planScope.scopeGoal')
      : tp('planScope.scopeGoalTitled', givenTaskIds.value.length, { title: goal.title });
  }
  const summary = selectionSummary(groups.value, selected.value);
  if (summary.tasks === 0) return t('planScope.scopeNone');
  if (summary.plans === 0) return tp('planScope.scopeSelectedOther', summary.tasks);
  return summary.other
    ? tp('planScope.scopeSelectedPlansOther', summary.tasks, { plans: summary.plans })
    : tp('planScope.scopeSelectedPlans', summary.tasks, { plans: summary.plans });
});

// ── 기간과 방식 ─────────────────────────────────────────────────────────
const startDate = ref('');
const endDate = ref('');
const dateTouched = ref(false);
const policies = ref<PlanPolicy[]>([...PLAN_POLICIES]);

/** The latest day anything in the scope is due on (the period reaches at least that far). */
const latestDueDate = computed<string | null>(() => {
  let latest: string | null = null;
  for (const taskId of scopeTaskIds.value) {
    const dueAt = tasksById.value.get(taskId)?.dueAt;
    if (dueAt === undefined || !Number.isFinite(Date.parse(dueAt))) continue;
    const date = localDateOf(dueAt, timeZone.value);
    if (latest === null || date > latest) latest = date;
  }
  return latest;
});

watch(
  [today, latestDueDate],
  ([day, due]) => {
    if (dateTouched.value) return;
    const dates = defaultHorizonDates(day, due);
    startDate.value = dates.start;
    endDate.value = dates.end;
  },
  { immediate: true },
);

const periodText = computed(() =>
  startDate.value.length === 0 || endDate.value.length === 0 ? '' : formatCivilDateRange(startDate.value, endDate.value),
);

function togglePolicy(policy: PlanPolicy): void {
  const next = new Set(policies.value);
  if (next.has(policy)) next.delete(policy);
  else next.add(policy);
  policies.value = PLAN_POLICIES.filter((item) => next.has(item));
}

// ── 언제 일할 수 있나요? ───────────────────────────────────────────────
/** The owner has no weekly rule at all: ask here. (Latched, so the card stays while it is being answered.) */
const askHours = ref(false);
const hoursDraft = ref<AvailabilityRule[]>([]);
const hoursError = ref<string | null>(null);

watch(
  availability,
  (value) => {
    if (value !== null && value.rules.length === 0) askHours.value = true;
  },
  { immediate: true },
);

const hoursMissing = computed(() => askHours.value && (availability.value?.rules.length ?? 0) === 0);

// ── 고정된 일정이 있나요? ──────────────────────────────────────────────
const commitmentRange = computed(() => {
  if (!availabilityQuery.isFetched.value && !availabilityQuery.isError.value) return null;
  return {
    from: zonedWallClockToInstant(today.value, 0, timeZone.value),
    to: zonedWallClockToInstant(addDaysToDate(today.value, 28), 0, timeZone.value),
  };
});
const commitmentsQuery = useQuery({
  queryKey: computed(() => ['plan-commitments', owner.value, commitmentRange.value?.from ?? 'none', commitmentRange.value?.to ?? 'none']),
  queryFn: ({ queryKey }) =>
    ownerFenced(String(queryKey[1]), async (binding) => {
      const page = await readCommitments(binding, { from: String(queryKey[2]), to: String(queryKey[3]) });
      return page.items.length;
    }),
  enabled: computed(() => commitmentRange.value !== null),
  retry: retryTransient,
});
/** Offered when the coming four weeks hold no 약속; it stays once shown (adding one does not take the card away). */
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

// ── 일정안 만들기 ───────────────────────────────────────────────────────
const busy = ref(false);
const error = ref<string | null>(null);

const blocker = computed<string | null>(() => {
  if (!hasScope.value) return t('planScope.needTasks');
  if (hoursMissing.value && hoursDraft.value.length === 0) return t('planScope.needHours');
  if (policies.value.length === 0) return t('planScope.policiesHelp');
  return null;
});

const canCreate = computed(
  () =>
    offline.mutationsEnabled &&
    !busy.value &&
    blocker.value === null &&
    startDate.value.length > 0 &&
    endDate.value.length > 0 &&
    !availabilityQuery.isPending.value,
);

/** Save the hours picked here. False: they were not saved (the card says why). */
function* saveHours(): OwnerSteps<boolean> {
  const current = availability.value;
  if (current === null) return false;
  const payload: AvailabilityPut = {
    timeZone: current.timeZone,
    rules: hoursDraft.value.map((rule) => ({ ...rule })),
    exceptions: current.exceptions.map((exception) => ({ ...exception })),
    prefs: { ...current.prefs },
  };
  const scope = 'plan:availability';
  const action = actions.begin(scope, payload, (left, right) => JSON.stringify(left) === JSON.stringify(right), current.version);
  try {
    const saved = yield* waitStep(plannerClient.putAvailability(action.payload, action.key, current.version));
    actions.settle(scope, action);
    queryClient.setQueryData(['availability'], saved);
    return true;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 412) {
      // Changed elsewhere meanwhile: the next try pins another version, so it is another action.
      actions.settle(scope, action);
      const fresh = yield* waitStep(plannerClient.getAvailability({ fresh: true }));
      queryClient.setQueryData(['availability'], fresh);
      hoursError.value = t('planScope.availability.conflict');
    } else {
      hoursError.value = errorMessage(cause, t('planScope.availability.saveError'));
    }
    return false;
  }
}

async function create(): Promise<void> {
  if (!canCreate.value) return;
  busy.value = true;
  error.value = null;
  hoursError.value = null;
  const input: PlanCreate = {
    scope: buildScope(),
    horizon: horizonOf(startDate.value, endDate.value, timeZone.value),
    policies: [...policies.value],
  };
  const session = sessionId.value;
  // Owner isolation (ADR-023): the hours are saved, the plan is made and the
  // comparison opens only for the owner who pressed the button.
  await runOwnerBound(
    function* (ownerScope) {
      if (hoursMissing.value) {
        const saved = yield* saveHours();
        if (!saved) return;
      }
      const plan = yield* planCreate.createSteps(input);
      if (plan === null) {
        error.value = planCreate.error.value;
        return;
      }
      // Unfinished business until it is confirmed (개요 and 계획 세우기 offer to go on).
      rememberPlanFlow(ownerScope.binding, { kind: 'plan', id: plan.id, sessionId: session ?? undefined });
      yield* ownerScope.wait(
        router.push({ name: 'plan-schedule', params: { id: plan.id }, ...(session === null ? {} : { query: { session } }) }),
      );
    },
    {
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}

function retryLoad(): void {
  void tasksQuery.refetch();
  void goalsQuery.refetch();
}

function onCommitmentSaved(): void {
  void commitmentsQuery.refetch();
}

const title = computed(() => scopeGoal.value?.title ?? t('planScope.title'));
/** The tasks are a plan's own (계획 세우기 made them): the earlier stages were gone through. */
const cameFromGoal = computed(() => goalId.value !== null || sessionId.value !== null);
const links = computed(() => (sessionId.value === null ? {} : { steps: `/plan/${sessionId.value}` }));
</script>

<template>
  <section class="page page--wide plan-page plan-scope" aria-labelledby="plan-heading" data-plan-stage="scope">
    <PlanFlowHeader
      :title="title"
      :lede="t('planScope.lede')"
      stage="schedule"
      :links="links"
      :skipped="cameFromGoal ? [] : ['goal', 'questions', 'steps']"
    />

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" class="offline-note" role="status">
      {{ t('planScope.offline') }}
    </UiBanner>
    <UiBanner v-if="error" tone="error" role="alert" data-plan-error>{{ error }}</UiBanner>

    <form class="plan-scope-grid" @submit.prevent="create">
      <div class="plan-scope-main">
        <UiCard class="plan-what" aria-labelledby="plan-what-title">
          <header class="card-header">
            <h2 id="plan-what-title" class="card-title"><UiIcon name="list" :size="18" />{{ t('planScope.what') }}</h2>
            <UiButton v-if="hasGivenScope && !picking" size="sm" variant="ghost" data-scope-change @click="openPicker">
              {{ t('planScope.scopeChange') }}
            </UiButton>
          </header>
          <p class="plan-scope-summary" role="status" data-scope-summary>{{ scopeSummary }}</p>

          <template v-if="showPicker">
            <template v-if="pickerLoading">
              <UiSkeleton variant="lines" :count="4" />
              <p class="visually-hidden" role="status">{{ t('planScope.loading') }}</p>
            </template>
            <UiBanner v-else-if="tasksQuery.isError.value" tone="error" role="alert">
              {{ t('planScope.loadError') }}
              <template #actions>
                <UiButton size="sm" icon="sync" @click="retryLoad">{{ t('common.retry') }}</UiButton>
              </template>
            </UiBanner>
            <UiEmptyState v-else-if="groups.length === 0" icon="inbox" :title="t('planScope.empty')" data-scope-empty>
              <p>{{ t('planScope.emptyBody') }}</p>
              <template #actions>
                <RouterLink class="btn btn--secondary" to="/tasks">{{ t('planScope.emptyCapture') }}</RouterLink>
                <RouterLink class="btn btn--ghost" to="/plan">{{ t('planScope.emptyGoal') }}</RouterLink>
              </template>
            </UiEmptyState>
            <template v-else>
              <p class="field-help">{{ t('planScope.pickerHelp') }}</p>
              <UiBanner v-if="goalsQuery.isError.value" tone="warn" inline data-testid="picker-goals-error">
                {{ t('planScope.goalsError') }}
              </UiBanner>
              <UiBanner v-if="tasksCapped" tone="warn" inline data-testid="picker-tasks-capped">
                {{ t('planScope.tasksCapped', { max: formatNumber(PICKER_PAGE_SIZE * PICKER_TASK_PAGES) }) }}
              </UiBanner>
              <UiBanner v-if="goalsCapped" tone="warn" inline data-testid="picker-goals-capped">
                {{ t('planScope.goalsCapped', { max: formatNumber(PICKER_PAGE_SIZE * PICKER_GOAL_PAGES) }) }}
              </UiBanner>
              <TaskScopePicker v-model:selected="selected" :groups="groups" :disabled="!offline.mutationsEnabled" />
            </template>
          </template>
          <ul v-else class="scope-list" data-scope-list>
            <li v-for="taskId in givenTaskIds" :key="taskId">
              {{ tasksById.get(taskId)?.title ?? t('planScope.taskFallback') }}
            </li>
          </ul>
        </UiCard>

        <template v-if="hoursMissing || askHours">
          <PlanAvailabilityStep v-if="hoursMissing" v-model:rules="hoursDraft" :disabled="!offline.mutationsEnabled || busy" />
          <UiBanner v-if="hoursError" tone="error" role="alert" data-plan-hours-error>{{ hoursError }}</UiBanner>
        </template>
        <UiBanner v-if="availabilityQuery.isError.value" tone="error" role="alert">
          {{ t('planScope.availability.loadError') }}
          <template #actions>
            <UiButton size="sm" icon="sync" @click="availabilityQuery.refetch()">{{ t('common.retry') }}</UiButton>
          </template>
        </UiBanner>

        <PlanCommitmentStep
          v-if="askCommitments"
          :time-zone="timeZone"
          :date="today"
          :offer-google="offerGoogle"
          @saved="onCommitmentSaved"
        />
      </div>

      <aside class="plan-scope-side">
        <UiCard class="plan-how" aria-labelledby="plan-how-title">
          <h2 id="plan-how-title" class="card-title"><UiIcon name="month" :size="18" />{{ t('planScope.how') }}</h2>
          <p class="plan-how-summary tabular" data-plan-how>
            <span>{{ periodText }}</span>
            <span>{{ t('planScope.howPolicies', { count: policies.length }) }}</span>
          </p>
          <details class="plan-how-options" data-plan-options-toggle>
            <summary>{{ t('planScope.howEdit') }}</summary>
            <div class="field-grid">
              <UiField id="plan-start" :label="t('planScope.start')">
                <input
                  id="plan-start"
                  v-model="startDate"
                  type="date"
                  :disabled="!offline.mutationsEnabled"
                  @change="dateTouched = true"
                />
              </UiField>
              <UiField id="plan-end" :label="t('planScope.end')">
                <input id="plan-end" v-model="endDate" type="date" :disabled="!offline.mutationsEnabled" @change="dateTouched = true" />
              </UiField>
            </div>
            <p class="field-help">{{ t('planScope.periodHelp', { timeZone }) }}</p>
            <fieldset class="plan-policies">
              <legend>{{ t('planScope.policies') }}</legend>
              <label v-for="policy in PLAN_POLICIES" :key="policy" class="plan-policy">
                <input
                  type="checkbox"
                  :checked="policies.includes(policy)"
                  :disabled="!offline.mutationsEnabled"
                  :data-policy="policy"
                  @change="togglePolicy(policy)"
                />
                <span class="plan-policy-text">
                  <span class="plan-policy-name">{{ policyLabel(policy) }}</span>
                  <span class="plan-policy-summary">{{ policySummary(policy) }}</span>
                </span>
              </label>
              <p class="field-help">{{ t('planScope.policiesHelp') }}</p>
            </fieldset>
          </details>

          <p v-if="blocker && offline.mutationsEnabled" id="plan-create-why" class="plan-how-blocker" data-plan-blocker>
            {{ blocker }}
          </p>
          <UiButton
            type="submit"
            variant="primary"
            size="lg"
            block
            icon="compare"
            :busy="busy"
            :disabled="!canCreate"
            :aria-describedby="blocker ? 'plan-create-why' : undefined"
            data-plan-create
          >
            {{ busy ? t('planScope.creating') : t('planScope.create') }}
          </UiButton>
        </UiCard>
      </aside>
    </form>
  </section>
</template>
