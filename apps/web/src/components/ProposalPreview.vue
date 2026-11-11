<script setup lang="ts">
import { computed } from 'vue';
import type { Today, TodayProposal } from '../api';
import { durationMinutes, formatClock, formatDay } from '../format';
import UiBadge from './ui/UiBadge.vue';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';

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
  <UiDialog
    labelledby="proposal-title"
    describedby="proposal-summary"
    class="proposal-preview"
    as="section"
    :dismissible="!busy"
    @close="emit('cancel')"
  >
    <header class="dialog-header dialog-header--start">
      <span class="dialog-icon">
        <UiIcon :name="proposal.kind === 'shrink' ? 'shrink' : 'reschedule'" :size="22" />
      </span>
      <div class="dialog-heading">
        <h2 id="proposal-title" class="dialog-title">Proposal preview</h2>
        <p id="proposal-summary" class="muted">
          {{ proposal.kind === 'shrink' ? 'Shrink' : 'Reschedule' }} proposal for
          {{ formatDay(proposal.date) }}. Nothing changes until you approve it.
        </p>
      </div>
    </header>
    <ul class="proposal-blocks" aria-label="Proposed block times">
      <li v-for="block in proposal.blocks" :key="block.blockId">
        <span class="proposal-title">{{ titleFor[block.taskId] ?? 'Scheduled block' }}</span>
        <span class="proposal-time tabular">
          {{ formatClock(block.startAt, proposal.timeZone) }}–{{ formatClock(block.endAt, proposal.timeZone) }}
          <UiBadge>{{ durationMinutes(block.startAt, block.endAt) }}m</UiBadge>
        </span>
      </li>
    </ul>
    <p v-if="availabilityVersion !== undefined" class="subtle proposal-meta">
      Availability version {{ availabilityVersion }}
    </p>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <div class="dialog-actions">
      <UiButton :disabled="busy" variant="ghost" @click="emit('cancel')">Cancel</UiButton>
      <UiButton
        variant="primary"
        :disabled="busy || disabled"
        :busy="busy"
        data-autofocus
        @click="emit('approve')"
      >
        {{ busy ? 'Approving…' : 'Approve proposal' }}
      </UiButton>
    </div>
  </UiDialog>
</template>
