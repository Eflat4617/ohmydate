<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

const props = defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();

const searchInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    searchInput.value?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="open" class="dialog-backdrop" @click.self="$emit('close')">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="search-title"
      @keydown.esc.stop="$emit('close')"
    >
      <h2 id="search-title">Search</h2>
      <label for="global-search">Search tasks</label>
      <input
        id="global-search"
        ref="searchInput"
        type="search"
        placeholder="Search is coming in a later milestone"
        autocomplete="off"
      />
      <p class="muted">Search will arrive with the knowledge milestone.</p>
      <button type="button" class="primary-action" @click="$emit('close')">Close</button>
    </div>
  </div>
</template>
