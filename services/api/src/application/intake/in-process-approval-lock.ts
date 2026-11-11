import type { Id } from '@ohmydate/domain';
import type {
  IntakeApprovalLock,
  IntakeApprovalLockHandle,
} from './ports.js';

const held = new Set<string>();

/**
 * Fallback for configurations without a `DATABASE_URL` (the production entry
 * point always has one). It serializes approvals inside this process only; the
 * served API uses `PgIntakeApprovalLock`, whose lock spans processes.
 */
export class InProcessIntakeApprovalLock implements IntakeApprovalLock {
  async tryAcquire(
    ownerId: Id,
    sessionId: Id,
  ): Promise<IntakeApprovalLockHandle | null> {
    const key = `${ownerId}:${sessionId}`;
    if (held.has(key)) return null;
    held.add(key);
    let released = false;
    const controller = new AbortController();
    return {
      signal: controller.signal,
      release: async () => {
        if (released) return;
        released = true;
        held.delete(key);
      },
    };
  }
}
