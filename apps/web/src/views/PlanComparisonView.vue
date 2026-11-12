<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
import WeekCalendar from '../components/WeekCalendar.vue';
import {
  blockIndexFromPath,
  metricsRows,
  policyLabel,
  policySummary,
} from '../domain/plan';
import { t } from '../i18n';
import I18nT from '../i18n/I18nT';
import {
  formatCivilDateRange,
  formatDate,
  formatDateTimeRange,
  formatDuration,
} from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { runOwnerBound } from '../session/ownerBound';
import { blockErrorText, diversityNoteText, type ServerText } from '../i18n/server';
import {
  addDaysToDate,
  localParts,
  startOfWeek,
  zonedWallClockToInstant,
} from '../domain/time';
import { useOfflineStore } from '../stores/offline';
import ReplanRequestButton from '../components/ReplanRequestButton.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const actions = new ActionStore();

const planId = computed(() => {
  const value = route.params['id'];
  return typeof value === 'string' ? value : '';
});

const planQuery = useQuery({
  queryKey: computed(() => ['plan', planId.value]),
  queryFn: () => plannerClient.getPlan(planId.value, { fresh: true }),
  enabled: computed(() => planId.value.length > 0),
});

const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability(),
});

const tasksQuery = useQuery({
  queryKey: ['tasks', 'plan-comparison'],
  queryFn: () => plannerClient.listTasks({ limit: 100 }),
});

const plan = computed<Plan | null>(() => planQuery.data.value ?? null);

// M5-03: an approved (active) plan can be replanned from its own page.
const planActive = computed(() => plan.value?.status === 'active' && plan.value.currentVersionId !== undefined);
const timeZone = computed(() => plan.value?.timeZone ?? availabilityQuery.data.value?.timeZone ?? 'UTC');

const weekStart = ref('');
const weekInitialized = ref(false);
watch(
  plan,
  (value) => {
    if (value === null || weekInitialized.value) return;
    weekStart.value = startOfWeek(localParts(value.horizon.start, value.timeZone).date);
    weekInitialized.value = true;
  },
  { immediate: true },
);

const weekDates = computed(() =>
  weekStart.value.length === 0
    ? []
    : Array.from({ length: 7 }, (_, index) => addDaysToDate(weekStart.value, index)),
);

const weekRange = computed(() => {
  if (weekStart.value.length === 0) return null;
  return {
    from: zonedWallClockToInstant(weekStart.value, 0, timeZone.value),
    to: zonedWallClockToInstant(addDaysToDate(weekStart.value, 7), 0, timeZone.value),
  };
});

const commitmentsQuery = useQuery({
  queryKey: computed(() => ['commitments', 'plan', weekRange.value?.from ?? 'none']),
  queryFn: () => {
    if (weekRange.value === null) throw new Error('Week range is unavailable');
    return plannerClient.listCommitments(weekRange.value);
  },
  enabled: computed(() => weekRange.value !== null),
});

const approvedBlocksQuery = useQuery({
  queryKey: computed(() => ['schedule-blocks', 'plan', weekRange.value?.from ?? 'none']),
  queryFn: () => {
    if (weekRange.value === null) throw new Error('Week range is unavailable');
    return plannerClient.listScheduleBlocks({ ...weekRange.value, limit: 100 });
  },
  enabled: computed(() => weekRange.value !== null),
});

const approvedBlocks = computed(() => {
  return [...(approvedBlocksQuery.data.value?.items ?? [])].sort(
    (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
  );
});

const taskNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const task of tasksQuery.data.value?.items ?? []) map[task.id] = task.title;
  return map;
});

const commitmentNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const commitment of commitmentsQuery.data.value?.items ?? []) map[commitment.id] = commitment.title;
  return map;
});

const commitmentOccurrences = computed(() =>
  (commitmentsQuery.data.value?.items ?? []).flatMap((commitment) => commitment.occurrences ?? []),
);

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
const approvedVersion = ref<PlanVersion | null>(null);
const calendarHeading = ref<HTMLElement | null>(null);

