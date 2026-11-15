<script setup lang="ts">
import { nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { isNavItemCurrent, NAV_PLACES, NAV_SETTINGS } from '../layout/navigation';
import { useUiStore } from '../stores/ui';
import BrandMark from './BrandMark.vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';
import { t } from '../i18n';

/**
 * The sidebar (HOLO-04, FLOW.md §4): the brand, 새 작업, then the places of
 * the loop in its own order, and 설정 and 도움말 at the foot. It is glass
 * that floats off the window's edge. Folded (ui.navCollapsed) it shows icons
 * only; the labels stay in the accessibility tree and become tooltips.
 */
const ui = useUiStore();
const router = useRouter();
const route = useRoute();

function newTask(): void {
  if (route.name === 'tasks' && route.query['view'] === undefined) {
    ui.requestNewTask();
    return;
  }
  void router.push({ name: 'tasks' }).then(async () => {
    await nextTick();
    ui.requestNewTask();
  });
}
</script>

<template>
  <nav
    id="app-sidebar"
    class="nav-rail glass glass--still glass--low"
    :class="{ 'nav-rail--collapsed': ui.navCollapsed }"
    :aria-label="t('nav.primary')"
    :data-collapsed="ui.navCollapsed ? 'true' : 'false'"
  >
    <!-- The way home, not a nav item: 개요 in the list carries aria-current. -->
    <RouterLink v-slot="{ href, navigate }" to="/overview" custom>
      <a class="nav-brand" :href="href" :aria-label="t('nav.home')" @click="navigate">
        <BrandMark :size="32" />
        <span class="nav-brand-name">{{ t('app.name') }}</span>
      </a>
    </RouterLink>

    <UiButton
      block
      icon="plus"
      class="nav-new-task"
      :aria-label="ui.navCollapsed ? t('nav.newTask') : undefined"
      :title="ui.navCollapsed ? t('nav.newTask') : undefined"
      @click="newTask"
    >
      <span class="nav-new-task-label">{{ t('nav.newTask') }}</span> <kbd>n</kbd>
    </UiButton>

    <ul class="nav-links nav-places" data-nav-places>
      <li v-for="item in NAV_PLACES" :key="item.id">
        <RouterLink
          :to="item.to"
          class="nav-link"
          :class="{ 'nav-link--current': isNavItemCurrent(item, route.name) }"
          :aria-current="isNavItemCurrent(item, route.name) ? 'page' : undefined"
          :title="ui.navCollapsed ? t(item.label) : undefined"
          :data-nav-place="item.id"
        >
          <UiIcon :name="item.icon" class="nav-link-icon" />
          <span class="nav-link-label">{{ t(item.label) }}</span>
          <kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
        </RouterLink>
      </li>
    </ul>

    <div class="nav-secondary">
      <RouterLink
        :to="NAV_SETTINGS.to"
        class="nav-link nav-link--quiet"
        :class="{ 'nav-link--current': isNavItemCurrent(NAV_SETTINGS, route.name) }"
        :aria-current="isNavItemCurrent(NAV_SETTINGS, route.name) ? 'page' : undefined"
        :title="ui.navCollapsed ? t(NAV_SETTINGS.label) : undefined"
        :data-nav-place="NAV_SETTINGS.id"
      >
        <UiIcon :name="NAV_SETTINGS.icon" class="nav-link-icon" />
        <span class="nav-link-label">{{ t(NAV_SETTINGS.label) }}</span>
      </RouterLink>
      <button
        type="button"
        class="nav-link nav-link--quiet"
        :title="ui.navCollapsed ? t('nav.search') : undefined"
        @click="ui.openSearch"
      >
        <UiIcon name="search" class="nav-link-icon" />
        <span class="nav-link-label">{{ t('nav.search') }}</span>
        <kbd>/</kbd>
      </button>
      <button
        type="button"
        class="nav-link nav-link--quiet"
        :title="ui.navCollapsed ? t('nav.help') : undefined"
        @click="ui.openHelp"
      >
        <UiIcon name="help" class="nav-link-icon" />
        <span class="nav-link-label">{{ t('nav.help') }}</span>
        <kbd>?</kbd>
      </button>
    </div>
  </nav>
</template>
