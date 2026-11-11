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
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { t } from '../i18n';
import { errorMessage } from '../i18n/problem';

const offline = useOfflineStore();
const queryClient = useQueryClient();
const actions = new ActionStore();

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

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
  if (rule.endLocal < rule.startLocal) return t('availability.ruleEndError', { index: index + 1 });
  return null;
}

function exceptionError(exception: AvailabilityException, index: number): string | null {
  if (exception.date.length === 0) return t('availability.exceptionDateError', { index: index + 1 });
  if (
    exception.startLocal !== undefined &&
    exception.endLocal !== undefined &&
    exception.endLocal <= exception.startLocal
  ) {
    return t('availability.exceptionEndError', { index: index + 1 });
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
    message.value = t('availability.savedMessage', { version: updated.version });
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
    error.value = errorMessage(cause, t('availability.saveError'));
  } finally {
    saving.value = false;
  }
}

function keepLocal(): void {
  if (conflict.value === null) return;
  draft.value = { ...conflict.value.local, version: conflict.value.server.version };
  conflict.value = null;
  dirty.value = true;
  message.value = t('availability.keptLocal');
  void nextTick().then(() => document.getElementById('availability-save')?.focus());
}

function useServer(): void {
  if (conflict.value === null) return;
  draft.value = cloneAvailability(conflict.value.server);
  conflict.value = null;
  dirty.value = false;
  message.value = t('availability.usedServer');
}

function retry(): void {
  void reload();
}
</script>

