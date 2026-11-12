import { computed, reactive, ref } from 'vue';
import { ActionStore, ApiError, isStoredFinalResult, plannerClient } from '../api';
import { t } from '../i18n';
import { errorMessage } from '../i18n/problem';
import { refreshLayoutNow } from '../layout/now';
import { runOwnerBound } from '../session/ownerBound';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';

/** What a lock toggle needs to know about an approved block (ScheduleBlock fields). */
export interface LockableBlock {
  readonly id: string;
  readonly locked: boolean;
  readonly version: number;
  readonly status: string;
  readonly startAt: string;
}

/**
 * The server's rule (08 §2.5, FU-71): only a planned block that has not
 * started yet can be locked or unlocked. Started blocks are history (06 §7.1).
 */
export function isBlockLockable(block: Pick<LockableBlock, 'status' | 'startAt'>, nowMs: number): boolean {
  return block.status === 'planned' && Date.parse(block.startAt) >= nowMs;
}

export interface BlockLockOptions {
  /**
   * Re-read what the screen shows (blocks and the plan revision — a lock moves
   * Today.version / Plan.version). Called after a change and after any
   * failure (FU-86F: also when no answer came back).
   */
  readonly refresh: () => Promise<unknown>;
}

/**
 * `POST /schedule-blocks/{id}:lock` / `:unlock` for a screen.
 *
 * Optimistic UI only through the owner guardrail (ADR-023, FU-77): the
 * requested state shows at once (`displayLocked`), the request, the toast, the
 * refresh and the clean-up all run inside one `runOwnerBound` task, so after a
 * user switch nothing of this action reaches the next user. A 412 (the block
 * changed elsewhere) or 409 (it started or finished meanwhile) explains
 * itself; every failure — a lost answer too — re-reads the screen before the
 * optimistic state is dropped; one Idempotency-Key per logical toggle, reused
 * only by a retry of the same request (08 §1).
 */
export function useBlockLock(options: BlockLockOptions) {
  const offline = useOfflineStore();
  const toast = useToastStore();
  const actions = new ActionStore();
  /** blockId → the state the user asked for, until the server answered and the screen re-read. */
  const pending = reactive(new Map<string, boolean>());
  const error = ref<string | null>(null);

  function displayLocked(block: Pick<LockableBlock, 'id' | 'locked'>): boolean {
    return pending.get(block.id) ?? block.locked;
  }

  function isPending(blockId: string): boolean {
    return pending.has(blockId);
  }

  /**
   * Some lock request of this screen is out (until its re-read is in). A lock
   * moves the plan revision, so the plan page holds candidate edits meanwhile
   * (FU-86): the re-read would otherwise discard them.
   */
  const anyPending = computed(() => pending.size > 0);

  async function toggle(block: LockableBlock): Promise<void> {
    if (!offline.mutationsEnabled || pending.has(block.id)) return;
    const locked = !block.locked;
    const scope = `schedule-block:lock:${block.id}`;
    const action = actions.begin(
      scope,
      { blockId: block.id, locked },
      (left, right) => left.blockId === right.blockId && left.locked === right.locked,
      block.version,
    );
    await runOwnerBound(function* (owner) {
      pending.set(block.id, locked);
      error.value = null;
      try {
        const saved = yield* owner.wait(
          plannerClient.setScheduleBlockLock(block.id, locked, action.key, block.version, owner.signal),
        );
        actions.settle(scope, action);
        toast.show(saved.locked ? t('blockLock.lockedToast') : t('blockLock.unlockedToast'));
        yield* owner.wait(options.refresh());
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (cause instanceof ApiError && cause.status === 412) {
          // The next attempt sends another If-Match, so it is a new action.
          actions.settle(scope, action);
          error.value = t('blockLock.stale');
        } else if (cause instanceof ApiError && cause.status === 409 && cause.code === 'illegal_transition') {
          error.value = t('blockLock.notLockable');
          // The block most likely started since the last layout tick (up to
          // LAYOUT_TICK_MS ago): read the clock now so its toggle goes at once
          // instead of staying pressable until the next tick (FU-86).
          refreshLayoutNow();
        } else {
          error.value = errorMessage(cause, t('blockLock.error'));
        }
        // Every failure ends with a re-read, still under `pending`. A lost
        // answer (network error, timeout, a gateway 5xx) may hide a lock the
        // server did apply — and the plan revision it moved. Without this the
        // screen would be released at the old revision, and a later re-read
        // would reset an edit made meanwhile without a word (FU-86F).
        yield* owner.wait(options.refresh());
      } finally {
        pending.delete(block.id);
      }
    });
  }

  return { displayLocked, isPending, anyPending, toggle, error };
}
