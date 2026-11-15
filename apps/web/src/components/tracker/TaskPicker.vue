<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ProjectHue } from '../../domain/overview';
import { pickerOptions, type TrackerTask } from '../../domain/tracker';
import { t, tp } from '../../i18n';
import UiBadge from '../ui/UiBadge.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * The task picker (HOLO-02): one field that searches the user's open tasks
 * and holds the one picked. A combobox with a list popup (WAI-ARIA 1.2):
 * typing filters by every word, the arrows move through the list, Enter
 * picks, Escape closes the list (and, with the list closed, puts the picked
 * title back). The task of the next planned block is listed first and marked.
 *
 * It only picks; what is done with the task is its screen's.
 */
const props = withDefaults(
  defineProps<{
    /** The picked task's id, or null. */
    modelValue: string | null;
    tasks: readonly TrackerTask[];
    /** Project titles and hues by id (a task whose project is unknown has no tag). */
    projects: ReadonlyMap<string, { readonly title: string; readonly hue: ProjectHue }>;
    /** The task of the next planned block, if any. */
    nextTaskId?: string | null;
    label: string;
    placeholder: string;
    disabled?: boolean;
    id?: string;
  }>(),
  { nextTaskId: null, disabled: false, id: 'task-picker' },
);
const emit = defineEmits<{ 'update:modelValue': [taskId: string | null] }>();

const input = ref<HTMLInputElement | null>(null);
const open = ref(false);
/** What is typed. While the list is closed it shows the picked task's title. */
const query = ref('');
const activeIndex = ref(0);
/** The person is typing a search (as opposed to looking at the picked title). */
const searching = ref(false);

const picked = computed(() => props.tasks.find((task) => task.id === props.modelValue) ?? null);

watch(
  picked,
  (task) => {
    if (!searching.value) query.value = task?.title ?? '';
  },
  { immediate: true },
);

const result = computed(() => pickerOptions(props.tasks, searching.value ? query.value : '', props.nextTaskId));
const options = computed(() => result.value.options);

watch(options, (list) => {
  if (activeIndex.value >= list.length) activeIndex.value = Math.max(0, list.length - 1);
});

const listId = computed(() => `${props.id}-list`);
function optionId(index: number): string {
  return `${props.id}-option-${index}`;
}

const status = computed(() => {
  if (!open.value) return '';
  if (options.value.length === 0) return t('tracker.picker.none');
  return result.value.more > 0
    ? tp('tracker.picker.countMore', options.value.length, { more: result.value.more })
    : tp('tracker.picker.count', options.value.length);
});

function show(): void {
  if (props.disabled || open.value) return;
  open.value = true;
  const at = options.value.findIndex((task) => task.id === props.modelValue);
  activeIndex.value = at === -1 ? 0 : at;
}

function hide(): void {
  open.value = false;
  searching.value = false;
  query.value = picked.value?.title ?? '';
}

function pick(task: TrackerTask): void {
  emit('update:modelValue', task.id);
  searching.value = false;
  query.value = task.title;
  open.value = false;
  void nextTick(() => input.value?.focus());
}

function onInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value;
  searching.value = true;
  activeIndex.value = 0;
  open.value = true;
  // Emptying the field takes the pick back.
  if (query.value.trim().length === 0 && props.modelValue !== null) emit('update:modelValue', null);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  // Enter that ends a Hangul composition is not a pick.
  if (event.isComposing || event.keyCode === 229) return;
  const count = options.value.length;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (!open.value) show();
      else if (count > 0) activeIndex.value = (activeIndex.value + 1) % count;
      break;
    case 'ArrowUp':
      event.preventDefault();
      if (!open.value) show();
      else if (count > 0) activeIndex.value = (activeIndex.value + count - 1) % count;
      break;
    case 'Home':
      if (open.value && count > 0) {
        event.preventDefault();
        activeIndex.value = 0;
      }
      break;
    case 'End':
      if (open.value && count > 0) {
        event.preventDefault();
        activeIndex.value = count - 1;
      }
      break;
    case 'Enter': {
      if (!open.value) return;
      event.preventDefault();
      const task = options.value[activeIndex.value];
      if (task !== undefined) pick(task);
      break;
    }
    case 'Escape':
      if (!open.value) return;
      event.preventDefault();
      event.stopPropagation();
      hide();
      break;
    default:
      break;
  }
}

function onBlur(event: FocusEvent): void {
  const next = event.relatedTarget;
  const root = (event.currentTarget as HTMLElement).closest('.task-finder');
  if (next instanceof Node && root?.contains(next) === true) return;
  hide();
}

function projectOf(task: TrackerTask) {
  return props.projects.get(task.projectId) ?? null;
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="task-finder" :class="{ 'task-finder--open': open }" data-task-picker>
    <label :for="id" class="field-label task-finder-label">{{ label }}</label>
    <div class="task-finder-field">
      <UiIcon name="search" :size="18" class="task-finder-icon" />
      <input
        :id="id"
        ref="input"
        class="task-finder-input"
        type="text"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-controls="listId"
        :aria-activedescendant="open && options.length > 0 ? optionId(activeIndex) : undefined"
        :value="query"
        :placeholder="placeholder"
        :disabled="disabled"
        @input="onInput"
        @keydown="onKeydown"
        @focus="($event.target as HTMLInputElement).select()"
        @click="show"
        @blur="onBlur"
      />
      <button
        type="button"
        class="btn btn--ghost btn--icon btn--sm task-finder-toggle"
        tabindex="-1"
        :aria-label="t('tracker.picker.toggle')"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-controls="listId"
        :disabled="disabled"
        @mousedown.prevent
        @click="open ? hide() : (show(), input?.focus())"
      >
        <UiIcon name="chevron-down" :size="16" />
      </button>
    </div>
    <ul v-show="open" :id="listId" class="menu glass task-finder-list" role="listbox" :aria-label="label">
      <li
        v-for="(task, index) in options"
        :id="optionId(index)"
        :key="task.id"
        class="task-finder-option"
        :class="{ 'task-finder-option--active': index === activeIndex }"
        role="option"
        :aria-selected="task.id === modelValue ? 'true' : 'false'"
        :data-task="task.id"
        @mousedown.prevent
        @mousemove="activeIndex = index"
        @click="pick(task)"
      >
        <span class="task-finder-option-title">{{ task.title }}</span>
        <UiBadge v-if="task.id === nextTaskId" tone="accent" class="task-finder-next">{{ t('tracker.picker.next') }}</UiBadge>
        <UiBadge v-if="projectOf(task)" :class="`badge--${projectOf(task)?.hue}`">{{ projectOf(task)?.title }}</UiBadge>
        <UiIcon v-if="task.id === modelValue" name="check" :size="16" class="task-finder-check" />
      </li>
      <li v-if="options.length === 0" class="task-finder-empty" role="presentation">{{ t('tracker.picker.none') }}</li>
      <li v-else-if="result.more > 0" class="task-finder-empty" role="presentation">
        {{ tp('tracker.picker.more', result.more) }}
      </li>
    </ul>
    <p class="visually-hidden" role="status" aria-live="polite">{{ status }}</p>
  </div>
</template>
