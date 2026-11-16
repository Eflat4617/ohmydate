/**
 * What is picked on the 할 일 canvas (HOLO-05). A selection is a set of to-do
 * ids and the one the next range starts from. Every function returns a new
 * selection; none of them knows about the screen.
 */
export interface Selection {
  readonly ids: ReadonlySet<string>;
  /** Where a range (Shift) is measured from: the last one picked on its own. */
  readonly anchor: string | null;
}

export const NO_SELECTION: Selection = { ids: new Set<string>(), anchor: null };

/** Add it if it is not picked, take it out if it is (Space, Ctrl-click, Shift-click). */
export function toggle(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: ids.has(id) ? id : selection.anchor === id ? null : selection.anchor };
}

/** Exactly this one. */
export function only(id: string): Selection {
  return { ids: new Set([id]), anchor: id };
}

/** Everything in `order` (Ctrl+A). */
export function all(order: readonly string[]): Selection {
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/**
 * From the anchor to `id` in `order`, added to what is picked (Shift+arrow).
 * Without an anchor that is still on the surface, `id` alone is added.
 */
export function extendTo(selection: Selection, id: string, order: readonly string[]): Selection {
  const to = order.indexOf(id);
  if (to === -1) return selection;
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const ids = new Set(selection.ids);
  if (from === -1) {
    ids.add(id);
    return { ids, anchor: id };
  }
  for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) ids.add(order[index] as string);
  return { ids, anchor: selection.anchor };
}

/** What a lasso caught: it replaces the selection, or is added to it (Shift held). */
export function lasso(selection: Selection, caught: readonly string[], add: boolean): Selection {
  const ids = add ? new Set(selection.ids) : new Set<string>();
  for (const id of caught) ids.add(id);
  const anchor = selection.anchor !== null && ids.has(selection.anchor) ? selection.anchor : (caught[0] ?? null);
  return { ids, anchor };
}

/** Drop what is no longer there (completed, deleted, filed away by another tab). */
export function prune(selection: Selection, present: ReadonlySet<string>): Selection {
  let changed = false;
  const ids = new Set<string>();
  for (const id of selection.ids) {
    if (present.has(id)) ids.add(id);
    else changed = true;
  }
  const anchor = selection.anchor !== null && present.has(selection.anchor) ? selection.anchor : null;
  if (!changed && anchor === selection.anchor) return selection;
  return { ids, anchor };
}

/** The picked ids in the order of the surface (what travels to the plan flow). */
export function ordered(selection: Selection, order: readonly string[]): string[] {
  return order.filter((id) => selection.ids.has(id));
}
