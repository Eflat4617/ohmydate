<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type Availability,
  type AvailabilityException,
  type AvailabilityPut,
  type AvailabilityRule,
} from '../api';
import { useOfflineStore } from '../stores/offline';

const offline = useOfflineStore();
const queryClient = useQueryClient();
const actions = new ActionStore();

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

const FALLBACK_ZONES = [
  'UTC',
  'Asia/Seoul',
  'Asia/Tokyo',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
];

const timeZones = computed<string[]>(() => {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported === 'function') {
    try {
      return supported('timeZone');
    } catch {
      return FALLBACK_ZONES;
    }
  }
  return FALLBACK_ZONES;
});

const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability({ fresh: true }),
});

const draft = ref<Availability | null>(null);
const dirty = ref(false);
const saving = ref(false);
const message = ref('');
const error = ref<string | null>(null);
const conflict = ref<{ server: Availability; local: Availability } | null>(null);
const conflictHeading = ref<HTMLElement | null>(null);

watch(
  () => availabilityQuery.data.value,
  (value) => {
    if (value !== undefined && draft.value === null) draft.value = cloneAvailability(value);
  },
  { immediate: true },
);

function cloneAvailability(value: Availability): Availability {
  return {
    version: value.version,
    timeZone: value.timeZone,
    rules: value.rules.map((rule) => ({ ...rule })),
    exceptions: value.exceptions.map((exception) => ({ ...exception })),
    prefs: { ...value.prefs },
  };
}

function buildPayload(value: Availability): AvailabilityPut {
  return {
    timeZone: value.timeZone,
    rules: value.rules.map((rule) => ({
      weekday: rule.weekday,
      startLocal: rule.startLocal,
      endLocal: rule.endLocal,
      kind: rule.kind,
    })),
    exceptions: value.exceptions.map((exception) => ({
      date: exception.date,
      kind: exception.kind,
      ...(exception.startLocal === undefined || exception.startLocal.length === 0
        ? {}
        : { startLocal: exception.startLocal }),
      ...(exception.endLocal === undefined || exception.endLocal.length === 0
        ? {}
        : { endLocal: exception.endLocal }),
    })),
    prefs: { ...value.prefs },
  };
}

function markDirty(): void {
  dirty.value = true;
  error.value = null;
}

function addRule(): void {
  if (draft.value === null) return;
  draft.value.rules.push({
    weekday: 1,
    startLocal: '09:00',
    endLocal: '17:00',
    kind: 'work',
  });
  markDirty();
}

function removeRule(index: number): void {
  draft.value?.rules.splice(index, 1);
  markDirty();
}

function addException(): void {
  if (draft.value === null) return;
  draft.value.exceptions.push({ date: '', kind: 'off' });
  markDirty();
}

function removeException(index: number): void {
  draft.value?.exceptions.splice(index, 1);
  markDirty();
}

function ruleError(rule: AvailabilityRule, index: number): string | null {
  if (rule.endLocal < rule.startLocal) return `Rule ${index + 1}: end must be after start`;
  return null;
}

function exceptionError(exception: AvailabilityException, index: number): string | null {
  if (exception.date.length === 0) return `Exception ${index + 1}: a date is required`;
  if (
    exception.startLocal !== undefined &&
    exception.endLocal !== undefined &&
    exception.endLocal <= exception.startLocal
  ) {
    return `Exception ${index + 1}: end must be after start`;
  }
  return null;
}

const validationErrors = computed<string[]>(() => {
  if (draft.value === null) return [];
  const errors: string[] = [];
  draft.value.rules.forEach((rule, index) => {
    const failure = ruleError(rule, index);
    if (failure !== null) errors.push(failure);
  });
  draft.value.exceptions.forEach((exception, index) => {
    const failure = exceptionError(exception, index);
    if (failure !== null) errors.push(failure);
  });
  return errors;
});

const canSave = computed(
  () => offline.mutationsEnabled && draft.value !== null && validationErrors.value.length === 0 && !saving.value,
);

async function reload(): Promise<void> {
  const fresh = await plannerClient.getAvailability({ fresh: true });
  queryClient.setQueryData(['availability'], fresh);
  if (!dirty.value) draft.value = cloneAvailability(fresh);
}

async function save(): Promise<void> {
  if (draft.value === null || !canSave.value) return;
  saving.value = true;
  error.value = null;
  message.value = '';
  const payload = buildPayload(draft.value);
  const scope = 'availability:put';
  const action = actions.begin(scope, payload, (left, right) => JSON.stringify(left) === JSON.stringify(right), draft.value.version);
  try {
    const updated = await plannerClient.putAvailability(payload, action.key, draft.value.version);
    actions.settle(scope, action);
    draft.value = cloneAvailability(updated);
    dirty.value = false;
    queryClient.setQueryData(['availability'], updated);
    message.value = `Availability saved as version ${updated.version}.`;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 412) {
      const server = await plannerClient.getAvailability({ fresh: true });
      queryClient.setQueryData(['availability'], server);
      conflict.value = { server, local: cloneAvailability(draft.value) };
      message.value = '';
      error.value = null;
      await nextTick();
      conflictHeading.value?.focus();
      return;
    }
    error.value = cause instanceof ApiError ? cause.detail : 'Could not save availability.';
  } finally {
    saving.value = false;
  }
}

