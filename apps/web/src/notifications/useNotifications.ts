import { computed, onUnmounted, ref } from 'vue';
import {
  ApiError,
  plannerClient,
  uuidV7Key,
  type Notification,
  type PlannerClient,
} from '../api';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';

const LABELS: Record<Notification['kind'], string> = {
  due_soon: 'A task is due soon',
  deadline_risk: 'Deadline risk detected',
  schedule_conflict: 'Schedule conflict detected',
  session_reminder: 'Focus session reminder',
  daily_summary: 'Daily summary is ready',
  replan_proposal: 'A replan proposal is ready',
};

export function notificationLabel(item: Notification): string {
  return LABELS[item.kind];
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

  async function poll(): Promise<void> {
    if (stopped) return;
    if (!offline.online) {
      delay = Math.min(delay * 2, maxDelay);
      schedule(delay);
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      const page = await client.listNotifications({ limit: 50 });
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
      error.value = cause instanceof ApiError ? cause.detail : 'Could not load notifications.';
      delay = Math.min(delay * 2, maxDelay);
    } finally {
      loading.value = false;
      schedule(delay);
    }
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
      error.value = 'Dismissing a notification requires a connection.';
      return false;
    }
    try {
      const updated = await client.dismissNotification(item.id, uuidV7Key(), item.version);
      items.value = items.value.map((current) => (current.id === updated.id ? updated : current));
      return true;
    } catch (cause) {
      error.value = cause instanceof ApiError ? cause.detail : 'Could not dismiss the notification.';
      return false;
    }
  }

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

  onUnmounted(stop);

  return { items, visibleItems, loading, error, start, stop, refresh, poll, dismiss };
}
