<script setup lang="ts">
import { t } from '../../i18n';
import I18nT from '../../i18n/I18nT';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 계획 세우기 · 질문 (HOLO-03A): the one question that comes before the
 * others — the AI found an earlier kind of work that looks like this one.
 * Saying yes takes that kind's steps as the draft; saying no goes on to the
 * questions. How sure it is and why are shown, never hidden.
 */
defineProps<{
  /** The name of the kind of work it resembles. */
  templateName: string;
  /** `0.82` → "82%". */
  confidenceText: string;
  /** 0..1, for the meter. */
  confidence: number;
  reasons: readonly { readonly key: string; readonly text: string; readonly lang: string | undefined }[];
  /** The kind is known and can be taken over. */
  canAccept: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ confirm: [similar: boolean] }>();
</script>

<template>
  <UiCard class="plan-type" aria-labelledby="plan-type-title" data-plan-type>
    <h2 id="plan-type-title" class="card-title"><UiIcon name="pattern" :size="18" />{{ t('planAsk.type.title') }}</h2>
    <p class="plan-type-body">
      <I18nT keypath="planAsk.type.body">
        <template #template><strong>{{ templateName }}</strong></template>
        <template #confidence><strong class="tabular">{{ confidenceText }}</strong></template>
      </I18nT>
    </p>
    <div class="meter plan-type-meter" :style="{ '--value': confidence }" aria-hidden="true">
      <span class="meter-fill"></span>
    </div>
    <ul v-if="reasons.length > 0" class="plan-type-reasons" :aria-label="t('planAsk.type.reasons')">
      <li v-for="reason in reasons" :key="reason.key" class="chip" :lang="reason.lang">{{ reason.text }}</li>
    </ul>
    <p class="plan-type-question">{{ t('planAsk.type.question') }}</p>
    <div class="plan-stage-actions">
      <UiButton :disabled="disabled" data-plan-type-no @click="emit('confirm', false)">{{ t('planAsk.type.no') }}</UiButton>
      <UiButton variant="primary" icon="check" :disabled="disabled || !canAccept" data-plan-type-yes @click="emit('confirm', true)">
        {{ t('planAsk.type.yes') }}
      </UiButton>
    </div>
  </UiCard>
</template>
