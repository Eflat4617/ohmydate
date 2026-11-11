<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import BottomNav from './BottomNav.vue';
import HelpDialog from './HelpDialog.vue';
import LlmConsentDialog from './LlmConsentDialog.vue';
import NavRail from './NavRail.vue';
import OfflineBanner from './OfflineBanner.vue';
import NotificationsPanel from './NotificationsPanel.vue';
import SearchDialog from './SearchDialog.vue';
import ToastHost from './ToastHost.vue';

const ui = useUiStore();
const offline = useOfflineStore();
const sessions = useSessionStore();
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
let revalidating = false;

async function revalidateIdentity(): Promise<void> {
  if (!auth.confirmed || revalidating) return;
  revalidating = true;
  try {
    await auth.loadCurrent();
  } finally {
    revalidating = false;
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void revalidateIdentity();
}

function onWindowFocus(): void {
  void revalidateIdentity();
}

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

  if (ui.helpOpen || ui.searchOpen || ui.notificationsOpen) {
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
    case 'f':
      if (route.name === 'focus') return;
      event.preventDefault();
      void router.push(sessions.active === null ? { name: 'today' } : `/focus/${sessions.active.id}`);
      break;
    default:
      break;
  }
}

onMounted(() => {
  teardownOffline = offline.initialize();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);
  void auth.ensureOwnerConfirmed();
});

watch(
  () => auth.bootstrapState,
  (state) => {
    if (state === 'anonymous' && route.name !== 'login' && router.hasRoute('login')) {
      void router.replace({ name: 'login' });
    }
  },
);

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('focus', onWindowFocus);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  teardownOffline?.();
});
</script>

<template>
  <div v-if="!auth.confirmed" class="app-shell app-shell--loading" role="status" aria-live="polite">
    <p class="muted">Loading OhMyDate…</p>
  </div>
  <template v-else>
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
    <NotificationsPanel :open="ui.notificationsOpen" @close="ui.closeDialogs()" />
    <LlmConsentDialog :open="consentOpen" @close="consentDismissed = true" />
  </template>
</template>
