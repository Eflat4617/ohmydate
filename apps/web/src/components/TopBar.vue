<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { displayNameOf, initialOf } from '../domain/displayName';
import { t, tp, type MessageKey } from '../i18n';
import { crumbFor } from '../layout/navigation';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import { useTheme, type ThemeChoice } from '../theme/theme';
import BrandMark from './BrandMark.vue';
import UiIcon from './ui/UiIcon.vue';
import type { IconName } from './ui/icons';

/**
 * The top bar (HOLO-01): on the left where you are (sidebar toggle, group /
 * screen), on the right what is the app's own — the theme, the notifications
 * and the account. It holds no page action; a view's one primary button
 * belongs to the view.
 */
const props = withDefaults(defineProps<{ unread?: number }>(), { unread: 0 });

const ui = useUiStore();
const auth = useAuthStore();
const route = useRoute();
const { choice, setTheme } = useTheme();

const crumb = computed(() => crumbFor(route.name));

const THEME_OPTIONS: readonly { value: ThemeChoice; label: MessageKey; icon: IconName }[] = [
  { value: 'light', label: 'theme.light', icon: 'sun' },
  { value: 'dark', label: 'theme.dark', icon: 'moon' },
  { value: 'system', label: 'theme.system', icon: 'monitor' },
];

const name = computed(() => displayNameOf(auth.user?.email));
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
  <header class="app-topbar">
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
      <!-- One sentence for assistive tech; the group / screen pair is what is seen. -->
      <p v-if="crumb" class="topbar-crumb" data-crumb>
        <span class="visually-hidden">{{ t('nav.crumb', { group: t(crumb.group), page: t(crumb.page) }) }}</span>
        <span class="topbar-crumb-group" aria-hidden="true">{{ t(crumb.group) }}</span>
        <span class="topbar-crumb-sep" aria-hidden="true">/</span>
        <span class="topbar-crumb-page" aria-hidden="true">{{ t(crumb.page) }}</span>
      </p>
    </div>

    <div class="topbar-end">
      <div class="segmented theme-switch" role="group" :aria-label="t('theme.label')">
        <button
          v-for="option in THEME_OPTIONS"
          :key="option.value"
          type="button"
          class="btn segmented-item theme-switch-item"
          :aria-pressed="choice === option.value ? 'true' : 'false'"
          :data-theme-choice="option.value"
          @click="setTheme(option.value)"
        >
          <UiIcon :name="option.icon" :size="16" />
          <span class="theme-switch-label">{{ t(option.label) }}</span>
        </button>
      </div>

      <button
        type="button"
        class="btn btn--icon topbar-bell"
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
        <div v-if="userOpen" id="topbar-user-menu" class="menu topbar-user-menu">
          <p v-if="auth.user" class="menu-note">{{ auth.user.email }}</p>
          <button type="button" class="btn btn--ghost menu-item" data-user-sign-out @click="signOut">
            <UiIcon name="logout" :size="18" />
            {{ t('nav.signOut') }}
          </button>
        </div>
      </div>
    </div>
  </header>
</template>
