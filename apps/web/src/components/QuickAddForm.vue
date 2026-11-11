<script setup lang="ts">
import { ref } from 'vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';
import { t } from '../i18n';

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ submit: [title: string] }>();

const title = ref('');
const input = ref<HTMLInputElement | null>(null);

function submit(): void {
  if (props.disabled === true) return;
  const value = title.value.trim();
  if (value.length === 0) return;
  emit('submit', value);
}

function clear(): void {
  title.value = '';
}

function focus(): void {
  input.value?.focus();
}

defineExpose({ focus, clear });
</script>

<template>
  <form class="quick-add" :class="{ 'quick-add--disabled': disabled }" @submit.prevent="submit">
    <label for="quick-add-title" class="quick-add-label">{{ t('quickAdd.label') }}</label>
    <div class="quick-add-row">
      <UiIcon name="plus" class="quick-add-icon" />
      <input
        id="quick-add-title"
        ref="input"
        v-model="title"
        class="quick-add-input"
        type="text"
        maxlength="200"
        :placeholder="t('quickAdd.placeholder')"
        autocomplete="off"
        :disabled="disabled"
      />
      <UiButton type="submit" variant="primary" :disabled="disabled || title.trim().length === 0">
        {{ t('quickAdd.submit') }}
      </UiButton>
    </div>
  </form>
</template>
