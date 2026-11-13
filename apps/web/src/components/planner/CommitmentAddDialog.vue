<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue';
import { useQueryClient, type QueryKey } from '@tanstack/vue-query';
import { ActionStore, plannerClient, type CommitmentCreate } from '../../api';
import type { DraftFormValues } from '../../domain/commitmentDraft';
import { weeklyDaysFromRrule, weeklyRrule, type WeekdayCode } from '../../domain/rrule';
import { instantFromLocalInput, localParts } from '../../domain/time';
import { t } from '../../i18n';
import { errorMessage } from '../../i18n/problem';
import { layoutClock } from '../../layout/clock';
import { runOwnerBound } from '../../session/ownerBound';
import { useOfflineStore } from '../../stores/offline';
import { useToastStore } from '../../stores/toast';
import CommitmentParseSection from '../CommitmentParseSection.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiField from '../ui/UiField.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 약속 추가 (HOLO-02): the planner's one primary action. Two ways in, in one
 * dialog — 말로 적기 on top (the 약속 screen's own section and flow, CAL-02)
 * and the fields under "직접 입력". Both save with the ordinary create call
 * (`POST /commitments`) and then refresh every list the planner draws from.
 *
 * - 직접 입력 shows what a person fills in: a title, when it starts and ends,
 *   and the weekdays it repeats on. The time zone and the raw rule are behind
 *   "고급"; they start from the owner's zone and from the weekdays picked.
 * - One filled button: 말로 적기's next step, or 약속 추가 once the manual
 *   fields are in use (a title typed, or a draft sent here with 고치기).
 * - Owner isolation (ADR-023): the save runs as an owner-bound task.
 */
const props = defineProps<{
  /** The owner's zone: what the times are read in. */
  timeZone: string;
  /** The day the planner is on (`YYYY-MM-DD`): the new 약속 starts there. */
  date: string;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

/** Everything on the planner that shows a 약속. */
const PLANNER_QUERIES: readonly QueryKey[] = [['planner-range'], ['day-agenda']];
const DAYS: readonly WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const offline = useOfflineStore();
const toast = useToastStore();
const queryClient = useQueryClient();
const actions = new ActionStore();

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** On today: the next full hour (not past 23:00); on another day: 09:00. One hour long. */
function defaultTimes(): { start: string; end: string } {
  const now = localParts(new Date(layoutClock().now()).toISOString(), props.timeZone);
  const hour = now.date === props.date ? Math.min(23, now.hour + 1) : 9;
  const endHour = Math.min(23, hour + 1);
  return {
    start: `${props.date}T${pad(hour)}:00`,
    end: `${props.date}T${pad(endHour)}:${endHour === hour ? '59' : '00'}`,
  };
}

const initial = defaultTimes();
const form = reactive({
  title: '',
  startLocal: initial.start,
  endLocal: initial.end,
  timeZone: props.timeZone,
  rrule: '',
});
const errors = reactive({ title: null as string | null, times: null as string | null });
const error = ref<string | null>(null);
const busy = ref(false);
const manualHeading = ref<HTMLElement | null>(null);
const advanced = ref<HTMLDetailsElement | null>(null);

const presetDays = computed<WeekdayCode[]>(() => weeklyDaysFromRrule(form.rrule));
/** The manual fields hold the dialog's filled button once they are in use. */
const manualActive = computed(() => form.title.trim().length > 0);

function toggleDay(code: WeekdayCode): void {
  const selected = new Set<WeekdayCode>(presetDays.value);
  if (selected.has(code)) selected.delete(code);
  else selected.add(code);
  form.rrule = weeklyRrule([...selected]);
}

/** 고치기 on a read draft: it opens in the manual fields as a new 약속. */
function fromDraft(values: DraftFormValues): void {
  form.title = values.title;
  form.startLocal = values.startLocal;
  form.endLocal = values.endLocal;
  form.timeZone = values.timeZone;
  form.rrule = values.rrule;
  errors.title = null;
  errors.times = null;
  error.value = null;
  // A rule the weekday chips cannot say is shown where it can be read.
  if (values.rrule.length > 0 && weeklyDaysFromRrule(values.rrule).length === 0 && advanced.value !== null) {
    advanced.value.open = true;
  }
  void nextTick(() => manualHeading.value?.focus());
}

function instants(): { startAt: string; endAt: string } | null {
  try {
    return {
      startAt: instantFromLocalInput(form.startLocal, form.timeZone),
      endAt: instantFromLocalInput(form.endLocal, form.timeZone),
    };
  } catch {
    return null;
  }
}

async function save(): Promise<void> {
  if (!offline.mutationsEnabled || busy.value) return;
  errors.title = form.title.trim().length === 0 ? t('commitments.titleRequired') : null;
  const range = instants();
  if (range === null) errors.times = t('commitments.invalidTimes');
  else if (Date.parse(range.endAt) <= Date.parse(range.startAt)) errors.times = t('commitments.endAfterStart');
  else errors.times = null;
  if (errors.title !== null || errors.times !== null || range === null) {
    void nextTick(() => document.getElementById(errors.title !== null ? 'planner-commitment-title' : 'planner-commitment-end')?.focus());
    return;
  }
  const rule = form.rrule.trim();
  const input: CommitmentCreate = {
    title: form.title.trim(),
    startAt: range.startAt,
    endAt: range.endAt,
    timeZone: form.timeZone,
    ...(rule.length === 0 ? {} : { rrule: rule }),
  };
  busy.value = true;
  error.value = null;
  const scope = 'planner:commitment:create';
  const action = actions.begin(scope, input, (left, right) => JSON.stringify(left) === JSON.stringify(right));
  await runOwnerBound(
    function* (owner) {
      try {
        yield* owner.wait(plannerClient.createCommitment(action.payload, action.key));
        actions.settle(scope, action);
        for (const queryKey of [['commitments'], ['availability'], ...PLANNER_QUERIES]) {
          yield queryClient.invalidateQueries({ queryKey });
        }
        toast.show(t('planner.add.saved', { title: input.title }));
        emit('saved');
        emit('close');
      } catch (cause) {
        error.value = errorMessage(cause, t('commitments.saveError'));
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
  <UiDialog labelledby="planner-add-title" size="lg" class="planner-add" :dismissible="!busy" data-planner-add-dialog @close="emit('close')">
    <header class="dialog-header">
      <div class="dialog-heading">
        <h2 id="planner-add-title" class="dialog-title">{{ t('planner.add.title') }}</h2>
        <p class="muted">{{ t('planner.add.lede') }}</p>
      </div>
      <button type="button" class="btn btn--ghost btn--icon" :aria-label="t('common.close')" :disabled="busy" @click="emit('close')">
        <UiIcon name="close" />
      </button>
    </header>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" inline role="status" data-planner-add-offline>
      {{ t('commitments.offline') }}
    </UiBanner>

    <CommitmentParseSection
      :manual-active="manualActive"
      :also-refresh="PLANNER_QUERIES"
      :heading-level="3"
      class="planner-add-parse"
      @edit="fromDraft"
    />

    <form class="planner-add-manual" novalidate data-planner-add-manual @submit.prevent="save">
      <h3 ref="manualHeading" class="settings-group-title planner-add-manual-title" tabindex="-1">
        {{ t('commitments.manualHeading') }}
      </h3>
      <UiField id="planner-commitment-title" :label="t('commitments.titleLabel')" :error="errors.title">
        <template #default="{ describedby, invalid }">
          <input
            id="planner-commitment-title"
            v-model="form.title"
            type="text"
            maxlength="200"
            :placeholder="t('commitments.titlePlaceholder')"
            :aria-describedby="describedby"
            :aria-invalid="invalid"
            :disabled="!offline.mutationsEnabled"
          />
        </template>
      </UiField>
      <div class="field-grid">
        <UiField id="planner-commitment-start" :label="t('planner.add.start')">
          <input
            id="planner-commitment-start"
            v-model="form.startLocal"
            type="datetime-local"
            :disabled="!offline.mutationsEnabled"
          />
        </UiField>
        <UiField id="planner-commitment-end" :label="t('planner.add.end')" :error="errors.times">
          <template #default="{ describedby, invalid }">
            <input
              id="planner-commitment-end"
              v-model="form.endLocal"
              type="datetime-local"
              :aria-describedby="describedby"
              :aria-invalid="invalid"
              :disabled="!offline.mutationsEnabled"
            />
          </template>
        </UiField>
      </div>
      <fieldset class="choice-group day-choices planner-add-days">
        <legend>{{ t('planner.add.repeat') }}</legend>
        <label v-for="day in DAYS" :key="day" class="choice-chip">
          <input
            type="checkbox"
            :checked="presetDays.includes(day)"
            :disabled="!offline.mutationsEnabled"
            :data-planner-add-day="day"
            @change="toggleDay(day)"
          />
          {{ t(`commitments.day.${day}`) }}
        </label>
      </fieldset>
      <details ref="advanced" class="planner-add-advanced" data-planner-add-advanced>
        <summary>{{ t('planner.add.advanced') }}</summary>
        <div class="planner-add-advanced-body">
          <UiField id="planner-commitment-timezone" :label="t('commitments.timeZone')">
            <input
              id="planner-commitment-timezone"
              v-model="form.timeZone"
              type="text"
              :disabled="!offline.mutationsEnabled"
            />
          </UiField>
          <UiField id="planner-commitment-rrule" :label="t('commitments.rrule')" :help="t('commitments.rruleHelp')">
            <template #default="{ describedby }">
              <input
                id="planner-commitment-rrule"
                v-model="form.rrule"
                type="text"
                class="mono-input"
                placeholder="FREQ=WEEKLY;BYDAY=MO,WE"
                :aria-describedby="describedby"
                :disabled="!offline.mutationsEnabled"
              />
            </template>
          </UiField>
        </div>
      </details>

      <UiBanner v-if="error" tone="error" role="alert" data-planner-add-error>{{ error }}</UiBanner>

      <div class="dialog-actions">
        <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</UiButton>
        <UiButton
          type="submit"
          :variant="manualActive ? 'primary' : 'secondary'"
          :busy="busy"
          :disabled="!offline.mutationsEnabled || busy"
          data-planner-add-save
        >
          {{ busy ? t('common.saving') : t('planner.add.save') }}
        </UiButton>
      </div>
    </form>
  </UiDialog>
</template>
