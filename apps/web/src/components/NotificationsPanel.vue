<script setup lang="ts">
import { inject, onMounted, ref } from 'vue';
import { routerKey } from 'vue-router';
import { plannerClient, uuidV7Key, type Notification as PlannerNotification } from '../api';
import { notificationLabel, useNotifications } from '../notifications/useNotifications';
import { runOwnerBound } from '../session/ownerBound';
import { useOfflineStore } from '../stores/offline';
import { useAuthStore } from '../stores/auth';
import { t } from '../i18n';
import { browserTimeZone, formatDateTime } from '../i18n/format';
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
const auth = useAuthStore();
const router = inject(routerKey, null);
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
  return formatDateTime(item.sentAt ?? item.scheduledAt, auth.user?.timeZone ?? browserTimeZone());
}

function meta(item: PlannerNotification): string {
  return t('notifications.meta', {
    state: t(`notifications.state.${item.state}`),
    time: clock(item),
    channel: t(`notifications.channel.${item.channel}`),
  });
}

const PROPOSAL_KEY = /^replan_proposal:([0-9a-f-]{36})$/i;

/** M5-03: a detected replan proposal links to its detail (dedupe key `replan_proposal:<id>`). */
function proposalPath(item: PlannerNotification): string | null {
  if (item.kind !== 'replan_proposal') return null;
  const match = PROPOSAL_KEY.exec(item.dedupeKey);
  return match?.[1] === undefined ? '/replan' : `/replan/${match[1]}`;
}

function openProposal(event: MouseEvent, path: string): void {
  if (router === null) return;
  event.preventDefault();
  emit('close');
  void router.push(path);
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

// Owner isolation (ADR-023): the permission prompt can stay open for a long
// time. If the signed-in user changes meanwhile, this browser must not be
// registered for push under the next user's account.
async function enablePush(): Promise<void> {
  if (!pushSupported.value || pushBusy.value || !offline.online) return;
  pushBusy.value = true;
  pushStatus.value = 'idle';
  await runOwnerBound(
    async (owner) => {
      try {
        const permission = await owner.wait(Notification.requestPermission());
        if (permission !== 'granted') {
          pushStatus.value = 'denied';
          return;
        }
        if (!offline.online) {
          pushStatus.value = 'idle';
          return;
        }
        const registration = await owner.wait(navigator.serviceWorker.ready);
        const existing = await owner.wait(registration.pushManager.getSubscription());
        const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
        const subscription =
          existing ??
          (await owner.wait(
            registration.pushManager.subscribe({
              userVisibleOnly: true,
              ...(typeof key === 'string' && key.length > 0
                ? { applicationServerKey: base64UrlToBytes(key) }
                : {}),
            }),
          ));
        const json = subscription.toJSON();
        const p256dh = json.keys?.p256dh;
        const auth = json.keys?.auth;
        if (typeof p256dh !== 'string' || typeof auth !== 'string') {
          pushStatus.value = 'unavailable';
          return;
        }
        await owner.wait(
          plannerClient.createPushSubscription(
            { endpoint: subscription.endpoint, keys: { p256dh, auth }, deviceLabel: 'Browser' },
            uuidV7Key(),
          ),
        );
        pushStatus.value = 'enabled';
      } catch (cause) {
        owner.rethrowIfStale(cause);
        pushStatus.value = 'unavailable';
      }
    },
    {
      onSettled: () => {
        pushBusy.value = false;
      },
    },
  );
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
        <h2 id="notifications-title" class="dialog-title">{{ t('notifications.title') }}</h2>
        <p class="muted">{{ t('notifications.lede') }}</p>
      </div>
      <UiButton
        variant="ghost"
        size="sm"
        icon-only
        :aria-label="t('notifications.close')"
        @click="emit('close')"
      >
        <UiIcon name="close" />
      </UiButton>
    </header>

    <UiBadge v-if="!offline.online" as="p" tone="offline" dot class="chip--offline" role="status">
      {{ t('common.readOnlyOffline') }}
    </UiBadge>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <p v-if="loading && items.length === 0" class="loading-row"><UiSpinner /> {{ t('notifications.loading') }}</p>

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
          <p class="notification-meta">{{ meta(item) }}</p>
        </div>
        <a
          v-if="proposalPath(item)"
          class="btn btn--secondary btn--sm"
          :href="proposalPath(item) ?? '/replan'"
          :aria-label="t('notifications.openProposalAria', { label: notificationLabel(item) })"
          data-open-proposal
          @click="openProposal($event, proposalPath(item) ?? '/replan')"
        >
          {{ t('notifications.openProposal') }}
        </a>
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="!offline.online || busyId === item.id"
          :busy="busyId === item.id"
          :aria-label="t('notifications.dismissAria', { label: notificationLabel(item) })"
          @click="onDismiss(item)"
        >
          {{ busyId === item.id ? t('notifications.dismissing') : t('notifications.dismiss') }}
        </UiButton>
      </li>
    </ul>
    <UiEmptyState v-else icon="bell" :title="t('notifications.empty')" compact />

    <section class="push-opt-in" aria-labelledby="push-title">
      <div class="push-opt-in-text">
        <h3 id="push-title">{{ t('notifications.push.title') }}</h3>
        <p class="muted">{{ t('notifications.push.lede') }}</p>
      </div>
      <UiButton
        :disabled="!pushSupported || pushBusy || !offline.online"
        :busy="pushBusy"
        icon="bell"
        @click="enablePush"
      >
        {{ pushBusy ? t('notifications.push.enabling') : t('notifications.push.enable') }}
      </UiButton>
      <p v-if="!offline.online" class="muted" role="status">{{ t('notifications.push.connect') }}</p>
      <p v-else-if="!pushSupported" class="muted">{{ t('notifications.push.unsupported') }}</p>
      <p v-else-if="pushStatus === 'denied'" class="error-text" role="alert">
        {{ t('notifications.push.denied') }}
      </p>
      <p v-else-if="pushStatus === 'enabled'" class="muted" role="status">{{ t('notifications.push.saved') }}</p>
      <p v-else-if="pushStatus === 'unavailable'" class="error-text" role="alert">
        {{ t('notifications.push.failed') }}
      </p>
    </section>
  </UiDialog>
</template>
