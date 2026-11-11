<script setup lang="ts">
import { computed } from 'vue';
import type { ConflictOperation } from '../composables/useTaskActions';
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';
import { t } from '../i18n';
import I18nT from '../i18n/I18nT';

const props = withDefaults(
  defineProps<{
    serverVersion: number;
    serverTitle: string;
    localTitle?: string | null;
    operation?: ConflictOperation;
    disabled?: boolean;
    busy?: boolean;
  }>(),
  { localTitle: null, operation: 'rename', disabled: false, busy: false },
);

const emit = defineEmits<{ reload: []; overwrite: []; cancel: [] }>();

const heading = computed(() => {
  switch (props.operation) {
    case 'complete':
      return t('conflict.headingComplete');
    case 'delete':
      return t('conflict.headingDelete');
    default:
      return t('conflict.headingRename');
  }
});

const overwriteLabel = computed(() => {
  switch (props.operation) {
    case 'complete':
      return t('conflict.overwriteComplete');
    case 'delete':
      return t('conflict.overwriteDelete');
    default:
      return t('conflict.overwriteRename');
  }
});

const cancelLabel = computed(() => (props.operation === 'rename' ? t('conflict.keepEditing') : t('common.cancel')));
</script>

<template>
  <!-- FU-09: focus trap, Escape = Keep editing, inert editor and global-shortcut
       isolation all come from UiDialog. -->
  <UiDialog
    labelledby="conflict-title"
    describedby="conflict-detail"
    class="conflict-dialog"
    @close="emit('cancel')"
  >
    <header class="dialog-header dialog-header--start">
      <span class="dialog-icon dialog-icon--warn"><UiIcon name="sync" :size="22" /></span>
      <div class="dialog-heading">
        <h2 id="conflict-title" class="dialog-title">{{ heading }}</h2>
        <p id="conflict-detail" class="muted">
          <I18nT keypath="conflict.detail">
            <template #version><strong>{{ serverVersion }}</strong></template>
          </I18nT>
        </p>
      </div>
    </header>
    <dl class="conflict-summary">
      <template v-if="operation === 'rename'">
        <dt>{{ t('conflict.serverTitle') }}</dt>
        <dd>{{ serverTitle }}</dd>
        <dt>{{ t('conflict.yourEdit') }}</dt>
        <dd>{{ localTitle ?? '' }}</dd>
      </template>
      <template v-else>
        <dt>{{ t('conflict.serverTitle') }}</dt>
        <dd>{{ serverTitle }}</dd>
        <dt>{{ t('conflict.yourChange') }}</dt>
        <dd>{{ operation === 'complete' ? t('conflict.markComplete') : t('conflict.deleteTask') }}</dd>
      </template>
    </dl>
    <p class="muted">{{ t('conflict.help') }}</p>
    <div class="dialog-actions dialog-actions--start" :aria-busy="busy ? 'true' : undefined">
      <UiButton
        variant="primary"
        data-autofocus
        :disabled="disabled || busy"
        @click="emit('reload')"
      >
        {{ t('conflict.reload') }}
      </UiButton>
      <UiButton :disabled="disabled || busy" @click="emit('overwrite')">
        {{ overwriteLabel }}
      </UiButton>
      <UiButton variant="ghost" @click="emit('cancel')">
        {{ cancelLabel }}
      </UiButton>
    </div>
  </UiDialog>
</template>
