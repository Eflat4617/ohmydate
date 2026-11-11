<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  ActionStore,
  plannerClient,
  type PlanCreate,
  type Task,
} from '../api';
import { addDaysToDate, todayInZone, zonedWallClockToInstant } from '../domain/time';
import { useOfflineStore } from '../stores/offline';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { policyLabel } from '../domain/plan';
import { t, tp } from '../i18n';
import { errorMessage } from '../i18n/problem';

const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const actions = new ActionStore();

const busy = ref(false);
const error = ref<string | null>(null);
const selectedTaskIds = ref<string[]>([]);
const startDate = ref('');
const endDate = ref('');
const policies = ref<NonNullable<PlanCreate['policies']>>(['front_loaded', 'balanced', 'focus_blocked']);
const dateTouched = ref(false);

const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability(),
});

const tasksQuery = useQuery({
  queryKey: ['tasks', 'plan-picker'],
  queryFn: () => plannerClient.listTasks({ limit: 100 }),
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

const scopeSummary = computed(() => {
  if (queryTaskIds.value.length > 0) return tp('planNew.scopeTasks', queryTaskIds.value.length);
  if (goalId.value !== null) return t('planNew.scopeGoal', { goalId: goalId.value });
  if (selectedTaskIds.value.length > 0) return tp('planNew.scopeSelected', selectedTaskIds.value.length);
  return t('planNew.scopeNone');
});

const POLICY_OPTIONS = ['front_loaded', 'balanced', 'focus_blocked'] as const;

const canGenerate = computed(
  () =>
    offline.mutationsEnabled &&
    !busy.value &&
    startDate.value.length > 0 &&
    endDate.value.length > 0 &&
    policies.value.length > 0 &&
    (usingQueryScope.value || selectedTaskIds.value.length > 0),
);

function toggleTask(taskId: string): void {
  const selected = new Set(selectedTaskIds.value);
  if (selected.has(taskId)) selected.delete(taskId);
  else selected.add(taskId);
  selectedTaskIds.value = [...selected];
}

function togglePolicy(policy: NonNullable<PlanCreate['policies']>[number]): void {
  const selected = new Set(policies.value);
  if (selected.has(policy)) selected.delete(policy);
  else selected.add(policy);
  policies.value = [...selected];
}

function buildScope(): PlanCreate['scope'] {
  if (queryTaskIds.value.length > 0) return { taskIds: queryTaskIds.value };
  if (goalId.value !== null) return { goalId: goalId.value };
  return { taskIds: selectedTaskIds.value };
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
  try {
    const plan = await plannerClient.createPlan(input, action.key);
    actions.settle(scopeKey, action);
    await router.push({ name: 'plan', params: { id: plan.id } });
  } catch (cause) {
    error.value = errorMessage(cause, t('planNew.generateError'));
  } finally {
    busy.value = false;
  }
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
        <p class="muted">{{ scopeSummary }}</p>
        <template v-if="!usingQueryScope">
          <UiSkeleton v-if="tasksQuery.isLoading.value" variant="lines" :count="4" />
          <p v-if="tasksQuery.isLoading.value" class="visually-hidden" role="status">{{ t('planNew.loading') }}</p>
          <UiEmptyState
            v-else-if="tasks.length === 0"
            compact
            icon="inbox"
            :title="t('planNew.empty')"
          />
          <ul v-else class="task-picker">
            <li v-for="task in tasks" :key="task.id">
              <label class="task-picker-row">
                <input
                  type="checkbox"
                  :checked="selectedTaskIds.includes(task.id)"
                  :disabled="!offline.mutationsEnabled"
                  @change="toggleTask(task.id)"
                />
                <span>{{ task.title }}</span>
              </label>
            </li>
          </ul>
        </template>
        <ul v-else class="scope-list">
          <li v-for="taskId in queryTaskIds" :key="taskId">
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
