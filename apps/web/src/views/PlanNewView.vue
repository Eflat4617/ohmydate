<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  ActionStore,
  plannerClient,
  type GoalSummary,
  type PlanCreate,
  type Task,
} from '../api';
import { addDaysToDate, todayInZone, zonedWallClockToInstant } from '../domain/time';
import {
  PICKER_GOAL_PAGES,
  PICKER_PAGE_SIZE,
  PICKER_TASK_PAGES,
  defaultGroupOpen,
  groupPickerTasks,
  groupSelection,
  isSchedulable,
  selectedCount,
  selectedTaskIdsInOrder,
  selectionSummary,
  toggleGroup,
  type PickerGroup,
} from '../domain/planPicker';
import { useOfflineStore } from '../stores/offline';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { policyLabel } from '../domain/plan';
import { formatNumber } from '../i18n/format';
import { t, tp } from '../i18n';
import { errorMessage } from '../i18n/problem';
import { collectPages, ownerFenced, runOwnerBound, useOwnerKey } from '../session/ownerBound';
import { keyOwner, retryFenced } from '../composables/notes';

const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const actions = new ActionStore();
const owner = useOwnerKey();

const busy = ref(false);
const error = ref<string | null>(null);
const selected = ref<ReadonlySet<string>>(new Set());
/** Groups the user opened or closed; the rest follow `defaultGroupOpen`. */
const openOverrides = ref<Readonly<Record<string, boolean>>>({});
const startDate = ref('');
const endDate = ref('');
const policies = ref<NonNullable<PlanCreate['policies']>>(['front_loaded', 'balanced', 'focus_blocked']);
const dateTouched = ref(false);

const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability(),
});

const tasksQuery = useQuery({
  queryKey: computed(() => ['tasks', owner.value, 'plan-picker'] as const),
  queryFn: ({ queryKey }) =>
    ownerFenced(keyOwner(queryKey), (binding) =>
      collectPages<Task>(
        binding,
        (cursor, signal) =>
          plannerClient.listTasks({ limit: PICKER_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }), signal }),
        { maxPages: PICKER_TASK_PAGES },
      ),
    ),
  retry: retryFenced(),
});

const goalsQuery = useQuery({
  queryKey: computed(() => ['goals', owner.value, 'plan-picker'] as const),
  queryFn: ({ queryKey }) =>
    ownerFenced(keyOwner(queryKey), (binding) =>
      collectPages<GoalSummary>(
        binding,
        (cursor, signal) =>
          plannerClient.listGoals({ limit: PICKER_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }), signal }),
        { maxPages: PICKER_GOAL_PAGES },
      ),
    ),
  retry: retryFenced(),
});

const timeZone = computed(() => availabilityQuery.data.value?.timeZone ?? 'UTC');

watch(
  timeZone,
  (zone) => {
    if (dateTouched.value) return;
    const today = todayInZone(zone);
    startDate.value = today;
    endDate.value = addDaysToDate(today, 13);
  },
  { immediate: true },
);

const tasks = computed<Task[]>(() => tasksQuery.data.value?.items ?? []);
const goals = computed<GoalSummary[]>(() => goalsQuery.data.value?.items ?? []);
const tasksCapped = computed(() => tasksQuery.data.value?.truncated === true);
const goalsCapped = computed(() => goalsQuery.data.value?.truncated === true);
/** Grouping waits for the goals, unless they failed: then everything is "기타 작업". */
const pickerLoading = computed(() => tasksQuery.isPending.value || goalsQuery.isPending.value);

const groups = computed<PickerGroup[]>(() => groupPickerTasks(goals.value, tasks.value));

const goalId = computed(() => {
  const value = route.query['goalId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
});

const queryTaskIds = computed(() => {
  const value = route.query['taskIds'];
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
  return [];
});

const usingQueryScope = computed(() => goalId.value !== null || queryTaskIds.value.length > 0);

const taskNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const task of tasks.value) map[task.id] = task.title;
  return map;
});

/** The ?goalId scope's goal, once the goal list has it. */
const scopeGoal = computed(() =>
  goalId.value === null ? null : (goals.value.find((goal) => goal.id === goalId.value) ?? null),
);

/** What a locked scope (?taskIds or ?goalId) will plan, by name. */
const lockedScopeTaskIds = computed<string[]>(() => {
  if (queryTaskIds.value.length > 0) return queryTaskIds.value;
  const goal = scopeGoal.value;
  if (goal === null) return [];
  const open = new Set(tasks.value.filter(isSchedulable).map((task) => task.id));
  return goal.taskIds.filter((taskId) => open.has(taskId));
});

const selectedIds = computed(() => selectedTaskIdsInOrder(groups.value, selected.value));

