import { computed, type ComputedRef } from 'vue';
import {
  captureOwnerBinding,
  isOwnerBindingCurrent,
  ownerState,
  type OwnerBinding,
} from './ownerEpoch';
import { ANONYMOUS_OWNER } from './ownerStorage';

/**
 * Owner-bound continuations (ADR-023 guardrail, FU-77).
 *
 * The defect this replaces: an async function awaits something, the signed-in
 * user changes meanwhile, and the lines after the await run for the wrong
 * user — they read "the current owner" (now someone else), write storage or
 * cache, toast or navigate. Each screen used to guard this by hand with a
 * check after each await; a missing check was found in review four times.
 *
 * `runOwnerBound` is the one way to write such a function:
 * - the OwnerBinding is captured when it is called, before the first await;
 * - the task awaits through the scope (`await owner.wait(…)`), which never
 *   resumes for a stale owner — it rejects with OwnerChangedError as soon as
 *   the owner changes;
 * - a `catch` inside the task starts with `owner.rethrowIfStale(cause)`, so a
 *   stale failure is never handled (shown, retried) as a real one;
 * - cleanup goes in `onSettled`, not `finally`: a `finally` block would also
 *   run for the stale owner;
 * - `owner.signal` cancels the requests, `owner.binding` is what storage
 *   writes take;
 * - when the owner changed, the task's result and its failure are dropped:
 *   neither `onError` nor `onSettled` runs, and the outcome is `stale`.
 *
 * ESLint rule owner-isolation/bound-await enforces the three "inside the
 * task" rules, so they cannot be forgotten on the next screen.
 */

/** Work outlived the owner it started for; whatever it produced must be dropped. */
export class OwnerChangedError extends Error {
  constructor() {
    super('owner changed during the request');
    this.name = 'OwnerChangedError';
  }
}

export function assertOwnerCurrent(binding: OwnerBinding): void {
  if (!isOwnerBindingCurrent(binding)) throw new OwnerChangedError();
}

/** A page of a cursor-paginated list. */
export interface OwnerPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface CollectPagesOptions<T> {
  /** Upper bound on requests (default MAX_LOOKUP_PAGES). */
  readonly maxPages?: number;
  /** Stop at the first item that matches. */
  readonly until?: (item: T) => boolean;
}

/** Page bound for whole-list lookups (link targets, promoted-note search). */
export const MAX_LOOKUP_PAGES = 5;

/**
 * Follow `nextCursor` under ONE binding: checked before every page is asked
 * for and after it arrives, with the binding's signal on every request. A
 * lookup whose owner changed throws OwnerChangedError — no page fetched with
 * the next user's credentials is ever merged into the previous user's list
 * (M6-03R-1 H1).
 */
export async function collectPages<T>(
  binding: OwnerBinding,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<OwnerPage<T>>,
  options: CollectPagesOptions<T> = {},
): Promise<{ items: T[]; found: T | null }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (options.maxPages ?? MAX_LOOKUP_PAGES); page += 1) {
    assertOwnerCurrent(binding);
    const result = await fetchPage(cursor, binding.signal);
    assertOwnerCurrent(binding);
    items.push(...result.items);
    const found = options.until === undefined ? undefined : result.items.find(options.until);
    if (found !== undefined) return { items, found };
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  return { items, found: null };
}

/** What a bound task works with. One scope = one owner, for the task's whole life. */
export interface OwnerScope {
  /** Pass to storage writers (session/ownerStorage.ts) and to anything that takes a binding. */
  readonly binding: OwnerBinding;
  readonly ownerId: string | null;
  /** Aborted the moment the owner changes; pass it to every request. */
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  /** Throws OwnerChangedError when the owner changed. */
  assertCurrent(): void;
  /**
   * First line of every `catch` in a bound task: a failure that is (or was
   * caused by) the owner change is thrown on, so the handler below it only
   * ever sees a real failure of the current owner's action.
   */
  rethrowIfStale(cause: unknown): void;
  /**
   * Await `pending` for this owner only: resolves or rejects like it while the
   * owner is current, rejects with OwnerChangedError as soon as it is not —
   * also when `pending` never settles or ignores the signal.
   */
  wait<T>(pending: PromiseLike<T> | T): Promise<T>;
  /** `collectPages` under this scope's binding. */
  pages<T>(
    fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<OwnerPage<T>>,
    options?: CollectPagesOptions<T>,
  ): Promise<{ items: T[]; found: T | null }>;
}

