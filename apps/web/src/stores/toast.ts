import { ref } from 'vue';
import { defineStore } from 'pinia';
import { isPageSealed, onActiveOwnerChange } from '../session/ownerEpoch';

export interface ToastAction {
  readonly label: string;
  readonly handler: () => void;
}

export interface Toast {
  readonly id: string;
  readonly message: string;
  readonly tone: 'info' | 'error';
  readonly action: ToastAction | null;
  /** Optional link-style second action (e.g. the layout toast's "자동 전환 끄기"). */
  readonly secondaryAction: ToastAction | null;
}

export interface ToastOptions {
  readonly tone?: 'info' | 'error';
  readonly action?: ToastAction;
  readonly secondaryAction?: ToastAction;
  readonly duration?: number;
}

let counter = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Owner isolation (ADR-023 guardrail): a toast belongs to the user who was
 * signed in when it appeared. Every toast is removed on an owner change, and a
 * page that is being hard-reset shows no new one — so a late continuation of
 * the previous user's action cannot tell the next user anything.
 */
export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);

  onActiveOwnerChange(() => clear());

  function show(message: string, options: ToastOptions = {}): string {
    counter += 1;
    const id = `toast-${counter}`;
    if (isPageSealed()) return id;
    const toast: Toast = {
      id,
      message,
      tone: options.tone ?? 'info',
      action: options.action ?? null,
      secondaryAction: options.secondaryAction ?? null,
    };
    toasts.value = [...toasts.value, toast];
    const duration = options.duration ?? 6000;
    if (duration > 0) {
      timers.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    }
    return id;
  }

  function dismiss(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function clear(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    toasts.value = [];
  }

  return { toasts, show, dismiss, clear };
});