function resetDraft(): void {
  draftBlocks.value = selectedCandidate.value?.blocks.map((block) => ({ ...block })) ?? [];
  dirty.value = false;
  previewResult.value = null;
  previewError.value = null;
  blockErrors.value = {};
  approveViolations.value = [];
  previewing.value = false;
}

watch(
  [() => plan.value?.id, () => plan.value?.version, selectedCandidateId],
  () => resetDraft(),
  { immediate: true },
);

watch(
  () => selectedCandidateId.value,
  () => {
    stale.value = false;
    approvedVersion.value = null;
    actionError.value = null;
  },
);

const errorIndexes = computed(() =>
  Object.keys(blockErrors.value)
    .map((key) => Number(key))
    .filter((index) => Number.isFinite(index)),
);

const previewViolations = computed<Violation[]>(() => previewResult.value?.violations ?? []);

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewToken = 0;

function clearPreviewTimer(): void {
  if (previewTimer !== null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
}

function schedulePreview(): void {
  clearPreviewTimer();
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void runPreview();
  }, 350);
}

watch(
  draftBlocks,
  () => {
    if (!dirty.value) return;
    blockErrors.value = {};
    previewError.value = null;
    schedulePreview();
  },
  { deep: true },
);

function mapProblemErrors(errors: Array<{ path: string; message: string }> | undefined): Record<number, ServerText> {
  const mapped: Record<number, ServerText> = {};
  for (const error of errors ?? []) {
    const index = blockIndexFromPath(error.path);
    if (index !== null) mapped[index] = blockErrorText(error.message);
  }
  return mapped;
}

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
    function* (owner) {
      try {
        const result = yield* owner.wait(
          plannerClient.previewCandidateEdit(activePlan.id, candidate.id, blocks, action.key, activePlan.version),
        );
        if (token !== previewToken) return;
        previewResult.value = result;
        blockErrors.value = {};
        approveViolations.value = [];
      } catch (cause) {
        if (token !== previewToken) return;
        if (cause instanceof ApiError) {
          if (cause.status === 422 && cause.code === 'validation_failed') {
            blockErrors.value = mapProblemErrors(cause.problem?.errors);
            previewResult.value = null;
            previewError.value =
              Object.keys(blockErrors.value).length === 0 ? errorMessage(cause) : null;
          } else if (cause.status === 422 && cause.code === 'constraint_violation') {
            previewResult.value = {
              feasible: false,
              violations: cause.problem?.violations ?? [],
              deficitMin: 0,
            };
            blockErrors.value = {};
          } else {
            previewResult.value = null;
            previewError.value = errorMessage(cause);
          }
        } else {
          previewResult.value = null;
          previewError.value = errorMessage(cause, t('plan.validateError'));
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

function onBlocksUpdated(next: PlanBlock[]): void {
  if (!offline.mutationsEnabled) return;
  draftBlocks.value = next;
  dirty.value = true;
}

function resetEdits(): void {
  resetDraft();
  message.value = t('plan.editsReset');
}

function selectCandidate(candidate: PlanCandidate): void {
  selectedCandidateId.value = candidate.id;
  approvedVersion.value = null;
  stale.value = false;
  void nextTick().then(() => calendarHeading.value?.focus());
}

function shiftWeek(days: number): void {
  if (weekStart.value.length === 0) return;
  weekStart.value = addDaysToDate(weekStart.value, days);
}

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
  const payload = { editedBlocks: edited ?? null };
  const scope = `plan:${activePlan.id}:${candidate.id}:approve`;
  const action = actions.begin(
    scope,
    payload,
    (left, right) => JSON.stringify(left) === JSON.stringify(right),
    activePlan.availabilityVersion,
  );
  await runOwnerBound(
    function* (owner) {
      try {
        const version = yield* owner.wait(
          plannerClient.approveCandidate(activePlan.id, candidate.id, action.key, activePlan.availabilityVersion, edited),
        );
        actions.settle(scope, action);
        approvedVersion.value = version;
        dirty.value = false;
        stale.value = false;
        message.value = t('plan.approvedMessage', { seq: version.seq });
        yield* owner.wait(Promise.all([planQuery.refetch(), approvedBlocksQuery.refetch()]));
      } catch (cause) {
        if (cause instanceof ApiError) {
          if (cause.status === 412 && cause.code === 'availability_changed') {
            actions.settle(scope, action);
            stale.value = true;
            message.value = '';
            actionError.value = null;
            yield* owner.wait(planQuery.refetch());
            return;
          }
          if (cause.status === 422 && cause.code === 'constraint_violation') {
            approveViolations.value = cause.problem?.violations ?? [];
            actionError.value = errorMessage(cause);
            return;
          }
          if (cause.status === 422 && cause.code === 'validation_failed') {
            blockErrors.value = mapProblemErrors(cause.problem?.errors);
            actionError.value =
              Object.keys(blockErrors.value).length === 0 ? errorMessage(cause) : t('plan.outsidePlan');
            return;
          }
          actionError.value = errorMessage(cause);
        } else {
          actionError.value = errorMessage(cause, t('plan.approveError'));
        }
      }
    },
    {
      onSettled: () => {
        approving.value = false;
      },
    },
  );
}

async function regenerate(): Promise<void> {
  const activePlan = plan.value;
  if (activePlan === null || regenerating.value) return;
  regenerating.value = true;
  actionError.value = null;
  const scope = `plan:${activePlan.id}:regenerate`;
  const action = actions.begin(scope, { planId: activePlan.id }, (left, right) => left.planId === right.planId, activePlan.version);
  await runOwnerBound(
    function* (owner) {
      try {
        const updated = yield* owner.wait(plannerClient.regeneratePlan(activePlan.id, action.key, activePlan.version));
        actions.settle(scope, action);
        queryClient.setQueryData(['plan', activePlan.id], updated);
        stale.value = false;
        approvedVersion.value = null;
        message.value = t('plan.regenerated');
        resetDraft();
      } catch (cause) {
        actionError.value = errorMessage(cause, t('plan.regenerateError'));
        if (cause instanceof ApiError && cause.status === 412) {
          yield* owner.wait(planQuery.refetch());
        }
      }
    },
    {
      onSettled: () => {
        regenerating.value = false;
      },
    },
  );
}

function goToToday(): void {
  void router.push({ name: 'today' });
}

const weekLabel = computed(() => {
  const first = weekDates.value[0];
  const last = weekDates.value[6];
  if (first === undefined || last === undefined) return '';
  return formatCivilDateRange(first, last, { year: true });
});

function noteFor(note: string | undefined): ServerText | null {
  return note === undefined || note.length === 0 ? null : diversityNoteText(note);
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
</script>

<template>
  <section class="page page--wide plan-comparison">
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('plan.title') }}</h1>
        <p v-if="plan" class="page-lede">
          {{ t('plan.generated', { date: formatDate(plan.createdAt, plan.timeZone, { year: true }), timeZone: plan.timeZone }) }}
        </p>
      </div>
      <div class="page-actions">
        <ReplanRequestButton v-if="plan && planActive" :plan-id="plan.id" variant="ghost" />
        <UiButton variant="ghost" icon="today" @click="goToToday">{{ t('plan.goToday') }}</UiButton>
      </div>
    </header>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" class="offline-note" role="status">
      {{ t('plan.offline') }}
    </UiBanner>
    <p class="status-region status-note" role="status" aria-live="polite">{{ message }}</p>
    <UiBanner v-if="actionError" tone="error" role="alert">{{ actionError }}</UiBanner>

    <div v-if="planQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('plan.loading') }}</p>
      <div class="candidate-grid"><UiSkeleton variant="card" :count="3" :lines="4" /></div>
    </div>
    <UiBanner v-else-if="planQuery.isError.value || plan === null" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('plan.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="planQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <template v-else>
      <div class="candidate-grid">
        <article
          v-for="candidate in plan.candidates"
          :key="candidate.id"
          class="candidate-card"
          :class="{
            'candidate-card--selected': selectedCandidateId === candidate.id,
            'candidate-card--infeasible': !candidate.feasible,
          }"
        >
          <button
            type="button"
            class="candidate-button"
            :aria-pressed="selectedCandidateId === candidate.id"
            :aria-label="t('plan.selectCandidate', { policy: policyLabel(candidate.policy) })"
            @click="selectCandidate(candidate)"
            @keydown.enter.prevent="selectCandidate(candidate)"
          >
            <span class="candidate-heading">
              <span class="candidate-policy">{{ policyLabel(candidate.policy) }}</span>
              <span v-if="candidate.feasible" class="badge badge--ok">
                <span class="badge-dot" aria-hidden="true"></span>{{ t('plan.feasible') }}
              </span>
              <span v-else class="badge badge--danger">
                {{ t('plan.infeasible', { deficit: formatDuration(candidate.deficitMin) }) }}
              </span>
              <span class="candidate-check" aria-hidden="true">
                <UiIcon name="check" :size="16" />
              </span>
            </span>
            <span v-if="policySummary(candidate.policy)" class="candidate-summary muted">
              {{ policySummary(candidate.policy) }}
            </span>
            <dl class="metrics-grid">
              <template v-for="row in metricsRows(candidate.metrics)" :key="row.key">
                <dt>{{ row.label }}</dt>
                <dd>{{ row.value }}</dd>
              </template>
            </dl>
            <p v-if="candidate.deficitMin > 0" class="error-text">
              {{ t('plan.deficit', { deficit: formatDuration(candidate.deficitMin) }) }}
            </p>
            <p
              v-if="noteFor(candidate.diversityNote)"
              class="candidate-note"
              :lang="noteFor(candidate.diversityNote)?.translated ? undefined : 'en'"
            >
              {{ noteFor(candidate.diversityNote)?.text }}
            </p>
          </button>
          <ExplanationList
            :lines="candidate.explanation"
            :items="candidate.explanationItems"
            :time-zone="timeZone"
            :task-names="taskNames"
          />
        </article>
      </div>

      <section v-if="selectedCandidate" class="calendar-panel" aria-labelledby="calendar-title">
        <div class="calendar-toolbar">
          <div>
            <h2 id="calendar-title" ref="calendarHeading" class="h2" tabindex="-1">
              {{ t('plan.weekView', { range: weekLabel }) }}
            </h2>
            <p class="muted">
              {{ policyLabel(selectedCandidate.policy) }} ·
              {{ dirty ? t('plan.editedBlocks') : t('plan.generatedBlocks') }} · {{ timeZone }}
            </p>
          </div>
          <div class="calendar-nav">
            <UiButton size="sm" icon="chevron-left" :disabled="weekStart.length === 0" @click="shiftWeek(-7)">
              {{ t('plan.previousWeek') }}
            </UiButton>
            <UiButton size="sm" :disabled="weekStart.length === 0" @click="shiftWeek(7)">
              {{ t('plan.nextWeek') }}
              <UiIcon name="chevron-right" :size="16" />
            </UiButton>
          </div>
        </div>

        <ul class="calendar-legend" :aria-label="t('plan.legend')">
          <li><span class="legend-swatch legend-swatch--availability" aria-hidden="true"></span>{{ t('plan.legendAvailable') }}</li>
          <li><span class="legend-swatch legend-swatch--focus" aria-hidden="true"></span>{{ t('plan.legendFocus') }}</li>
          <li><span class="legend-swatch legend-swatch--commitment" aria-hidden="true"></span>{{ t('plan.legendCommitment') }}</li>
          <li><span class="legend-swatch legend-swatch--block" aria-hidden="true"></span>{{ t('plan.legendBlock') }}</li>
        </ul>

        <WeekCalendar
          :blocks="draftBlocks"
          :time-zone="timeZone"
          :week-start="weekStart"
          :availability="availabilityQuery.data.value ?? null"
          :commitment-occurrences="commitmentOccurrences"
          :commitment-names="commitmentNames"
          :task-names="taskNames"
          :editable="offline.mutationsEnabled && !approving"
          :selected-index="null"
          :error-indexes="errorIndexes"
          @update:blocks="onBlocksUpdated"
        />

        <p class="calendar-hint">
          <UiIcon name="info" :size="16" />
          <span>{{ t('plan.hint') }}</span>
        </p>

        <section
          v-if="approvedBlocks.length > 0"
          class="approved-schedule"
          aria-labelledby="approved-schedule-title"
        >
          <h3 id="approved-schedule-title" class="h3">{{ t('plan.approvedSchedule') }}</h3>
          <ul class="approved-schedule-list">
            <li
              v-for="block in approvedBlocks"
              :key="block.id"
              :data-approved-block-id="block.id"
            >
              <span class="approved-schedule-time">
                {{ formatDateTimeRange(block.startAt, block.endAt, timeZone) }}
              </span>
              <span class="approved-schedule-title">{{ taskNames[block.taskId] ?? block.taskId }}</span>
              <UiBadge class="chip" tone="success">{{ t(`plan.blockStatus.${block.status}`) }}</UiBadge>
            </li>
          </ul>
        </section>

        <div class="violation-region" aria-live="polite">
          <p v-if="previewing" class="loading-row">{{ t('plan.validating') }}</p>
          <UiBanner v-if="previewError" tone="error" role="alert">{{ previewError }}</UiBanner>
          <ul v-if="errorIndexes.length > 0" class="violation-list">
            <li v-for="index in errorIndexes" :key="`block-error-${index}`" class="error-text">
              <I18nT keypath="plan.blockError" :params="{ index: index + 1 }">
                <template #message>
                  <span :lang="blockErrors[index]?.translated ? undefined : 'en'">{{ blockErrors[index]?.text }}</span>
                </template>
              </I18nT>
            </li>
          </ul>
          <ExplanationList :violations="previewViolations" :time-zone="timeZone" :task-names="taskNames" />
          <ExplanationList :violations="approveViolations" :time-zone="timeZone" :task-names="taskNames" />
        </div>

        <UiBanner v-if="stale" tone="conflict" class="conflict-panel" role="alert">
          <p><strong>{{ t('plan.staleTitle') }}</strong> {{ t('plan.staleBody') }}</p>
          <template #actions>
            <UiButton
              variant="primary"
              size="sm"
              icon="sync"
              :busy="regenerating"
              :disabled="!offline.mutationsEnabled || regenerating"
              @click="regenerate"
            >
              {{ regenerating ? t('plan.regenerating') : t('plan.regeneratePlan') }}
            </UiButton>
          </template>
        </UiBanner>

        <div class="form-actions calendar-actions">
          <UiButton
            variant="primary"
            icon="check"
            :busy="approving"
            :disabled="!offline.mutationsEnabled || approving || previewing"
            @click="approve"
            @keydown.enter.prevent="approve"
          >
            {{ approving ? t('plan.approving') : t('plan.approve') }}
          </UiButton>
          <UiButton variant="ghost" :disabled="!dirty || approving" @click="resetEdits">{{ t('plan.resetEdits') }}</UiButton>
          <UiButton
            v-if="!stale"
            variant="ghost"
            icon="sync"
            :busy="regenerating"
            :disabled="!offline.mutationsEnabled || regenerating"
            @click="regenerate"
          >
            {{ regenerating ? t('plan.regenerating') : t('plan.regenerate') }}
          </UiButton>
        </div>

        <UiBanner v-if="approvedVersion" as="section" tone="success" class="approved-panel" aria-live="polite">
          <h2 class="h2">{{ t('plan.approvedTitle') }}</h2>
          <dl class="kv-list">
            <dt>{{ t('plan.approvedVersion') }}</dt>
            <dd>{{ approvedVersion.seq }}</dd>
            <dt>{{ t('plan.approvedBlocks') }}</dt>
            <dd>{{ approvedVersion.blocks.length }}</dd>
            <dt>{{ t('plan.approvedAvailability') }}</dt>
            <dd>{{ approvedVersion.availabilityVersion }}</dd>
            <dt>{{ t('plan.approvedBy') }}</dt>
            <dd>{{ t(`plan.createdBy.${approvedVersion.createdBy}`) }}</dd>
          </dl>
          <template #actions>
            <RouterLink class="btn btn--primary" :to="{ name: 'today' }">
              {{ t('plan.openToday') }}
            </RouterLink>
          </template>
        </UiBanner>
      </section>
    </template>
  </section>
</template>
