import { computed, onUnmounted, ref } from 'vue';
import {
  plannerClient,
  uuidV7Key,
  type Notification,
  type PlannerClient,
} from '../api';
import { t } from '../i18n';
import { errorMessage } from '../i18n/problem';
import { runOwnerBound } from '../session/ownerBound';
import { onActiveOwnerChange } from '../session/ownerEpoch';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';

export function notificationLabel(item: Pick<Notification, 'kind'>): string {
  return t(`notifications.kind.${item.kind}`);
}

export interface NotificationsOptions {
  readonly client?: PlannerClient;
  readonly pollDelayMs?: number;
  readonly maxDelayMs?: number;
}

export function useNotifications(options: NotificationsOptions = {}) {
  const client = options.client ?? plannerClient;
  const offline = useOfflineStore();
  const toast = useToastStore();
  const baseDelay = options.pollDelayMs ?? 5_000;
  const maxDelay = options.maxDelayMs ?? 60_000;

  const items = ref<Notification[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const seen = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = baseDelay;
  let stopped = false;

  const visibleItems = computed(() => items.value.filter((item) => item.state !== 'dismissed'));

  function schedule(nextDelay: number): void {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, nextDelay);
  }

  // Owner isolation (ADR-023): a poll or a dismiss belongs to the user who was
  // signed in when it started. A response that arrives after a user switch is
  // dropped — the previous user's notifications are neither listed nor toasted
  // for the next one.
  async function poll(): Promise<void> {
    if (stopped) return;
    if (!offline.online) {
      delay = Math.min(delay * 2, maxDelay);
      schedule(delay);
      return;
    }
    loading.value = true;
    error.value = null;
    await runOwnerBound(
      function* (owner) {
        try {
          const page = yield* owner.wait(client.listNotifications({ limit: 50 }));
          items.value = page.items;
          for (const item of page.items) {
            if (item.state !== 'sent') continue;
            const key = `${item.id}:${item.version}`;
            if (seen.has(key)) continue;
            seen.add(key);
            toast.show(notificationLabel(item), { duration: 8000 });
          }
          delay = baseDelay;
        } catch (cause) {
          error.value = errorMessage(cause, t('notifications.loadFailed'));
          delay = Math.min(delay * 2, maxDelay);
        }
      },
      {
        onSettled: () => {
          loading.value = false;
          schedule(delay);
        },
      },
    );
  }

  async function refresh(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await poll();
  }

  async function dismiss(item: Notification): Promise<boolean> {
    if (!offline.online) {
      error.value = t('notifications.dismissOffline');
      return false;
    }
    const outcome = await runOwnerBound(
      function* (owner) {
        const updated = yield* owner.wait(client.dismissNotification(item.id, uuidV7Key(), item.version));
        items.value = items.value.map((current) => (current.id === updated.id ? updated : current));
      },
      {
        onError: (cause) => {
          error.value = errorMessage(cause, t('notifications.dismissFailed'));
        },
      },
    );
    return outcome.status === 'done';
  }

  // What is listed and what was already announced belong to the previous
  // user; a panel that stays mounted starts over for the next one.
  const stopWatchingOwner = onActiveOwnerChange(() => {
    items.value = [];
    seen.clear();
    error.value = null;
    loading.value = false;
    delay = baseDelay;
    if (!stopped) schedule(baseDelay);
  });

  function start(): void {
    stopped = false;
    if (timer === null) void poll();
  }

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  onUnmounted(() => {
    stop();
    stopWatchingOwner();
  });

  return { items, visibleItems, loading, error, start, stop, refresh, poll, dismiss };
}
