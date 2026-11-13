<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type Commitment,
  type CommitmentCreate,
  type CommitmentPatch,
} from '../api';
import {
  addDaysToDate,
  instantFromLocalInput,
  localInputValue,
  startOfWeek,
  todayInZone,
  zonedWallClockToInstant,
} from '../domain/time';
import {
  expandOccurrences,
  weeklyDaysFromRrule,
  weeklyRrule,
  type WeekdayCode,
} from '../domain/rrule';
import { useOfflineStore } from '../stores/offline';
import CommitmentParseSection from '../components/CommitmentParseSection.vue';
import type { DraftFormValues } from '../domain/commitmentDraft';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { t } from '../i18n';
import { formatDateTimeRange } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { runOwnerBound, type OwnerSteps } from '../session/ownerBound';

const offline = useOfflineStore();
const queryClient = useQueryClient();
const actions = new ActionStore();

const DAYS: readonly WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const fallbackZone =
  typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
const fromDate = ref(startOfWeek(todayInZone(fallbackZone)));
const toDate = ref(addDaysToDate(fromDate.value, 6));
const rangeTouched = ref(false);
const message = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
const formHeading = ref<HTMLElement | null>(null);

const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability(),
});

const timeZone = computed(() => availabilityQuery.data.value?.timeZone ?? fallbackZone);

watch(
  timeZone,
  (zone) => {
    if (rangeTouched.value) return;
    fromDate.value = startOfWeek(todayInZone(zone));
    toDate.value = addDaysToDate(fromDate.value, 6);
  },
  { immediate: true },
);

const range = computed(() => {
  try {
    return {
      from: zonedWallClockToInstant(fromDate.value, 0, timeZone.value),
      to: zonedWallClockToInstant(toDate.value, 24 * 60, timeZone.value),
    };
  } catch {
    return null;
  }
});

const commitmentsQuery = useQuery({
  queryKey: computed(() => ['commitments', range.value?.from ?? 'invalid', range.value?.to ?? 'invalid']),
  queryFn: () => {
    if (range.value === null) throw new Error('Invalid commitment range');
    return plannerClient.listCommitments(range.value);
  },
  enabled: computed(() => range.value !== null),
});

const commitments = computed<Commitment[]>(() => commitmentsQuery.data.value?.items ?? []);

const form = reactive({
  id: null as string | null,
  title: '',
  startLocal: `${todayInZone(fallbackZone)}T09:00`,
  endLocal: `${todayInZone(fallbackZone)}T10:00`,
  timeZone: fallbackZone,
  rrule: '',
});

const presetDays = computed<WeekdayCode[]>(() => weeklyDaysFromRrule(form.rrule));

/**
 * CAL-02: the manual form holds the screen's one filled button while it is in
 * use (editing, or a title typed / a draft loaded); otherwise "말로 적기" does.
 */
const manualActive = computed(() => form.id !== null || form.title.trim().length > 0);

watch(
  timeZone,
  (zone) => {
    if (form.id === null) form.timeZone = zone;
  },
  { immediate: true },
);

function toggleDay(code: WeekdayCode): void {
  const selected = new Set<WeekdayCode>(presetDays.value);
  if (selected.has(code)) selected.delete(code);
  else selected.add(code);
  form.rrule = weeklyRrule([...selected]);
}

const previewSource = computed(() => {
  try {
    return {
      startAt: instantFromLocalInput(form.startLocal, form.timeZone),
      endAt: instantFromLocalInput(form.endLocal, form.timeZone),
      timeZone: form.timeZone,
      rrule: form.rrule.trim().length > 0 ? form.rrule.trim() : undefined,
    };
  } catch {
    return null;
  }
});

const preview = computed(() => {
  if (previewSource.value === null || range.value === null) return [];
  if (Date.parse(previewSource.value.endAt) <= Date.parse(previewSource.value.startAt)) return [];
  return expandOccurrences(previewSource.value, range.value.from, range.value.to, 20);
});

function formatOccurrence(startAt: string, endAt: string, timeZone: string = form.timeZone): string {
  return formatDateTimeRange(startAt, endAt, timeZone);
}

