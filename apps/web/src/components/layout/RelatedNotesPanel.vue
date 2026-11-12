<script setup lang="ts">
import { computed, useId } from 'vue';
import { useRoute } from 'vue-router';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import { useRelatedNotes } from '../../composables/relatedNotes';
import { t } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
import { useLayoutContext } from '../../layout/context';

/**
 * RelatedNotes{limit} (07 §2.1, §3.4): at most `limit` notes linked to what
 * the user is working on now (see `useRelatedNotes`), newest first, each one
 * link to the note. Titles only — never note bodies — so the panel stays calm.
 */
const props = defineProps<{ limit: number }>();

const route = useRoute();
const layout = useLayoutContext();
const headingId = `layout-related-notes-${useId()}`;
const { context, notes, loading, failed, retry } = useRelatedNotes(() => props.limit);

const contextLine = computed(() => {
  const current = context.value;
  if (current.kind === 'task') return current.title === null ? null : t('layout.relatedNotes.contextTask', { title: current.title });
  if (current.kind === 'goal') return t('layout.relatedNotes.contextGoal');
  if (current.kind === 'note') return t('layout.relatedNotes.contextNote');
  return null;
});
const onNotes = computed(() => typeof route.name === 'string' && route.name.startsWith('notes'));
</script>

<template>
  <section class="layout-panel" :aria-labelledby="headingId" data-panel="related-notes">
    <h2 :id="headingId" class="layout-panel-title">
      <UiIcon name="leaf" :size="18" />
      <span>{{ t('layout.relatedNotes.title') }}</span>
    </h2>
    <p v-if="contextLine" class="layout-panel-lede muted" data-related-context>{{ contextLine }}</p>
    <template v-if="loading">
      <p class="visually-hidden" role="status">{{ t('layout.relatedNotes.loading') }}</p>
      <UiSkeleton variant="lines" :lines="2" />
    </template>
    <div v-else-if="failed" class="layout-panel-error">
      <p class="muted" role="alert">{{ t('layout.relatedNotes.loadError') }}</p>
      <UiButton size="sm" variant="ghost" icon="sync" @click="retry">{{ t('common.retry') }}</UiButton>
    </div>
    <ul v-else-if="notes.length > 0" class="layout-related-list" :aria-label="t('layout.relatedNotes.list')">
      <li v-for="item in notes" :key="item.note.id" class="layout-related-item" :data-related-note="item.note.id">
        <RouterLink :to="`/notes/${item.note.id}`" class="layout-related-title">{{ item.note.title }}</RouterLink>
        <span class="layout-related-meta">
          <UiBadge tone="outline">{{ t(`layout.relatedNotes.via.${item.via}`) }}</UiBadge>
          <time :datetime="item.note.updatedAt" class="tabular muted">{{ formatDateTime(item.note.updatedAt, layout.timeZone.value) }}</time>
        </span>
      </li>
    </ul>
    <UiEmptyState v-else compact :icon="null" :title="t('layout.relatedNotes.emptyTitle')">
      <p>{{ t('layout.relatedNotes.emptyBody', { limit }) }}</p>
      <p v-if="context.kind === 'none'" class="muted">{{ t('layout.relatedNotes.noContext') }}</p>
    </UiEmptyState>
    <RouterLink v-if="!onNotes" to="/notes" class="layout-panel-link">{{ t('layout.relatedNotes.openAll') }}</RouterLink>
  </section>
</template>
