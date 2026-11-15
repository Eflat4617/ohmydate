<script setup lang="ts">
import { computed, ref } from 'vue';
import ThemeSwitch from '../ThemeSwitch.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import { t } from '../../i18n';
import { useLayoutStore } from '../../stores/layout';
import { useTransparency } from '../../theme/transparency';

/**
 * 설정 › 화면 (HOLO-04): how the app looks and how it rearranges itself —
 * the theme, the glass, and the automatic layout (its switch, its lock and
 * the order it decides in). Everything here is this device's and this
 * owner's; nothing is sent anywhere.
 */
const layout = useLayoutStore();
const { reduced, setReduced } = useTransparency();
const status = ref('');

const autoSwitch = computed(() => layout.prefs.autoSwitch);
const locked = computed(() => layout.prefs.locked);
const currentMode = computed(() => layout.current?.mode ?? null);

const ORDER = ['locked', 'focus', 'planning', 'risk', 'review', 'notes', 'overview'] as const;

function onAutoChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!layout.setAutoSwitch(target.checked)) {
    // Not saved (the signed-in user changed): show what is really in effect.
    target.checked = layout.prefs.autoSwitch;
    return;
  }
  status.value = target.checked ? t('layout.announce.autoOn') : t('layout.announce.autoOff');
}

function onTransparencyChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!setReduced(target.checked)) {
    target.checked = reduced.value;
    return;
  }
  status.value = target.checked ? t('settings.display.glassOffStatus') : t('settings.display.glassOnStatus');
}

function lockCurrent(): void {
  const mode = currentMode.value;
  if (mode === null || !layout.lockCurrent()) return;
  status.value = t('layout.announce.locked', { mode: layout.modeName(mode) });
}

function unlock(): void {
  layout.unlock();
  if (layout.prefs.locked === null) status.value = t('layout.announce.unlocked');
}
</script>

<template>
  <section class="settings-section layout-settings" aria-labelledby="layout-settings-title" data-settings-display>
    <header class="settings-section-head">
      <div class="page-heading">
        <h2 id="layout-settings-title" class="settings-section-title">{{ t('settings.display.title') }}</h2>
        <p class="page-lede">{{ t('settings.display.lede') }}</p>
      </div>
    </header>

    <div class="settings-cards">
      <section class="card settings-card" aria-labelledby="display-theme-title" data-display-theme>
        <h3 id="display-theme-title" class="card-title"><UiIcon name="sun" :size="18" />{{ t('settings.display.theme') }}</h3>
        <p class="settings-card-lede">{{ t('settings.display.themeHelp') }}</p>
        <ThemeSwitch class="settings-theme" />
      </section>

      <section class="card settings-card" aria-labelledby="display-glass-title" data-display-glass>
        <h3 id="display-glass-title" class="card-title"><UiIcon name="ring" :size="18" />{{ t('settings.display.glass') }}</h3>
        <label class="switch-row">
          <input
            type="checkbox"
            role="switch"
            class="switch"
            :checked="reduced"
            aria-describedby="display-glass-help"
            data-display-transparency
            @change="onTransparencyChange"
          />
          <span>{{ t('settings.display.glassLabel') }}</span>
        </label>
        <p id="display-glass-help" class="settings-card-lede">{{ t('settings.display.glassHelp') }}</p>
      </section>

      <section class="card settings-card settings-card--wide" aria-labelledby="display-layout-title">
        <h3 id="display-layout-title" class="card-title"><UiIcon name="layout" :size="18" />{{ t('layout.settings.title') }}</h3>
        <p class="settings-card-lede">{{ t('layout.settings.lede') }}</p>

        <fieldset class="settings-group settings-group--compact">
          <legend class="visually-hidden">{{ t('layout.settings.autoLegend') }}</legend>
          <label class="switch-row">
            <input
              type="checkbox"
              role="switch"
              class="switch"
              :checked="autoSwitch"
              aria-describedby="layout-auto-help"
              data-layout-auto
              @change="onAutoChange"
            />
            <span>{{ t('layout.settings.autoLabel') }}</span>
          </label>
          <p id="layout-auto-help" class="settings-card-lede">
            {{ autoSwitch ? t('layout.settings.autoOnStatus') : t('layout.settings.autoOffStatus') }}
            {{ t('layout.settings.autoHelp') }}
          </p>
        </fieldset>

        <fieldset class="settings-group settings-group--compact settings-card-part">
          <legend class="visually-hidden">{{ t('layout.settings.lockLegend') }}</legend>
          <p class="settings-current" data-layout-lock-status>
            {{ locked ? t('layout.settings.lockedStatus', { mode: layout.modeName(locked) }) : t('layout.settings.unlockedStatus') }}
          </p>
          <p class="settings-card-lede">{{ t('layout.settings.lockHelp') }}</p>
          <div class="settings-actions">
            <UiButton v-if="locked" icon="lock" data-layout-unlock @click="unlock">{{ t('layout.settings.unlock') }}</UiButton>
            <template v-else>
              <UiButton v-if="currentMode" icon="lock" data-layout-lock @click="lockCurrent">
                {{ t('layout.settings.lockCurrent', { mode: layout.modeName(currentMode) }) }}
              </UiButton>
              <p v-else class="settings-card-lede">{{ t('layout.settings.lockUnavailable') }}</p>
            </template>
          </div>
        </fieldset>

        <details class="settings-fold">
          <summary>{{ t('layout.settings.orderLegend') }}</summary>
          <ol class="layout-order">
            <li v-for="rule in ORDER" :key="rule">{{ t(`layout.settings.order.${rule}`) }}</li>
          </ol>
        </details>
      </section>
    </div>

    <p class="visually-hidden" role="status" aria-live="polite">{{ status }}</p>
  </section>
</template>
