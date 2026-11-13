import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { readNavCollapsed, writeNavCollapsed } from '../layout/shellNav';
import { captureOwnerBinding, currentOwnerId, onActiveOwnerChange } from '../session/ownerEpoch';

export const useUiStore = defineStore('ui', () => {
  const helpOpen = ref(false);
  const searchOpen = ref(false);
  const notificationsOpen = ref(false);
  const conflictCount = ref(0);
  const conflictOpen = computed(() => conflictCount.value > 0);
  const newTaskRequest = ref(0);
  // HOLO-01: the sidebar folded down to icons, remembered per owner.
  const navCollapsed = ref(readNavCollapsed(currentOwnerId()));
  onActiveOwnerChange((nextOwnerId) => {
    navCollapsed.value = readNavCollapsed(nextOwnerId);
  });

  function setNavCollapsed(collapsed: boolean): void {
    // The owner is noted at the click; a stale binding writes nothing.
    const binding = captureOwnerBinding();
    navCollapsed.value = collapsed;
    writeNavCollapsed(binding, collapsed);
  }

  function toggleNav(): void {
    setNavCollapsed(!navCollapsed.value);
  }

  function openHelp(): void {
    helpOpen.value = true;
    searchOpen.value = false;
    notificationsOpen.value = false;
  }

  function openSearch(): void {
    searchOpen.value = true;
    helpOpen.value = false;
    notificationsOpen.value = false;
  }

  function openNotifications(): void {
    notificationsOpen.value = true;
    helpOpen.value = false;
    searchOpen.value = false;
  }

  function closeDialogs(): void {
    helpOpen.value = false;
    searchOpen.value = false;
    notificationsOpen.value = false;
  }

  function openConflict(): void {
    conflictCount.value += 1;
  }

  function closeConflict(): void {
    conflictCount.value = Math.max(0, conflictCount.value - 1);
  }

  function requestNewTask(): void {
    newTaskRequest.value += 1;
  }

  return {
    helpOpen,
    searchOpen,
    notificationsOpen,
    conflictOpen,
    conflictCount,
    newTaskRequest,
    navCollapsed,
    setNavCollapsed,
    toggleNav,
    openHelp,
    openSearch,
    openNotifications,
    closeDialogs,
    openConflict,
    closeConflict,
    requestNewTask,
  };
});
