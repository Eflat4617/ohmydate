import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

export const useOfflineStore = defineStore('offline', () => {
  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
  const mutationsEnabled = computed(() => online.value);

  function setOnline(value: boolean): void {
    online.value = value;
  }

  function onOnline(): void {
    online.value = true;
  }

  function onOffline(): void {
    online.value = false;
  }

  function initialize(): () => void {
    online.value = typeof navigator === 'undefined' ? true : navigator.onLine;
    if (typeof window === 'undefined') return () => undefined;
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }

  return { online, mutationsEnabled, setOnline, initialize };
});