<template>
  <section class="page page--wide availability-page">
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('availability.title') }}</h1>
        <p class="page-lede">{{ t('availability.lede') }}</p>
      </div>
    </header>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" class="offline-note" role="status">
      {{ t('availability.offline') }}
    </UiBanner>
    <p class="status-region status-note" role="status" aria-live="polite">{{ message }}</p>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <div v-if="availabilityQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('availability.loading') }}</p>
      <UiSkeleton variant="card" :count="3" :lines="3" />
    </div>
    <UiBanner v-else-if="availabilityQuery.isError.value" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('availability.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="retry">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <form v-else-if="draft" class="settings-form" @submit.prevent="save">
      <fieldset class="settings-group">
        <legend>{{ t('availability.timeZone') }}</legend>
        <UiField id="availability-timezone" :label="t('availability.timeZoneLabel')" class="field--narrow">
          <select
            id="availability-timezone"
            v-model="draft.timeZone"
            :disabled="!offline.mutationsEnabled"
            @change="markDirty"
          >
            <option v-for="zone in timeZones" :key="zone" :value="zone">{{ zone }}</option>
          </select>
        </UiField>
      </fieldset>

      <fieldset class="settings-group">
        <legend>{{ t('availability.rules') }}</legend>
        <p class="muted">{{ t('availability.rulesLede') }}</p>
        <div class="rule-table" role="table" :aria-label="t('availability.rulesTable')">
          <div class="rule-row rule-head" role="row">
            <span role="columnheader">{{ t('availability.colWeekday') }}</span>
            <span role="columnheader">{{ t('availability.colStart') }}</span>
            <span role="columnheader">{{ t('availability.colEnd') }}</span>
            <span role="columnheader">{{ t('availability.colKind') }}</span>
            <span role="columnheader"><span class="visually-hidden">{{ t('availability.colActions') }}</span></span>
          </div>
          <div
            v-for="(rule, index) in draft.rules"
            :key="`rule-${index}`"
            class="rule-row"
            role="row"
          >
            <div role="cell" class="rule-cell rule-cell--weekday">
              <label class="sr-only" :for="`rule-weekday-${index}`">{{ t('availability.ruleWeekday', { index: index + 1 }) }}</label>
              <select
                :id="`rule-weekday-${index}`"
                v-model.number="rule.weekday"
                :disabled="!offline.mutationsEnabled"
                @change="markDirty"
              >
                <option v-for="day in WEEKDAYS" :key="day" :value="day">{{ t(`availability.weekday.${day}`) }}</option>
              </select>
            </div>
            <div role="cell" class="rule-cell">
              <label class="sr-only" :for="`rule-start-${index}`">{{ t('availability.ruleStart', { index: index + 1 }) }}</label>
              <input
                :id="`rule-start-${index}`"
                v-model="rule.startLocal"
                type="time"
                :disabled="!offline.mutationsEnabled"
                @input="markDirty"
              />
            </div>
            <div role="cell" class="rule-cell">
              <label class="sr-only" :for="`rule-end-${index}`">{{ t('availability.ruleEnd', { index: index + 1 }) }}</label>
              <input
                :id="`rule-end-${index}`"
                v-model="rule.endLocal"
                type="time"
                :disabled="!offline.mutationsEnabled"
                @input="markDirty"
              />
            </div>
            <div role="cell" class="rule-cell">
              <label class="sr-only" :for="`rule-kind-${index}`">{{ t('availability.ruleKind', { index: index + 1 }) }}</label>
              <select
                :id="`rule-kind-${index}`"
                v-model="rule.kind"
                :disabled="!offline.mutationsEnabled"
                @change="markDirty"
              >
                <option value="work">{{ t('availability.kindWork') }}</option>
                <option value="focus">{{ t('availability.kindFocus') }}</option>
              </select>
            </div>
            <div role="cell" class="rule-cell rule-cell--action">
              <UiButton
                variant="danger-ghost"
                size="sm"
                icon="trash"
                class="link-button danger"
                :disabled="!offline.mutationsEnabled"
                @click="removeRule(index)"
              >
                <span class="visually-hidden">{{ t('availability.ruleRemovePrefix', { index: index + 1 }) }}</span
                >{{ t('common.remove') }}
              </UiButton>
            </div>
          </div>
        </div>
        <div>
          <UiButton icon="plus" size="sm" :disabled="!offline.mutationsEnabled" @click="addRule">
            {{ t('availability.addRule') }}
          </UiButton>
        </div>
      </fieldset>

      <fieldset class="settings-group">
        <legend>{{ t('availability.exceptions') }}</legend>
        <p class="muted">{{ t('availability.exceptionsLede') }}</p>
        <UiEmptyState
          v-if="draft.exceptions.length === 0"
          compact
          icon="today"
          :title="t('availability.exceptionsEmpty')"
        />
        <div
          v-for="(exception, index) in draft.exceptions"
          :key="`exception-${index}`"
          class="rule-row exception-row"
        >
          <div class="rule-cell rule-cell--weekday">
            <label class="sr-only" :for="`exception-date-${index}`">{{ t('availability.exceptionDate', { index: index + 1 }) }}</label>
            <input
              :id="`exception-date-${index}`"
              v-model="exception.date"
              type="date"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
          </div>
          <div class="rule-cell">
            <label class="sr-only" :for="`exception-kind-${index}`">{{ t('availability.exceptionKind', { index: index + 1 }) }}</label>
            <select
              :id="`exception-kind-${index}`"
              v-model="exception.kind"
              :disabled="!offline.mutationsEnabled"
              @change="markDirty"
            >
              <option value="off">{{ t('availability.kindOff') }}</option>
              <option value="extra">{{ t('availability.kindExtra') }}</option>
            </select>
          </div>
          <div class="rule-cell">
            <label class="sr-only" :for="`exception-start-${index}`">{{ t('availability.exceptionStart', { index: index + 1 }) }}</label>
            <input
              :id="`exception-start-${index}`"
              v-model="exception.startLocal"
              type="time"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
          </div>
          <div class="rule-cell">
            <label class="sr-only" :for="`exception-end-${index}`">{{ t('availability.exceptionEnd', { index: index + 1 }) }}</label>
            <input
              :id="`exception-end-${index}`"
              v-model="exception.endLocal"
              type="time"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
          </div>
          <div class="rule-cell rule-cell--action">
            <UiButton
              variant="danger-ghost"
              size="sm"
              icon="trash"
              class="link-button danger"
              :disabled="!offline.mutationsEnabled"
              @click="removeException(index)"
            >
              <span class="visually-hidden">{{ t('availability.exceptionRemovePrefix', { index: index + 1 }) }}</span
              >{{ t('common.remove') }}
            </UiButton>
          </div>
        </div>
        <div>
          <UiButton icon="plus" size="sm" :disabled="!offline.mutationsEnabled" @click="addException">
            {{ t('availability.addException') }}
          </UiButton>
        </div>
      </fieldset>

      <fieldset class="settings-group">
        <legend>{{ t('availability.prefs') }}</legend>
        <div class="prefs-grid">
          <UiField id="pref-max-focus" :label="t('availability.maxDailyFocus')">
            <input
              id="pref-max-focus"
              v-model.number="draft.prefs.maxDailyFocusMin"
              type="number"
              min="0"
              step="5"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
          </UiField>
          <UiField id="pref-break-after" :label="t('availability.breakAfter')">
            <input
              id="pref-break-after"
              v-model.number="draft.prefs.breakAfterMin"
              type="number"
              min="0"
              step="5"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
          </UiField>
          <UiField id="pref-break" :label="t('availability.breakLength')">
            <input
              id="pref-break"
              v-model.number="draft.prefs.breakMin"
              type="number"
              min="0"
              step="5"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
          </UiField>
          <UiField id="pref-day-start" :label="t('availability.dayStart')">
            <input
              id="pref-day-start"
              v-model="draft.prefs.dayStartLocal"
              type="time"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
          </UiField>
          <UiField id="pref-day-end" :label="t('availability.dayEnd')">
            <input
              id="pref-day-end"
              v-model="draft.prefs.dayEndLocal"
              type="time"
              :disabled="!offline.mutationsEnabled"
              @input="markDirty"
            />
          </UiField>
          <UiField id="pref-risk" :label="t('availability.riskLevel')">
            <select
              id="pref-risk"
              v-model="draft.prefs.riskLevel"
              :disabled="!offline.mutationsEnabled"
              @change="markDirty"
            >
              <option value="p50">{{ t('availability.riskP50') }}</option>
              <option value="p90">{{ t('availability.riskP90') }}</option>
            </select>
          </UiField>
        </div>
      </fieldset>

      <ul v-if="validationErrors.length > 0" class="violation-list" aria-live="polite">
        <li v-for="failure in validationErrors" :key="failure" class="error-text">
          <UiIcon name="error" :size="16" /> {{ failure }}
        </li>
      </ul>

      <div class="form-actions form-actions--sticky">
        <UiButton id="availability-save" type="submit" variant="primary" :busy="saving" :disabled="!canSave">
          {{ saving ? t('common.saving') : t('availability.save') }}
        </UiButton>
        <UiBadge :tone="dirty ? 'warn' : 'success'" dot>
          {{
            t('availability.status', {
              version: draft.version,
              state: dirty ? t('availability.unsaved') : t('availability.saved'),
            })
          }}
        </UiBadge>
      </div>
    </form>

    <UiDialog
      v-if="conflict"
      role="alertdialog"
      labelledby="availability-conflict-title"
      close-on-backdrop
      @close="conflict = null"
    >
      <header class="dialog-header dialog-header--start">
        <span class="dialog-icon dialog-icon--warn"><UiIcon name="sync" :size="22" /></span>
        <div class="dialog-heading">
          <h2 id="availability-conflict-title" ref="conflictHeading" class="dialog-title" tabindex="-1">
            {{ t('availability.conflictTitle') }}
          </h2>
          <p class="muted">{{ t('availability.conflictBody', { version: conflict.server.version }) }}</p>
        </div>
      </header>
      <dl class="conflict-summary">
        <dt>{{ t('availability.localRules') }}</dt>
        <dd>{{ conflict.local.rules.length }}</dd>
        <dt>{{ t('availability.serverRules') }}</dt>
        <dd>{{ conflict.server.rules.length }}</dd>
        <dt>{{ t('availability.localTimeZone') }}</dt>
        <dd>{{ conflict.local.timeZone }}</dd>
        <dt>{{ t('availability.serverTimeZone') }}</dt>
        <dd>{{ conflict.server.timeZone }}</dd>
      </dl>
      <div class="dialog-actions dialog-actions--start">
        <UiButton variant="primary" :disabled="!offline.mutationsEnabled" @click="keepLocal">
          {{ t('availability.keepLocal') }}
        </UiButton>
        <UiButton @click="useServer">{{ t('availability.useServer') }}</UiButton>
        <UiButton variant="ghost" @click="conflict = null">{{ t('availability.keepEditing') }}</UiButton>
      </div>
    </UiDialog>
  </section>
</template>
