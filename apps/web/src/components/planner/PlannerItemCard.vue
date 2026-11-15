<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { rememberFocusBlocks } from '../../composables/focusContext';
import { isBlockLockable, useBlockLock, type BlockLock } from '../../composables/useBlockLock';
import { useFocusStart, useRunningSession } from '../../composables/useOverview';
import type { ProjectHue } from '../../domain/overview';
import type { WeekItem } from '../../domain/weekGrid';
import { t } from '../../i18n';
import { formatDateTime, formatDateTimeRange, formatDuration, minutesBetween } from '../../i18n/format';
import { useOfflineStore } from '../../stores/offline';
import { useSessionStore } from '../../stores/session';
import BlockLockToggle from '../BlockLockToggle.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * The floating detail card of one planner item (HOLO-02): what it is, when,
 * which project it belongs to, and what can be done with it from here —
 *
 *   블록   집중 시작 (the Focus screen's own session) · 블록 고정 · 작업 열기
 *   약속   고치기 (the planner's dialog; one from Google Calendar says so and is edited there)
 *   마감   작업 열기
 *
 * None of its buttons is filled: the screen's one primary is 약속 추가.
 * It is a small dialog that does not block the page: Escape and 닫기 give the
 * focus back to the item, and leaving it with Tab closes it.
 */
const props = withDefaults(
  defineProps<{
    item: WeekItem;
    timeZone: string;
    nowMs: number;
    /** The task's project, when it is known. */
    project: { readonly title: string; readonly hue: ProjectHue } | null;
    /** Re-read what the planner shows (a lock moves the block's version). */
    refresh: () => Promise<unknown>;
    /** Which side of its item the card stands on (for the small entrance). */
    side: 'right' | 'left' | 'below' | 'above';
    /**
     * The screen's own lock requests (HOLO-03A): a screen that has to know
     * while a lock is out — 일정안 holds edits meanwhile — passes its
     * `useBlockLock` here; without one the card keeps its own.
     */
    lock?: BlockLock | undefined;
    /** The lock cannot be changed right now (the screen says why in `lockNote`). */
    lockDisabled?: boolean;
    lockNote?: string | null;
  }>(),
  { lock: undefined, lockDisabled: false, lockNote: null },
);
const emit = defineEmits<{ close: [restoreFocus: boolean]; edit: [commitmentId: string] }>();

const router = useRouter();
const sessionStore = useSessionStore();
const offline = useOfflineStore();
const { running, refetch: refetchRunning } = useRunningSession();
const focus = useFocusStart({ onActiveExists: refetchRunning });
const lock = props.lock ?? useBlockLock({ refresh: () => props.refresh() });

const title = computed(() => props.item.title ?? t('month.untitledTask'));
const overdue = computed(() => props.item.kind === 'deadline' && Date.parse(props.item.startAt) < props.nowMs);

const kind = computed(() => {
  if (props.item.kind === 'block') {
    return props.item.done
      ? { label: t('month.detail.kind.blockDone'), tone: 'success' as const }
      : { label: t('month.detail.kind.block'), tone: 'accent' as const };
  }
  if (props.item.kind === 'commitment') return { label: t('month.detail.kind.commitment'), tone: 'cyan' as const };
  return { label: t('month.detail.kind.deadline'), tone: 'orange' as const };
});

const when = computed(() => {
  const item = props.item;
  if (item.endAt === null) return t('planner.card.dueAt', { when: formatDateTime(item.startAt, props.timeZone) });
  return formatDateTimeRange(item.startAt, item.endAt, props.timeZone);
});
const length = computed(() =>
  props.item.endAt === null ? null : formatDuration(minutesBetween(props.item.startAt, props.item.endAt)),
);

const block = computed(() => props.item.block);
const startable = computed(() => props.item.kind === 'block' && !props.item.done && props.item.taskId !== null);
const lockable = computed(() => block.value !== null && isBlockLockable(block.value, props.nowMs));
const starting = computed(() => focus.startingTaskId.value !== null);

function start(): void {
  const item = props.item;
  if (item.taskId === null || block.value === null || item.endAt === null) return;
  // Presentational only: lets Focus show the block's title and planned length.
  rememberFocusBlocks(
    sessionStore.ownerId,
    [{ id: block.value.id, taskId: item.taskId, title: title.value, startAt: item.startAt, endAt: item.endAt }],
    props.timeZone,
  );
  void focus.start({ taskId: item.taskId, blockId: block.value.id });
}

function resume(): void {
  const session = running.value;
  if (session !== null) void router.push(`/focus/${session.id}`);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  emit('close', true);
}

/** Focus that walks out of the card (Tab past its last button) closes it; a press outside is the screen's. */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  const root = event.currentTarget;
  if (!(next instanceof Node) || !(root instanceof Node) || root.contains(next)) return;
  emit('close', false);
}
</script>

<template>
  <section
    class="planner-card glass"
    :class="`planner-card--${side}`"
    role="dialog"
    aria-modal="false"
    aria-labelledby="planner-card-title"
    aria-describedby="planner-card-when"
    tabindex="-1"
    :data-planner-card="item.kind"
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <header class="planner-card-head">
      <p class="planner-card-tags">
        <UiBadge :class="`badge--${kind.tone}`" data-planner-card-kind>{{ kind.label }}</UiBadge>
        <UiBadge v-if="item.fromGoogle" tone="outline" data-planner-card-source>{{ t('commitments.google.source') }}</UiBadge>
        <UiBadge v-if="overdue" tone="danger">{{ t('task.overdue') }}</UiBadge>
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
    <p id="planner-card-when" class="planner-card-when">
      <UiIcon name="clock" :size="16" />
      <span class="tabular">{{ when }}</span>
      <span v-if="length" class="planner-card-length tabular">{{ length }}</span>
    </p>
    <p v-if="item.fromGoogle" class="planner-card-note" data-planner-card-google>{{ t('planner.card.google') }}</p>

    <p v-if="lockNote" class="planner-card-note block-lock-hint" data-planner-card-lock-note>{{ lockNote }}</p>
    <UiBanner v-if="focus.error.value" tone="error" inline role="alert" data-planner-card-error>
      {{ focus.error.value }}
    </UiBanner>
    <UiBanner v-if="lock.error.value" tone="error" inline role="alert" class="block-lock-error">
      {{ lock.error.value }}
    </UiBanner>

    <div class="planner-card-actions">
      <template v-if="item.kind === 'block'">
        <UiButton v-if="startable && running" size="sm" icon="play" data-planner-card-resume @click="resume">
          {{ t('overview.resume') }}
        </UiButton>
        <UiButton
          v-else-if="startable"
          size="sm"
          icon="play"
          :disabled="!focus.canStart.value"
          :busy="starting"
          data-planner-card-start
          @click="start"
        >
          {{ starting ? t('overview.starting') : t('overview.startFocus') }}
        </UiButton>
        <BlockLockToggle
          v-if="block && lockable"
          :locked="lock.displayLocked(block)"
          :pending="lock.isPending(block.id)"
          :disabled="!offline.mutationsEnabled || lockDisabled"
          described-by="planner-card-title planner-card-when"
          @toggle="lock.toggle(block)"
        />
        <BlockLockToggle v-else-if="block" read-only :locked="block.locked" />
      </template>
      <RouterLink
        v-if="item.taskId"
        :to="`/tasks/${item.taskId}`"
        class="btn btn--sm"
        data-planner-card-task
      >
        <UiIcon name="open" :size="16" class="btn-icon" />{{ t('planner.card.openTask') }}
      </RouterLink>
      <!-- A 약속 is changed right here (the planner's own dialog); one from Google is changed there. -->
      <UiButton
        v-if="item.kind === 'commitment' && !item.fromGoogle && item.commitmentId"
        size="sm"
        icon="edit"
        :disabled="!offline.mutationsEnabled"
        data-planner-card-edit
        @click="emit('edit', item.commitmentId)"
      >
        {{ t('planner.card.edit') }}
      </UiButton>
    </div>
  </section>
</template>
