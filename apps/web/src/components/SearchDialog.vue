<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiField from './ui/UiField.vue';

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <UiDialog v-if="open" labelledby="search-title" close-on-backdrop @close="$emit('close')">
    <h2 id="search-title" class="dialog-title">Search</h2>
    <UiField
      id="global-search"
      label="Search tasks"
      help="Search will arrive with the knowledge milestone."
    >
      <template #default="{ describedby }">
        <input
          id="global-search"
          type="search"
          placeholder="Search is coming in a later milestone"
          autocomplete="off"
          data-autofocus
          :aria-describedby="describedby"
        />
      </template>
    </UiField>
    <div class="dialog-actions">
      <UiButton variant="primary" @click="$emit('close')">Close</UiButton>
    </div>
  </UiDialog>
</template>
