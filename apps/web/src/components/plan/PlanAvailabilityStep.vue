<script setup lang="ts">
import { computed } from 'vue';
import type { AvailabilityRule } from '../../api';
import { weekTotals } from '../../domain/availabilityGrid';
import { AVAILABILITY_PRESETS, applyPreset, presetActive, removePreset, type AvailabilityPreset } from '../../domain/availabilityPresets';
import { t } from '../../i18n';
import { formatHoursAndMinutes } from '../../i18n/format';
import AvailabilityWeekGrid from '../AvailabilityWeekGrid.vue';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * "언제 일할 수 있나요?" (HOLO-03A, FLOW §2): asked inside 계획 세우기 when
 * the owner has no available hours yet, so nobody is sent to a settings
 * screen to get ready. Three quick answers (each paints its hours) and the
 * 가용 시간 screen's own grid under "직접 칠하기".
 *
 * It only edits `rules`; the screen saves them — together with making the
 * plan, through the availability route (If-Match + Idempotency-Key).
 */
const props = withDefaults(defineProps<{ rules: AvailabilityRule[]; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ 'update:rules': [rules: AvailabilityRule[]] }>();

const total = computed(() => weekTotals(props.rules).total);

function toggle(preset: AvailabilityPreset): void {
  emit('update:rules', presetActive(props.rules, preset) ? removePreset(props.rules, preset) : applyPreset(props.rules, preset));
}
</script>

<template>
  <UiCard class="plan-prep plan-prep--hours" aria-labelledby="plan-hours-title" data-plan-hours>
    <header class="card-header">
      <h2 id="plan-hours-title" class="card-title"><UiIcon name="availability" :size="18" />{{ t('planScope.availability.title') }}</h2>
      <p class="plan-prep-total tabular" role="status" data-plan-hours-total>
        {{ total > 0 ? t('planScope.availability.total', { duration: formatHoursAndMinutes(total) }) : t('planScope.availability.none') }}
      </p>
    </header>
    <p class="plan-prep-lede">{{ t('planScope.availability.lede') }}</p>

    <fieldset class="choice-group plan-presets" :disabled="disabled">
      <legend class="visually-hidden">{{ t('planScope.availability.presets') }}</legend>
      <label v-for="preset in AVAILABILITY_PRESETS" :key="preset.id" class="choice-chip plan-preset">
        <input
          type="checkbox"
          :checked="presetActive(rules, preset)"
          :data-preset="preset.id"
          @change="toggle(preset)"
        />
        <span class="plan-preset-text">
          <span class="plan-preset-name">{{ t(`planScope.availability.preset.${preset.id}`) }}</span>
          <span class="plan-preset-hint tabular">{{ t(`planScope.availability.preset.${preset.id}Hint`) }}</span>
        </span>
      </label>
    </fieldset>

    <details class="plan-paint" data-plan-hours-paint>
      <summary>{{ t('planScope.availability.paint') }}</summary>
      <AvailabilityWeekGrid :rules="rules" :readonly="disabled" @update:rules="emit('update:rules', $event)" />
    </details>
    <p class="field-help">{{ t('planScope.availability.later') }}</p>
  </UiCard>
</template>
