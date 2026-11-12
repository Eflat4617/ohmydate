<script setup lang="ts">
import { ref } from 'vue';
import type { EstimationFeedback, SessionReviewRequest } from '../api';
import { t } from '../i18n';
import { formatDuration } from '../i18n/format';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiField from './ui/UiField.vue';
import UiIcon from './ui/UiIcon.vue';
import I18nT from '../i18n/I18nT';

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    busy?: boolean;
    error?: string | null;
    feedback?: EstimationFeedback | null;
  }>(),
  { disabled: false, busy: false, error: null, feedback: null },
);
const emit = defineEmits<{ submit: [review: SessionReviewRequest] }>();

const outcome = ref<'done' | 'partial' | 'blocked'>('done');
const chips = ref<string[]>([]);
const note = ref('');

const NOTE_MAX = 2000;

const reasons: SessionReviewRequest['reasonChips'][number][] = [
  'focus_lost',
  'interrupted',
  'task_larger',
  'task_smaller',
  'blocked_dependency',
  'low_energy',
  'other',
];

const outcomes: ('done' | 'partial' | 'blocked')[] = ['done', 'partial', 'blocked'];

function toggleChip(id: string, checked: boolean): void {
  chips.value = checked ? [...chips.value, id] : chips.value.filter((item) => item !== id);
}

function submit(): void {
  const trimmed = note.value.trim();
  emit('submit', {
    outcome: outcome.value,
    reasonChips: [...chips.value] as SessionReviewRequest['reasonChips'],
    ...(trimmed.length === 0 ? {} : { note: trimmed }),
  });
}
</script>

<template>
  <section class="review-sheet" aria-labelledby="review-title">
    <header class="review-sheet-header">
      <h2 id="review-title">{{ t('review.title') }}</h2>
      <p class="muted">{{ t('review.lede') }}</p>
    </header>

    <fieldset class="choice-group review-outcomes">
      <legend>{{ t('review.outcome') }}</legend>
      <label
        v-for="item in outcomes"
        :key="item"
        class="choice-chip choice-chip--tile"
        :class="`choice-chip--${item}`"
      >
        <input v-model="outcome" type="radio" :value="item" :disabled="disabled || busy" />
        {{ t(`review.outcomes.${item}`) }}
      </label>
    </fieldset>

    <fieldset class="choice-group review-reasons">
      <legend>{{ t('review.reasonsLegend') }}</legend>
      <label v-for="reason in reasons" :key="reason" class="choice-chip">
        <input
          type="checkbox"
          :value="reason"
          :checked="chips.includes(reason)"
          :disabled="disabled || busy"
          @change="toggleChip(reason, ($event.target as HTMLInputElement).checked)"
        />
        {{ t(`review.reasons.${reason}`) }}
      </label>
    </fieldset>

    <div class="review-note-group">
      <UiField id="review-note" :label="t('review.note')" class="review-note">
        <template #default="{ describedby }">
          <textarea
            id="review-note"
            v-model="note"
            :maxlength="NOTE_MAX"
            rows="3"
            :aria-describedby="describedby ?? 'review-note-count'"
            :disabled="disabled || busy"
          />
        </template>
      </UiField>
      <p id="review-note-count" class="subtle review-count tabular">
        <small>{{ t('review.count', { count: note.length, max: NOTE_MAX }) }}</small>
      </p>
    </div>

    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <UiButton variant="primary" size="lg" class="review-submit" :disabled="disabled || busy" :busy="busy" @click="submit">
      {{ busy ? t('review.submitting') : t('review.submit') }}
    </UiButton>

    <div v-if="feedback" class="estimation-feedback banner banner--success" role="status">
      <UiIcon name="check-circle" :size="18" class="estimation-feedback-icon banner-icon" />
      <div class="banner-content">
        <h3>{{ t('review.feedbackTitle') }}</h3>
        <p>
          <I18nT keypath="review.feedback">
            <template #estimated>{{ formatDuration(feedback.estimatedP50) }}</template>
            <template #actual>{{ formatDuration(feedback.actualFocusMin) }}</template>
            <template #quality><strong>{{ t(`review.quality.${feedback.quality}`) }}</strong></template>
          </I18nT>
        </p>
      </div>
    </div>
  </section>
</template>
