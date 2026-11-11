<script setup lang="ts">
import { useToastStore, type Toast } from '../stores/toast';
import UiIcon from './ui/UiIcon.vue';
import { t } from '../i18n';

const toast = useToastStore();

function runAction(item: Toast): void {
  item.action?.handler();
  toast.dismiss(item.id);
}
</script>

<template>
  <div class="toast-region" aria-live="polite" aria-atomic="false" data-modal-exempt>
    <div
      v-for="item in toast.toasts"
      :key="item.id"
      class="toast"
      :class="`toast--${item.tone}`"
      role="status"
    >
      <UiIcon :name="item.tone === 'error' ? 'error' : 'check-circle'" :size="18" class="toast-icon" />
      <span class="toast-message">{{ item.message }}</span>
      <button
        v-if="item.action"
        type="button"
        class="btn btn--ghost btn--sm toast-action"
        @click="runAction(item)"
      >
        {{ item.action.label }}
      </button>
      <button
        type="button"
        class="btn btn--ghost btn--sm btn--icon toast-dismiss"
        :aria-label="t('toast.dismiss', { message: item.message })"
        @click="toast.dismiss(item.id)"
      >
        <UiIcon name="close" :size="16" />
      </button>
    </div>
  </div>
</template>
