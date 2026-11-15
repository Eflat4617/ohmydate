/**
 * The pointer's light on glass (FLOW.md §6, progressive enhancement only).
 *
 * `.glass` draws a faint highlight at `--glass-x` / `--glass-y`; this moves it
 * under a mouse so the surface answers like glass does. It is never needed to
 * read or use anything, and it is not installed at all where it would be
 * wrong: without a fine hovering pointer, or when the person asked for less
 * motion. One element is touched per frame at most, and only custom
 * properties change, so nothing is laid out again.
 */
const GLASS = '.glass';

export interface GlassLightHandle {
  /** Stop following the pointer and take the light off the surface it is on. */
  stop(): void;
}

function clear(element: HTMLElement | null): void {
  element?.style.removeProperty('--glass-x');
  element?.style.removeProperty('--glass-y');
}

/** True where a moving highlight is welcome. Read once, at install. */
export function glassLightAllowed(target: Pick<Window, 'matchMedia'> = window): boolean {
  if (typeof target.matchMedia !== 'function') return false;
  return (
    target.matchMedia('(hover: hover) and (pointer: fine)').matches &&
    !target.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function installGlassLight(root: Document = document): GlassLightHandle | null {
  const view = root.defaultView;
  if (view === null || !glassLightAllowed(view)) return null;

  let lit: HTMLElement | null = null;
  let frame: number | null = null;
  let scheduled = false;
  let last: { target: EventTarget | null; x: number; y: number } | null = null;

  const paint = (): void => {
    scheduled = false;
    if (last === null) return;
    const surface = last.target instanceof Element ? last.target.closest<HTMLElement>(GLASS) : null;
    if (surface !== lit) {
      clear(lit);
      lit = surface;
    }
    if (surface === null) return;
    const box = surface.getBoundingClientRect();
    surface.style.setProperty('--glass-x', `${Math.round(last.x - box.left)}px`);
    surface.style.setProperty('--glass-y', `${Math.round(last.y - box.top)}px`);
  };

  const onMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') return;
    last = { target: event.target, x: event.clientX, y: event.clientY };
    if (scheduled) return;
    scheduled = true;
    frame = view.requestAnimationFrame(paint);
  };

  const onLeave = (): void => {
    last = null;
    clear(lit);
    lit = null;
  };

  root.addEventListener('pointermove', onMove, { passive: true });
  root.documentElement.addEventListener('pointerleave', onLeave);

  return {
    stop() {
      root.removeEventListener('pointermove', onMove);
      root.documentElement.removeEventListener('pointerleave', onLeave);
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null;
      scheduled = false;
      onLeave();
    },
  };
}
