<script setup lang="ts">
import { computed } from 'vue';
import type { ContextDocument } from '../../api';
import { t } from '../../i18n';
import { browserTimeZone, formatDateTime } from '../../i18n/format';
import { useAuthStore } from '../../stores/auth';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import { plainSummary } from './markdown';

/**
 * Notes linked to something (project tab, task detail): title, a plain-text
 * summary (never rendered Markdown), when it changed, and whether it may be
 * sent to the AI. Each row opens the note.
 */
const props = withDefaults(
  defineProps<{
    notes: readonly ContextDocument[];
    loading?: boolean;
    failed?: boolean;
    emptyText: string;
    loadingText: string;
    errorText: string;
    label: string;
  }>(),
  { loading: false, failed: false },
);

const emit = defineEmits<{ retry: [] }>();
const auth = useAuthStore();
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());
</script>

<template>
  <div class="linked-notes" data-linked-notes>
    <div v-if="props.loading">
      <p class="visually-hidden" role="status">{{ loadingText }}</p>
      <UiSkeleton variant="lines" :lines="3" />
    </div>
    <UiBanner v-else-if="failed" tone="error">
      <p role="alert">{{ errorText }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="emit('retry')">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <p v-else-if="notes.length === 0" class="muted" data-linked-notes-empty>{{ emptyText }}</p>
    <ul v-else class="linked-note-list" :aria-label="label">
      <li v-for="note in notes" :key="note.id" class="linked-note">
        <RouterLink :to="`/notes/${note.id}`" class="linked-note-title" :data-linked-note="note.id">{{ note.title }}</RouterLink>
        <span v-if="plainSummary(note.bodyMd, 80)" class="linked-note-summary muted">{{ plainSummary(note.bodyMd, 80) }}</span>
        <span class="linked-note-meta">
          <time :datetime="note.updatedAt" class="tabular">{{ t('notes.updated', { time: formatDateTime(note.updatedAt, timeZone) }) }}</time>
          <UiBadge v-if="note.llmAllowed" tone="accent">{{ t('notes.badges.aiAllowed') }}</UiBadge>
          <UiBadge v-if="note.source === 'task_description'" tone="outline">{{ t('notes.badges.promoted') }}</UiBadge>
        </span>
      </li>
    </ul>
  </div>
</template>
