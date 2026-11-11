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
  formatLocalTime,
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
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';

const offline = useOfflineStore();
const queryClient = useQueryClient();
const actions = new ActionStore();

const DAYS: Array<{ code: WeekdayCode; label: string }> = [
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
  { code: 'SU', label: 'Sun' },
];

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

function formatOccurrence(startAt: string, endAt: string): string {
  return `${localInputValue(startAt, form.timeZone).replace('T', ' ')} – ${formatLocalTime(endAt, form.timeZone)}`;
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

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['commitments'] });
  await queryClient.invalidateQueries({ queryKey: ['availability'] });
}

async function save(): Promise<void> {
  if (!offline.mutationsEnabled || busy.value) return;
  if (previewSource.value === null) {
    error.value = 'Start and end must be valid local times.';
    return;
  }
  if (Date.parse(previewSource.value.endAt) <= Date.parse(previewSource.value.startAt)) {
    error.value = 'End must be after start.';
    return;
  }
  if (form.title.trim().length === 0) {
    error.value = 'A title is required.';
    return;
  }
  busy.value = true;
  error.value = null;
  message.value = '';
  try {
    if (form.id === null) {
      const input: CommitmentCreate = {
        title: form.title.trim(),
        startAt: previewSource.value.startAt,
        endAt: previewSource.value.endAt,
        timeZone: form.timeZone,
        ...(form.rrule.trim().length === 0 ? {} : { rrule: form.rrule.trim() }),
      };
      const scope = 'commitment:create';
      const action = actions.begin(scope, input, (left, right) => JSON.stringify(left) === JSON.stringify(right));
      await plannerClient.createCommitment(input, action.key);
      actions.settle(scope, action);
      message.value = 'Commitment created.';
    } else {
      const patch: CommitmentPatch = {
        title: form.title.trim(),
        startAt: previewSource.value.startAt,
        endAt: previewSource.value.endAt,
        timeZone: form.timeZone,
        rrule: form.rrule.trim().length === 0 ? null : form.rrule.trim(),
      };
      const scope = `commitment:${form.id}:update`;
      const action = actions.begin(scope, patch, (left, right) => JSON.stringify(left) === JSON.stringify(right));
      await plannerClient.updateCommitment(form.id, patch, action.key);
      actions.settle(scope, action);
      message.value = 'Commitment updated.';
    }
    resetForm();
    await refresh();
  } catch (cause) {
    if (cause instanceof ApiError) {
      error.value =
        cause.status === 412
          ? 'This commitment changed elsewhere. Reload the list before editing again.'
          : cause.detail;
    } else {
      error.value = 'Could not save the commitment.';
    }
  } finally {
    busy.value = false;
  }
}

