<script setup lang="ts">
import { ref } from 'vue';
import {
  defaultGroupOpen,
  groupSelection,
  selectedCount,
  toggleGroup,
  type PickerGroup,
} from '../../domain/planPicker';
import { t, tp } from '../../i18n';
import UiIcon from '../ui/UiIcon.vue';

/**
 * What a plan is made of (FU-98; HOLO-03A moved it into 계획 세우기): the
 * owner's open tasks, grouped by the plan that created them, so a whole plan
 * is picked with one checkbox. The newest plan is on top and open; a group's
 * "모두 선택" is checked, unchecked or — with some of its tasks picked —
 * indeterminate.
 *
 * `selected` is the only state it changes (`update:selected`); which groups
 * are folded is its own.
 */
const props = withDefaults(
  defineProps<{
    groups: readonly PickerGroup[];
    selected: ReadonlySet<string>;
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const emit = defineEmits<{ 'update:selected': [selected: Set<string>] }>();

/** Groups the user opened or closed; the rest follow `defaultGroupOpen`. */
const openOverrides = ref<Readonly<Record<string, boolean>>>({});

function groupTitle(group: PickerGroup): string {
  return group.title ?? t('planScope.groupOther');
}

/** DOM id stem for a group (goal ids are UUIDs, so this is a valid id). */
function groupDomId(group: PickerGroup): string {
  return `picker-group-${group.goalId ?? 'other'}`;
}

function isGroupOpen(group: PickerGroup, index: number): boolean {
  return openOverrides.value[group.key] ?? defaultGroupOpen(index, props.groups.length);
}

function setGroupOpen(group: PickerGroup, index: number): void {
  openOverrides.value = { ...openOverrides.value, [group.key]: !isGroupOpen(group, index) };
}

function toggleTask(taskId: string): void {
  const next = new Set(props.selected);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  emit('update:selected', next);
}

function toggleWholeGroup(group: PickerGroup): void {
  emit('update:selected', toggleGroup(group, props.selected));
}
</script>

<template>
  <div class="picker-groups" data-scope-picker>
    <div
      v-for="(group, index) in groups"
      :key="group.key"
      class="picker-group"
      :class="{ 'picker-group--other': group.kind === 'other' }"
      role="group"
      :aria-labelledby="`${groupDomId(group)}-title`"
      :data-group-key="group.key"
    >
      <div class="picker-group-head">
        <button
          :id="`${groupDomId(group)}-toggle`"
          type="button"
          class="picker-group-toggle"
          :aria-expanded="isGroupOpen(group, index)"
          :aria-controls="`${groupDomId(group)}-tasks`"
          @click="setGroupOpen(group, index)"
        >
          <UiIcon class="picker-group-chevron" name="chevron-right" :size="16" />
          <UiIcon :name="group.kind === 'goal' ? 'plan' : 'inbox'" :size="18" />
          <span class="picker-group-text">
            <span :id="`${groupDomId(group)}-title`" class="picker-group-title">{{ groupTitle(group) }}</span>
            <span class="picker-group-meta">
              <span>{{ tp('planScope.groupCount', group.tasks.length) }}</span>
              <span v-if="selectedCount(group, selected) > 0" class="picker-group-selected">{{
                tp('planScope.groupSelected', selectedCount(group, selected))
              }}</span>
            </span>
          </span>
        </button>
        <label class="picker-group-all">
          <input
            type="checkbox"
            data-group-all
            :checked="groupSelection(group, selected) === 'all'"
            :indeterminate="groupSelection(group, selected) === 'some'"
            :aria-label="t('planScope.selectAllIn', { group: groupTitle(group) })"
            :disabled="disabled"
            @change="toggleWholeGroup(group)"
          />
          <span aria-hidden="true">{{ t('planScope.selectAll') }}</span>
        </label>
      </div>
      <ul v-show="isGroupOpen(group, index)" :id="`${groupDomId(group)}-tasks`" class="task-picker">
        <li v-for="task in group.tasks" :key="task.id">
          <label class="task-picker-row">
            <input
              type="checkbox"
              :value="task.id"
              :checked="selected.has(task.id)"
              :disabled="disabled"
              @change="toggleTask(task.id)"
            />
            <span>{{ task.title }}</span>
          </label>
        </li>
      </ul>
    </div>
  </div>
</template>
