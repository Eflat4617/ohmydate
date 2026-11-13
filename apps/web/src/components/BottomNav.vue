<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';
import { MORE_LINKS } from '../layout/navigation';
import { t } from '../i18n';

const ui = useUiStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const moreOpen = ref(false);

// HOLO-01: the sheet lists every sidebar link the bar does not hold itself,
// in the sidebar's order — 개요 first (CAL-01: 한달 is here too).
const moreLinks = MORE_LINKS;

const MORE_ROUTES = new Set([...MORE_LINKS.flatMap((link) => link.routes), 'task']);
const moreActive = computed(() => typeof route.name === 'string' && MORE_ROUTES.has(route.name));

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
  <nav class="bottom-nav" :aria-label="t('nav.primary')">
    <RouterLink to="/today" class="bottom-nav-item">
      <UiIcon name="today" :size="22" />
      <span>{{ t('nav.today') }}</span>
    </RouterLink>
    <RouterLink to="/inbox" class="bottom-nav-item">
      <UiIcon name="inbox" :size="22" />
      <span>{{ t('nav.inbox') }}</span>
    </RouterLink>
    <button type="button" class="bottom-nav-add" :aria-label="t('nav.newTask')" @click="newTask">
      <UiIcon name="plus" :size="24" />
    </button>
    <RouterLink to="/plan/new" class="bottom-nav-item">
      <UiIcon name="plan" :size="22" />
      <span>{{ t('nav.planShort') }}</span>
    </RouterLink>
    <button
      type="button"
      class="bottom-nav-item"
      :class="{ 'router-link-active': moreActive }"
      aria-haspopup="dialog"
      :aria-expanded="moreOpen ? 'true' : 'false'"
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
      <li v-for="link in moreLinks" :key="link.to">
        <RouterLink :to="link.to" class="nav-link" @click="closeMore">
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