async function remove(commitment: Commitment): Promise<void> {
  if (!offline.mutationsEnabled || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const scope = `commitment:${commitment.id}:delete`;
    const action = actions.begin(scope, { id: commitment.id }, (left, right) => left.id === right.id);
    await plannerClient.deleteCommitment(commitment.id, action.key);
    actions.settle(scope, action);
    if (form.id === commitment.id) resetForm();
    message.value = 'Commitment deleted.';
    await refresh();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.detail : 'Could not delete the commitment.';
  } finally {
    busy.value = false;
  }
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
        <h1>Commitments</h1>
        <p class="page-lede">Fixed calendar time that planning must work around.</p>
      </div>
    </header>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" class="offline-note" role="status">
      Read-only while offline. Commitment edits are disabled.
    </UiBanner>
    <p class="status-region status-note" role="status" aria-live="polite">{{ message }}</p>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <div class="commitments-layout">
      <div class="commitments-list-column">
        <fieldset class="settings-group settings-group--compact">
          <legend>List range</legend>
          <div class="field-grid">
            <UiField id="commitment-from" label="From">
              <input id="commitment-from" :value="fromDate" type="date" @change="onFromChange" />
            </UiField>
            <UiField id="commitment-to" label="To">
              <input id="commitment-to" v-model="toDate" type="date" @change="rangeTouched = true" />
            </UiField>
          </div>
        </fieldset>

        <div v-if="commitmentsQuery.isLoading.value">
          <p class="visually-hidden" role="status">Loading commitments…</p>
          <UiSkeleton variant="card" :count="2" :lines="2" />
        </div>
        <UiBanner v-else-if="commitmentsQuery.isError.value" tone="error" class="error-panel">
          <p class="error-text" role="alert">Could not load commitments.</p>
          <template #actions>
            <UiButton size="sm" icon="sync" @click="refresh">Retry</UiButton>
          </template>
        </UiBanner>
        <UiEmptyState
          v-else-if="commitments.length === 0"
          icon="commitment"
          title="No commitments in this range."
          aria-live="polite"
        />
        <ul v-else class="commitment-list">
          <UiCard v-for="commitment in commitments" :key="commitment.id" as="li" class="commitment-item">
            <div class="commitment-main">
              <div class="commitment-title-row">
                <span class="commitment-swatch" aria-hidden="true"></span>
                <strong class="commitment-title">{{ commitment.title }}</strong>
                <UiBadge v-if="commitment.rrule" tone="info">
                  <UiIcon name="reschedule" :size="12" />Repeats
                </UiBadge>
              </div>
              <span class="commitment-when tabular">
                {{ localInputValue(commitment.startAt, commitment.timeZone).replace('T', ' ') }} –
                {{ formatLocalTime(commitment.endAt, commitment.timeZone) }} · {{ commitment.timeZone }}
              </span>
              <span v-if="commitment.rrule" class="subtle commitment-rule">Repeats: {{ commitment.rrule }}</span>
              <span class="subtle commitment-version">Version {{ commitment.version }}</span>
            </div>
            <ul v-if="(commitment.occurrences?.length ?? 0) > 0" class="occurrence-list">
              <li v-for="occurrence in commitment.occurrences" :key="`${occurrence.startAt}-${occurrence.endAt}`">
                {{ localInputValue(occurrence.startAt, commitment.timeZone).replace('T', ' ') }} –
                {{ formatLocalTime(occurrence.endAt, commitment.timeZone) }}
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
                Edit<span class="visually-hidden"> {{ commitment.title }}</span>
              </UiButton>
              <UiButton
                size="sm"
                variant="danger-ghost"
                icon="trash"
                class="danger"
                :disabled="!offline.mutationsEnabled || busy"
                @click="remove(commitment)"
              >
                Delete<span class="visually-hidden"> {{ commitment.title }}</span>
              </UiButton>
            </div>
          </UiCard>
        </ul>
      </div>

      <form class="settings-form commitment-editor" @submit.prevent="save">
        <fieldset class="settings-group">
          <legend>{{ form.id === null ? 'New commitment' : 'Edit commitment' }}</legend>
          <h2 ref="formHeading" class="sr-only" tabindex="-1">
            {{ form.id === null ? 'New commitment form' : 'Edit commitment form' }}
          </h2>
          <UiField id="commitment-title" label="Title">
            <input
              id="commitment-title"
              v-model="form.title"
              type="text"
              maxlength="200"
              placeholder="e.g. Seminar, commute, family dinner"
              :disabled="!offline.mutationsEnabled"
            />
          </UiField>
          <div class="field-grid">
            <UiField id="commitment-start" label="Start (local wall clock)">
              <input
                id="commitment-start"
                v-model="form.startLocal"
                type="datetime-local"
                :disabled="!offline.mutationsEnabled"
              />
            </UiField>
            <UiField id="commitment-end" label="End (local wall clock)">
              <input
                id="commitment-end"
                v-model="form.endLocal"
                type="datetime-local"
                :disabled="!offline.mutationsEnabled"
              />
            </UiField>
          </div>
          <UiField id="commitment-timezone" label="IANA time zone">
            <input
              id="commitment-timezone"
              v-model="form.timeZone"
              type="text"
              :disabled="!offline.mutationsEnabled"
            />
          </UiField>
        </fieldset>

        <fieldset class="settings-group">
          <legend>Repeat</legend>
          <div class="choice-group day-choices" role="group" aria-label="Weekly recurrence presets">
            <label v-for="day in DAYS" :key="day.code" class="choice-chip">
              <input
                type="checkbox"
                :checked="presetDays.includes(day.code)"
                :disabled="!offline.mutationsEnabled"
                @change="toggleDay(day.code)"
              />
              {{ day.label }}
            </label>
          </div>
          <UiField
            id="commitment-rrule"
            label="Raw RRULE (optional)"
            help="Presets write a weekly rule; raw rules accept a bounded RFC 5545 subset."
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
          <h2 id="occurrence-preview-title" class="h2">Occurrences preview</h2>
          <p v-if="preview.length === 0" class="muted" aria-live="polite">No occurrences in the selected range.</p>
          <ul v-else class="occurrence-list" aria-live="polite">
            <li v-for="occurrence in preview" :key="`${occurrence.startAt}-${occurrence.endAt}`">
              {{ formatOccurrence(occurrence.startAt, occurrence.endAt) }}
            </li>
          </ul>
        </section>

        <div class="form-actions">
          <UiButton type="submit" variant="primary" :busy="busy" :disabled="!offline.mutationsEnabled || busy">
            {{ form.id === null ? 'Create commitment' : 'Save commitment' }}
          </UiButton>
          <UiButton v-if="form.id !== null" variant="ghost" :disabled="busy" @click="resetForm">
            Cancel edit
          </UiButton>
        </div>
      </form>
    </div>
  </section>
</template>
