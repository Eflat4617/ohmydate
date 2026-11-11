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
import { IntakeApprovalOwnershipLostError } from '../application/intake/intake-error.js';
import { ensurePlannerTaskIdentity } from './planner-task-identity.js';

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
    ...(row.holder_token === null ? {} : { holderToken: row.holder_token }),
    ...(row.last_call_started_at === null
      ? {}
      : { lastCallStartedAt: row.last_call_started_at.toISOString() as never }),
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
    readonly holderToken: string;
    readonly providerMaxCallMs: number;
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

      // ADR-020 §7: if an unreleased previous holder may still have a provider
      // call in flight, the successor must wait one full call budget before
      // resolving unknown steps. The lock itself is already held here.
      if (
        existing !== undefined &&
        existing.state === 'in_progress' &&
        existing.holder_token !== null &&
        existing.holder_token !== input.holderToken &&
        existing.last_call_started_at !== null
      ) {
        const elapsedMs = now.getTime() - existing.last_call_started_at.getTime();
        if (elapsedMs < input.providerMaxCallMs) {
          return {
            kind: 'in_progress',
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((input.providerMaxCallMs - elapsedMs) / 1000),
            ),
          };
        }
      }

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
            holder_token: input.holderToken,
            last_call_started_at: null,
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
            holder_token: input.holderToken,
            last_call_started_at: null,
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
    holderToken: string,
  ): Promise<void> {
    // The holder predicate is part of the same UPDATE as the write, so a
    // successor's begin() cannot commit between an ownership check and the
    // step mutation (M2-03cR2 LOW).
    const result = await this.#db
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
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('intake_approval')
            .select('intake_approval.session_id')
            .whereRef(
              'intake_approval.session_id',
              '=',
              'intake_approval_step.session_id',
            )
            .where('intake_approval.owner_id', '=', ownerId)
            .where('intake_approval.state', '=', 'in_progress')
            .where('intake_approval.holder_token', '=', holderToken),
        ),
      )
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw new IntakeApprovalOwnershipLostError();
    }
  }

  /**
   * ADR-020 §7: called before every provider call. The timestamp bounds how
   * long a successor must wait before treating this holder as gone.
   */
  async touch(ownerId: Id, sessionId: Id, holderToken: string): Promise<void> {
    const now = new Date(this.#clock.now());
    const result = await this.#db
      .updateTable('intake_approval')
      .set({ last_call_started_at: now, updated_at: now })
      .where('session_id', '=', sessionId)
      .where('owner_id', '=', ownerId)
      .where('state', '=', 'in_progress')
      .where('holder_token', '=', holderToken)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw new IntakeApprovalOwnershipLostError();
    }
  }

  async fail(ownerId: Id, sessionId: Id, holderToken: string): Promise<void> {
    const now = new Date(this.#clock.now());
    const result = await this.#db
      .updateTable('intake_approval')
      .set({ state: 'failed', holder_token: null, updated_at: now })
      .where('session_id', '=', sessionId)
      .where('owner_id', '=', ownerId)
      .where('state', '=', 'in_progress')
      .where('holder_token', '=', holderToken)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw new IntakeApprovalOwnershipLostError();
    }
  }

  async complete(input: {
    readonly ownerId: Id;
    readonly sessionId: Id;
    readonly expectedSessionVersion: number;
    readonly outboxId: Id;
    readonly holderToken: string;
    readonly identityTasks: readonly import('@ohmydate/domain').Task[];
    readonly estimates: readonly {
      readonly id: Id;
      readonly taskId: Id;
      readonly p50Min: number;
      readonly p90Min: number;
      readonly method: 'template' | 'llm' | 'personal';
      readonly confidence: number;
    }[];
  }): Promise<IntakeSessionRecord> {
    return this.#db.transaction().execute(async (trx) => {
      const approval = await trx
        .selectFrom('intake_approval')
        .select(['state', 'holder_token'])
        .where('session_id', '=', input.sessionId)
        .where('owner_id', '=', input.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (
        approval === undefined ||
        approval.state !== 'in_progress' ||
        approval.holder_token !== input.holderToken
      ) {
        throw new IntakeApprovalOwnershipLostError();
      }
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
      await ensurePlannerTaskIdentity(trx, input.ownerId, input.identityTasks);
      for (const estimate of input.estimates) {
        await trx
          .insertInto('estimate')
          .values({
            id: estimate.id,
            owner_id: input.ownerId,
            task_id: estimate.taskId,
            p50_min: estimate.p50Min,
            p90_min: estimate.p90Min,
            method: estimate.method,
            confidence: estimate.confidence,
            is_current: true,
          })
          .execute();
      }
      await trx
        .updateTable('intake_approval')
        .set({ state: 'completed', holder_token: null, updated_at: new Date(this.#clock.now()) })
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
