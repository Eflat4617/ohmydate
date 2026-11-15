<script setup lang="ts">
import { computed } from 'vue';
import type { Project, Task } from '../../api';
import { projectHue } from '../../domain/overview';
import { t, tp } from '../../i18n';
import InboxView from '../../views/InboxView.vue';
import TaskList from '../TaskList.vue';
import UiBadge from '../ui/UiBadge.vue';

/**
 * 할 일 · 목록 (HOLO-05): the same to-dos as rows, for anyone who would rather
 * read a list than a surface. The inbox first — with the one-line quick add
 * and 말로 적기 as they always were — then every folder as a section of its
 * own, finished to-dos included. A row is renamed, finished and deleted in
 * place (TaskList), with the same conflict dialog and the same undo.
 */
const props = defineProps<{
  /** Every to-do of the board: the inbox's and the folders', open and finished. */
  tasks: readonly Task[];
  folders: readonly Project[];
  disabled: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();

const byFolder = computed(() => {
  const map = new Map<string, Task[]>();
  for (const task of props.tasks) {
    const list = map.get(task.projectId);
    if (list === undefined) map.set(task.projectId, [task]);
    else list.push(task);
  }
  return map;
});

function tasksOf(folderId: string): Task[] {
  return byFolder.value.get(folderId) ?? [];
}

function openCount(folderId: string): number {
  return tasksOf(folderId).filter((task) => task.status !== 'done').length;
}
</script>

<template>
  <div class="todo-list" data-tasks-list>
    <InboxView />
    <section
      v-for="folder in folders"
      :key="folder.id"
      class="todo-list-section"
      :aria-labelledby="`todo-list-folder-${folder.id}`"
      :data-list-folder="folder.id"
    >
      <header class="todo-list-head">
        <h2 :id="`todo-list-folder-${folder.id}`" class="todo-list-title">
          <span class="pond-dot" :data-hue="projectHue(folder.id)" aria-hidden="true"></span>
          <RouterLink :to="`/projects/${folder.id}`" data-list-folder-link>{{ folder.title }}</RouterLink>
        </h2>
        <UiBadge v-if="openCount(folder.id) > 0" tone="outline" data-list-folder-count>
          {{ tp('inbox.openCount', openCount(folder.id)) }}
        </UiBadge>
      </header>
      <TaskList :tasks="tasksOf(folder.id)" :disabled="disabled" :empty-text="t('canvas.list.folderEmpty')" @refresh="emit('refresh')" />
    </section>
  </div>
</template>
