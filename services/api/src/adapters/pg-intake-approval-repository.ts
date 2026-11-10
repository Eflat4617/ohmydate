import type { Clock, Id } from '@ohmydate/domain';
import { VersionConflictError } from '@ohmydate/domain';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  Database,
  IntakeApprovalStepTable,
  IntakeApprovalTable,
  JsonValue,
} from '../db/types.js';
import { jsonb } from '../db/types.js';
import { draftKind } from '../application/intake/ports.js';
import type {
  ApprovalStepRecord,
  BeginApprovalResult,
  IntakeApprovalRecord,
  IntakeApprovalStore,
  IntakeSessionRecord,
} from '../application/intake/ports.js';
import { mapSession } from './pg-intake-session-repository.js';

type ApprovalRow = Selectable<IntakeApprovalTable>;
type StepRow = Selectable<IntakeApprovalStepTable>;

function mapStep(row: StepRow): ApprovalStepRecord {
  return {
    stepKey: row.step_key,
    plannedTaskId: row.planned_task_id as Id,
    state: row.state as ApprovalStepRecord['state'],
    ...(row.task_id === null ? {} : { taskId: row.task_id as Id }),
    ...(row.dependency_state === null ? {} : { dependencyState: row.dependency_state }),
  };
}

function mapApproval(row: ApprovalRow, steps: readonly StepRow[]): IntakeApprovalRecord {
  return {
    sessionId: row.session_id as Id,
    ownerId: row.owner_id as Id,
    draftVersion: row.draft_version,
    state: row.state as IntakeApprovalRecord['state'],
    leaseExpiresAt: row.lease_expires_at.toISOString() as never,
    idempotencyKey: row.idempotency_key,
    steps: steps.map(mapStep),
  };
}

export class PgIntakeApprovalRepository implements IntakeApprovalStore {
  readonly #db: Kysely<Database>;
  readonly #clock: Clock;

