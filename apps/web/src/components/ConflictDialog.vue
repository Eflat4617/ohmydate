<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

defineProps<{
  serverVersion: number;
  serverTitle: string;
  localTitle: string;
}>();

const emit = defineEmits<{ reload: []; overwrite: []; cancel: [] }>();

const reloadButton = ref<HTMLButtonElement | null>(null);

onMounted(() => {
  void nextTick().then(() => reloadButton.value?.focus());
});
</script>

<template>
  <div class="dialog-backdrop">
    <div
      class="dialog conflict-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      aria-describedby="conflict-detail"
    >
      <h2 id="conflict-title">This task changed elsewhere</h2>
      <p id="conflict-detail">
        The server has version <strong>{{ serverVersion }}</strong
        >. Your edit was based on an older version.
      </p>
      <dl class="conflict-summary">
        <dt>Server title</dt>
        <dd>{{ serverTitle }}</dd>
        <dt>Your edit</dt>
        <dd>{{ localTitle }}</dd>
      </dl>
      <p class="muted">Reload keeps the server version. Overwrite re-fetches and re-applies your edit.</p>
      <div class="dialog-actions">
        <button ref="reloadButton" type="button" class="primary-action" @click="emit('reload')">
          Reload server version
        </button>
        <button type="button" @click="emit('overwrite')">Overwrite with my edit</button>
        <button type="button" class="link-button" @click="emit('cancel')">Keep editing</button>
      </div>
    </div>
  </div>
</template>
