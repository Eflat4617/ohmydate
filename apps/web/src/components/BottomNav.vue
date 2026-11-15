<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';
import { BOTTOM_BAR_PLACES, isNavItemCurrent, MORE_LINKS } from '../layout/navigation';
import { t } from '../i18n';

/**
 * The phone's bar (HOLO-04): the first places of the loop — 개요, 할 일, 계획 —
 * with 담기 in the middle (it opens the capture bar as a sheet) and 더 보기
 * for the rest, in glass that floats above the page's lower edge.
 */
const ui = useUiStore();
const auth = useAuthStore();
const route = useRoute();
const moreOpen = ref(false);

const [first, second, third] = BOTTOM_BAR_PLACES;
const before = [first, second].filter((item) => item !== undefined);
const after = [third].filter((item) => item !== undefined);

const moreActive = computed(() => MORE_LINKS.some((link) => isNavItemCurrent(link, route.name)));

function closeMore(): void {
  moreOpen.value = false;
}

async function openFromMore(action: () => void): Promise<void> {
  moreOpen.value = false;
  await nextTick();
  action();
}

function signOut(): void {
  moreOpen.value = false;
  void auth.logout();
}
</script>

<template>
  <nav class="bottom-nav glass glass--low" :aria-label="t('nav.primary')">
    <RouterLink
      v-for="item in before"
      :key="item.id"
      :to="item.to"
      class="bottom-nav-item"
      :class="{ 'bottom-nav-item--current': isNavItemCurrent(item, route.name) }"
      :aria-current="isNavItemCurrent(item, route.name) ? 'page' : undefined"
      :data-nav-place="item.id"
    >
      <UiIcon :name="item.icon" :size="22" />
      <span>{{ t(item.label) }}</span>
    </RouterLink>
    <button
      type="button"
      class="bottom-nav-add"
      :aria-label="t('nav.capture')"
      aria-haspopup="dialog"
      data-nav-capture
      @click="ui.openCapture('capture')"
    >
      <UiIcon name="plus" :size="24" />
    </button>
    <RouterLink
      v-for="item in after"
      :key="item.id"
      :to="item.to"
      class="bottom-nav-item"
      :class="{ 'bottom-nav-item--current': isNavItemCurrent(item, route.name) }"
      :aria-current="isNavItemCurrent(item, route.name) ? 'page' : undefined"
      :data-nav-place="item.id"
    >
      <UiIcon :name="item.icon" :size="22" />
      <span>{{ t(item.label) }}</span>
    </RouterLink>
    <button
      type="button"
      class="bottom-nav-item"
      :class="{ 'bottom-nav-item--current': moreActive }"
      aria-haspopup="dialog"
      :aria-expanded="moreOpen ? 'true' : 'false'"
      data-nav-more
      @click="moreOpen = true"
    >
      <UiIcon name="more" :size="22" />
      <span>{{ t('nav.more') }}</span>
    </button>
  </nav>

  <UiDialog
    v-if="moreOpen"
    variant="sheet"
    labelledby="more-sheet-title"
    close-on-backdrop
    class="more-sheet"
    @close="closeMore"
  >
    <header class="dialog-header">
      <h2 id="more-sheet-title" class="dialog-title">{{ t('nav.more') }}</h2>
      <button type="button" class="btn btn--ghost btn--icon" :aria-label="t('nav.closeMore')" @click="closeMore">
        <UiIcon name="close" />
      </button>
    </header>
    <ul class="nav-links more-links">
      <li v-for="link in MORE_LINKS" :key="link.id">
        <RouterLink
          :to="link.to"
          class="nav-link"
          :class="{ 'nav-link--current': isNavItemCurrent(link, route.name) }"
          :aria-current="isNavItemCurrent(link, route.name) ? 'page' : undefined"
          @click="closeMore"
        >
          <UiIcon :name="link.icon" class="nav-link-icon" />
          <span class="nav-link-label">{{ t(link.label) }}</span>
        </RouterLink>
      </li>
      <li>
        <button type="button" class="nav-link nav-link-button" @click="openFromMore(ui.openNotifications)">
          <UiIcon name="bell" class="nav-link-icon" />
          <span class="nav-link-label">{{ t('nav.notifications') }}</span>
        </button>
      </li>
    </ul>
    <hr />
    <ul class="nav-links more-links">
      <li>
        <button type="button" class="nav-link nav-link--quiet" @click="openFromMore(ui.openSearch)">
          <UiIcon name="search" class="nav-link-icon" />
          <span class="nav-link-label">{{ t('nav.search') }}</span>
        </button>
      </li>
      <li>
        <button type="button" class="nav-link nav-link--quiet" @click="openFromMore(ui.openHelp)">
          <UiIcon name="help" class="nav-link-icon" />
          <span class="nav-link-label">{{ t('nav.help') }}</span>
        </button>
      </li>
      <li>
        <button type="button" class="nav-link nav-link--quiet" @click="signOut">
          <UiIcon name="logout" class="nav-link-icon" />
          <span class="nav-link-label">{{ t('nav.signOut') }}</span>
        </button>
      </li>
    </ul>
  </UiDialog>
</template>