function waitFor<T>(binding: OwnerBinding, pending: PromiseLike<T> | T): Promise<T> {
  const source = Promise.resolve(pending);
  if (!isOwnerBindingCurrent(binding)) {
    // Nobody is left to hear a late failure of the abandoned work.
    source.catch(() => undefined);
    return Promise.reject(new OwnerChangedError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new OwnerChangedError());
    };
    binding.signal.addEventListener('abort', onAbort, { once: true });
    const finish = (deliver: () => void): void => {
      if (settled) return;
      settled = true;
      binding.signal.removeEventListener('abort', onAbort);
      if (isOwnerBindingCurrent(binding)) deliver();
      else reject(new OwnerChangedError());
    };
    source.then(
      (value) => finish(() => resolve(value)),
      (cause: unknown) => finish(() => reject(cause)),
    );
  });
}

export function ownerScopeOf(binding: OwnerBinding): OwnerScope {
  return {
    binding,
    ownerId: binding.ownerId,
    signal: binding.signal,
    isCurrent: () => isOwnerBindingCurrent(binding),
    assertCurrent: () => assertOwnerCurrent(binding),
    rethrowIfStale(cause) {
      if (cause instanceof OwnerChangedError) throw cause;
      assertOwnerCurrent(binding);
    },
    wait: (pending) => waitFor(binding, pending),
    pages: (fetchPage, options) => collectPages(binding, fetchPage, options),
  };
}

export type OwnerBoundOutcome<T> =
  | { readonly status: 'done'; readonly value: T }
  /** The owner changed: nothing was reported, nothing may be done with the work. */
  | { readonly status: 'stale' }
  /** The task failed for the current owner and `onError` handled it. */
  | { readonly status: 'failed'; readonly cause: unknown };

export interface OwnerBoundOptions {
  /**
   * Continue under a binding captured earlier, when the action really began
   * there (a click that starts a timer, a dialog that confirms later). A
   * binding that is already stale runs nothing.
   */
  readonly binding?: OwnerBinding;
  /** A real failure, only while the owner is current. Without it the failure is rethrown. */
  readonly onError?: (cause: unknown) => void;
  /** After success or failure — never after the owner changed. */
  readonly onSettled?: () => void;
}

const STALE = { status: 'stale' } as const;

/**
 * Run `task` for the owner who is signed in right now. See the module comment;
 * in short: await only through `owner.wait(…)`, write only with
 * `owner.binding`, and put what must happen afterwards in the task or in
 * `onError` / `onSettled` — code after `await runOwnerBound(…)` must first
 * check `outcome.status`.
 */
export async function runOwnerBound<T>(
  task: (owner: OwnerScope) => Promise<T> | T,
  options: OwnerBoundOptions = {},
): Promise<OwnerBoundOutcome<T>> {
  // Synchronous: an async function runs to its first await in the caller's turn.
  const binding = options.binding ?? captureOwnerBinding();
  if (!isOwnerBindingCurrent(binding)) return STALE;
  let outcome: OwnerBoundOutcome<T>;
  try {
    const value = await task(ownerScopeOf(binding));
    if (!isOwnerBindingCurrent(binding)) return STALE;
    outcome = { status: 'done', value };
  } catch (cause) {
    if (!isOwnerBindingCurrent(binding) || cause instanceof OwnerChangedError) return STALE;
    if (options.onError === undefined) {
      options.onSettled?.();
      throw cause;
    }
    options.onError(cause);
    outcome = { status: 'failed', cause };
  }
  options.onSettled?.();
  return outcome;
}

// ── Vue Query: one cached lookup = one owner ────────────────────────────────

/** Cache-key owner: the same source the OwnerBinding is captured from. */
export function ownerKeyOf(ownerId: string | null): string {
  return ownerId ?? ANONYMOUS_OWNER;
}

export function useOwnerKey(): ComputedRef<string> {
  return computed(() => ownerKeyOf(ownerState.ownerId.value));
}

/**
 * Run one lookup for `owner` (the owner in its cache key) under one binding.
 * Refuses to start for another owner, and refuses to return once the owner
 * changed — also when the request itself failed because the binding aborted it.
 */
export async function ownerFenced<T>(owner: string, run: (binding: OwnerBinding) => Promise<T>): Promise<T> {
  const binding = captureOwnerBinding();
  if (ownerKeyOf(binding.ownerId) !== owner) throw new OwnerChangedError();
  let result: T;
  try {
    result = await run(binding);
  } catch (cause) {
    assertOwnerCurrent(binding);
    throw cause;
  }
  assertOwnerCurrent(binding);
  return result;
}
