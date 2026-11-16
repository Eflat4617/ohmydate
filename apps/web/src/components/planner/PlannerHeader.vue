<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { PLANNER_VIEWS, plannerLocation, type PlannerViewKind } from '../../domain/plannerRoute';
import { t } from '../../i18n';
import { useOfflineStore } from '../../stores/offline';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import CommitmentAddDialog from './CommitmentAddDialog.vue';

/**
 * The head every view of 플래너 shares (HOLO-02): the stretch of time on show
 * as the page's title, then — in one row — back / 오늘 / forward, the view
 * switch (일 · 주 · 월) and the screen's single primary button, 약속 추가.
 *
 * The view owns its dates; this only says "previous", "next" and "current"
 * back to it. Switching the view goes to the same day in the other view
 * (`anchor`), through the address (domain/plannerRoute.ts).
 */
const props = withDefaults(
  defineProps<{
    view: PlannerViewKind;
    title: string;
    /** A quiet line beside the title (the month's counts). */
    summary?: string | null;
    /** A civil date inside what is on show: where the other views open, and the day a new 약속 starts on. */
    anchor: string;
    today: string;
    timeZone: string;
    /** What is on show already holds today: 오늘 has nowhere to go. */
    isCurrent: boolean;
    /** Names of the group and its two arrows (they differ by view: 주, 날, 달). */
    navigationLabel: string;
    previousLabel: string;
    nextLabel: string;
    /** `month`: also carry the month page's own test hooks (`data-month-title`, …). */
    hooks?: 'month' | null;
  }>(),
  { summary: null, hooks: null },
);
/** `added`: a 약속 was added from this head; it starts at the instant given. */
const emit = defineEmits<{ previous: []; next: []; current: []; added: [startAt: string] }>();

const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const adding = ref(false);

function hook(name: string): Record<string, string> {
  return props.hooks === null ? {} : { [`data-${props.hooks}-${name}`]: '' };
}

const views = computed(() =>
  PLANNER_VIEWS.map((view) => ({ view, label: t(`planner.view.${view}`), current: view === props.view })),
);

function show(view: PlannerViewKind): void {
  if (view === props.view) return;
  void router.push(plannerLocation(view, props.anchor, props.today, route.name));
}
</script>

<template>
  <header class="page-header planner-head">
    <div class="page-heading planner-heading">
      <h1 data-planner-title v-bind="hook('title')">{{ title }}</h1>
      <p v-if="summary" class="page-lede month-summary planner-summary">{{ summary }}</p>
    </div>
    <div class="page-actions planner-actions">
      <UiBadge v-if="!offline.online" tone="offline" class="chip--offline" role="status">
        {{ t('common.readOnlyOffline') }}
      </UiBadge>
      <div class="planner-nav month-nav" role="group" :aria-label="navigationLabel">
        <UiButton
          icon="chevron-left"
          icon-only
          :aria-label="previousLabel"
          data-planner-previous
          v-bind="hook('previous')"
          @click="emit('previous')"
        />
        <UiButton :disabled="isCurrent" data-planner-current v-bind="hook('current')" @click="emit('current')">
          {{ t('planner.today') }}
        </UiButton>
        <UiButton
          icon="chevron-right"
          icon-only
          :aria-label="nextLabel"
          data-planner-next
          v-bind="hook('next')"
          @click="emit('next')"
        />
      </div>
      <div class="segmented glass glass--still glass--flat planner-views" role="group" :aria-label="t('planner.views')">
        <button
          v-for="item in views"
          :key="item.view"
          type="button"
          class="btn segmented-item"
          :aria-pressed="item.current ? 'true' : 'false'"
          :data-planner-view="item.view"
          @click="show(item.view)"
        >
          {{ item.label }}
        </button>
      </div>
      <UiButton variant="primary" icon="plus" :disabled="!offline.mutationsEnabled" data-planner-add @click="adding = true">
        {{ t('planner.add.open') }}
      </UiButton>
    </div>
  </header>
  <CommitmentAddDialog
    v-if="adding"
    :time-zone="timeZone"
    :date="anchor"
    @close="adding = false"
    @saved="(startAt) => startAt !== undefined && emit('added', startAt)"
  />
</template>
