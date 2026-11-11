<script setup lang="ts">
import { computed } from 'vue';
import type { Today, TodayProposal } from '../api';
import { formatClock, formatDay } from '../format';

const props = defineProps<{
  proposal: TodayProposal;
  today: Today | null;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{ approve: []; cancel: [] }>();

const titleFor = computed<Record<string, string>>(() => {
  const titles: Record<string, string> = {};
  for (const block of props.today?.blocks ?? []) titles[block.taskId] = block.title;
  return titles;
});

const availabilityVersion = computed<number | undefined>(() => {
  const value = (props.proposal as { availabilityVersion?: unknown }).availabilityVersion;
  return typeof value === 'number' ? value : undefined;
});
</script>

<template>
  <div class="dialog-backdrop" role="presentation">
    <section
      class="dialog proposal-preview"
      role="dialog"
      aria-modal="true"
      aria-labelledby="proposal-title"
    >
      <h2 id="proposal-title">Proposal preview</h2>
      <p class="muted">
        {{ proposal.kind === 'shrink' ? 'Shrink' : 'Reschedule' }} proposal for
        {{ formatDay(proposal.date) }}. Nothing changes until you approve it.
      </p>
      <ul class="proposal-blocks" aria-label="Proposed block times">
        <li v-for="block in proposal.blocks" :key="block.blockId">
          <span class="proposal-title">{{ titleFor[block.taskId] ?? 'Scheduled block' }}</span>
          <span>{{ formatClock(block.startAt, proposal.timeZone) }}–{{ formatClock(block.endAt, proposal.timeZone) }}</span>
        </li>
      </ul>
      <p v-if="availabilityVersion !== undefined" class="muted">
        Availability version {{ availabilityVersion }}
      </p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button
          type="button"
          class="primary-action"
          :disabled="busy || disabled"
          @click="emit('approve')"
        >
          {{ busy ? 'Approving…' : 'Approve proposal' }}
        </button>
        <button type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
      </div>
    </section>
  </div>
</template>
