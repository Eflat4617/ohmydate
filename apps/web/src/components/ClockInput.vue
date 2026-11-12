<script setup lang="ts">
import { normaliseClockInput } from '../domain/availabilityGrid';
import { t } from '../i18n';

/**
 * 24-hour `HH:mm` field for availability times (FU-97).
 *
 * A native `<input type="time">` cannot hold `24:00` (a rule that runs to
 * midnight showed an empty end) and drops a half-typed value such as `10:--`
 * to an empty string, which then saved as "no time". This field keeps
 * exactly what is typed; on blur it tidies `9` → `09:00`, `930` → `09:30`, and
 * the form's validation explains anything it still cannot read.
 */
const model = defineModel<string | undefined>();

defineProps<{
  id: string;
  disabled?: boolean;
  invalid?: boolean;
}>();

const emit = defineEmits<{ edited: [] }>();

function onInput(event: Event): void {
  model.value = (event.target as HTMLInputElement).value;
  emit('edited');
}

function onBlur(event: Event): void {
  const input = event.target as HTMLInputElement;
  const normal = normaliseClockInput(input.value);
  if (normal === input.value) return;
  input.value = normal;
  model.value = normal;
  emit('edited');
}
</script>

<template>
  <input
    :id="id"
    class="clock-input"
    type="text"
    inputmode="numeric"
    autocomplete="off"
    spellcheck="false"
    maxlength="5"
    :placeholder="t('availability.clockPlaceholder')"
    :value="model ?? ''"
    :disabled="disabled"
    :aria-invalid="invalid ? 'true' : undefined"
    @input="onInput"
    @blur="onBlur"
  />
</template>
