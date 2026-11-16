<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import type { IconName } from '../ui/icons';
import { t } from '../../i18n';

/**
 * The frame every 개요 widget shares: a card with a small title, an "open"
 * icon-link to the screen that owns the detail, and three bodies — a skeleton
 * in the card's own shape while it loads, an error with a retry that leaves
 * the rest of the page alone, or the widget.
 */
withDefaults(
  defineProps<{
    widget: string;
    title: string;
    icon: IconName;
    state?: 'loading' | 'error' | 'ready';
    /** Where the "open" corner goes; without it the card has no corner link. */
    to?: RouteLocationRaw | null;
    openLabel?: string | null;
  }>(),
  { state: 'ready', to: null, openLabel: null },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <section
    class="card overview-card"
    :class="`overview-card--${widget}`"
    :aria-labelledby="`overview-${widget}-title`"
    :aria-busy="state === 'loading' ? 'true' : undefined"
    :data-widget="widget"
    :data-state="state"
  >
    <header class="card-header overview-card-head">
      <!-- An h3: the cards are parts of 이번 주, whose own heading is the h2 above them. -->
      <h3 :id="`overview-${widget}-title`" class="card-title">
        <UiIcon :name="icon" :size="18" />
        {{ title }}
      </h3>
      <RouterLink v-if="to && openLabel" :to="to" class="icon-link" :aria-label="openLabel" data-open>
        <UiIcon name="open" :size="16" />
      </RouterLink>
    </header>
    <div v-if="state === 'loading'" class="overview-card-body overview-card-skeleton" aria-hidden="true">
      <slot name="skeleton" />
    </div>
    <div v-else-if="state === 'error'" class="overview-card-error" role="alert">
      <p>{{ t('overview.cardError') }}</p>
      <UiButton size="sm" icon="sync" data-retry @click="$emit('retry')">{{ t('common.retry') }}</UiButton>
    </div>
    <div v-else class="overview-card-body">
      <slot />
    </div>
  </section>
</template>
