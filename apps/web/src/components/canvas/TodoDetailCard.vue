<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Project, Task } from '../../api';
import { useFocusStart, useRunningSession } from '../../composables/useOverview';
import type { CanvasTodo } from '../../domain/canvas/todo';
import { projectHue } from '../../domain/overview';
import { instantFromLocalInput, localInputValue } from '../../domain/time';
import { t } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import type { CanvasActions } from './types';

/**
 * The one floating detail of the 할 일 canvas (HOLO-05): the screen's single
 * frosted surface, anchored to the to-do it is about. What can be done to a
 * to-do is here —
 *
 *   제목 (edited in place, saved with Enter or 저장) · 마감 (set, change, clear)
 *   폴더 (file it without dragging) · 완료 · 집중 시작 · 계획에 넣기 · 작업 열기 · 삭제
 *
 * None of its buttons is filled: the screen's one primary is 계획에 넣기 in
 * the head. It is a dialog that does not block the page: Escape and 닫기 give
 * the focus back to the to-do, and Tab out of it closes it. Offline it reads
 * only (nothing is renamed, filed, finished or deleted).
 */
const props = defineProps<{
  todo: CanvasTodo<Task>;
  folders: readonly Project[];
  timeZone: string;
  disabled: boolean;
  /** Which side of its to-do the card stands on (for the small entrance). */
  side: 'right' | 'left' | 'below' | 'above';
  actions: CanvasActions;
}>();
const emit = defineEmits<{ close: [restoreFocus: boolean] }>();

const router = useRouter();
const { running, refetch: refetchRunning } = useRunningSession();
const focus = useFocusStart({ onActiveExists: refetchRunning });

const task = computed(() => props.todo.task);

// ── 제목 ────────────────────────────────────────────────────────────────
const draft = ref(props.todo.task.title);
const titleInput = ref<HTMLInputElement | null>(null);
const saving = ref(false);
const dirty = computed(() => draft.value.trim().length > 0 && draft.value.trim() !== task.value.title);
// The title changed under the card (saved, or changed elsewhere): show it, unless the owner is typing.
watch(
  () => task.value.title,
  (title, before) => {
    if (draft.value.trim() === before || !dirty.value) draft.value = title;
  },
);

async function saveTitle(): Promise<void> {
  if (!dirty.value || saving.value || props.disabled) return;
  saving.value = true;
  try {
    await props.actions.rename(task.value, draft.value.trim());
  } finally {
    saving.value = false;
    // 저장 goes away once the title is saved: the focus stays in the card, on the title.
    void nextTick(() => {
      if (document.activeElement === document.body || document.activeElement === null) titleInput.value?.focus({ preventScroll: true });
    });
  }
}

// ── 마감 ────────────────────────────────────────────────────────────────
const dueText = computed(() =>
  task.value.dueAt === undefined ? t('canvas.detail.dueNone') : formatDateTime(task.value.dueAt, props.timeZone),
);
const dueOpen = ref(false);
const dueLocal = ref('');
const dueBusy = ref(false);

function openDue(): void {
  dueLocal.value = task.value.dueAt === undefined ? '' : localInputValue(task.value.dueAt, props.timeZone);
  dueOpen.value = !dueOpen.value;
}

async function saveDue(next: string | null): Promise<void> {
  if (dueBusy.value || props.disabled) return;
  dueBusy.value = true;
  try {
    if (await props.actions.setDue(task.value, next)) dueOpen.value = false;
  } finally {
    dueBusy.value = false;
  }
}

function submitDue(): void {
  if (dueLocal.value.length === 0) return;
  void saveDue(instantFromLocalInput(dueLocal.value, props.timeZone));
}

// ── 폴더 ────────────────────────────────────────────────────────────────
const INBOX = '';
const folderChoice = computed(() => props.todo.folderId ?? INBOX);
const folderTag = computed(() => {
  const folder = props.folders.find((item) => item.id === props.todo.folderId);
  return folder === undefined ? null : { title: folder.title, hue: projectHue(folder.id) };
});

function onFolderChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const next = value === INBOX ? null : value;
  if (next === props.todo.folderId || props.disabled) return;
  // The to-do goes to another water: the card has nothing left to stand by.
  void props.actions.file([task.value], next);
  emit('close', true);
}

// ── What can be done with it ────────────────────────────────────────────
const completing = ref(false);
async function complete(): Promise<void> {
  if (completing.value || props.disabled) return;
  completing.value = true;
  try {
    if (await props.actions.complete(task.value)) emit('close', false);
  } finally {
    completing.value = false;
  }
}

function remove(): void {
  if (props.disabled) return;
  props.actions.remove(task.value);
  emit('close', false);
}

function start(): void {
  void focus.start({ taskId: task.value.id, title: task.value.title });
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

/** Focus that walks out of the card closes it — unless it went into a dialog laid over the page. */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  const root = event.currentTarget;
  if (!(next instanceof Element) || !(root instanceof Node) || root.contains(next)) return;
  if (next.closest('.dialog, [role="dialog"], [role="alertdialog"]') !== null) return;
  emit('close', false);
}
</script>

<template>
  <section
    class="pond-card glass"
    :class="`pond-card--${side}`"
    role="dialog"
    aria-modal="false"
    :aria-label="t('canvas.detail.label')"
    tabindex="-1"
    data-pond-ignore
    data-todo-card
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <header class="pond-card-head">
      <p class="pond-card-tags">
        <UiBadge v-if="task.status === 'in_progress'" tone="info" data-todo-card-status>{{ t('canvas.todo.inProgress') }}</UiBadge>
        <UiBadge v-if="todo.overdue" tone="danger" data-todo-card-overdue>{{ t('task.overdue') }}</UiBadge>
        <UiBadge v-if="todo.planned" tone="accent" data-todo-card-planned>{{ t('canvas.todo.planned') }}</UiBadge>
        <UiBadge v-if="folderTag" :class="`badge--${folderTag.hue}`" data-todo-card-folder>{{ folderTag.title }}</UiBadge>
        <UiBadge v-else tone="outline" data-todo-card-folder>{{ t('canvas.inbox') }}</UiBadge>
      </p>
      <button
        type="button"
        class="btn btn--ghost btn--icon btn--sm pond-card-close"
        :aria-label="t('common.close')"
        data-todo-card-close
        @click="emit('close', true)"
      >
        <UiIcon name="close" :size="16" />
      </button>
    </header>

    <form class="pond-card-title" @submit.prevent="saveTitle">
      <label :for="`pond-card-title-${task.id}`" class="visually-hidden">{{ t('canvas.detail.title') }}</label>
      <input
        :id="`pond-card-title-${task.id}`"
        ref="titleInput"
        v-model="draft"
        type="text"
        maxlength="200"
        class="pond-card-title-input"
        autocomplete="off"
        :disabled="disabled || saving"
        data-todo-card-title
      />
      <UiButton v-if="dirty" type="submit" size="sm" :busy="saving" :disabled="disabled || saving" data-todo-card-save>
        {{ saving ? t('canvas.detail.saving') : t('canvas.detail.save') }}
      </UiButton>
    </form>

    <div class="pond-card-row">
      <UiIcon name="flag" :size="16" class="pond-card-row-icon" />
      <p class="pond-card-due tabular" :class="{ 'pond-card-due--overdue': todo.overdue }" data-todo-card-due>
        <span class="visually-hidden">{{ t('canvas.detail.due') }}</span>
        {{ dueText }}
      </p>
      <button
        type="button"
        class="pond-card-link"
        :aria-expanded="dueOpen ? 'true' : 'false'"
        :disabled="disabled"
        data-todo-card-due-toggle
        @click="openDue"
      >
        {{ task.dueAt === undefined ? t('canvas.detail.dueSet') : t('canvas.detail.dueChange') }}
      </button>
    </div>
    <form v-if="dueOpen" class="pond-card-due-form" data-todo-card-due-form @submit.prevent="submitDue">
      <label :for="`pond-card-due-${task.id}`" class="visually-hidden">{{ t('canvas.detail.dueInput') }}</label>
      <input :id="`pond-card-due-${task.id}`" v-model="dueLocal" type="datetime-local" :disabled="disabled || dueBusy" data-todo-card-due-input />
      <div class="pond-card-due-actions">
        <UiButton type="submit" size="sm" :busy="dueBusy" :disabled="disabled || dueBusy || dueLocal.length === 0" data-todo-card-due-save>
          {{ t('canvas.detail.dueSave') }}
        </UiButton>
        <UiButton
          v-if="task.dueAt !== undefined"
          size="sm"
          variant="ghost"
          :disabled="disabled || dueBusy"
          data-todo-card-due-clear
          @click="saveDue(null)"
        >
          {{ t('canvas.detail.dueClear') }}
        </UiButton>
      </div>
    </form>

    <div class="pond-card-row">
      <UiIcon name="projects" :size="16" class="pond-card-row-icon" />
      <label :for="`pond-card-folder-${task.id}`" class="visually-hidden">{{ t('canvas.detail.folder') }}</label>
      <select
        :id="`pond-card-folder-${task.id}`"
        class="pond-card-folder"
        :value="folderChoice"
        :disabled="disabled"
        data-todo-card-folder-select
        @change="onFolderChange"
      >
        <option :value="INBOX">{{ t('canvas.picker.inbox') }}</option>
        <option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.title }}</option>
      </select>
    </div>

    <p v-if="todo.planned" class="pond-card-note" data-todo-card-planned-note>{{ t('canvas.detail.plannedNote') }}</p>
    <p v-if="disabled" class="pond-card-note" role="status" data-todo-card-offline>{{ t('canvas.detail.offline') }}</p>
    <UiBanner v-if="focus.error.value" tone="error" inline role="alert" data-todo-card-error>{{ focus.error.value }}</UiBanner>

    <div class="pond-card-actions">
      <UiButton
        size="sm"
        icon="check"
        :busy="completing"
        :disabled="disabled || completing"
        :aria-label="t('canvas.detail.completeAria', { title: task.title })"
        data-todo-card-complete
        @click="complete"
      >
        {{ t('canvas.detail.complete') }}
      </UiButton>
      <UiButton v-if="running" size="sm" icon="play" data-todo-card-resume @click="resume">{{ t('canvas.detail.resume') }}</UiButton>
      <UiButton
        v-else
        size="sm"
        icon="play"
        :busy="focus.startingTaskId.value !== null"
        :disabled="!focus.canStart.value"
        data-todo-card-focus
        @click="start"
      >
        {{ focus.startingTaskId.value !== null ? t('canvas.detail.focusStarting') : t('canvas.detail.focus') }}
      </UiButton>
      <RouterLink class="btn btn--sm" :to="{ path: '/plan/schedule', query: { taskIds: task.id } }" data-todo-card-plan>
        <UiIcon name="plan" :size="16" class="btn-icon" />{{ t('canvas.detail.toPlan') }}
      </RouterLink>
    </div>
    <div class="pond-card-foot">
      <RouterLink class="pond-card-link" :to="`/tasks/${task.id}`" data-todo-card-open>
        {{ t('canvas.detail.open') }}<UiIcon name="arrow-right" :size="14" />
      </RouterLink>
      <UiButton
        size="sm"
        variant="danger-ghost"
        icon="trash"
        :disabled="disabled"
        :aria-label="t('canvas.detail.removeAria', { title: task.title })"
        data-todo-card-remove
        @click="remove"
      >
        {{ t('canvas.detail.remove') }}
      </UiButton>
    </div>
  </section>
</template>
