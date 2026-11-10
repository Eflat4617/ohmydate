import { ref } from 'vue';
import { defineStore } from 'pinia';

export interface ToastAction {
  readonly label: string;
  readonly handler: () => void;
}

export interface Toast {
  readonly id: string;
  readonly message: string;
  readonly tone: 'info' | 'error';
  readonly action: ToastAction | null;
}

export interface ToastOptions {
  readonly tone?: 'info' | 'error';
  readonly action?: ToastAction;
  readonly duration?: number;
}

let counter = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);

  function show(message: string, options: ToastOptions = {}): string {
    counter += 1;
    const id = `toast-${counter}`;
    const toast: Toast = {
      id,
      message,
      tone: options.tone ?? 'info',
      action: options.action ?? null,
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
