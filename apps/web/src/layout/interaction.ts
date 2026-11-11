import { isLayoutComponentId, type InteractionSignals, type LayoutComponentId } from '@ohmydate/ui-policy';

/**
 * Tracks what the user is doing right now so the policy can wait (07 §2.3):
 * typing in a field, dragging, pressing inside a panel, or a dialog open
 * inside a panel. Read on demand; `onChange` fires when an interaction ends.
 */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden']);
const DRAG_THRESHOLD_PX = 6;

export function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return !element.disabled;
  if (element instanceof HTMLInputElement) return !element.disabled && !NON_TEXT_INPUTS.has(element.type);
  return false;
}

export function layoutItemOf(element: EventTarget | null): LayoutComponentId | null {
  if (!(element instanceof Element)) return null;
  const item = element.closest<HTMLElement>('[data-layout-item]');
  const id = item?.dataset['layoutItem'];
  return isLayoutComponentId(id) ? id : null;
}

export interface InteractionTracker {
  snapshot(root: HTMLElement | null): InteractionSignals;
  start(): void;
  stop(): void;
}

export function createInteractionTracker(onChange: () => void): InteractionTracker {
  let pressed: LayoutComponentId | null = null;
  let origin: { x: number; y: number } | null = null;
  let pointerDragging = false;
  let htmlDragging = false;

  const onPointerDown = (event: PointerEvent) => {
    pressed = layoutItemOf(event.target);
    origin = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (origin === null || event.buttons === 0 || pointerDragging) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= DRAG_THRESHOLD_PX) pointerDragging = true;
  };
  const onPointerEnd = () => {
    const wasBusy = pressed !== null || pointerDragging;
    pressed = null;
    origin = null;
    pointerDragging = false;
    if (wasBusy) onChange();
  };
  const onDragStart = () => {
    htmlDragging = true;
  };
  const onDragEnd = () => {
    if (!htmlDragging) return;
    htmlDragging = false;
    onChange();
  };
  const onFocusChange = () => onChange();

  return {
    snapshot(root) {
      const active = document.activeElement;
      const typing = isEditable(active);
      const busy = new Set<LayoutComponentId>();
      if (pressed !== null) busy.add(pressed);
      if (typing) {
        const item = layoutItemOf(active);
        if (item !== null) busy.add(item);
      }
      if (root !== null) {
        for (const dialog of root.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
          const item = layoutItemOf(dialog);
          if (item !== null) busy.add(item);
        }
      }
      return { typing, dragging: pointerDragging || htmlDragging, activeComponents: [...busy] };
    },
    start() {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', onPointerEnd, true);
      document.addEventListener('pointercancel', onPointerEnd, true);
      document.addEventListener('dragstart', onDragStart, true);
      document.addEventListener('dragend', onDragEnd, true);
      document.addEventListener('drop', onDragEnd, true);
      document.addEventListener('focusin', onFocusChange, true);
      document.addEventListener('focusout', onFocusChange, true);
    },
    stop() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      document.removeEventListener('dragstart', onDragStart, true);
      document.removeEventListener('dragend', onDragEnd, true);
      document.removeEventListener('drop', onDragEnd, true);
      document.removeEventListener('focusin', onFocusChange, true);
      document.removeEventListener('focusout', onFocusChange, true);
    },
  };
}
