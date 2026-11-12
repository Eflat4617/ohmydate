<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DocumentLink, DocumentLinkCreate } from '../../api';
import { sameTarget, type LinkTargets } from '../../composables/notes';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiField from '../ui/UiField.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import { t } from '../../i18n';

/**
 * Picks one project or task to link a note to (08 §2.7 POST /documents/{id}/links).
 * Already linked targets stay visible but cannot be picked again. Goals have
 * no list endpoint; they are linked from the planning wizard instead.
 */
const props = withDefaults(
  defineProps<{
    links: readonly DocumentLink[];
    targets: LinkTargets;
    busy?: boolean;
    error?: string | null;
  }>(),
  { busy: false, error: null },
);

const emit = defineEmits<{ pick: [link: DocumentLinkCreate]; close: [] }>();

const MAX_OPTIONS = 100;
const kind = ref<'project' | 'task'>('project');
const filter = ref('');
const selected = ref<string | null>(null);

watch(kind, () => {
  selected.value = null;
});

interface Option {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly linked: boolean;
}

const options = computed<Option[]>(() => {
  const needle = filter.value.trim().toLocaleLowerCase('ko-KR');
  const source: Option[] =
    kind.value === 'project'
      ? props.targets.projects.value.map((project) => ({
          id: project.id,
          title: project.kind === 'inbox' ? t('nav.inbox') : project.title,
          detail: null,
          linked: props.links.some((link) => sameTarget(link, 'project', project.id)),
        }))
      : props.targets.tasks.value.map((task) => {
          const project = props.targets.projectOf(task.projectId);
          return {
            id: task.id,
            title: task.title,
            detail: project === undefined ? null : project.kind === 'inbox' ? t('nav.inbox') : project.title,
            linked: props.links.some((link) => sameTarget(link, 'task', task.id)),
          };
        });
  const matched = needle.length === 0 ? source : source.filter((option) => option.title.toLocaleLowerCase('ko-KR').includes(needle));
  return matched.slice(0, MAX_OPTIONS);
});

const total = computed(() => (kind.value === 'project' ? props.targets.projects.value.length : props.targets.tasks.value.length));
const canPick = computed(() => selected.value !== null && !props.busy);

function pick(): void {
  if (selected.value === null || props.busy) return;
  emit('pick', { targetKind: kind.value, targetId: selected.value });
}
</script>

<template>
  <UiDialog labelledby="link-picker-title" describedby="link-picker-hint" class="link-picker" @close="emit('close')">
    <form class="link-picker-form" @submit.prevent="pick">
      <header class="dialog-header">
        <h2 id="link-picker-title" class="dialog-title">{{ t('notes.links.picker.title') }}</h2>
      </header>
      <fieldset class="choice-group">
        <legend>{{ t('notes.links.picker.kindLegend') }}</legend>
        <label class="choice-chip">
          <input v-model="kind" type="radio" name="link-picker-kind" value="project" data-autofocus />
          {{ t('notes.links.kind.project') }}
        </label>
        <label class="choice-chip">
          <input v-model="kind" type="radio" name="link-picker-kind" value="task" />
          {{ t('notes.links.kind.task') }}
        </label>
      </fieldset>
      <UiField id="link-picker-filter" :label="t('notes.links.picker.filterLabel')">
        <input id="link-picker-filter" v-model="filter" type="search" autocomplete="off" maxlength="200" />
      </UiField>
      <p id="link-picker-hint" class="field-help">{{ t('notes.links.picker.goalHint') }}</p>

      <div v-if="targets.loading.value">
        <p class="visually-hidden" role="status">{{ t('notes.links.picker.loading') }}</p>
        <UiSkeleton variant="lines" :lines="3" />
      </div>
      <UiBanner v-else-if="targets.failed.value" tone="error" role="alert">{{ t('notes.links.picker.loadError') }}</UiBanner>
      <p v-else-if="total === 0" class="muted">{{ t('notes.links.picker.empty') }}</p>
      <p v-else-if="options.length === 0" class="muted" role="status">{{ t('notes.links.picker.noMatch') }}</p>
      <fieldset v-else class="link-picker-options">
        <legend class="visually-hidden">{{ t('notes.links.picker.listLabel') }}</legend>
        <label
          v-for="option in options"
          :key="option.id"
          class="link-option"
          :class="{ 'link-option--linked': option.linked }"
          :data-link-option="option.id"
        >
          <input v-model="selected" type="radio" name="link-picker-target" :value="option.id" :disabled="option.linked" />
          <span class="link-option-text">
            <span class="link-option-title">{{ option.title }}</span>
            <span v-if="option.detail" class="link-option-detail muted">{{ option.detail }}</span>
          </span>
          <UiBadge v-if="option.linked" tone="outline">{{ t('notes.links.picker.already') }}</UiBadge>
        </label>
      </fieldset>

      <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
      <div class="dialog-actions">
        <UiButton variant="ghost" @click="emit('close')">{{ t('notes.links.picker.cancel') }}</UiButton>
        <UiButton type="submit" variant="primary" icon="link" :busy="busy" :disabled="!canPick">
          {{ t('notes.links.picker.confirm') }}
        </UiButton>
      </div>
    </form>
  </UiDialog>
</template>
