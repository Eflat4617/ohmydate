<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ submit: [title: string] }>();

const title = ref('');
const input = ref<HTMLInputElement | null>(null);

function submit(): void {
  if (props.disabled === true) return;
  const value = title.value.trim();
  if (value.length === 0) return;
  emit('submit', value);
  title.value = '';
}

function focus(): void {
  input.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <form class="quick-add" @submit.prevent="submit">
    <label for="quick-add-title">Quick add task</label>
    <div class="quick-add-row">
      <input
        id="quick-add-title"
        ref="input"
        v-model="title"
        type="text"
        maxlength="200"
        placeholder="What needs doing?"
        autocomplete="off"
        :disabled="disabled"
      />
      <button type="submit" class="primary-action" :disabled="disabled || title.trim().length === 0">
        Add task
      </button>
    </div>
  </form>
</template>
