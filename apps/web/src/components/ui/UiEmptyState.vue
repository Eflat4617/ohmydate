<script setup lang="ts">
import { useSlots } from 'vue';
import UiIcon from './UiIcon.vue';
import type { IconName } from './icons';

withDefaults(
  defineProps<{
    title: string;
    icon?: IconName | null;
    as?: string;
    compact?: boolean;
  }>(),
  { icon: 'leaf', as: 'div', compact: false },
);

const slots = useSlots();
</script>

<template>
  <component :is="as" class="empty-state" :class="{ 'empty-state--compact': compact }">
    <span v-if="icon" class="empty-state-icon"><UiIcon :name="icon" :size="22" /></span>
    <p class="empty-state-title">{{ title }}</p>
    <div v-if="slots.default" class="empty-state-body"><slot /></div>
    <div v-if="slots.actions" class="empty-state-actions"><slot name="actions" /></div>
  </component>
</template>
