<script setup lang="ts">
import { computed } from 'vue';
import type { Today, TodayProposal, Violation } from '../api';
import { t } from '../i18n';
import { formatCivilDate, formatDuration, formatTimeRange, minutesBetween } from '../i18n/format';
import UiBadge from './ui/UiBadge.vue';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';
import ExplanationList from './ExplanationList.vue';

const props = defineProps<{
  proposal: TodayProposal;
  today: Today | null;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  /** Coded findings of a 422 `constraint_violation` approval (FU-62). */
  violations?: readonly Violation[];
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
        <h2 id="proposal-title" class="dialog-title">{{ t('proposal.title') }}</h2>
        <p id="proposal-summary" class="muted">
          {{
            t(proposal.kind === 'shrink' ? 'proposal.summaryShrink' : 'proposal.summaryReschedule', {
              date: formatCivilDate(proposal.date),
            })
          }}
        </p>
      </div>
    </header>
    <ul class="proposal-blocks" :aria-label="t('proposal.blocks')">
      <li v-for="block in proposal.blocks" :key="block.blockId">
        <span class="proposal-title">{{ titleFor[block.taskId] ?? t('proposal.fallbackBlock') }}</span>
        <span class="proposal-time tabular">
          {{ formatTimeRange(block.startAt, block.endAt, proposal.timeZone) }}
          <UiBadge>{{ formatDuration(minutesBetween(block.startAt, block.endAt)) }}</UiBadge>
        </span>
      </li>
    </ul>
    <p v-if="availabilityVersion !== undefined" class="subtle proposal-meta">
      {{ t('proposal.availabilityVersion', { version: availabilityVersion }) }}
    </p>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <ExplanationList :violations="violations ?? []" :time-zone="proposal.timeZone" :task-names="titleFor" />
    <div class="dialog-actions">
      <UiButton :disabled="busy" variant="ghost" @click="emit('cancel')">{{ t('common.cancel') }}</UiButton>
      <UiButton
        variant="primary"
        :disabled="busy || disabled"
        :busy="busy"
        data-autofocus
        @click="emit('approve')"
      >
        {{ busy ? t('proposal.approving') : t('proposal.approve') }}
      </UiButton>
    </div>
  </UiDialog>
</template>
