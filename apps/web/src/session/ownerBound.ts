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
 * `runOwnerBound` is the one way to write such a function. The task is a
 * GENERATOR, not an async function, and that is the point:
 *
 *   await runOwnerBound(function* (owner) {
 *     const saved = yield* owner.wait(api.save(input, owner.signal));
 *     draft.value = saved;                      // only ever runs for this owner
 *     yield* announce(t('saved'));              // a helper is a generator too
 *   });
 *
 * - The OwnerBinding is captured when `runOwnerBound` is called, before
 *   anything is awaited.
 * - Every `yield` hands control to the runner. When what was yielded settles,
 *   the runner checks the binding and resumes the task IN THE SAME SYNCHRONOUS
 *   TURN. The check is therefore made when the code after the wait is about to
 *   run — not when the awaited promise resolved, which is a microtask earlier
 *   and leaves room for the owner to change in between (FU-77R-1 H1). No line
 *   of a task can run for a stale owner; there is nothing to remember to call.
 * - `await` does not exist inside a generator, so the unfenced form cannot be
 *   written by mistake, and the compiler rejects an async function as a task.
 * - A stale task is abandoned where it waits: its `catch` and `finally` blocks
 *   do not run, neither do `onError` / `onSettled`, and the outcome is `stale`.
 * - A helper that awaits and then writes (announce, focus, refresh) must be a
 *   generator delegated with `yield*`; its waits then go through the same
 *   runner. An async helper called from a task is fenced only at its end.
 * - `owner.signal` cancels the requests, `owner.binding` is what storage
 *   writes take.
 *
 * ESLint rule owner-isolation/bound-task covers what the compiler cannot:
 * async helpers called from a task, and effects placed after
 * `await runOwnerBound(…)` in the function that started it.
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

/**
 * The steps of an owner-bound task: a generator that yields what it waits
 * for. `yield* owner.wait(promise)` gives the awaited value its type.
 */
export type OwnerSteps<T> = Generator<unknown, T, unknown>;

/** What `runOwnerBound` runs. A generator function — an async function does not type-check. */
export type OwnerTask<T> = (owner: OwnerScope) => OwnerSteps<T>;

/**
 * Wait for `pending` inside an owner-bound task or helper:
 * `const value = yield* waitStep(promise)`. Same as `owner.wait`, for helper
 * generators that take no scope.
 */
export function* waitStep<T>(pending: PromiseLike<T> | T): OwnerSteps<T> {
  return (yield pending) as T;
}

function* pagesSteps<T>(
  binding: OwnerBinding,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<OwnerPage<T>>,
  options: CollectPagesOptions<T>,
): OwnerSteps<{ items: T[]; found: T | null }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (options.maxPages ?? MAX_LOOKUP_PAGES); page += 1) {
    const result = yield* waitStep(fetchPage(cursor, binding.signal));
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
   * `const value = yield* owner.wait(pending)`: wait for this owner only. The
   * task resumes with the value (or the failure) if the owner is still current
   * at that moment, and never resumes otherwise — also when `pending` never
   * settles or ignores the signal.
   */
  wait<T>(pending: PromiseLike<T> | T): OwnerSteps<T>;
  /** `yield* owner.pages(…)`: follow `nextCursor` under this owner, its signal on every request. */
  pages<T>(
    fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<OwnerPage<T>>,
    options?: CollectPagesOptions<T>,
  ): OwnerSteps<{ items: T[]; found: T | null }>;
}

/**
 * Test seam for the owner-switch harness: the instants at which an owner
 * change is hardest on a bound task. Production never installs a probe.
 */
export interface OwnerBoundProbe {
  /** A bound task started to wait; the work it waits for is under way. */
  waiting(): void;
  /** What it waited for settled while its owner was current; the task has not resumed yet. */
  settled(): void;
  /** A bound task finished for its owner; whoever awaits it has not resumed yet. */
  finished(): void;
}

let probe: OwnerBoundProbe | null = null;

export function probeOwnerBound(next: OwnerBoundProbe | null): void {
  probe = next;
}

/**
 * Settles like `pending` while the owner is current; rejects with
 * OwnerChangedError as soon as it is not. This only stops the WAIT early —
 * whether the task may go on is decided by the runner when it resumes.
 */
function settleFor<T>(binding: OwnerBinding, pending: PromiseLike<T> | T): Promise<T> {
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
      if (!isOwnerBindingCurrent(binding)) {
        reject(new OwnerChangedError());
        return;
      }
      deliver();
      probe?.settled();
    };
    source.then(
      (value) => finish(() => resolve(value)),
      (cause: unknown) => finish(() => reject(cause)),
    );
    probe?.waiting();
  });
}

export function ownerScopeOf(binding: OwnerBinding): OwnerScope {
  return {
    binding,
    ownerId: binding.ownerId,
    signal: binding.signal,
    isCurrent: () => isOwnerBindingCurrent(binding),
    assertCurrent: () => assertOwnerCurrent(binding),
    wait: waitStep,
    pages: (fetchPage, options = {}) => pagesSteps(binding, fetchPage, options),
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

function isGenerator(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  );
}

/**
 * Run `task` for the owner who is signed in right now. See the module comment.
 *
 * The outcome is handed to the caller a microtask after the task's last line,
 * so the function that awaits `runOwnerBound` must not act on it: put what has
 * to happen in the task (or in `onError` / `onSettled`, which run in the task's
 * last turn) and only return or map the outcome afterwards.
 */
export async function runOwnerBound<T>(
  task: OwnerTask<T>,
  options: OwnerBoundOptions = {},
): Promise<OwnerBoundOutcome<T>> {
  // Synchronous up to the first wait: an async function runs to its first
  // await in the caller's turn, and so does the task's first stretch of code.
  const binding = options.binding ?? captureOwnerBinding();
  if (!isOwnerBindingCurrent(binding)) return STALE;
  let outcome: OwnerBoundOutcome<T>;
  try {
    const steps = task(ownerScopeOf(binding));
    let step = steps.next();
    while (step.done !== true) {
      if (isGenerator(step.value)) {
        throw new TypeError('An owner-bound task yielded a generator: delegate to a helper with `yield*`.');
      }
      let resume: () => IteratorResult<unknown, T>;
      try {
        const value = await settleFor(binding, step.value);
        resume = () => steps.next(value);
      } catch (cause) {
        resume = () => steps.throw(cause);
      }
      // The turn in which the task goes on. The owner is checked HERE, and the
      // task's next stretch of code runs before this turn ends, so nothing can
      // change the owner in between. A stale task is abandoned as it stands.
      if (!isOwnerBindingCurrent(binding)) return STALE;
      step = resume();
    }
    outcome = { status: 'done', value: step.value };
  } catch (cause) {
    if (!isOwnerBindingCurrent(binding) || cause instanceof OwnerChangedError) return STALE;
    if (options.onError === undefined) {
      options.onSettled?.();
      probe?.finished();
      throw cause;
    }
    options.onError(cause);
    outcome = { status: 'failed', cause };
  }
  options.onSettled?.();
  probe?.finished();
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
