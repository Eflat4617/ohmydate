<script setup lang="ts">
import { nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { isNavItemCurrent, NAV_GROUPS } from '../layout/navigation';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import BrandMark from './BrandMark.vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';
import { t } from '../i18n';

/**
 * The sidebar (HOLO-01): brand, 새 작업, the navigation groups and, at the
 * foot, search, help and sign-out. Folded (ui.navCollapsed) it shows icons
 * only; the labels stay in the accessibility tree and become tooltips.
 */
const ui = useUiStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

function signOut(): void {
  void auth.logout();
}

function newTask(): void {
  if (route.name === 'inbox') {
    ui.requestNewTask();
    return;
  }
  void router.push({ name: 'inbox' }).then(async () => {
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

    <div class="nav-groups">
      <div v-for="group in NAV_GROUPS" :key="group.id" class="nav-group" :data-nav-group="group.id">
        <p class="nav-group-label" aria-hidden="true">{{ t(group.label) }}</p>
        <ul class="nav-links">
          <li v-for="item in group.items" :key="item.to">
            <RouterLink
              :to="item.to"
              class="nav-link"
              :class="{ 'nav-link--current': isNavItemCurrent(item, route.name) }"
              :aria-current="isNavItemCurrent(item, route.name) ? 'page' : undefined"
              :title="ui.navCollapsed ? t(item.label) : undefined"
            >
              <UiIcon :name="item.icon" class="nav-link-icon" />
              <span class="nav-link-label">{{ t(item.label) }}</span>
              <kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>

    <div class="nav-secondary">
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
      <button
        type="button"
        class="nav-link nav-link--quiet"
        :title="ui.navCollapsed ? t('nav.signOut') : undefined"
        @click="signOut"
      >
        <UiIcon name="logout" class="nav-link-icon" />
        <span class="nav-link-label">{{ t('nav.signOut') }}</span>
      </button>
    </div>
  </nav>
</template>
