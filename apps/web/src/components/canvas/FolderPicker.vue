<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import type { Project } from '../../api';
import { projectHue } from '../../domain/overview';
import { t } from '../../i18n';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 폴더로 옮기기 (HOLO-05): where the picked to-dos go, without a drag — the
 * open water (인박스), any folder, or a new one. A menu: the arrow keys walk
 * it, Enter picks, Escape puts it away. It opens from `v` on the canvas and
 * from the selection bar.
 */
const props = defineProps<{
  folders: readonly Project[];
  /** Where every picked to-do already is (marked, and not offered as a move): a folder id, null for the inbox, undefined when they differ. */
  current: string | null | undefined;
}>();
const emit = defineEmits<{ pick: [folderId: string | null]; create: []; close: [restoreFocus: boolean] }>();

const root = ref<HTMLElement | null>(null);

function items(): HTMLElement[] {
  return [...(root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
}

onMounted(() => {
  void nextTick(() => items()[0]?.focus({ preventScroll: true }));
});

function onKeydown(event: KeyboardEvent): void {
  const list = items();
  const index = list.indexOf(document.activeElement as HTMLElement);
  let next: number | null = null;
  if (event.key === 'ArrowDown') next = (index + 1) % list.length;
  else if (event.key === 'ArrowUp') next = (index + list.length - 1) % list.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = list.length - 1;
  else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close', true);
    return;
  } else if (event.key === 'Tab') {
    emit('close', false);
    return;
  }
  if (next === null) return;
  event.preventDefault();
  event.stopPropagation();
  list[next]?.focus({ preventScroll: true });
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (!(next instanceof Node) || root.value?.contains(next) === true) return;
  emit('close', false);
}
</script>

<template>
  <div
    ref="root"
    class="menu glass pond-picker"
    role="menu"
    :aria-label="t('canvas.picker.title')"
    data-pond-ignore
    data-folder-picker
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <p class="menu-note" aria-hidden="true">{{ t('canvas.picker.title') }}</p>
    <button
      type="button"
      role="menuitem"
      class="btn btn--ghost menu-item"
      :disabled="props.current === null"
      data-folder-pick="inbox"
      @click="emit('pick', null)"
    >
      <UiIcon name="inbox" :size="16" class="btn-icon" />
      <span class="pond-picker-name">{{ t('canvas.picker.inbox') }}</span>
      <span v-if="props.current === null" class="pond-picker-here">{{ t('canvas.picker.current') }}</span>
    </button>
    <button
      v-for="folder in folders"
      :key="folder.id"
      type="button"
      role="menuitem"
      class="btn btn--ghost menu-item"
      :disabled="props.current === folder.id"
      :data-folder-pick="folder.id"
      @click="emit('pick', folder.id)"
    >
      <span class="pond-dot" :data-hue="projectHue(folder.id)" aria-hidden="true"></span>
      <span class="pond-picker-name">{{ folder.title }}</span>
      <span v-if="props.current === folder.id" class="pond-picker-here">{{ t('canvas.picker.current') }}</span>
    </button>
    <button type="button" role="menuitem" class="btn btn--ghost menu-item" data-folder-pick="new" @click="emit('create')">
      <UiIcon name="plus" :size="16" class="btn-icon" />
      <span class="pond-picker-name">{{ t('canvas.picker.newFolder') }}</span>
    </button>
  </div>
</template>
