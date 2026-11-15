<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IDENTITY_REVALIDATION_TIMEOUT_MS, useAuthStore } from '../stores/auth';
import { useLlmConsentStore } from '../stores/llmConsent';
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
import TopBar from './TopBar.vue';
import BrandMark from './BrandMark.vue';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiSpinner from './ui/UiSpinner.vue';
import { calmMode } from '../composables/useCalmMode';
import { NAV_PLACES } from '../layout/navigation';
import { t } from '../i18n';

const ui = useUiStore();
const offline = useOfflineStore();
const sessions = useSessionStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
// FU-91: when the consent dialog opens (once per session and owner, or when
// an AI action asks for it) is decided by the llmConsent store.
const llmConsent = useLlmConsentStore();
const detachConsentHost = llmConsent.attachHost();

let teardownOffline: (() => void) | null = null;
let revalidation: Promise<void> | null = null;

/**
 * Re-check who is signed in when the tab comes back (focus, visibility, the
 * network returning). One check at a time: a trigger that arrives while one is
 * in flight joins it instead of starting another, so repeated events cannot
 * loop. Each check is bounded by IDENTITY_REVALIDATION_TIMEOUT_MS (FU-56/FU-85).
 */
function revalidateIdentity(): Promise<void> {
  if (!auth.confirmed) return Promise.resolve();
  if (revalidation !== null) return revalidation;
  revalidation = auth
    .loadCurrent({ timeoutMs: IDENTITY_REVALIDATION_TIMEOUT_MS })
    .then(() => undefined)
    .finally(() => {
      revalidation = null;
    });
  return revalidation;
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void revalidateIdentity();
}

function onWindowFocus(): void {
  void revalidateIdentity();
}

function onBackOnline(): void {
  void revalidateIdentity();
}

/*
 * The failed-check notice stays mounted from the failure until a check
 * succeeds (or the owner changes), so a retry — from the button, a focus or
 * the network returning — keeps the button and its keyboard focus in place
 * and only marks it busy. While offline the OfflineBanner already explains
 * why nothing can be checked, so the notice (a second polite live region)
 * waits until the network is back.
 */
const revalidationFailed = ref(false);
const revalidationBanner = ref<InstanceType<typeof UiBanner> | null>(null);
const mainContent = ref<HTMLElement | null>(null);
// HOLO-01: how many delivered notifications are still listed (the bell's dot).
const unreadNotifications = ref(0);

watch(
  () => auth.revalidationState,
  (state) => {
    if (state === 'failed') revalidationFailed.value = true;
    else if (state === 'idle') revalidationFailed.value = false;
  },
  { immediate: true },
);

const revalidationNoticeShown = computed(() => revalidationFailed.value && offline.online);
const revalidationBusy = computed(() => auth.revalidationState === 'pending');

// Runs before the DOM update that removes the notice: if keyboard focus is
// inside it, hand focus to the main region instead of letting it fall to body.
watch(revalidationNoticeShown, (shown, wasShown) => {
  if (shown || !wasShown) return;
  const banner: unknown = revalidationBanner.value?.$el;
  if (!(banner instanceof HTMLElement) || !banner.contains(document.activeElement)) return;
  void nextTick(() => {
    mainContent.value?.focus({ preventScroll: true });
  });
});

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
  if (route.name === 'tasks' && route.query['view'] === undefined) {
    ui.requestNewTask();
    return;
  }
  void router.push({ name: 'tasks' }).then(async () => {
    await nextTick();
    ui.requestNewTask();
  });
}

/** The places' own keys (o, t, p, m, f), from the one list the sidebar reads. */
const PLACE_KEYS = new Map(NAV_PLACES.flatMap((item) => (item.shortcut === undefined ? [] : [[item.shortcut, item] as const])));

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
      return;
    case '/':
      event.preventDefault();
      ui.openSearch();
      return;
    case '?':
      event.preventDefault();
      ui.openHelp();
      return;
    default:
      break;
  }

  const place = PLACE_KEYS.get(event.key);
  if (place === undefined) return;
  if (place.id === 'focus') {
    // 집중: the session that is running, else the timer's own place. On the
    // timer itself the key is the timer's (it moves focus to the clock).
    if (route.name === 'focus') return;
    event.preventDefault();
    void router.push(sessions.active === null ? place.to : `/focus/${sessions.active.id}`);
    return;
  }
  event.preventDefault();
  void router.push(place.to);
}

onMounted(() => {
  teardownOffline = offline.initialize();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('online', onBackOnline);
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
  window.removeEventListener('online', onBackOnline);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  teardownOffline?.();
  detachConsentHost();
});
</script>

<template>
  <div v-if="!auth.confirmed" class="app-shell app-shell--loading" role="status" aria-live="polite">
    <BrandMark :size="40" />
    <p class="app-loading-text"><UiSpinner /> <span>{{ t('app.loading') }}</span></p>
  </div>
  <template v-else>
    <a class="skip-link" href="#main-content">{{ t('app.skipToContent') }}</a>
    <div class="ambient" aria-hidden="true" data-ambient></div>
    <div class="app-shell" :class="{ 'app-shell--calm': calmMode, 'app-shell--nav-collapsed': ui.navCollapsed }">
      <NavRail />
      <div class="app-main">
        <TopBar :unread="unreadNotifications" />
        <OfflineBanner />
        <UiBanner
          v-if="revalidationNoticeShown"
          ref="revalidationBanner"
          tone="offline"
          inline
          class="identity-revalidation-banner"
          role="status"
          aria-live="polite"
        >
          {{ t('revalidation.failed') }}
          <template #actions>
            <UiButton size="sm" :busy="revalidationBusy" @click="revalidateIdentity">
              {{ t('revalidation.retry') }}
            </UiButton>
          </template>
        </UiBanner>
        <main id="main-content" ref="mainContent" tabindex="-1" class="app-content">
          <slot />
        </main>
      </div>
      <BottomNav />
    </div>
    <ToastHost />
    <HelpDialog :open="ui.helpOpen" @close="ui.closeDialogs()" />
    <SearchDialog :open="ui.searchOpen" @close="ui.closeDialogs()" />
    <NotificationsPanel
      :open="ui.notificationsOpen"
      @close="ui.closeDialogs()"
      @unread="unreadNotifications = $event"
    />
    <LlmConsentDialog :open="llmConsent.open" @close="llmConsent.closed()" />
  </template>
</template>
