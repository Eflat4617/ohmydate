import type { Id } from '@ohmydate/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { IntakeError } from '../application/intake/intake-error.js';
import type { Database } from '../db/types.js';

/**
 * ADR-020 §1: one advisory lock key per intake session. The same key is used by
 * the session-level lock held for an approval and by the transaction-scoped
 * probe every other session mutation makes.
 */
export function intakeSessionLockKey(sessionId: Id): string {
  return `ohmydate.intake.approve:${sessionId}`;
}

/** SQL expression shared by the session lock and the transaction-scoped probe. */
export function intakeSessionLockExpression(sessionId: Id): string {
  return `hashtextextended(${quoteLiteral(intakeSessionLockKey(sessionId))}, 0)`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * ADR-020 §2: mutations run this inside their CAS transaction. A live approval
 * holds the session-level lock on another connection, so the probe fails and
 * the mutation reports 409 `approval_in_progress`.
 */
export async function tryIntakeSessionXactLock(
  executor: Kysely<Database> | Transaction<Database>,
  sessionId: Id,
): Promise<boolean> {
  const result = await sql<{ locked: boolean }>`
    SELECT pg_try_advisory_xact_lock(${sql.raw(intakeSessionLockExpression(sessionId))}) AS locked
  `.execute(executor);
  return result.rows[0]?.locked === true;
}

export async function requireIntakeSessionXactLock(
  executor: Kysely<Database> | Transaction<Database>,
  sessionId: Id,
): Promise<void> {
  if (!(await tryIntakeSessionXactLock(executor, sessionId))) {
    throw new IntakeError(
      409,
      'approval_in_progress',
      'Approval in progress',
      'the intake draft is already being approved',
    );
  }
}