  constructor(db: Kysely<Database>, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  async begin(input: {
    readonly ownerId: Id;
    readonly sessionId: Id;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly leaseMs: number;
    readonly steps: readonly { readonly stepKey: string; readonly plannedTaskId: Id }[];
  }): Promise<BeginApprovalResult> {
    return this.#db.transaction().execute(async (trx) => {
      const session = await trx
        .selectFrom('intake_session')
        .selectAll()
        .where('id', '=', input.sessionId)
        .where('owner_id', '=', input.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) return { kind: 'not_found' };

      const now = new Date(this.#clock.now());
      const existing = await trx
        .selectFrom('intake_approval')
        .selectAll()
        .where('session_id', '=', input.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (existing !== undefined && existing.state === 'completed') {
        return { kind: 'completed', session: mapSession(session) };
      }

      // ADR-020: the caller holds the session-level advisory lock, so any
      // in-progress row here is a crashed/previous attempt for this same
      // session and may be resumed. Never take over based on a lease clock.
      if (session.version !== input.expectedVersion) {
        return { kind: 'version_conflict', actualVersion: session.version };
      }
      if (session.state !== 'decomposition') {
        return { kind: 'illegal_state', state: session.state as never };
      }

      const lease = new Date(now.getTime() + input.leaseMs);
      if (existing === undefined) {
        await trx
          .insertInto('intake_approval')
          .values({
            session_id: input.sessionId,
            owner_id: input.ownerId,
            draft_version: session.version,
            state: 'in_progress',
            lease_expires_at: lease,
            idempotency_key: input.idempotencyKey,
          })
          .execute();
      } else {
        await trx
          .updateTable('intake_approval')
          .set({
            draft_version: session.version,
            state: 'in_progress',
            lease_expires_at: lease,
            idempotency_key: input.idempotencyKey,
            updated_at: now,
          })
          .where('session_id', '=', input.sessionId)
          .execute();
        if (existing.draft_version !== session.version) {
          await trx
            .deleteFrom('intake_approval_step')
            .where('session_id', '=', input.sessionId)
            .execute();
        }
      }

      const stepRows = await trx
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', input.sessionId)
        .execute();
      const present = new Set(stepRows.map((step) => step.step_key));
      const missing = input.steps.filter((step) => !present.has(step.stepKey));
      if (missing.length > 0) {
        await trx
          .insertInto('intake_approval_step')
          .values(
            missing.map((step) => ({
              session_id: input.sessionId,
              step_key: step.stepKey,
              planned_task_id: step.plannedTaskId,
              state: 'pending',
            })),
          )
          .onConflict((conflict) => conflict.columns(['session_id', 'step_key']).doNothing())
          .execute();
      }
      const steps = await trx
        .selectFrom('intake_approval_step')
        .selectAll()
        .where('session_id', '=', input.sessionId)
        .execute();
      const approval = await trx
        .selectFrom('intake_approval')
        .selectAll()
        .where('session_id', '=', input.sessionId)
        .executeTakeFirstOrThrow();
      return { kind: 'started', approval: mapApproval(approval, steps) };
    });
  }

  async load(ownerId: Id, sessionId: Id): Promise<IntakeApprovalRecord | null> {
    const approval = await this.#db
      .selectFrom('intake_approval')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (approval === undefined) return null;
    const steps = await this.#db
      .selectFrom('intake_approval_step')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('step_key', 'asc')
      .execute();
    return mapApproval(approval, steps);
  }

  async markStep(
    ownerId: Id,
    sessionId: Id,
    stepKey: string,
    patch: {
      readonly state: 'pending' | 'created' | 'unknown';
      readonly taskId?: Id;
      readonly dependencyState?: string;
    },
  ): Promise<void> {
    const approval = await this.#db
      .selectFrom('intake_approval')
      .select('session_id')
      .where('session_id', '=', sessionId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (approval === undefined) return;
    await this.#db
      .updateTable('intake_approval_step')
      .set({
        state: patch.state,
        ...(patch.taskId === undefined ? {} : { task_id: patch.taskId }),
        ...(patch.dependencyState === undefined
          ? {}
          : { dependency_state: patch.dependencyState }),
      })
      .where('session_id', '=', sessionId)
      .where('step_key', '=', stepKey)
      .execute();
  }

  async fail(ownerId: Id, sessionId: Id): Promise<void> {
    await this.#db
      .updateTable('intake_approval')
      .set({ state: 'failed', updated_at: new Date(this.#clock.now()) })
      .where('session_id', '=', sessionId)
      .where('owner_id', '=', ownerId)
      .execute();
  }

  async complete(input: {
    readonly ownerId: Id;
    readonly sessionId: Id;
    readonly expectedSessionVersion: number;
    readonly outboxId: Id;
  }): Promise<IntakeSessionRecord> {
    return this.#db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('intake_session')
        .set({
          state: 'feasibility_check',
          updated_at: new Date(this.#clock.now()),
          version: sql<number>`version + 1`,
        })
        .where('id', '=', input.sessionId)
        .where('owner_id', '=', input.ownerId)
        .where('version', '=', input.expectedSessionVersion)
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) {
        throw new VersionConflictError(
          input.expectedSessionVersion as never,
          input.expectedSessionVersion as never,
        );
      }
      await trx
        .updateTable('intake_approval')
        .set({ state: 'completed', updated_at: new Date(this.#clock.now()) })
        .where('session_id', '=', input.sessionId)
        .where('owner_id', '=', input.ownerId)
        .execute();
      const proposal = await trx
        .selectFrom('agent_proposal')
        .select('id')
        .where('owner_id', '=', input.ownerId)
        .where('kind', '=', draftKind(input.sessionId))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (proposal !== undefined) {
        await trx
          .updateTable('agent_proposal')
          .set({
            decision: 'approved',
            updated_at: new Date(this.#clock.now()),
            version: sql<number>`version + 1`,
          })
          .where('id', '=', proposal.id)
          .where('owner_id', '=', input.ownerId)
          .execute();
      }
      await trx
        .insertInto('outbox_event')
        .values({
          id: input.outboxId,
          owner_id: input.ownerId,
          topic: 'intake.draft_approved',
          payload: jsonb({
            sessionId: input.sessionId,
            version: updated.version,
          } as unknown as JsonValue),
        })
        .execute();
      return mapSession(updated);
    });
  }
}