function resetForm(): void {
  form.id = null;
  form.title = '';
  const zone = timeZone.value;
  form.startLocal = `${todayInZone(zone)}T09:00`;
  form.endLocal = `${todayInZone(zone)}T10:00`;
  form.timeZone = zone;
  form.rrule = '';
}

function edit(commitment: Commitment): void {
  form.id = commitment.id;
  form.title = commitment.title;
  form.startLocal = localInputValue(commitment.startAt, commitment.timeZone);
  form.endLocal = localInputValue(commitment.endAt, commitment.timeZone);
  form.timeZone = commitment.timeZone;
  form.rrule = commitment.rrule ?? '';
  void nextTick().then(() => formHeading.value?.focus());
}

/** CAL-02 고치기: a draft opens in the manual form as a new commitment. */
function fromDraft(values: DraftFormValues): void {
  form.id = null;
  form.title = values.title;
  form.startLocal = values.startLocal;
  form.endLocal = values.endLocal;
  form.timeZone = values.timeZone;
  form.rrule = values.rrule;
  error.value = null;
  void nextTick().then(() => formHeading.value?.focus());
}

function* refreshSteps(): OwnerSteps<void> {
  yield queryClient.invalidateQueries({ queryKey: ['commitments'] });
  yield queryClient.invalidateQueries({ queryKey: ['availability'] });
}

/** The retry button. Inside a task, delegate to `refreshSteps` instead. */
async function refresh(): Promise<void> {
  await runOwnerBound(refreshSteps);
}

