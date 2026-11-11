<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useUiStore } from '../stores/ui';
import BottomNav from './BottomNav.vue';
import HelpDialog from './HelpDialog.vue';
import LlmConsentDialog from './LlmConsentDialog.vue';
import NavRail from './NavRail.vue';
import OfflineBanner from './OfflineBanner.vue';
import SearchDialog from './SearchDialog.vue';
import ToastHost from './ToastHost.vue';

const ui = useUiStore();
const offline = useOfflineStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const consentDismissed = ref(false);
const consentOpen = computed(
  () =>
    !consentDismissed.value &&
    auth.user?.llmProvider === 'deepseek' &&
    auth.user.llm?.consent?.granted !== true,
);

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
  if (route.name === 'inbox') {
    ui.requestNewTask();
    return;
  }
  void router.push({ name: 'inbox' }).then(async () => {
    await nextTick();
    ui.requestNewTask();
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (ui.conflictOpen) return;

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
  if (auth.user === null) void auth.loadCurrent();
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
  <LlmConsentDialog :open="consentOpen" @close="consentDismissed = true" />
</template>
