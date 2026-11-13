<script setup lang="ts">
import { computed } from 'vue';
import UiIcon from './UiIcon.vue';

/**
 * Label + control + help + error, wired by id. The control itself stays a
 * native element in the caller's slot (so v-model and modifiers are untouched);
 * the slot receives `describedby` / `invalid` to bind onto it.
 */
const props = withDefaults(
  defineProps<{
    id: string;
    label: string;
    help?: string | null;
    error?: string | null;
    hideLabel?: boolean;
  }>(),
  { help: null, error: null, hideLabel: false },
);

const helpId = computed(() => (props.help ? `${props.id}-help` : undefined));
const errorId = computed(() => (props.error ? `${props.id}-error` : undefined));
const describedby = computed(() => {
  const ids = [helpId.value, errorId.value].filter((value): value is string => value !== undefined);
  return ids.length === 0 ? undefined : ids.join(' ');
});
const invalid = computed<'true' | undefined>(() => (props.error ? 'true' : undefined));
</script>

<template>
  <div class="field" :class="{ 'field--invalid': error }">
    <label :for="id" class="field-label" :class="{ 'visually-hidden': hideLabel }">{{ label }}</label>
    <slot :id="id" :describedby="describedby" :invalid="invalid" />
    <p v-if="help" :id="helpId" class="field-help">{{ help }}</p>
    <p v-if="error" :id="errorId" class="field-error">
      <UiIcon name="error" :size="16" />
      <span>{{ error }}</span>
    </p>
  </div>
</template>
