import type { Id, Task } from '@ohmydate/domain';
import type { Transaction } from 'kysely';
import type { Database } from '../db/types.js';

type Trx = Transaction<Database>;

/**
 * Mirror the provider-authoritative task into the planner tables required by
 * the planning FKs (estimate.task_id, schedule_block.task_id).
 *
 * Provider data stays the source of truth; these rows are identity/cache only.
 * Inserts are idempotent per id. A cross-owner id collision is not repaired
 * here: the composite (id, owner_id) FK on task/schedule_block fails, which
 * the caller maps to a 409 rather than overwriting another owner's row.
 */
export async function ensurePlannerTaskIdentity(
  trx: Trx,
  ownerId: Id,
  tasks: readonly Task[],
): Promise<void> {
  const projects = new Map<string, Task>();
  for (const task of tasks) {
    if (!projects.has(task.projectId)) projects.set(task.projectId, task);
  }
  for (const [projectId, task] of projects) {
    await trx
      .insertInto('project')
      .values({
        id: projectId,
        owner_id: ownerId,
        title: task.title,
        kind: 'normal',
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
  }
  for (const task of tasks) {
    await trx
      .insertInto('task')
      .values({
        id: task.id,
        owner_id: ownerId,
        project_id: task.projectId,
        title_cache: task.title,
        status_cache: task.status,
        due_at: task.dueAt === undefined ? null : new Date(task.dueAt),
        splittable: task.splittable,
        min_session_min: task.session?.minMinutes ?? null,
        max_session_min: task.session?.maxMinutes ?? null,
        priority: task.priority,
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
  }
}
