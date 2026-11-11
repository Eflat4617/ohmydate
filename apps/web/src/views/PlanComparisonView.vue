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
import WeekCalendar from '../components/WeekCalendar.vue';
import {
  blockIndexFromPath,
  metricsRows,
  policyLabel,
  violationText,
} from '../domain/plan';
import {
  addDaysToDate,
  localParts,
  startOfWeek,
  zonedWallClockToInstant,
} from '../domain/time';
import { useOfflineStore } from '../stores/offline';

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
const blockErrors = ref<Record<number, string>>({});
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

function mapProblemErrors(errors: Array<{ path: string; message: string }> | undefined): Record<number, string> {
  const mapped: Record<number, string> = {};
  for (const error of errors ?? []) {
    const index = blockIndexFromPath(error.path);
    if (index !== null) mapped[index] = error.message;
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
  try {
    const result = await plannerClient.previewCandidateEdit(
      activePlan.id,
      candidate.id,
      blocks,
      action.key,
      activePlan.version,
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
          Object.keys(blockErrors.value).length === 0 ? cause.detail : null;
      } else if (cause.status === 422 && cause.code === 'constraint_violation') {
        previewResult.value = {
          feasible: false,
          violations: cause.problem?.violations ?? [],
          deficitMin: 0,
        };
        blockErrors.value = {};
      } else {
        previewResult.value = null;
        previewError.value = cause.detail;
      }
    } else {
      previewResult.value = null;
      previewError.value = 'Could not validate the edited blocks.';
    }
  } finally {
    if (token === previewToken) previewing.value = false;
  }
}

function onBlocksUpdated(next: PlanBlock[]): void {
  if (!offline.mutationsEnabled) return;
  draftBlocks.value = next;
  dirty.value = true;
}

function resetEdits(): void {
  resetDraft();
  message.value = 'Edits reset to the generated candidate.';
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
  try {
    const version = await plannerClient.approveCandidate(
      activePlan.id,
      candidate.id,
      action.key,
      activePlan.availabilityVersion,
      edited,
    );
    actions.settle(scope, action);
    approvedVersion.value = version;
    dirty.value = false;
    stale.value = false;
    message.value = `Approved plan version ${version.seq}.`;
    await planQuery.refetch();
  } catch (cause) {
    if (cause instanceof ApiError) {
      if (cause.status === 412 && cause.code === 'availability_changed') {
        actions.settle(scope, action);
        stale.value = true;
        message.value = '';
        actionError.value = null;
        await planQuery.refetch();
        return;
      }
      if (cause.status === 422 && cause.code === 'constraint_violation') {
        approveViolations.value = cause.problem?.violations ?? [];
        actionError.value = cause.detail;
        return;
      }
      if (cause.status === 422 && cause.code === 'validation_failed') {
        blockErrors.value = mapProblemErrors(cause.problem?.errors);
        actionError.value =
          Object.keys(blockErrors.value).length === 0 ? cause.detail : 'Some blocks are outside the plan.';
        return;
      }
      actionError.value = cause.detail;
    } else {
      actionError.value = 'Could not approve the selected candidate.';
    }
  } finally {
    approving.value = false;
  }
}

async function regenerate(): Promise<void> {
  const activePlan = plan.value;
  if (activePlan === null || regenerating.value) return;
  regenerating.value = true;
  actionError.value = null;
  const scope = `plan:${activePlan.id}:regenerate`;
  const action = actions.begin(scope, { planId: activePlan.id }, (left, right) => left.planId === right.planId, activePlan.version);
  try {
    const updated = await plannerClient.regeneratePlan(activePlan.id, action.key, activePlan.version);
    actions.settle(scope, action);
    queryClient.setQueryData(['plan', activePlan.id], updated);
    stale.value = false;
    approvedVersion.value = null;
    message.value = 'Plan regenerated against the latest availability.';
    resetDraft();
  } catch (cause) {
    actionError.value = cause instanceof ApiError ? cause.detail : 'Could not regenerate the plan.';
    if (cause instanceof ApiError && cause.status === 412) {
      await planQuery.refetch();
    }
  } finally {
    regenerating.value = false;
  }
}

function goToToday(): void {
  void router.push({ name: 'today' });
}