function keepLocal(): void {
  if (conflict.value === null) return;
  draft.value = { ...conflict.value.local, version: conflict.value.server.version };
  conflict.value = null;
  dirty.value = true;
  message.value = 'Your edits were kept. Review the server version and save again.';
  void nextTick().then(() => document.getElementById('availability-save')?.focus());
}

function useServer(): void {
  if (conflict.value === null) return;
  draft.value = cloneAvailability(conflict.value.server);
  conflict.value = null;
  dirty.value = false;
  message.value = 'Reloaded the server version. Your local edits were discarded.';
}

function retry(): void {
  void reload();
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>Availability</h1>
        <p class="muted">Weekly rules, exceptions and focus preferences used to generate plans.</p>
      </div>
    </header>

    <p v-if="!offline.mutationsEnabled" class="offline-note" role="status">
      Read-only while offline. Availability edits are disabled.
    </p>
    <p class="status-region" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div v-if="availabilityQuery.isLoading.value" class="muted">Loading availability…</div>
    <div v-else-if="availabilityQuery.isError.value" class="error-panel">
      <p class="error-text" role="alert">Could not load availability.</p>
      <button type="button" @click="retry">Retry</button>
    </div>

    <form v-else-if="draft" class="settings-form" @submit.prevent="save">
      <fieldset class="settings-group">
        <legend>Time zone</legend>
        <label for="availability-timezone">IANA time zone</label>
        <select
          id="availability-timezone"
          v-model="draft.timeZone"
          :disabled="!offline.mutationsEnabled"
          @change="markDirty"
        >
          <option v-for="zone in timeZones" :key="zone" :value="zone">{{ zone }}</option>
        </select>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Weekly rules</legend>
        <p class="muted">Local wall-clock windows. Availability repeats every week.</p>
        <div class="rule-table" role="table" aria-label="Weekly availability rules">
          <div class="rule-row rule-head" role="row">
            <span role="columnheader">Weekday</span>
            <span role="columnheader">Start</span>
            <span role="columnheader">End</span>
            <span role="columnheader">Kind</span>
            <span role="columnheader">Actions</span>
          </div>
          <div
            v-for="(rule, index) in draft.rules"
            :key="`rule-${index}`"
            class="rule-row"
            role="row"
          >
            <label class="sr-only" :for="`rule-weekday-${index}`">Weekday for rule {{ index + 1 }}</label>
            <select
              :id="`rule-weekday-${index}`"
              v-model.number="rule.weekday"
              :disabled="!offline.mutationsEnabled"
              @change="markDirty"
            >
              <option v-for="day in WEEKDAYS" :key="day.value" :value="day.value">{{ day.label }}</option>
            </select>
            <label class="sr-only" :for="`rule-start-${index}`">Start for rule {{ index + 1 }}</label>
            <input
              :id="`rule-start-${index}`"
              v-model="rule.startLocal"
              type="time"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
            <label class="sr-only" :for="`rule-end-${index}`">End for rule {{ index + 1 }}</label>
            <input
              :id="`rule-end-${index}`"
              v-model="rule.endLocal"
              type="time"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
            <label class="sr-only" :for="`rule-kind-${index}`">Kind for rule {{ index + 1 }}</label>
            <select
              :id="`rule-kind-${index}`"
              v-model="rule.kind"
              :disabled="!offline.mutationsEnabled"
              @change="markDirty"
            >
              <option value="work">Work</option>
              <option value="focus">Focus</option>
            </select>
            <button
              type="button"
              class="link-button danger"
              :disabled="!offline.mutationsEnabled"
              @click="removeRule(index)"
            >
              Remove rule {{ index + 1 }}
            </button>
          </div>
        </div>
        <button type="button" :disabled="!offline.mutationsEnabled" @click="addRule">
          Add weekly rule
        </button>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Exceptions</legend>
        <p class="muted">A dated exception either removes availability (off) or adds a window (extra).</p>
        <div v-if="draft.exceptions.length === 0" class="muted">No exceptions.</div>
        <div
          v-for="(exception, index) in draft.exceptions"
          :key="`exception-${index}`"
          class="rule-row exception-row"
        >
          <label class="sr-only" :for="`exception-date-${index}`">Date for exception {{ index + 1 }}</label>
          <input
            :id="`exception-date-${index}`"
            v-model="exception.date"
            type="date"
            :disabled="!offline.mutationsEnabled"
            @input="markDirty"
          />
          <label class="sr-only" :for="`exception-kind-${index}`">Kind for exception {{ index + 1 }}</label>
          <select
            :id="`exception-kind-${index}`"
            v-model="exception.kind"
            :disabled="!offline.mutationsEnabled"
            @change="markDirty"
          >
            <option value="off">Off</option>
            <option value="extra">Extra</option>
          </select>
          <label class="sr-only" :for="`exception-start-${index}`">Start for exception {{ index + 1 }}</label>
          <input
            :id="`exception-start-${index}`"
            v-model="exception.startLocal"
            type="time"
            :disabled="!offline.mutationsEnabled"
            @input="markDirty"
          />
          <label class="sr-only" :for="`exception-end-${index}`">End for exception {{ index + 1 }}</label>
          <input
            :id="`exception-end-${index}`"
            v-model="exception.endLocal"
            type="time"
            :disabled="!offline.mutationsEnabled"
            @input="markDirty"
          />
          <button
            type="button"
            class="link-button danger"
            :disabled="!offline.mutationsEnabled"
            @click="removeException(index)"
          >
            Remove exception {{ index + 1 }}
          </button>
        </div>
        <button type="button" :disabled="!offline.mutationsEnabled" @click="addException">
          Add exception
        </button>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Focus preferences</legend>
        <div class="prefs-grid">
          <label for="pref-max-focus">Max daily focus (minutes)</label>
          <input
            id="pref-max-focus"
            v-model.number="draft.prefs.maxDailyFocusMin"
            type="number"
            min="0"
            step="5"
            :disabled="!offline.mutationsEnabled"
            @input="markDirty"
          />
          <label for="pref-break-after">Break after (minutes)</label>
          <input
            id="pref-break-after"
            v-model.number="draft.prefs.breakAfterMin"
            type="number"
            min="0"
            step="5"
            :disabled="!offline.mutationsEnabled"
            @input="markDirty"
          />
          <label for="pref-break">Break length (minutes)</label>
          <input
            id="pref-break"
            v-model.number="draft.prefs.breakMin"
            type="number"
            min="0"
            step="5"
            :disabled="!offline.mutationsEnabled"
            @input="markDirty"
          />
          <label for="pref-day-start">Day start</label>
          <input
            id="pref-day-start"
            v-model="draft.prefs.dayStartLocal"
            type="time"
            :disabled="!offline.mutationsEnabled"
            @input="markDirty"
          />
          <label for="pref-day-end">Day end</label>
          <input
            id="pref-day-end"
            v-model="draft.prefs.dayEndLocal"
            type="time"
            :disabled="!offline.mutationsEnabled"
            @input="markDirty"
          />
          <label for="pref-risk">Risk level</label>
          <select
            id="pref-risk"
            v-model="draft.prefs.riskLevel"
            :disabled="!offline.mutationsEnabled"
            @change="markDirty"
          >
            <option value="p50">P50 (typical)</option>
            <option value="p90">P90 (safe)</option>
          </select>
        </div>
      </fieldset>

      <ul v-if="validationErrors.length > 0" class="violation-list" aria-live="polite">
        <li v-for="failure in validationErrors" :key="failure" class="error-text">{{ failure }}</li>
      </ul>

      <div class="form-actions">
        <button id="availability-save" type="submit" class="primary-action" :disabled="!canSave">
          {{ saving ? 'Saving…' : 'Save availability' }}
        </button>
        <span class="muted">Version {{ draft.version }} · {{ dirty ? 'Unsaved changes' : 'Saved' }}</span>
      </div>
    </form>

    <div
      v-if="conflict"
      class="dialog-backdrop"
      role="presentation"
      @click.self="conflict = null"
    >
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="availability-conflict-title">
        <h2 id="availability-conflict-title" ref="conflictHeading" tabindex="-1">
          Availability changed elsewhere
        </h2>
        <p>
          The server is at version {{ conflict.server.version }}. Your local edits are preserved
          until you choose. Review the server rules before merging.
        </p>
        <dl class="conflict-summary">
          <dt>Local rules</dt>
          <dd>{{ conflict.local.rules.length }}</dd>
          <dt>Server rules</dt>
          <dd>{{ conflict.server.rules.length }}</dd>
          <dt>Local time zone</dt>
          <dd>{{ conflict.local.timeZone }}</dd>
          <dt>Server time zone</dt>
          <dd>{{ conflict.server.timeZone }}</dd>
        </dl>
        <div class="dialog-actions">
          <button type="button" class="primary-action" :disabled="!offline.mutationsEnabled" @click="keepLocal">
            Keep my changes and retry
          </button>
          <button type="button" @click="useServer">Use server version</button>
          <button type="button" class="link-button" @click="conflict = null">Keep editing</button>
        </div>
      </div>
    </div>
  </section>
</template>
