<script setup lang="ts">
import { computed, ref } from 'vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiButton from '../components/ui/UiButton.vue';
import { t } from '../i18n';
import { useLayoutStore } from '../stores/layout';

const layout = useLayoutStore();
const status = ref('');

const autoSwitch = computed(() => layout.prefs.autoSwitch);
const locked = computed(() => layout.prefs.locked);
const currentMode = computed(() => layout.current?.mode ?? null);

const ORDER = ['locked', 'focus', 'planning', 'risk', 'review', 'notes', 'overview'] as const;

function onAutoChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  layout.setAutoSwitch(target.checked);
  status.value = target.checked ? t('layout.announce.autoOn') : t('layout.announce.autoOff');
}

function lockCurrent(): void {
  const mode = currentMode.value;
  if (mode === null || !layout.lockCurrent()) return;
  status.value = t('layout.announce.locked', { mode: layout.modeName(mode) });
}

function unlock(): void {
  layout.unlock();
  status.value = t('layout.announce.unlocked');
}
</script>

<template>
  <section class="page layout-settings" aria-labelledby="layout-settings-title">
    <header class="page-header">
      <div class="page-heading">
        <h1 id="layout-settings-title">{{ t('layout.settings.title') }}</h1>
        <p class="page-lede">{{ t('layout.settings.lede') }}</p>
      </div>
    </header>

    <fieldset class="settings-group">
      <legend>{{ t('layout.settings.autoLegend') }}</legend>
      <div class="settings-status">
        <UiBadge :tone="autoSwitch ? 'success' : 'neutral'" dot size="lg">
          {{ autoSwitch ? t('layout.settings.autoOnStatus') : t('layout.settings.autoOffStatus') }}
        </UiBadge>
      </div>
      <label class="layout-switch">
        <input
          type="checkbox"
          role="switch"
          :checked="autoSwitch"
          aria-describedby="layout-auto-help"
          data-layout-auto
          @change="onAutoChange"
        />
        <span>{{ t('layout.settings.autoLabel') }}</span>
      </label>
      <p id="layout-auto-help" class="muted">{{ t('layout.settings.autoHelp') }}</p>
    </fieldset>

    <fieldset class="settings-group">
      <legend>{{ t('layout.settings.lockLegend') }}</legend>
      <p class="settings-current" data-layout-lock-status>
        {{ locked ? t('layout.settings.lockedStatus', { mode: layout.modeName(locked) }) : t('layout.settings.unlockedStatus') }}
      </p>
      <p class="muted">{{ t('layout.settings.lockHelp') }}</p>
      <div class="settings-actions">
        <UiButton v-if="locked" icon="lock" data-layout-unlock @click="unlock">{{ t('layout.settings.unlock') }}</UiButton>
        <template v-else>
          <UiButton v-if="currentMode" icon="lock" data-layout-lock @click="lockCurrent">
            {{ t('layout.settings.lockCurrent', { mode: layout.modeName(currentMode) }) }}
          </UiButton>
          <p v-else class="muted">{{ t('layout.settings.lockUnavailable') }}</p>
        </template>
      </div>
    </fieldset>

    <section class="settings-group" aria-labelledby="layout-order-title">
      <h2 id="layout-order-title" class="settings-group-title">{{ t('layout.settings.orderLegend') }}</h2>
      <ol class="layout-order">
        <li v-for="rule in ORDER" :key="rule">{{ t(`layout.settings.order.${rule}`) }}</li>
      </ol>
    </section>

    <p class="visually-hidden" role="status" aria-live="polite">{{ status }}</p>
  </section>
</template>
