<script setup lang="ts">
import { computed, useId } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import { focusContextFor } from '../../composables/focusContext';
import { t, tp } from '../../i18n';
import { useLayoutContext } from '../../layout/context';
import { skipReviewToday } from '../../layout/localSignals';
import { useLayoutStore } from '../../stores/layout';
import { useSessionStore } from '../../stores/session';

const MAX_LISTED = 3;

const context = useLayoutContext();
const layout = useLayoutStore();
const sessions = useSessionStore();
const headingId = `layout-review-${useId()}`;

const pending = computed(() =>
  context.unreviewed.value.slice(0, MAX_LISTED).map((session) => ({
    id: session.id,
    title: focusContextFor(sessions.ownerId, session.blockId, session.taskId)?.title ?? t('layout.currentTask.fallback'),
  })),
);
const count = computed(() => context.unreviewed.value.length);

function skip(): void {
  skipReviewToday(sessions.ownerId, context.day.value);
  layout.intent({ announce: true });
}
</script>

<template>
  <section class="layout-panel layout-panel--accent" :aria-labelledby="headingId" data-panel="review-prompt">
    <h2 :id="headingId" class="layout-panel-title">
      <UiIcon name="check-circle" :size="18" />
      <span>{{ count > 0 ? t('layout.review.title') : t('layout.review.none') }}</span>
    </h2>
    <template v-if="count > 0">
      <p class="layout-panel-lede">{{ tp('layout.review.count', count) }}</p>
      <ul class="layout-review-list" :aria-label="t('layout.review.list')">
        <li v-for="item in pending" :key="item.id" class="layout-review-item">
          <span class="layout-review-title">{{ item.title }}</span>
          <RouterLink
            :to="`/focus/${item.id}`"
            class="btn btn--secondary btn--sm"
            :aria-label="t('layout.review.openAria', { title: item.title })"
          >
            {{ t('layout.review.open') }}
          </RouterLink>
        </li>
      </ul>
      <div class="layout-panel-actions">
        <UiButton size="sm" variant="ghost" @click="skip">{{ t('layout.review.skip') }}</UiButton>
      </div>
    </template>
  </section>
</template>