const scopeSummary = computed(() => {
  if (queryTaskIds.value.length > 0) return tp('planNew.scopeTasks', queryTaskIds.value.length);
  if (goalId.value !== null) {
    const goal = scopeGoal.value;
    return goal === null
      ? t('planNew.scopeGoal', { goalId: goalId.value })
      : tp('planNew.scopeGoalTitled', lockedScopeTaskIds.value.length, { title: goal.title });
  }
  const summary = selectionSummary(groups.value, selected.value);
  if (summary.tasks === 0) return t('planNew.scopeNone');
  if (summary.plans === 0) return tp('planNew.scopeSelectedOther', summary.tasks);
  return summary.other
    ? tp('planNew.scopeSelectedPlansOther', summary.tasks, { plans: summary.plans })
    : tp('planNew.scopeSelectedPlans', summary.tasks, { plans: summary.plans });
});

const POLICY_OPTIONS = ['front_loaded', 'balanced', 'focus_blocked'] as const;

const canGenerate = computed(
  () =>
    offline.mutationsEnabled &&
    !busy.value &&
    startDate.value.length > 0 &&
    endDate.value.length > 0 &&
    policies.value.length > 0 &&
    (usingQueryScope.value || selectedIds.value.length > 0),
);

function groupTitle(group: PickerGroup): string {
  return group.title ?? t('planNew.groupOther');
}

/** DOM id stem for a group (goal ids are UUIDs, so this is a valid id). */
function groupDomId(group: PickerGroup): string {
  return `picker-group-${group.goalId ?? 'other'}`;
}

function isGroupOpen(group: PickerGroup, index: number): boolean {
  return openOverrides.value[group.key] ?? defaultGroupOpen(index, groups.value.length);
}

function setGroupOpen(group: PickerGroup, index: number): void {
  openOverrides.value = { ...openOverrides.value, [group.key]: !isGroupOpen(group, index) };
}

function toggleTask(taskId: string): void {
  const next = new Set(selected.value);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  selected.value = next;
}

function toggleWholeGroup(group: PickerGroup): void {
  selected.value = toggleGroup(group, selected.value);
}

function togglePolicy(policy: NonNullable<PlanCreate['policies']>[number]): void {
  const next = new Set(policies.value);
  if (next.has(policy)) next.delete(policy);
  else next.add(policy);
  policies.value = [...next];
}

function buildScope(): PlanCreate['scope'] {
  if (queryTaskIds.value.length > 0) return { taskIds: queryTaskIds.value };
  if (goalId.value !== null) return { goalId: goalId.value };
  return { taskIds: selectedIds.value };
}

function retryLoad(): void {
  void tasksQuery.refetch();
  void goalsQuery.refetch();
}

