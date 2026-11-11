<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';
import type { IconName } from './ui/icons';

const ui = useUiStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const moreOpen = ref(false);

interface MoreLink {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
}

const moreLinks: readonly MoreLink[] = [
  { to: '/projects', label: 'Projects', icon: 'projects' },
  { to: '/plans/new', label: 'New plan', icon: 'compare' },
  { to: '/commitments', label: 'Commitments', icon: 'commitment' },
  { to: '/settings/availability', label: 'Availability', icon: 'availability' },
  { to: '/settings/ai', label: 'AI settings', icon: 'ai' },
];

const MORE_ROUTES = new Set(['projects', 'project', 'plans-new', 'plan', 'commitments', 'availability', 'ai-settings']);
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
  <nav class="bottom-nav" aria-label="Primary">
    <RouterLink to="/today" class="bottom-nav-item">
      <UiIcon name="today" :size="22" />
      <span>Today</span>
    </RouterLink>
    <RouterLink to="/inbox" class="bottom-nav-item">
      <UiIcon name="inbox" :size="22" />
      <span>Inbox</span>
    </RouterLink>
    <button type="button" class="bottom-nav-add" aria-label="New task" @click="newTask">
      <UiIcon name="plus" :size="24" />
    </button>
    <RouterLink to="/plan/new" class="bottom-nav-item">
      <UiIcon name="plan" :size="22" />
      <span>Plan</span>
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
      <span>More</span>
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
      <h2 id="more-sheet-title" class="dialog-title">More</h2>
      <button type="button" class="btn btn--ghost btn--icon" aria-label="Close menu" @click="closeMore">
        <UiIcon name="close" />
      </button>
    </header>
    <ul class="nav-links more-links">
      <li v-for="link in moreLinks" :key="link.to">
        <RouterLink :to="link.to" class="nav-link" @click="closeMore">
          <UiIcon :name="link.icon" class="nav-link-icon" />
          <span class="nav-link-label">{{ link.label }}</span>
        </RouterLink>
      </li>
      <li>
        <button type="button" class="nav-link nav-link-button" @click="openFromMore(ui.openNotifications)">
          <UiIcon name="bell" class="nav-link-icon" />
          <span class="nav-link-label">Notifications</span>
        </button>
      </li>
    </ul>
    <hr />
    <ul class="nav-links more-links">
      <li>
        <button type="button" class="nav-link nav-link--quiet" @click="openFromMore(ui.openSearch)">
          <UiIcon name="search" class="nav-link-icon" />
          <span class="nav-link-label">Search</span>
        </button>
      </li>
      <li>
        <button type="button" class="nav-link nav-link--quiet" @click="openFromMore(ui.openHelp)">
          <UiIcon name="help" class="nav-link-icon" />
          <span class="nav-link-label">Help</span>
        </button>
      </li>
      <li>
        <button type="button" class="nav-link nav-link--quiet" @click="signOut">
          <UiIcon name="logout" class="nav-link-icon" />
          <span class="nav-link-label">Sign out</span>
        </button>
      </li>
    </ul>
  </UiDialog>
</template>
