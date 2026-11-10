import type { Id, SessionWindow, TaskPriority, TaskStatus } from '@ohmydate/domain';
import type { PlannerFieldStore, PlannerTaskFields } from '@ohmydate/provider-vikunja';
import type { Kysely } from 'kysely';
import { jsonb, type Database, type JsonValue } from '../../db/types.js';

function toJson(fields: PlannerTaskFields): JsonValue {
  return {
    splittable: fields.splittable,
    priority: fields.priority as number,
    status: fields.status,
    dependsOn: [...fields.dependsOn],
    ...(fields.session === undefined
      ? {}
      : { session: { minMinutes: fields.session.minMinutes, maxMinutes: fields.session.maxMinutes } }),
  };
}

function fromJson(value: JsonValue): PlannerTaskFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('vikunja_planner_fields.fields is not a JSON object');
  }
  const splittable = value['splittable'];
  const priority = value['priority'];
  const status = value['status'];
  const dependsOn = value['dependsOn'];
  const session = value['session'];
  if (typeof splittable !== 'boolean') {
    throw new Error('vikunja_planner_fields.fields.splittable is invalid');
  }
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 4) {
    throw new Error('vikunja_planner_fields.fields.priority is invalid');
  }
  if (status !== 'todo' && status !== 'in_progress' && status !== 'done') {
    throw new Error('vikunja_planner_fields.fields.status is invalid');
  }
  if (!Array.isArray(dependsOn) || dependsOn.some((entry) => typeof entry !== 'string')) {
    throw new Error('vikunja_planner_fields.fields.dependsOn is invalid');
  }
  let parsedSession: SessionWindow | undefined;
  if (session !== undefined && session !== null) {
    if (typeof session !== 'object' || Array.isArray(session)) {
      throw new Error('vikunja_planner_fields.fields.session is invalid');
    }
    const minMinutes = session['minMinutes'];
    const maxMinutes = session['maxMinutes'];
    if (typeof minMinutes !== 'number' || typeof maxMinutes !== 'number') {
      throw new Error('vikunja_planner_fields.fields.session is invalid');
    }
    parsedSession = { minMinutes, maxMinutes };
  }
  return {
    splittable,
    priority: priority as TaskPriority,
    status: status as TaskStatus,
    dependsOn: dependsOn as unknown as readonly Id[],
    ...(parsedSession === undefined ? {} : { session: parsedSession }),
  };
}

/**
 * PostgreSQL-backed `PlannerFieldStore` (ADR-004: planner-only fields).
 *
 * `owner_id` is denormalized from `vikunja_mapping` on write; a task must be
 * mapped before its planner fields exist, which the adapter already guarantees
 * (mapping `put` precedes `putTask`). A missing mapping is a programming error
 * and surfaces as a rejected write rather than an unowned row.
 */
export class PgPlannerFieldStore implements PlannerFieldStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getTask(entityId: Id): Promise<PlannerTaskFields | null> {
    const row = await this.#db
      .selectFrom('vikunja_planner_fields')
      .select('fields')
      .where('task_id', '=', entityId)
      .executeTakeFirst();
    return row === undefined ? null : fromJson(row.fields);
  }

  async putTask(entityId: Id, fields: PlannerTaskFields): Promise<void> {
    const mapping = await this.#db
      .selectFrom('vikunja_mapping')
      .select('owner_id')
      .where('entity_type', '=', 'task')
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    if (mapping === undefined) {
      throw new Error(`cannot store planner fields for unmapped task ${entityId}`);
    }
    const values = {
      task_id: entityId,
      owner_id: mapping.owner_id,
      fields: jsonb(toJson(fields)),
    };
    await this.#db
      .insertInto('vikunja_planner_fields')
      .values(values)
      .onConflict((conflict) =>
        conflict.column('task_id').doUpdateSet({
          owner_id: values.owner_id,
          fields: values.fields,
          updated_at: new Date(),
        }),
      )
      .execute();
  }
}
