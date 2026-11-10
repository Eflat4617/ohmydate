<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useOfflineStore } from '../stores/offline';
import { useUiStore } from '../stores/ui';
import BottomNav from './BottomNav.vue';
import HelpDialog from './HelpDialog.vue';
import NavRail from './NavRail.vue';
import OfflineBanner from './OfflineBanner.vue';
import SearchDialog from './SearchDialog.vue';
import ToastHost from './ToastHost.vue';

const ui = useUiStore();
const offline = useOfflineStore();
const router = useRouter();
const route = useRoute();

let teardownOffline: (() => void) | null = null;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

function requestNewTask(): void {
  ui.requestNewTask();
  if (route.name !== 'inbox') void router.push({ name: 'inbox' });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (isTypingTarget(event.target)) {
    if (event.key === 'Escape') ui.closeDialogs();
    return;
  }

  if (ui.helpOpen || ui.searchOpen) {
    if (event.key === 'Escape') {
      event.preventDefault();
      ui.closeDialogs();
    }
    return;
  }

  switch (event.key) {
    case 'n':
      event.preventDefault();
      requestNewTask();
      break;
    case 't':
      event.preventDefault();
      void router.push({ name: 'today' });
      break;
    case '/':
      event.preventDefault();
      ui.openSearch();
      break;
    case '?':
      event.preventDefault();
      ui.openHelp();
      break;
    default:
      break;
  }
}

onMounted(() => {
  teardownOffline = offline.initialize();
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  teardownOffline?.();
});
</script>

<template>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <div class="app-shell">
    <NavRail />
    <div class="app-main">
      <OfflineBanner />
      <main id="main-content" tabindex="-1">
        <slot />
      </main>
    </div>
    <BottomNav />
  </div>
  <ToastHost />
  <HelpDialog :open="ui.helpOpen" @close="ui.closeDialogs()" />
  <SearchDialog :open="ui.searchOpen" @close="ui.closeDialogs()" />
</template>
