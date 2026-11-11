import { isLayoutComponentId } from '@ohmydate/ui-policy';

/**
 * Focus preservation across a layout change (07 §5). Before the change we note
 * where focus is; afterwards, if that element is gone, focus goes to the same
 * place in the same component, else to the primary region (never to <body>).
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusSnapshot {
  readonly element: HTMLElement | null;
  readonly item: string | null;
  readonly index: number;
}

export function captureFocus(root: HTMLElement | null): FocusSnapshot {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || root === null || !root.contains(active)) {
    return { element: active instanceof HTMLElement ? active : null, item: null, index: -1 };
  }
  const itemEl = active.closest<HTMLElement>('[data-layout-item]');
  const item = itemEl?.dataset['layoutItem'] ?? null;
  const index = itemEl === null || itemEl === undefined ? -1 : [...itemEl.querySelectorAll(FOCUSABLE)].indexOf(active);
  return { element: active, item, index };
}

function focusQuietly(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

/** Returns where focus ended up, for tests. */
export function restoreFocus(snapshot: FocusSnapshot, root: HTMLElement | null): HTMLElement | null {
  const { element } = snapshot;
  if (element !== null && element.isConnected && element !== document.body) {
    // Still on screen: leave it exactly where it is.
    if (document.activeElement !== element && root?.contains(element) === true) focusQuietly(element);
    return element;
  }
  if (root === null) return null;
  // Focus was on <body> or outside the frame and nothing was lost.
  if (element === null || element === document.body) return null;
  // Item ids come from the closed registry enum, so they are safe in a selector.
  if (snapshot.item !== null && isLayoutComponentId(snapshot.item)) {
    const itemEl = root.querySelector<HTMLElement>(`[data-layout-item="${snapshot.item}"]`);
    if (itemEl !== null) {
      const focusables = [...itemEl.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const target = focusables[Math.min(Math.max(snapshot.index, 0), focusables.length - 1)];
      if (target !== undefined) {
        focusQuietly(target);
        return target;
      }
    }
  }
  const primary = root.querySelector<HTMLElement>('[data-layout-region="primary"]');
  if (primary !== null) {
    focusQuietly(primary);
    return primary;
  }
  return null;
}
