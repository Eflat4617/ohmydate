<script setup lang="ts">
import { ref, watch } from 'vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';
import { t } from '../i18n';

/**
 * The inbox's one-line quick add: type a title, Enter, it is added at once.
 * CAL-05: `primary` (default true) lets the page give its one filled button to
 * 말로 적기 while this field is empty; `filled-change` says when it has text.
 */
const props = withDefaults(defineProps<{ disabled?: boolean; primary?: boolean }>(), {
  disabled: false,
  primary: true,
});
const emit = defineEmits<{ submit: [title: string]; 'filled-change': [filled: boolean] }>();

const title = ref('');
const input = ref<HTMLInputElement | null>(null);

watch(
  () => title.value.trim().length > 0,
  (filled) => emit('filled-change', filled),
);

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
      <UiButton
        type="submit"
        :variant="primary ? 'primary' : 'secondary'"
        :disabled="disabled || title.trim().length === 0"
      >
        {{ t('quickAdd.submit') }}
      </UiButton>
    </div>
  </form>
</template>
