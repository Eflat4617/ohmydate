import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { readNavCollapsed, writeNavCollapsed } from '../layout/shellNav';
import { captureOwnerBinding, currentOwnerId, onActiveOwnerChange } from '../session/ownerEpoch';

export type CaptureMode = 'capture' | 'search';

export const useUiStore = defineStore('ui', () => {
  const helpOpen = ref(false);
  const notificationsOpen = ref(false);
  const conflictCount = ref(0);
  const conflictOpen = computed(() => conflictCount.value > 0);
  /**
   * HOLO-04: the capture bar (담기 줄). `n`, `Ctrl+K`, `/` and the buttons that
   * stand for them bump `captureRequest`; the bar in the top bar answers by
   * taking the focus, and where it is not on screen (a phone) the shell opens
   * it as a sheet. `captureMode` says whether it puts things down or searches.
   */
  const captureRequest = ref(0);
  const captureMode = ref<CaptureMode>('capture');
  const captureSheetOpen = ref(false);
  /** HOLO-04: the three-step start guide (FLOW.md §3) is on screen. Who needs it is composables/firstRun.ts. */
  const firstRunOpen = ref(false);
  // HOLO-01: the sidebar folded down to icons, remembered per owner.
  const navCollapsed = ref(readNavCollapsed(currentOwnerId()));
  onActiveOwnerChange((nextOwnerId) => {
    navCollapsed.value = readNavCollapsed(nextOwnerId);
    captureSheetOpen.value = false;
    captureMode.value = 'capture';
    firstRunOpen.value = false;
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
    notificationsOpen.value = false;
  }

  function openNotifications(): void {
    notificationsOpen.value = true;
    helpOpen.value = false;
  }

  function closeDialogs(): void {
    helpOpen.value = false;
    notificationsOpen.value = false;
  }

  function openConflict(): void {
    conflictCount.value += 1;
  }

  function closeConflict(): void {
    conflictCount.value = Math.max(0, conflictCount.value - 1);
  }

  function setCaptureMode(mode: CaptureMode): void {
    captureMode.value = mode;
  }

  /** Ask for the capture bar: to put something down (the default) or to search. */
  function openCapture(mode: CaptureMode = 'capture'): void {
    helpOpen.value = false;
    notificationsOpen.value = false;
    captureMode.value = mode;
    captureRequest.value += 1;
  }

  /** Search lives in the capture bar. */
  function openSearch(): void {
    openCapture('search');
  }

  function setCaptureSheet(open: boolean): void {
    captureSheetOpen.value = open;
  }

  function setFirstRun(open: boolean): void {
    if (open) {
      helpOpen.value = false;
      notificationsOpen.value = false;
      captureSheetOpen.value = false;
    }
    firstRunOpen.value = open;
  }

  return {
    helpOpen,
    notificationsOpen,
    conflictOpen,
    conflictCount,
    captureRequest,
    captureMode,
    captureSheetOpen,
    firstRunOpen,
    navCollapsed,
    setNavCollapsed,
    toggleNav,
    openHelp,
    openSearch,
    openNotifications,
    closeDialogs,
    openConflict,
    closeConflict,
    setCaptureMode,
    openCapture,
    setCaptureSheet,
    setFirstRun,
  };
});
