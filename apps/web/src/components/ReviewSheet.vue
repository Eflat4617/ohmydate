<script setup lang="ts">
import { ref } from 'vue';
import type { EstimationFeedback, SessionReviewRequest } from '../api';
import { formatSlack } from '../format';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiField from './ui/UiField.vue';
import UiIcon from './ui/UiIcon.vue';

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

const reasons: { id: SessionReviewRequest['reasonChips'][number]; label: string }[] = [
  { id: 'focus_lost', label: 'Lost focus' },
  { id: 'interrupted', label: 'Interrupted' },
  { id: 'task_larger', label: 'Task was larger' },
  { id: 'task_smaller', label: 'Task was smaller' },
  { id: 'blocked_dependency', label: 'Blocked by dependency' },
  { id: 'low_energy', label: 'Low energy' },
  { id: 'other', label: 'Other' },
];

const outcomes: { id: 'done' | 'partial' | 'blocked'; label: string }[] = [
  { id: 'done', label: 'Done' },
  { id: 'partial', label: 'Partial' },
  { id: 'blocked', label: 'Blocked' },
];

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
      <h2 id="review-title">How did the session go?</h2>
      <p class="muted">One tap is enough. Reasons and a note are optional.</p>
    </header>

    <fieldset class="choice-group review-outcomes">
      <legend>Outcome</legend>
      <label
        v-for="item in outcomes"
        :key="item.id"
        class="choice-chip choice-chip--tile"
        :class="`choice-chip--${item.id}`"
      >
        <input v-model="outcome" type="radio" :value="item.id" :disabled="disabled || busy" />
        {{ item.label }}
      </label>
    </fieldset>

    <fieldset class="choice-group review-reasons">
      <legend>What affected the session?</legend>
      <label v-for="reason in reasons" :key="reason.id" class="choice-chip">
        <input
          type="checkbox"
          :value="reason.id"
          :checked="chips.includes(reason.id)"
          :disabled="disabled || busy"
          @change="toggleChip(reason.id, ($event.target as HTMLInputElement).checked)"
        />
        {{ reason.label }}
      </label>
    </fieldset>

    <UiField id="review-note" label="Note (optional, private)" class="review-note">
      <template #default="{ describedby }">
        <textarea
          id="review-note"
          v-model="note"
          maxlength="2000"
          rows="3"
          :aria-describedby="describedby ?? 'review-note-count'"
          :disabled="disabled || busy"
        />
      </template>
    </UiField>
    <p id="review-note-count" class="subtle review-count"><small>{{ note.length }} / 2000</small></p>

    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>

    <UiButton variant="primary" size="lg" block :disabled="disabled || busy" :busy="busy" @click="submit">
      {{ busy ? 'Saving review…' : 'Submit review' }}
    </UiButton>

    <div v-if="feedback" class="estimation-feedback" role="status">
      <UiIcon name="check-circle" :size="20" class="estimation-feedback-icon" />
      <div>
        <h3>Estimation feedback</h3>
        <p>
          Estimated {{ formatSlack(feedback.estimatedP50) }} · actual
          {{ formatSlack(feedback.actualFocusMin) }} ·
          <strong>{{ feedback.quality }}</strong>
        </p>
      </div>
    </div>
  </section>
</template>
