<script setup lang="ts">
import type { IntakeAssumption } from '../../api';
import { t } from '../../i18n';
import { assumptionValueText } from '../../i18n/server';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 계획 세우기 (HOLO-03A): what the planner took for granted because a
 * question was skipped, answered "모름" or never asked — said plainly beside
 * the steps it shaped, so nothing is assumed in silence.
 */
defineProps<{ assumptions: readonly IntakeAssumption[] }>();

const REASONS = ['skip', 'idk', 'unanswered'] as const;

function reasonLabel(reason: string): string {
  return (REASONS as readonly string[]).includes(reason)
    ? t(`planAsk.assumptionReasons.${reason as (typeof REASONS)[number]}`)
    : reason;
}
</script>

<template>
  <UiCard v-if="assumptions.length > 0" compact class="plan-assumptions" aria-labelledby="plan-assumptions-title" data-plan-assumptions>
    <h2 id="plan-assumptions-title" class="card-title"><UiIcon name="info" :size="18" />{{ t('planAsk.assumptions') }}</h2>
    <dl class="plan-assumption-list">
      <div v-for="assumption in assumptions" :key="assumption.field" class="plan-assumption" :data-assumption="assumption.field">
        <dt>
          {{ t(`planAsk.fields.${assumption.field}`) }}
          <span class="chip">{{ reasonLabel(assumption.reason) }}</span>
        </dt>
        <dd>{{ assumptionValueText(assumption.field, assumption.value).text }}</dd>
      </div>
    </dl>
  </UiCard>
</template>