async function generate(): Promise<void> {
  if (!canGenerate.value || startDate.value.length === 0 || endDate.value.length === 0) return;
  busy.value = true;
  error.value = null;
  const input: PlanCreate = {
    scope: buildScope(),
    horizon: {
      start: zonedWallClockToInstant(startDate.value, 0, timeZone.value),
      end: zonedWallClockToInstant(endDate.value, 24 * 60, timeZone.value),
    },
    policies: policies.value,
  };
  const scopeKey = 'plan:create';
  const action = actions.begin(scopeKey, input, (left, right) => JSON.stringify(left) === JSON.stringify(right));
  // Owner isolation (ADR-023): the new plan opens only for the owner who asked for it.
  await runOwnerBound(
    function* (owner) {
      try {
        const plan = yield* owner.wait(plannerClient.createPlan(input, action.key));
        actions.settle(scopeKey, action);
        yield* owner.wait(router.push({ name: 'plan', params: { id: plan.id } }));
      } catch (cause) {
        error.value = errorMessage(cause, t('planNew.generateError'));
      }
    },
    {
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}
</script>

<template>
  <section class="page page--wide">
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('planNew.title') }}</h1>
        <p class="page-lede">{{ t('planNew.lede') }}</p>
      </div>
    </header>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" class="offline-note" role="status">
      {{ t('planNew.offline') }}
    </UiBanner>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <form class="plan-new-form" @submit.prevent="generate">
      <fieldset class="settings-group plan-new-scope">
        <legend>{{ t('planNew.scope') }}</legend>
        <p class="muted plan-new-summary" role="status">{{ scopeSummary }}</p>
        <template v-if="!usingQueryScope">
          <UiSkeleton v-if="pickerLoading" variant="lines" :count="4" />
          <p v-if="pickerLoading" class="visually-hidden" role="status">{{ t('planNew.loading') }}</p>
          <UiBanner v-else-if="tasksQuery.isError.value" tone="error" role="alert">
            {{ t('planNew.loadError') }}
            <UiButton size="sm" variant="secondary" @click="retryLoad">{{ t('common.retry') }}</UiButton>
          </UiBanner>
          <UiEmptyState
            v-else-if="groups.length === 0"
            compact
            icon="inbox"
            :title="t('planNew.empty')"
          />
          <template v-else>
            <p class="field-help">{{ t('planNew.pickerHelp') }}</p>
            <UiBanner v-if="goalsQuery.isError.value" tone="warn" inline data-testid="picker-goals-error">
              {{ t('planNew.goalsError') }}
            </UiBanner>
            <UiBanner v-if="tasksCapped" tone="warn" inline data-testid="picker-tasks-capped">
              {{ t('planNew.tasksCapped', { max: formatNumber(PICKER_PAGE_SIZE * PICKER_TASK_PAGES) }) }}
            </UiBanner>
            <UiBanner v-if="goalsCapped" tone="warn" inline data-testid="picker-goals-capped">
              {{ t('planNew.goalsCapped', { max: formatNumber(PICKER_PAGE_SIZE * PICKER_GOAL_PAGES) }) }}
            </UiBanner>
            <div class="picker-groups">
              <div
                v-for="(group, index) in groups"
                :key="group.key"
                class="picker-group"
                :class="{ 'picker-group--other': group.kind === 'other' }"
                role="group"
                :aria-labelledby="`${groupDomId(group)}-title`"
                :data-group-key="group.key"
              >
                <div class="picker-group-head">
                  <button
                    :id="`${groupDomId(group)}-toggle`"
                    type="button"
                    class="picker-group-toggle"
                    :aria-expanded="isGroupOpen(group, index)"
                    :aria-controls="`${groupDomId(group)}-tasks`"
                    @click="setGroupOpen(group, index)"
                  >
                    <UiIcon class="picker-group-chevron" name="chevron-right" :size="16" />
                    <UiIcon :name="group.kind === 'goal' ? 'projects' : 'inbox'" :size="18" />
                    <span class="picker-group-text">
                      <span :id="`${groupDomId(group)}-title`" class="picker-group-title">{{ groupTitle(group) }}</span>
                      <span class="picker-group-meta">
                        {{ tp('planNew.groupCount', group.tasks.length) }}<template
                          v-if="selectedCount(group, selected) > 0"
                        > · {{ tp('planNew.groupSelected', selectedCount(group, selected)) }}</template>
                      </span>
                    </span>
                  </button>
                  <label class="picker-group-all">
                    <input
                      type="checkbox"
                      data-group-all
                      :checked="groupSelection(group, selected) === 'all'"
                      :indeterminate="groupSelection(group, selected) === 'some'"
                      :aria-label="t('planNew.selectAllIn', { group: groupTitle(group) })"
                      :disabled="!offline.mutationsEnabled"
                      @change="toggleWholeGroup(group)"
                    />
                    <span aria-hidden="true">{{ t('planNew.selectAll') }}</span>
                  </label>
                </div>
                <ul
                  v-show="isGroupOpen(group, index)"
                  :id="`${groupDomId(group)}-tasks`"
                  class="task-picker"
                >
                  <li v-for="task in group.tasks" :key="task.id">
                    <label class="task-picker-row">
                      <input
                        type="checkbox"
                        :value="task.id"
                        :checked="selected.has(task.id)"
                        :disabled="!offline.mutationsEnabled"
                        @change="toggleTask(task.id)"
                      />
                      <span>{{ task.title }}</span>
                    </label>
                  </li>
                </ul>
              </div>
            </div>
          </template>
        </template>
        <ul v-else class="scope-list">
          <li v-for="taskId in lockedScopeTaskIds" :key="taskId">
            {{ taskNames[taskId] ?? taskId }}
          </li>
        </ul>
      </fieldset>

      <div class="plan-new-side">
        <fieldset class="settings-group">
          <legend>{{ t('planNew.horizon') }}</legend>
          <div class="field-grid">
            <UiField id="plan-start" :label="t('planNew.start')">
              <input
                id="plan-start"
                v-model="startDate"
                type="date"
                :disabled="!offline.mutationsEnabled"
                @change="dateTouched = true"
              />
            </UiField>
            <UiField id="plan-end" :label="t('planNew.end')">
              <input
                id="plan-end"
                v-model="endDate"
                type="date"
                :disabled="!offline.mutationsEnabled"
                @change="dateTouched = true"
              />
            </UiField>
          </div>
          <p class="field-help">{{ t('planNew.timeZoneHelp', { timeZone }) }}</p>
        </fieldset>

        <fieldset class="settings-group">
          <legend>{{ t('planNew.policies') }}</legend>
          <div class="choice-group policy-choices">
            <label v-for="policy in POLICY_OPTIONS" :key="policy" class="choice-chip">
              <input
                type="checkbox"
                :checked="policies?.includes(policy)"
                :disabled="!offline.mutationsEnabled"
                @change="togglePolicy(policy)"
              />
              {{ policyLabel(policy) }}
            </label>
          </div>
          <p class="field-help">{{ t('planNew.policiesHelp') }}</p>
        </fieldset>

        <div class="form-actions">
          <UiButton type="submit" variant="primary" size="lg" block icon="compare" :busy="busy" :disabled="!canGenerate">
            {{ busy ? t('planNew.generating') : t('planNew.generate') }}
          </UiButton>
        </div>
      </div>
    </form>
  </section>
</template>
