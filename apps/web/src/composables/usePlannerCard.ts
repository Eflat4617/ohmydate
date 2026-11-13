import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { placeCard, type CardPlacement, type Rect } from '../domain/weekGrid';

/**
 * The one floating detail card of 플래너 (HOLO-02): which item it is open
 * for, where it stands, and how it goes away.
 *
 * The card is an absolutely placed child of `frame` (the scrolling grid's
 * content, or the day list), so it moves with the item it is anchored to.
 * It closes on Escape (focus goes back to the item), on a press outside it,
 * and when another item is opened — there is never a second one.
 */
export interface PlannerCardOptions {
  /** The positioned element the card is placed in. */
  readonly frame: Ref<HTMLElement | null>;
  /**
   * The part of the frame that can be seen, in the frame's own coordinates
   * (a grid that scrolls inside itself). Without it: the whole frame, with
   * room under it for the card.
   */
  readonly visible?: () => Rect | null;
}

const HIDDEN: Readonly<Record<string, string>> = { visibility: 'hidden' };

export function usePlannerCard(options: PlannerCardOptions) {
  const openKey = ref<string | null>(null);
  const style = ref<Record<string, string>>({ ...HIDDEN });
  const side = ref<CardPlacement['side']>('right');
  /** The card's root element (set by the card through a template ref). */
  const card = ref<HTMLElement | null>(null);
  let anchor: HTMLElement | null = null;

  function place(): void {
    const frame = options.frame.value;
    const panel = card.value;
    if (frame === null || panel === null || anchor === null) return;
    const origin = frame.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const visible = options.visible?.() ?? {
      left: 0,
      top: 0,
      width: frame.clientWidth,
      height: frame.clientHeight + size.height + 16,
    };
    const placed = placeCard(
      { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height },
      size,
      visible,
    );
    side.value = placed.side;
    style.value = { left: `${Math.round(placed.left)}px`, top: `${Math.round(placed.top)}px` };
  }

  function onOutsidePointer(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (card.value?.contains(target) === true) return;
    // A press on the item itself is its own toggle (the click that follows).
    if (anchor?.contains(target) === true) return;
    close();
  }

  function open(key: string, element: HTMLElement): void {
    anchor = element;
    style.value = { ...HIDDEN };
    openKey.value = key;
    void nextTick(async () => {
      place();
      // Its place has to be in the page before it can take the focus: until
      // then the card is hidden, and a hidden element cannot be focused.
      await nextTick();
      const panel = card.value;
      if (panel === null || openKey.value !== key) return;
      // In view first, so taking the focus does not jump the page.
      if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      panel.focus({ preventScroll: true });
    });
  }

  /** Escape closes the card wherever the focus is (on its item, too). */
  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close({ restoreFocus: true });
  }

  /** `restoreFocus`: the keyboard asked (Escape, 닫기), so focus goes back to the item. */
  function close(how: { restoreFocus?: boolean } = {}): void {
    const target = anchor;
    openKey.value = null;
    anchor = null;
    style.value = { ...HIDDEN };
    if (how.restoreFocus === true && target !== null && target.isConnected) target.focus();
  }

  function toggle(key: string, element: HTMLElement): void {
    if (openKey.value === key) close({ restoreFocus: true });
    else open(key, element);
  }

  watch(openKey, (key) => {
    if (typeof document === 'undefined') return;
    if (key !== null) {
      document.addEventListener('pointerdown', onOutsidePointer);
      document.addEventListener('keydown', onDocumentKeydown);
      window.addEventListener('resize', place);
    } else {
      document.removeEventListener('pointerdown', onOutsidePointer);
      document.removeEventListener('keydown', onDocumentKeydown);
      window.removeEventListener('resize', place);
    }
  });

  onBeforeUnmount(() => {
    if (typeof document === 'undefined') return;
    document.removeEventListener('pointerdown', onOutsidePointer);
    document.removeEventListener('keydown', onDocumentKeydown);
    window.removeEventListener('resize', place);
  });

  return { openKey, style, side, card, open, close, toggle, place };
}
