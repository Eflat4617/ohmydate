<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { clearFlowReturn, useFlowReturn } from '../composables/flowReturn';
import { captureOwnerBinding } from '../session/ownerEpoch';
import AiSettings from '../components/settings/AiSettings.vue';
import AvailabilitySettings from '../components/settings/AvailabilitySettings.vue';
import CalendarSettings from '../components/settings/CalendarSettings.vue';
import DisplaySettings from '../components/settings/DisplaySettings.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import type { IconName } from '../components/ui/icons';
import { SETTINGS_SECTIONS, settingsSectionOf, type SettingsSection } from '../domain/settings';
import { t } from '../i18n';

/**
 * 설정 (HOLO-04, FLOW.md §4): one screen, four sections — 가용 시간, 캘린더
 * 연동, AI, 화면. It is where things are changed later, not where anyone has
 * to go first: every flow asks for what it needs where it needs it.
 *
 * The section is in the address (`/settings/calendar`), so each one can be
 * linked to and the Google sign-in comes back to its own section.
 */
const route = useRoute();
const router = useRouter();
const section = computed(() => settingsSectionOf(route.params['section']));

// FLOW §5 되돌아오기: a flow that sent the owner here (to connect a calendar) left its address.
const { path: returnPath } = useFlowReturn();
function goBack(): void {
  const target = returnPath.value;
  if (target === null) return;
  clearFlowReturn(captureOwnerBinding());
  void router.push(target);
}

const SECTIONS: Readonly<Record<SettingsSection, { readonly icon: IconName; readonly component: Component }>> = {
  availability: { icon: 'availability', component: AvailabilitySettings },
  calendar: { icon: 'link', component: CalendarSettings },
  ai: { icon: 'ai', component: AiSettings },
  display: { icon: 'layout', component: DisplaySettings },
};
</script>

<template>
  <section class="page page--wide settings-page" data-settings :data-settings-section="section">
    <header class="page-header settings-head">
      <div class="page-heading">
        <h1>{{ t('settings.title') }}</h1>
        <p class="page-lede">{{ t('settings.lede') }}</p>
      </div>
      <nav class="segmented glass glass--still glass--flat settings-sections" :aria-label="t('settings.sections')">
        <RouterLink
          v-for="id in SETTINGS_SECTIONS"
          :key="id"
          :to="{ name: 'settings', params: { section: id }, query: {} }"
          class="btn segmented-item"
          :aria-current="section === id ? 'page' : undefined"
          :data-settings-link="id"
        >
          <UiIcon :name="SECTIONS[id].icon" :size="16" />
          {{ t(`settings.section.${id}`) }}
        </RouterLink>
      </nav>
    </header>

    <!-- Sent here from a flow: the way back is the first thing on the screen. -->
    <div v-if="returnPath" class="banner banner--accent banner--inline settings-return" role="status" data-settings-return>
      <UiIcon name="arrow-left" :size="18" class="banner-icon" />
      <div class="banner-content">
        <p class="banner-body">{{ t('settings.return.body') }}</p>
      </div>
      <div class="banner-actions">
        <button type="button" class="btn btn--sm" data-settings-return-go @click="goBack">{{ t('settings.return.go') }}</button>
      </div>
    </div>

    <!-- One section at a time; a section keeps nothing of another's state. -->
    <component :is="SECTIONS[section].component" :key="section" />
  </section>
</template>