const weekLabel = computed(() => {
  if (weekDates.value.length === 0) return '';
  return `${weekDates.value[0]} – ${weekDates.value[6]}`;
});

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
  <section class="page">
    <header class="page-header">
      <div>
        <h1>Plan comparison</h1>
        <p class="muted" v-if="plan">Generated {{ plan.createdAt.slice(0, 10) }} · {{ plan.timeZone }}</p>
      </div>
      <button type="button" class="link-button" @click="goToToday">Go to Today</button>
    </header>

    <p v-if="!offline.mutationsEnabled" class="offline-note" role="status">
      Read-only while offline. Editing, regeneration and approval are disabled.
    </p>
    <p class="status-region" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="actionError" class="error-text" role="alert">{{ actionError }}</p>

    <div v-if="planQuery.isLoading.value" class="muted">Loading plan…</div>
    <div v-else-if="planQuery.isError.value || plan === null" class="error-panel">
      <p class="error-text" role="alert">Could not load this plan.</p>
      <button type="button" @click="planQuery.refetch()">Retry</button>
    </div>

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
            :aria-label="`Select ${policyLabel(candidate.policy)} candidate`"
            @click="selectCandidate(candidate)"
            @keydown.enter.prevent="selectCandidate(candidate)"
          >
            <span class="candidate-heading">
              <span class="candidate-policy">{{ policyLabel(candidate.policy) }}</span>
              <span v-if="candidate.feasible" class="badge badge--ok">Feasible</span>
              <span v-else class="badge badge--danger">
                Infeasible · deficit {{ candidate.deficitMin }} min
              </span>
            </span>
            <dl class="metrics-grid">
              <template v-for="row in metricsRows(candidate.metrics)" :key="row.key">
                <dt>{{ row.label }}</dt>
                <dd>{{ row.value }}</dd>
              </template>
            </dl>
            <p v-if="candidate.deficitMin > 0" class="error-text">
              Deficit: {{ candidate.deficitMin }} min of work cannot be placed.
            </p>
            <ul v-if="candidate.explanation.length > 0" class="explanation-list">
              <li v-for="line in candidate.explanation" :key="line">{{ line }}</li>
            </ul>
            <p v-if="candidate.diversityNote" class="muted">{{ candidate.diversityNote }}</p>
          </button>
        </article>
      </div>

      <section v-if="selectedCandidate" class="calendar-panel" aria-labelledby="calendar-title">
        <div class="calendar-toolbar">
          <div>
            <h2 id="calendar-title" ref="calendarHeading" class="h2" tabindex="-1">
              Week view · {{ weekLabel }}
            </h2>
            <p class="muted">
              {{ policyLabel(selectedCandidate.policy) }} ·
              {{ dirty ? 'Edited blocks' : 'Generated blocks' }} · {{ timeZone }}
            </p>
          </div>
          <div class="calendar-nav">
            <button type="button" :disabled="weekStart.length === 0" @click="shiftWeek(-7)">
              Previous week
            </button>
            <button type="button" :disabled="weekStart.length === 0" @click="shiftWeek(7)">
              Next week
            </button>
          </div>
        </div>

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

        <p class="muted">
          Edit with drag/resize or with the keyboard: ArrowUp/ArrowDown moves a block by 5 minutes,
          Shift+ArrowUp/Shift+ArrowDown resizes it.
        </p>

        <div class="violation-region" aria-live="polite">
          <p v-if="previewing" class="muted">Validating edits…</p>
          <p v-if="previewError" class="error-text" role="alert">{{ previewError }}</p>
          <ul v-if="errorIndexes.length > 0" class="violation-list">
            <li v-for="index in errorIndexes" :key="`block-error-${index}`" class="error-text">
              Block {{ index + 1 }}: {{ blockErrors[index] }}
            </li>
          </ul>
          <ul v-if="previewViolations.length > 0" class="violation-list">
            <li v-for="(violation, index) in previewViolations" :key="`preview-violation-${index}`">
              <strong>{{ violation.code }}</strong> — {{ violationText(violation) }}
              <span class="muted">{{ violation.message }}</span>
            </li>
          </ul>
          <ul v-if="approveViolations.length > 0" class="violation-list">
            <li v-for="(violation, index) in approveViolations" :key="`approve-violation-${index}`">
              <strong>{{ violation.code }}</strong> — {{ violationText(violation) }}
              <span class="muted">{{ violation.message }}</span>
            </li>
          </ul>
        </div>

        <div v-if="stale" class="conflict-panel" role="alert">
          <p><strong>Availability changed elsewhere.</strong> Regenerate candidates before approving.</p>
          <button type="button" class="primary-action" :disabled="!offline.mutationsEnabled || regenerating" @click="regenerate">
            {{ regenerating ? 'Regenerating…' : 'Regenerate plan' }}
          </button>
        </div>

        <div class="form-actions">
          <button
            type="button"
            class="primary-action"
            :disabled="!offline.mutationsEnabled || approving || previewing"
            @click="approve"
            @keydown.enter.prevent="approve"
          >
            {{ approving ? 'Approving…' : 'Approve this plan' }}
          </button>
          <button type="button" :disabled="!dirty || approving" @click="resetEdits">Reset edits</button>
          <button
            v-if="!stale"
            type="button"
            :disabled="!offline.mutationsEnabled || regenerating"
            @click="regenerate"
          >
            {{ regenerating ? 'Regenerating…' : 'Regenerate' }}
          </button>
        </div>

        <section v-if="approvedVersion" class="approved-panel" aria-live="polite">
          <h2 class="h2">Plan approved</h2>
          <dl class="metrics-grid">
            <dt>Version</dt>
            <dd>{{ approvedVersion.seq }}</dd>
            <dt>Blocks</dt>
            <dd>{{ approvedVersion.blocks.length }}</dd>
            <dt>Availability version</dt>
            <dd>{{ approvedVersion.availabilityVersion }}</dd>
            <dt>Created by</dt>
            <dd>{{ approvedVersion.createdBy }}</dd>
          </dl>
          <RouterLink class="primary-action link-action" :to="{ name: 'today' }">
            Open Today
          </RouterLink>
        </section>
      </section>
    </template>
  </section>
</template>
