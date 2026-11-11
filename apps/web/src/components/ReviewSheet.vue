<script setup lang="ts">
import { ref } from 'vue';
import type { EstimationFeedback, SessionReviewRequest } from '../api';
import { formatSlack } from '../format';

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
    <h2 id="review-title">How did the session go?</h2>

    <fieldset class="review-outcomes">
      <legend>Outcome</legend>
      <label><input v-model="outcome" type="radio" value="done" :disabled="disabled || busy" /> Done</label>
      <label><input v-model="outcome" type="radio" value="partial" :disabled="disabled || busy" /> Partial</label>
      <label><input v-model="outcome" type="radio" value="blocked" :disabled="disabled || busy" /> Blocked</label>
    </fieldset>

    <fieldset class="review-reasons">
      <legend>What affected the session?</legend>
      <label v-for="reason in reasons" :key="reason.id">
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

    <label class="review-note" for="review-note">
      Note (optional, private)
      <textarea
        id="review-note"
        v-model="note"
        maxlength="2000"
        rows="3"
        :disabled="disabled || busy"
      />
    </label>
    <p class="muted"><small>{{ note.length }} / 2000</small></p>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <button type="button" class="primary-action" :disabled="disabled || busy" @click="submit">
      {{ busy ? 'Saving review…' : 'Submit review' }}
    </button>

    <div v-if="feedback" class="estimation-feedback" role="status">
      <h3>Estimation feedback</h3>
      <p>
        Estimated {{ formatSlack(feedback.estimatedP50) }} · actual
        {{ formatSlack(feedback.actualFocusMin) }} ·
        <strong>{{ feedback.quality }}</strong>
      </p>
    </div>
  </section>
</template>
