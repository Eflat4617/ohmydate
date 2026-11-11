import { onScopeDispose, readonly, ref, type Ref } from 'vue';
import { localDateIso } from '../format';
import { layoutClock } from './clock';

/**
 * One shared, reactive "now" (from the Clock port) for everything the layout
 * derives from time: Next up expiry, the review window, the current day and
 * so the date of the Today query. It ticks while anything uses it, so a
 * screen left open stays current without any other state change (M6-02R-1 L1).
 */
export const LAYOUT_TICK_MS = 30_000;

const now = ref(layoutClock().now());
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Re-reads the clock now (used right before a layout decision). */
export function refreshLayoutNow(): number {
  now.value = layoutClock().now();
  return now.value;
}

/** Call from a component's setup (or another effect scope). */
export function useLayoutNow(): Readonly<Ref<number>> {
  users += 1;
  refreshLayoutNow();
  if (timer === null) timer = setInterval(refreshLayoutNow, LAYOUT_TICK_MS);
  onScopeDispose(() => {
    users -= 1;
    if (users === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });
  return readonly(now);
}

/** Browser-local date (as `GET /today?date=` expects) of a shared "now". */
export function localDateAt(instantMs: number): string {
  return localDateIso(new Date(instantMs));
}