// Owner isolation (ADR-023): save and remove run under the owner who started
// them. If the signed-in user changed meanwhile, nothing is announced, reset
// or refetched.
async function save(): Promise<void> {
  if (!offline.mutationsEnabled || busy.value) return;
  const source = previewSource.value;
  if (source === null) {
    error.value = t('commitments.invalidTimes');
    return;
  }
  if (Date.parse(source.endAt) <= Date.parse(source.startAt)) {
    error.value = t('commitments.endAfterStart');
    return;
  }
  if (form.title.trim().length === 0) {
    error.value = t('commitments.titleRequired');
    return;
  }
  busy.value = true;
  error.value = null;
  message.value = '';
  await runOwnerBound(
    function* (owner) {
      try {
        if (form.id === null) {
          const input: CommitmentCreate = {
            title: form.title.trim(),
            startAt: source.startAt,
            endAt: source.endAt,
            timeZone: form.timeZone,
            ...(form.rrule.trim().length === 0 ? {} : { rrule: form.rrule.trim() }),
          };
          const scope = 'commitment:create';
          const action = actions.begin(scope, input, (left, right) => JSON.stringify(left) === JSON.stringify(right));
          yield* owner.wait(plannerClient.createCommitment(input, action.key));
          actions.settle(scope, action);
          message.value = t('commitments.created');
        } else {
          const patch: CommitmentPatch = {
            title: form.title.trim(),
            startAt: source.startAt,
            endAt: source.endAt,
            timeZone: form.timeZone,
            rrule: form.rrule.trim().length === 0 ? null : form.rrule.trim(),
          };
          const scope = `commitment:${form.id}:update`;
          const action = actions.begin(scope, patch, (left, right) => JSON.stringify(left) === JSON.stringify(right));
          yield* owner.wait(plannerClient.updateCommitment(form.id, patch, action.key));
          actions.settle(scope, action);
          message.value = t('commitments.updated');
        }
        resetForm();
        yield* refreshSteps();
      } catch (cause) {
        error.value =
          cause instanceof ApiError && cause.status === 412
            ? t('commitments.changedElsewhere')
            : errorMessage(cause, t('commitments.saveError'));
      }
    },
    {
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}

async function remove(commitment: Commitment): Promise<void> {
  if (!offline.mutationsEnabled || busy.value) return;
  busy.value = true;
  error.value = null;
  await runOwnerBound(
    function* (owner) {
      try {
        const scope = `commitment:${commitment.id}:delete`;
        const action = actions.begin(scope, { id: commitment.id }, (left, right) => left.id === right.id);
        yield* owner.wait(plannerClient.deleteCommitment(commitment.id, action.key));
        actions.settle(scope, action);
        if (form.id === commitment.id) resetForm();
        message.value = t('commitments.deleted');
        yield* refreshSteps();
      } catch (cause) {
        error.value = errorMessage(cause, t('commitments.deleteError'));
      }
    },
    {
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}

function setFrom(value: string): void {
  rangeTouched.value = true;
  fromDate.value = value;
  if (toDate.value < value) toDate.value = value;
}

function onFromChange(event: Event): void {
  if (event.target instanceof HTMLInputElement) setFrom(event.target.value);
}
</script>

<template>
  <section class="page page--wide commitments-page">
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('commitments.title') }}</h1>
        <p class="page-lede">{{ t('commitments.lede') }}</p>
      </div>
    </header>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" class="offline-note" role="status">
      {{ t('commitments.offline') }}
    </UiBanner>
    <p class="status-region status-note" role="status" aria-live="polite">{{ message }}</p>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <CommitmentParseSection :manual-active="manualActive" @edit="fromDraft" />

    <div class="commitments-layout">
      <div class="commitments-list-column">
        <fieldset class="settings-group settings-group--compact">
          <legend>{{ t('commitments.range') }}</legend>
          <div class="field-grid">
            <UiField id="commitment-from" :label="t('commitments.from')">
              <input id="commitment-from" :value="fromDate" type="date" @change="onFromChange" />
            </UiField>
            <UiField id="commitment-to" :label="t('commitments.to')">
              <input id="commitment-to" v-model="toDate" type="date" @change="rangeTouched = true" />
            </UiField>
          </div>
        </fieldset>

        <div v-if="commitmentsQuery.isLoading.value">
          <p class="visually-hidden" role="status">{{ t('commitments.loading') }}</p>
          <UiSkeleton variant="card" :count="2" :lines="2" />
        </div>
        <UiBanner v-else-if="commitmentsQuery.isError.value" tone="error" class="error-panel">
          <p class="error-text" role="alert">{{ t('commitments.loadError') }}</p>
          <template #actions>
            <UiButton size="sm" icon="sync" @click="refresh">{{ t('common.retry') }}</UiButton>
          </template>
        </UiBanner>
        <UiEmptyState
          v-else-if="commitments.length === 0"
          icon="commitment"
          :title="t('commitments.empty')"
          aria-live="polite"
        />
        <ul v-else class="commitment-list">
          <UiCard v-for="commitment in commitments" :key="commitment.id" as="li" class="commitment-item">
            <div class="commitment-main">
              <div class="commitment-title-row">
                <span class="commitment-swatch" aria-hidden="true"></span>
                <strong class="commitment-title">{{ commitment.title }}</strong>
                <UiBadge v-if="commitment.rrule" tone="info">
                  <UiIcon name="reschedule" :size="12" />{{ t('commitments.repeats') }}
                </UiBadge>
              </div>
              <span class="commitment-when tabular">
                <span>{{ formatOccurrence(commitment.startAt, commitment.endAt, commitment.timeZone) }}</span>
                <span class="commitment-zone">{{ commitment.timeZone }}</span>
              </span>
              <span v-if="commitment.rrule" class="subtle commitment-rule">
                {{ t('commitments.repeatRule', { rule: commitment.rrule }) }}
              </span>
              <span class="subtle commitment-version">{{ t('common.version', { version: commitment.version }) }}</span>
            </div>
            <ul v-if="(commitment.occurrences?.length ?? 0) > 0" class="occurrence-list">
              <li v-for="occurrence in commitment.occurrences" :key="`${occurrence.startAt}-${occurrence.endAt}`">
                {{ formatOccurrence(occurrence.startAt, occurrence.endAt, commitment.timeZone) }}
              </li>
            </ul>
            <div class="card-footer card-footer--end">
              <UiButton
                size="sm"
                variant="ghost"
                icon="edit"
                :disabled="!offline.mutationsEnabled || busy"
                @click="edit(commitment)"
              >
                <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: commitment.title }) }}</span
                >{{ t('common.edit') }}
              </UiButton>
              <UiButton
                size="sm"
                variant="danger-ghost"
                icon="trash"
                class="danger"
                :disabled="!offline.mutationsEnabled || busy"
                @click="remove(commitment)"
              >
                <span class="visually-hidden">{{ t('commitments.hiddenTitle', { title: commitment.title }) }}</span
                >{{ t('common.delete') }}
              </UiButton>
            </div>
          </UiCard>
        </ul>
      </div>

      <form class="settings-form commitment-editor" @submit.prevent="save">
        <fieldset class="settings-group">
          <legend>{{ form.id === null ? t('commitments.manualHeading') : t('commitments.editLegend') }}</legend>
          <h2 ref="formHeading" class="sr-only" tabindex="-1">
            {{ form.id === null ? t('commitments.newForm') : t('commitments.editForm') }}
          </h2>
          <UiField id="commitment-title" :label="t('commitments.titleLabel')">
            <input
              id="commitment-title"
              v-model="form.title"
              type="text"
              maxlength="200"
              :placeholder="t('commitments.titlePlaceholder')"
              :disabled="!offline.mutationsEnabled"
            />
          </UiField>
          <div class="field-grid">
            <UiField id="commitment-start" :label="t('commitments.start')">
              <input
                id="commitment-start"
                v-model="form.startLocal"
                type="datetime-local"
                :disabled="!offline.mutationsEnabled"
              />
            </UiField>
            <UiField id="commitment-end" :label="t('commitments.end')">
              <input
                id="commitment-end"
                v-model="form.endLocal"
                type="datetime-local"
                :disabled="!offline.mutationsEnabled"
              />
            </UiField>
          </div>
          <UiField id="commitment-timezone" :label="t('commitments.timeZone')">
            <input
              id="commitment-timezone"
              v-model="form.timeZone"
              type="text"
              :disabled="!offline.mutationsEnabled"
            />
          </UiField>
        </fieldset>

        <fieldset class="settings-group">
          <legend>{{ t('commitments.repeat') }}</legend>
          <div class="choice-group day-choices" role="group" :aria-label="t('commitments.presets')">
            <label v-for="day in DAYS" :key="day" class="choice-chip">
              <input
                type="checkbox"
                :checked="presetDays.includes(day)"
                :disabled="!offline.mutationsEnabled"
                @change="toggleDay(day)"
              />
              {{ t(`commitments.day.${day}`) }}
            </label>
          </div>
          <UiField
            id="commitment-rrule"
            :label="t('commitments.rrule')"
            :help="t('commitments.rruleHelp')"
          >
            <template #default="{ describedby }">
              <input
                id="commitment-rrule"
                v-model="form.rrule"
                type="text"
                class="mono-input"
                placeholder="FREQ=WEEKLY;BYDAY=MO,WE"
                :aria-describedby="describedby"
                :disabled="!offline.mutationsEnabled"
              />
            </template>
          </UiField>
        </fieldset>

        <section class="card card--flat occurrence-preview" aria-labelledby="occurrence-preview-title">
          <h2 id="occurrence-preview-title" class="h2">{{ t('commitments.preview') }}</h2>
          <p v-if="preview.length === 0" class="muted" aria-live="polite">{{ t('commitments.previewEmpty') }}</p>
          <ul v-else class="occurrence-list" aria-live="polite">
            <li v-for="occurrence in preview" :key="`${occurrence.startAt}-${occurrence.endAt}`">
              {{ formatOccurrence(occurrence.startAt, occurrence.endAt) }}
            </li>
          </ul>
        </section>

        <div class="form-actions">
          <UiButton
            type="submit"
            :variant="manualActive ? 'primary' : 'secondary'"
            :busy="busy"
            :disabled="!offline.mutationsEnabled || busy"
          >
            {{ form.id === null ? t('commitments.create') : t('commitments.save') }}
          </UiButton>
          <UiButton v-if="form.id !== null" variant="ghost" :disabled="busy" @click="resetForm">
            {{ t('commitments.cancelEdit') }}
          </UiButton>
        </div>
      </form>
    </div>
  </section>
</template>
