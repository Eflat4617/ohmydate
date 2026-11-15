<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { IntakeAnswerInput, IntakeField, PlannedQuestion } from '../../api';
import { t } from '../../i18n';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 계획 세우기 · 질문 (HOLO-03A): the few things the AI asks, answered in one
 * go. A question left blank is skipped; "모름" is an answer of its own (the
 * planner then takes a cautious default and says which). One button sends
 * them all and goes on to the steps.
 *
 * It only says what was answered (`submit`); the screen sends it.
 */
const props = withDefaults(defineProps<{ questions: readonly PlannedQuestion[]; busy?: boolean; disabled?: boolean }>(), {
  busy: false,
  disabled: false,
});
const emit = defineEmits<{ submit: [answers: IntakeAnswerInput[]] }>();

const SCOPES = ['small', 'medium', 'large'] as const;

const text = reactive<Record<string, string>>({});
const flag = reactive<Record<string, boolean>>({});
const unknown = reactive<Record<string, boolean>>({});

// A new round of questions starts with nothing filled in for it.
watch(
  () => props.questions.map((question) => question.field).join(','),
  () => {
    for (const key of Object.keys(text)) delete text[key];
    for (const key of Object.keys(flag)) delete flag[key];
    for (const key of Object.keys(unknown)) delete unknown[key];
  },
);

type Kind = 'boolean' | 'number' | 'scope' | 'text';

function kindOf(field: IntakeField): Kind {
  if (field === 'availabilityConfirmed' || field === 'reviewNeeded') return 'boolean';
  if (field === 'priority' || field === 'maxFocusMinutes') return 'number';
  if (field === 'estimatedScope') return 'scope';
  return 'text';
}

/** What a question's answer is: a value, "모름", or nothing (skipped). */
function answerOf(question: PlannedQuestion): IntakeAnswerInput {
  const field = question.field;
  if (unknown[field] === true) return { questionKey: field, action: 'idk' };
  const kind = kindOf(field);
  if (kind === 'boolean') {
    return flag[field] === true ? { questionKey: field, action: 'answer', value: true } : { questionKey: field, action: 'skip' };
  }
  const raw = (text[field] ?? '').trim();
  if (raw.length === 0) return { questionKey: field, action: 'skip' };
  if (kind === 'number') {
    const value = Number(raw);
    return Number.isFinite(value) ? { questionKey: field, action: 'answer', value } : { questionKey: field, action: 'skip' };
  }
  return { questionKey: field, action: 'answer', value: raw };
}

function submit(): void {
  if (props.disabled || props.busy || props.questions.length === 0) return;
  emit(
    'submit',
    props.questions.map((question) => answerOf(question)),
  );
}

function setUnknown(field: IntakeField, event: Event): void {
  unknown[field] = event.target instanceof HTMLInputElement && event.target.checked;
}
</script>

<template>
  <UiCard as="form" class="plan-questions" aria-labelledby="plan-questions-title" data-plan-questions @submit.prevent="submit">
    <header class="plan-stage-head">
      <h2 id="plan-questions-title" class="card-title"><UiIcon name="ai" :size="18" />{{ t('planAsk.title') }}</h2>
      <p class="plan-stage-lede">{{ t('planAsk.lede') }}</p>
    </header>

    <ol class="plan-question-list">
      <li v-for="question in questions" :key="question.field" class="plan-question" :data-question="question.field">
        <label class="plan-question-prompt" :for="`answer-${question.field}`">
          {{ t(`planAsk.questions.${question.field}`) }}
          <UiBadge v-if="question.required" tone="outline">{{ t('planAsk.required') }}</UiBadge>
        </label>
        <div class="plan-question-answer">
          <select
            v-if="kindOf(question.field) === 'scope'"
            :id="`answer-${question.field}`"
            v-model="text[question.field]"
            :disabled="disabled || busy || unknown[question.field]"
          >
            <option value="">{{ t('planAsk.choose') }}</option>
            <option v-for="scope in SCOPES" :key="scope" :value="scope">{{ t(`planAsk.scope.${scope}`) }}</option>
          </select>
          <label v-else-if="kindOf(question.field) === 'boolean'" class="choice-chip plan-question-yes">
            <input
              :id="`answer-${question.field}`"
              v-model="flag[question.field]"
              type="checkbox"
              :disabled="disabled || busy || unknown[question.field]"
            />
            {{ t('planAsk.yes') }}
          </label>
          <input
            v-else-if="kindOf(question.field) === 'number'"
            :id="`answer-${question.field}`"
            v-model="text[question.field]"
            type="number"
            inputmode="numeric"
            :disabled="disabled || busy || unknown[question.field]"
          />
          <input
            v-else
            :id="`answer-${question.field}`"
            v-model="text[question.field]"
            type="text"
            maxlength="2000"
            autocomplete="off"
            :disabled="disabled || busy || unknown[question.field]"
          />
          <label class="choice-chip plan-question-idk">
            <input
              type="checkbox"
              :checked="unknown[question.field] === true"
              :disabled="disabled || busy"
              :aria-label="t('planAsk.idkAria', { question: t(`planAsk.questions.${question.field}`) })"
              :data-idk="question.field"
              @change="setUnknown(question.field, $event)"
            />
            <span aria-hidden="true">{{ t('planAsk.idk') }}</span>
          </label>
        </div>
      </li>
    </ol>

    <div class="plan-stage-actions">
      <slot name="secondary" />
      <UiButton type="submit" variant="primary" icon="arrow-right" :busy="busy" :disabled="disabled || busy" data-plan-answer>
        {{ busy ? t('planAsk.submitting') : t('planAsk.submit') }}
      </UiButton>
    </div>
  </UiCard>
</template>
