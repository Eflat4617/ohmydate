<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { plannerClient, uuidV7Key, type Notification as PlannerNotification } from '../api';
import { notificationLabel, useNotifications } from '../notifications/useNotifications';
import { formatClock } from '../format';
import { useOfflineStore } from '../stores/offline';
import UiBadge from './ui/UiBadge.vue';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiEmptyState from './ui/UiEmptyState.vue';
import UiIcon from './ui/UiIcon.vue';
import UiSpinner from './ui/UiSpinner.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const offline = useOfflineStore();
const { items, visibleItems, loading, error, start, dismiss } = useNotifications();
const busyId = ref<string | null>(null);
const pushSupported = ref(false);
const pushStatus = ref<'idle' | 'denied' | 'enabled' | 'unavailable'>('idle');
const pushBusy = ref(false);

onMounted(() => {
  pushSupported.value =
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof Notification !== 'undefined' &&
    'PushManager' in window;
  start();
});

function clock(item: PlannerNotification): string {
  return formatClock(item.sentAt ?? item.scheduledAt);
}

async function onDismiss(item: PlannerNotification): Promise<void> {
  busyId.value = item.id;
  try {
    await dismiss(item);
  } finally {
    busyId.value = null;
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + padding;
  const binary = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function enablePush(): Promise<void> {
  if (!pushSupported.value || pushBusy.value || !offline.online) return;
  pushBusy.value = true;
  pushStatus.value = 'idle';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      pushStatus.value = 'denied';
      return;
    }
    if (!offline.online) {
      pushStatus.value = 'idle';
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        ...(typeof key === 'string' && key.length > 0
          ? { applicationServerKey: base64UrlToBytes(key) }
          : {}),
      }));
    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (typeof p256dh !== 'string' || typeof auth !== 'string') {
      pushStatus.value = 'unavailable';
      return;
    }
    await plannerClient.createPushSubscription(
      { endpoint: subscription.endpoint, keys: { p256dh, auth }, deviceLabel: 'Browser' },
      uuidV7Key(),
    );
    pushStatus.value = 'enabled';
  } catch {
    pushStatus.value = 'unavailable';
  } finally {
    pushBusy.value = false;
  }
}

</script>

<template>
  <UiDialog
    v-if="props.open"
    variant="sheet"
    labelledby="notifications-title"
    class="notifications-panel"
    as="section"
    close-on-backdrop
    @close="emit('close')"
  >
    <header class="dialog-header">
      <div class="dialog-heading">
        <h2 id="notifications-title" class="dialog-title">Notifications</h2>
        <p class="muted">Reminders and daily summaries for this account.</p>
      </div>
      <UiButton
        variant="ghost"
        size="sm"
        icon-only
        aria-label="Close notifications"
        @click="emit('close')"
      >
        <UiIcon name="close" />
      </UiButton>
    </header>

    <UiBadge v-if="!offline.online" as="p" tone="offline" dot class="chip--offline" role="status">
      Read-only while offline
    </UiBadge>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <p v-if="loading && items.length === 0" class="loading-row"><UiSpinner /> Loading notifications…</p>

    <ul v-if="visibleItems.length > 0" class="notification-list">
      <li
        v-for="item in visibleItems"
        :key="item.id"
        class="notification-item"
        :data-notification-id="item.id"
      >
        <span class="notification-icon" :class="`notification-icon--${item.state}`" aria-hidden="true">
          <UiIcon :name="item.kind === 'daily_summary' ? 'today' : 'bell'" :size="18" />
        </span>
        <div class="notification-body">
          <p class="notification-kind">{{ notificationLabel(item) }}</p>
          <p class="notification-meta">
            <span class="notification-state">{{ item.state }}</span> · {{ clock(item) }} · {{ item.channel }}
          </p>
        </div>
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="!offline.online || busyId === item.id"
          :busy="busyId === item.id"
          :aria-label="`Dismiss notification: ${notificationLabel(item)}`"
          @click="onDismiss(item)"
        >
          {{ busyId === item.id ? 'Dismissing…' : 'Dismiss' }}
        </UiButton>
      </li>
    </ul>
    <UiEmptyState v-else icon="bell" title="No notifications right now." compact />

    <section class="push-opt-in" aria-labelledby="push-title">
      <div class="push-opt-in-text">
        <h3 id="push-title">Push notifications</h3>
        <p class="muted">
          In-app toasts work today. Browser push is opt-in and only registered when the browser grants permission.
        </p>
      </div>
      <UiButton
        :disabled="!pushSupported || pushBusy || !offline.online"
        :busy="pushBusy"
        icon="bell"
        @click="enablePush"
      >
        {{ pushBusy ? 'Enabling…' : 'Enable push notifications' }}
      </UiButton>
      <p v-if="!offline.online" class="muted" role="status">Connect to enable push notifications.</p>
      <p v-else-if="!pushSupported" class="muted">Push is not supported in this browser.</p>
      <p v-else-if="pushStatus === 'denied'" class="error-text" role="alert">
        Permission was not granted, so no push subscription was sent.
      </p>
      <p v-else-if="pushStatus === 'enabled'" class="muted" role="status">Push subscription saved.</p>
      <p v-else-if="pushStatus === 'unavailable'" class="error-text" role="alert">
        The browser subscription could not be created.
      </p>
    </section>
  </UiDialog>
</template>
