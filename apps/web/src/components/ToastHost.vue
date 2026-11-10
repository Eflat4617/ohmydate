<script setup lang="ts">
import { useToastStore, type Toast } from '../stores/toast';

const toast = useToastStore();

function runAction(item: Toast): void {
  item.action?.handler();
  toast.dismiss(item.id);
}
</script>

<template>
  <div class="toast-region" aria-live="polite" aria-atomic="false">
    <div
      v-for="item in toast.toasts"
      :key="item.id"
      class="toast"
      :class="`toast--${item.tone}`"
      role="status"
    >
      <span>{{ item.message }}</span>
      <button v-if="item.action" type="button" class="toast-action" @click="runAction(item)">
        {{ item.action.label }}
      </button>
      <button
        type="button"
        class="toast-dismiss"
        :aria-label="`Dismiss notification: ${item.message}`"
        @click="toast.dismiss(item.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>
