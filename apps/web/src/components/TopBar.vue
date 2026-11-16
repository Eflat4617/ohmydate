<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { displayNameFor, initialOf } from '../domain/displayName';
import { t, tp } from '../i18n';
import { crumbFor, NAV_SETTINGS } from '../layout/navigation';
import { isDesktop, ownerEmail } from '../platform/mode';
import { useChosenName } from '../session/chosenName';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import BrandMark from './BrandMark.vue';
import CaptureBar from './capture/CaptureBar.vue';
import NowPill from './NowPill.vue';
import ThemeSwitch from './ThemeSwitch.vue';
import UiIcon from './ui/UiIcon.vue';

/**
 * The top bar (HOLO-04, FLOW.md §4): glass that floats over the page. On the
 * left where you are (sidebar toggle, the place and the screen under it); in
 * the middle the capture bar (담기 줄); on the right the now pill, the
 * notifications and the account, whose menu holds the theme, 설정 and
 * sign-out. It holds no page action; a view's one primary button belongs to
 * the view.
 */
const props = withDefaults(defineProps<{ unread?: number }>(), { unread: 0 });

const ui = useUiStore();
const auth = useAuthStore();
const route = useRoute();

const crumb = computed(() => crumbFor(route.name));
const crumbText = computed(() => {
  const value = crumb.value;
  if (value === null) return '';
  return value.page === null
    ? t('nav.crumb', { place: t(value.place) })
    : t('nav.crumbNested', { place: t(value.place), page: t(value.page) });
});

// Desktop: one owner and no account — nothing to sign out of, and no address to show.
const desktop = isDesktop();
const email = computed(() => ownerEmail(auth.user));
// The name the owner chose on this device, else the e-mail's own part (HOLO-07).
const chosenName = useChosenName();
const name = computed(() => displayNameFor(chosenName.name.value, email.value));
const initial = computed(() => initialOf(name.value));
const bellLabel = computed(() =>
  props.unread > 0 ? tp('nav.notificationsUnread', props.unread) : t('nav.notifications'),
);

const userOpen = ref(false);
const userRoot = ref<HTMLElement | null>(null);
const userButton = ref<HTMLButtonElement | null>(null);

function onOutsidePointer(event: PointerEvent): void {
  const root = userRoot.value;
  if (root !== null && event.target instanceof Node && !root.contains(event.target)) userOpen.value = false;
}

watch(userOpen, (open) => {
  if (typeof document === 'undefined') return;
  if (open) document.addEventListener('pointerdown', onOutsidePointer);
  else document.removeEventListener('pointerdown', onOutsidePointer);
});

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onOutsidePointer);
});

// Another screen: the menu has done its job.
watch(
  () => route.fullPath,
  () => {
    userOpen.value = false;
  },
);

function toggleUser(): void {
  userOpen.value = !userOpen.value;
}

function closeUser(event: KeyboardEvent): void {
  if (!userOpen.value) return;
  // The menu takes this Escape; the shell's own handler has nothing to close.
  event.stopPropagation();
  userOpen.value = false;
  void nextTick(() => userButton.value?.focus());
}

function onUserFocusOut(event: FocusEvent): void {
  const root = userRoot.value;
  const next = event.relatedTarget;
  if (root !== null && next instanceof Node && !root.contains(next)) userOpen.value = false;
}

function signOut(): void {
  userOpen.value = false;
  void auth.logout();
}
</script>

<template>
  <header class="app-topbar glass glass--host glass--low">
    <div class="topbar-start">
      <button
        type="button"
        class="btn btn--ghost btn--icon topbar-nav-toggle"
        :aria-label="ui.navCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
        :aria-expanded="ui.navCollapsed ? 'false' : 'true'"
        aria-controls="app-sidebar"
        data-nav-toggle
        @click="ui.toggleNav"
      >
        <UiIcon name="sidebar" />
      </button>
      <RouterLink v-slot="{ href, navigate }" to="/overview" custom>
        <a class="topbar-brand" :href="href" :aria-label="t('nav.home')" @click="navigate">
          <BrandMark :size="30" />
        </a>
      </RouterLink>
      <!-- One sentence for assistive tech; the place (and the screen under it) is what is seen. -->
      <p v-if="crumb" class="topbar-crumb" :class="{ 'topbar-crumb--nested': crumb.page !== null }" data-crumb>
        <span class="visually-hidden">{{ crumbText }}</span>
        <span class="topbar-crumb-place" aria-hidden="true">{{ t(crumb.place) }}</span>
        <template v-if="crumb.page !== null">
          <span class="topbar-crumb-sep" aria-hidden="true">/</span>
          <span class="topbar-crumb-page" aria-hidden="true">{{ t(crumb.page) }}</span>
        </template>
      </p>
    </div>

    <!-- 담기 줄: on every screen, in the middle of the bar (from 1024px; a phone opens it from its nav). -->
    <CaptureBar class="topbar-capture" />

    <div class="topbar-end">
      <NowPill />
      <button
        type="button"
        class="btn btn--ghost btn--icon topbar-bell"
        :aria-label="bellLabel"
        :data-unread="unread > 0 ? unread : undefined"
        @click="ui.openNotifications"
      >
        <UiIcon name="bell" />
        <span v-if="unread > 0" class="topbar-dot" aria-hidden="true"></span>
      </button>

      <div ref="userRoot" class="topbar-user" @focusout="onUserFocusOut" @keydown.esc="closeUser">
        <button
          ref="userButton"
          type="button"
          class="btn btn--ghost topbar-user-button"
          :aria-label="name ? t('nav.account', { name }) : t('nav.accountFallback')"
          :aria-expanded="userOpen ? 'true' : 'false'"
          :aria-controls="userOpen ? 'topbar-user-menu' : undefined"
          data-user-menu
          @click="toggleUser"
        >
          <span class="topbar-avatar" aria-hidden="true">
            <template v-if="initial">{{ initial }}</template>
            <UiIcon v-else name="user" :size="18" />
          </span>
          <span v-if="name" class="topbar-user-name">{{ name }}</span>
          <UiIcon name="chevron-down" :size="16" class="topbar-user-caret" />
        </button>
        <div v-if="userOpen" id="topbar-user-menu" class="menu glass topbar-user-menu">
          <p v-if="email" class="menu-note">{{ email }}</p>
          <ThemeSwitch class="topbar-theme" />
          <RouterLink :to="NAV_SETTINGS.to" class="btn btn--ghost menu-item" data-user-settings>
            <UiIcon :name="NAV_SETTINGS.icon" :size="18" />
            {{ t(NAV_SETTINGS.label) }}
          </RouterLink>
          <button v-if="!desktop" type="button" class="btn btn--ghost menu-item" data-user-sign-out @click="signOut">
            <UiIcon name="logout" :size="18" />
            {{ t('nav.signOut') }}
          </button>
        </div>
      </div>
    </div>
  </header>
</template>
