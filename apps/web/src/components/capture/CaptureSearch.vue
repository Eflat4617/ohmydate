<script setup lang="ts">
import { computed } from 'vue';
import { useTaskDirectory } from '../../composables/useOverview';
import { matchesSearch } from '../../domain/capture';
import { t, tp } from '../../i18n';
import { NAV_ITEMS } from '../../layout/navigation';
import UiIcon from '../ui/UiIcon.vue';
import UiSpinner from '../ui/UiSpinner.vue';

/**
 * 검색, inside the capture bar (HOLO-04, FLOW.md §4): the owner's own tasks by
 * the words of their titles, and the places by name. It reads the task list
 * the other screens read (owner-keyed and fenced: composables/useOverview.ts)
 * and is mounted only while the bar is in its search mode, so nothing is
 * fetched for it otherwise. Nothing found leads back a stage: the words can
 * be put down as a to-do.
 */
const props = defineProps<{ query: string }>();
const emit = defineEmits<{ go: []; capture: [text: string] }>();

const RESULT_LIMIT = 8;

const directory = useTaskDirectory();
const query = computed(() => props.query.trim());

const places = computed(() =>
  query.value.length === 0 ? [] : NAV_ITEMS.filter((item) => matchesSearch(t(item.label), query.value)),
);

const tasks = computed(() => {
  const all = directory.data.value?.tasks;
  if (all === undefined || query.value.length === 0) return [];
  return [...all.values()]
    .filter((task) => matchesSearch(task.title, query.value))
    // What is still to do comes first; then by name.
    .sort((left, right) => Number(left.status === 'done') - Number(right.status === 'done') || left.title.localeCompare(right.title, 'ko'))
    .slice(0, RESULT_LIMIT);
});

const total = computed(() => places.value.length + tasks.value.length);
const loading = computed(() => directory.isLoading.value && query.value.length > 0);
const status = computed(() => {
  if (query.value.length === 0 || loading.value) return '';
  return total.value === 0 ? t('capture.search.none', { q: query.value }) : tp('capture.search.count', total.value);
});
</script>

<template>
  <div class="capture-search" data-capture-search>
    <p class="visually-hidden" role="status" aria-live="polite">{{ status }}</p>
    <p v-if="query.length === 0" class="capture-hint">{{ t('capture.search.hint') }}</p>
    <p v-else-if="loading" class="capture-hint"><UiSpinner /> {{ t('capture.search.loading') }}</p>
    <template v-else>
      <ul v-if="total > 0" class="capture-results" :aria-label="t('capture.search.results')">
        <li v-for="place in places" :key="place.id">
          <RouterLink :to="place.to" class="capture-result" data-capture-result="place" @click="emit('go')">
            <UiIcon :name="place.icon" :size="18" class="capture-result-icon" />
            <span class="capture-result-title">{{ t(place.label) }}</span>
            <span class="capture-result-kind">{{ t('capture.search.place') }}</span>
          </RouterLink>
        </li>
        <li v-for="task in tasks" :key="task.id">
          <RouterLink :to="`/tasks/${task.id}`" class="capture-result" data-capture-result="task" @click="emit('go')">
            <UiIcon :name="task.status === 'done' ? 'check-circle' : 'inbox'" :size="18" class="capture-result-icon" />
            <span class="capture-result-title">{{ task.title }}</span>
            <span class="capture-result-kind">{{ t(`task.status.${task.status}`) }}</span>
          </RouterLink>
        </li>
      </ul>
      <!-- Nothing found: back a stage (FLOW §5) — the words can be put down as a to-do. -->
      <div v-else class="capture-none" data-capture-search-none>
        <p class="capture-hint">{{ t('capture.search.none', { q: query }) }}</p>
        <button type="button" class="btn btn--sm" data-capture-search-capture @click="emit('capture', query)">
          <UiIcon name="plus" :size="16" class="btn-icon" />{{ t('capture.search.captureInstead') }}
        </button>
      </div>
    </template>
  </div>
</template>
