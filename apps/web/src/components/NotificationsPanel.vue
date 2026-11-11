<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { plannerClient, uuidV7Key, type Notification as PlannerNotification } from '../api';
import { notificationLabel, useNotifications } from '../notifications/useNotifications';
import { formatClock } from '../format';
import { useOfflineStore } from '../stores/offline';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const offline = useOfflineStore();
const { items, loading, error, start, refresh, dismiss } = useNotifications();
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
  <div v-if="props.open" class="dialog-backdrop" role="presentation">
    <section
      class="dialog notifications-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notifications-title"
    >
      <header class="page-header">
        <h2 id="notifications-title">Notifications</h2>
        <button type="button" class="link-button" aria-label="Close notifications" @click="emit('close')">
          Close
        </button>
      </header>

      <p v-if="!offline.online" class="chip chip--offline" role="status">Read-only while offline</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p v-if="loading && items.length === 0" class="muted">Loading notifications…</p>

      <ul v-if="items.filter((item) => item.state !== 'dismissed').length > 0" class="notification-list">
        <li
          v-for="item in items.filter((entry) => entry.state !== 'dismissed')"
          :key="item.id"
          class="notification-item"
          :data-notification-id="item.id"
        >
          <div>
            <p class="notification-kind">{{ notificationLabel(item) }}</p>
            <p class="muted">
              <span>{{ item.state }}</span> · {{ clock(item) }} · {{ item.channel }}
            </p>
          </div>
          <button
            type="button"
            :disabled="!offline.online || busyId === item.id"
            :aria-label="`Dismiss notification: ${notificationLabel(item)}`"
            @click="onDismiss(item)"
          >
            {{ busyId === item.id ? 'Dismissing…' : 'Dismiss' }}
          </button>
        </li>
      </ul>
      <p v-else class="muted empty-state">No notifications right now.</p>

      <section class="push-opt-in" aria-labelledby="push-title">
        <h3 id="push-title">Push notifications</h3>
        <p class="muted">
          In-app toasts work today. Browser push is opt-in and only registered when the browser grants permission.
        </p>
        <button type="button" :disabled="!pushSupported || pushBusy || !offline.online" @click="enablePush">
          {{ pushBusy ? 'Enabling…' : 'Enable push notifications' }}
        </button>
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
    </section>
  </div>
</template>
