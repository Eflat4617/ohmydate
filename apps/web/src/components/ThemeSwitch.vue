<script setup lang="ts">
import { t, type MessageKey } from '../i18n';
import { useTheme, type ThemeChoice } from '../theme/theme';
import UiIcon from './ui/UiIcon.vue';
import type { IconName } from './ui/icons';

/**
 * The colour theme (라이트 · 다크 · 시스템) as a segmented control. It lives
 * in the account menu and in 설정 › 화면; the choice is stored per owner
 * (theme/theme.ts).
 */
const { choice, setTheme } = useTheme();

const OPTIONS: readonly { value: ThemeChoice; label: MessageKey; icon: IconName }[] = [
  { value: 'light', label: 'theme.light', icon: 'sun' },
  { value: 'dark', label: 'theme.dark', icon: 'moon' },
  { value: 'system', label: 'theme.system', icon: 'monitor' },
];
</script>

<template>
  <div class="segmented glass glass--still glass--flat theme-switch" role="group" :aria-label="t('theme.label')">
    <button
      v-for="option in OPTIONS"
      :key="option.value"
      type="button"
      class="btn segmented-item theme-switch-item"
      :aria-pressed="choice === option.value ? 'true' : 'false'"
      :data-theme-choice="option.value"
      @click="setTheme(option.value)"
    >
      <UiIcon :name="option.icon" :size="16" />
      <span class="theme-switch-label">{{ t(option.label) }}</span>
    </button>
  </div>
</template>
