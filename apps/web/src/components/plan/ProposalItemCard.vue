<script setup lang="ts">
import { computed } from 'vue';
import { EDIT_GRID_MINUTES, movedInterval, resizedInterval, type BlockInterval } from '../../domain/planDraft';
import type { ProjectHue } from '../../domain/overview';
import type { WeekItem } from '../../domain/weekGrid';
import { t } from '../../i18n';
import { formatDateTimeRange, formatDuration, minutesBetween } from '../../i18n/format';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * The floating detail card of a block that is not approved yet (HOLO-03A):
 * the planner's own card (`.planner-card`, placed by usePlannerCard), with
 * what can be done to a proposal — move it five minutes either way, make it
 * five minutes shorter or longer. Dragging on the grid does the same; this is
 * the way that needs no pointer and no modifier key.
 *
 * It only says what the block would become (`edit`); the screen owns the
 * list and asks the server whether the result still holds.
 */
const props = withDefaults(
  defineProps<{
    item: WeekItem;
    timeZone: string;
    project: { readonly title: string; readonly hue: ProjectHue } | null;
    side: 'right' | 'left' | 'below' | 'above';
    /** The block can be changed right now. */
    editable?: boolean;
    /** Why it cannot (shown instead of the controls' effect). */
    blockedReason?: string | null;
    /** What the server said is wrong with this block. */
    problem?: string | null;
  }>(),
  { editable: false, blockedReason: null, problem: null },
);
const emit = defineEmits<{ close: [restoreFocus: boolean]; edit: [next: BlockInterval] }>();

const title = computed(() => props.item.title ?? t('month.untitledTask'));
const interval = computed<BlockInterval | null>(() =>
  props.item.endAt === null ? null : { startAt: props.item.startAt, endAt: props.item.endAt },
);
const when = computed(() =>
  interval.value === null ? '' : formatDateTimeRange(interval.value.startAt, interval.value.endAt, props.timeZone),
);
const minutes = computed(() => (interval.value === null ? 0 : minutesBetween(interval.value.startAt, interval.value.endAt)));

function move(delta: number): void {
  if (interval.value !== null && props.editable) emit('edit', movedInterval(interval.value, delta));
}

function resize(delta: number): void {
  if (interval.value !== null && props.editable) emit('edit', resizedInterval(interval.value, delta));
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  emit('close', true);
}

/** Focus that walks out of the card (Tab past its last control) closes it. */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  const root = event.currentTarget;
  if (!(next instanceof Node) || !(root instanceof Node) || root.contains(next)) return;
  emit('close', false);
}
</script>

<template>
  <section
    class="planner-card planner-card--proposal"
    :class="`planner-card--${side}`"
    role="dialog"
    aria-modal="false"
    aria-labelledby="planner-card-title"
    aria-describedby="planner-card-when"
    tabindex="-1"
    data-planner-card="proposal"
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <header class="planner-card-head">
      <p class="planner-card-tags">
        <UiBadge tone="outline" data-planner-card-kind>{{ t('planSchedule.card.tag') }}</UiBadge>
        <UiBadge v-if="project" :class="`badge--${project.hue}`" data-planner-card-project>{{ project.title }}</UiBadge>
      </p>
      <button
        type="button"
        class="btn btn--ghost btn--icon btn--sm planner-card-close"
        :aria-label="t('common.close')"
        data-planner-card-close
        @click="emit('close', true)"
      >
        <UiIcon name="close" :size="16" />
      </button>
    </header>

    <h2 id="planner-card-title" class="planner-card-title">{{ title }}</h2>
    <p id="planner-card-when" class="planner-card-when" aria-live="polite">
      <UiIcon name="clock" :size="16" />
      <span class="tabular">{{ when }}</span>
      <span class="planner-card-length tabular">{{ formatDuration(minutes) }}</span>
    </p>
    <p v-if="item.invalid" class="planner-card-problem" role="status" data-planner-card-problem>
      <UiIcon name="warn" :size="16" /><span>{{ problem ?? t('planSchedule.card.invalid') }}</span>
    </p>
    <p v-if="blockedReason" class="planner-card-note" data-planner-card-blocked>{{ blockedReason }}</p>

    <div class="planner-card-edit">
      <div class="planner-card-edit-row" role="group" :aria-label="t('planSchedule.card.move')">
        <span class="planner-card-edit-label" aria-hidden="true">{{ t('planSchedule.card.move') }}</span>
        <UiButton size="sm" icon="chevron-left" :disabled="!editable" data-card-earlier @click="move(-EDIT_GRID_MINUTES)">
          {{ t('planSchedule.card.earlier') }}
        </UiButton>
        <UiButton size="sm" :disabled="!editable" data-card-later @click="move(EDIT_GRID_MINUTES)">
          {{ t('planSchedule.card.later') }}<UiIcon name="chevron-right" :size="16" />
        </UiButton>
      </div>
      <div class="planner-card-edit-row" role="group" :aria-label="t('planSchedule.card.length')">
        <span class="planner-card-edit-label" aria-hidden="true">{{ t('planSchedule.card.length') }}</span>
        <UiButton
          size="sm"
          icon="shrink"
          :disabled="!editable || minutes <= EDIT_GRID_MINUTES"
          data-card-shorter
          @click="resize(-EDIT_GRID_MINUTES)"
        >
          {{ t('planSchedule.card.shorter') }}
        </UiButton>
        <UiButton size="sm" icon="expand" :disabled="!editable" data-card-longer @click="resize(EDIT_GRID_MINUTES)">
          {{ t('planSchedule.card.longer') }}
        </UiButton>
      </div>
    </div>

    <div v-if="item.taskId" class="planner-card-actions">
      <RouterLink :to="`/tasks/${item.taskId}`" class="btn btn--sm" data-planner-card-task>
        <UiIcon name="open" :size="16" class="btn-icon" />{{ t('planner.card.openTask') }}
      </RouterLink>
    </div>
  </section>
</template>
