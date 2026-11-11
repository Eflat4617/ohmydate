<script setup lang="ts">
import { computed, useSlots } from 'vue';
import UiIcon from './UiIcon.vue';
import type { IconName } from './icons';

type Tone = 'info' | 'success' | 'warn' | 'error' | 'offline' | 'conflict' | 'accent';

/**
 * Notice / banner for info, warn, error, offline and conflict states. The
 * caller owns live-region semantics through `role` (status for passive
 * updates, alert for errors that block the user) — the banner never adds one.
 */
const props = withDefaults(
  defineProps<{
    tone?: Tone;
    title?: string | null;
    role?: 'status' | 'alert' | null;
    inline?: boolean;
    icon?: IconName | null;
    as?: string;
  }>(),
  { tone: 'info', title: null, role: null, inline: false, icon: null, as: 'div' },
);

const slots = useSlots();

const DEFAULT_ICONS: Record<Tone, IconName> = {
  info: 'info',
  success: 'check-circle',
  warn: 'warn',
  error: 'error',
  offline: 'offline',
  conflict: 'sync',
  accent: 'info',
};

const iconName = computed<IconName>(() => props.icon ?? DEFAULT_ICONS[props.tone]);
</script>

<template>
  <component
    :is="as"
    class="banner"
    :class="[`banner--${tone}`, { 'banner--inline': inline }]"
    :role="role ?? undefined"
  >
    <UiIcon :name="iconName" :size="20" class="banner-icon" />
    <div class="banner-content">
      <p v-if="title" class="banner-title">{{ title }}</p>
      <div class="banner-body"><slot /></div>
      <div v-if="!inline && slots.actions" class="banner-actions"><slot name="actions" /></div>
    </div>
    <div v-if="inline && slots.actions" class="banner-actions"><slot name="actions" /></div>
  </component>
</template>
