import {
  ESTIMATOR_VERSION,
  NotFoundError,
  VersionConflictError,
  instantToEpochMs,
  type EstimateMethod,
  type EstimationStepKind,
  type Id,
  type IdGenerator,
  type Instant,
} from '@ohmydate/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { jsonb, type Database, type JsonValue } from '../db/types.js';
import {
  MAX_LEARNING_FEEDBACK_ROWS,
  type EstimatedTask,
  type EstimationMutation,
  type EstimationRefreshPlan,
  type EstimationSnapshot,
  type EstimationStore,
  type FeedbackRow,
  type StoredEstimate,
  type TaskEstimationContext,
} from '../application/estimation-service.js';

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

/** Marks template.stats written by the estimator (05 §10 learned values). */
const LEARNED_STATS_SOURCE = ESTIMATOR_VERSION;
const STEP_KINDS: ReadonlySet<string> = new Set(['prep', 'work', 'review', 'buffer']);
const METHODS: ReadonlySet<string> = new Set(['prior', 'template', 'personal', 'llm']);

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stepKinds(payload: unknown): Map<string, EstimationStepKind> {
  const parsed = typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload;
  const kinds = new Map<string, EstimationStepKind>();
  if (!isRecord(parsed) || !isRecord(parsed['draft'])) return kinds;
  const steps = parsed['draft']['steps'];
  if (!Array.isArray(steps)) return kinds;
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const key = step['key'];
    const kind = step['kind'];
    if (typeof key === 'string' && typeof kind === 'string' && STEP_KINDS.has(kind)) {
      kinds.set(key, kind as EstimationStepKind);
    }
  }
  return kinds;
}

function mapEstimate(row: {
  id: string;
  task_id: string;
  p50_min: number;
  p90_min: number;
  method: string;
  confidence: number;
}): StoredEstimate {
  return {
    id: row.id as Id,
    taskId: row.task_id as Id,
    p50Min: row.p50_min,
    p90Min: row.p90_min,
    method: (METHODS.has(row.method) ? row.method : 'prior') as EstimateMethod,
    confidence: Number(row.confidence),
  };
}

/**
 * PostgreSQL estimation learning store (05 §6/§10). Estimate history is kept:
 * a refresh marks the current row `is_current = false` and inserts the new
 * current row plus its evidence rows (summaries are numbers only).
 */
export class PgEstimationStore implements EstimationStore {
  readonly #db: Db;
  readonly #ids: IdGenerator;

  constructor(options: { db: Db; ids: IdGenerator }) {
    this.#db = options.db;
    this.#ids = options.ids;
  }

  async snapshot(ownerId: Id): Promise<EstimationSnapshot> {
    return this.#snapshot(this.#db, ownerId);
  }

  async refresh(
    ownerId: Id,
    now: Instant,
    mutation: EstimationMutation | undefined,
    compute: (snapshot: EstimationSnapshot) => EstimationRefreshPlan,
  ): Promise<EstimationSnapshot> {
    return this.#db.transaction().execute(async (trx) => {
      const nowDate = new Date(instantToEpochMs(now));
      await sql`select pg_advisory_xact_lock(hashtextextended(${`ohmydate.estimation:${ownerId}`}, 0))`.execute(
        trx,
      );
      if (mutation?.kind === 'exclude') {
        await this.#setExcluded(trx, ownerId, mutation, nowDate);
      } else if (mutation?.kind === 'reset') {
        await this.#reset(trx, ownerId, mutation.templateId);
      }
      const before = await this.#snapshot(
        trx,
        ownerId,
        mutation?.kind === 'exclude' ? mutation.feedbackId : undefined,
      );
      const plan = compute(before);
      for (const update of plan.qualities) {
        // Automatic reclassification is not an owner edit: the row version
        // (the PATCH If-Match) is left unchanged.
        await trx
          .updateTable('estimation_feedback')
          .set({ quality: update.quality, updated_at: nowDate })
          .where('id', '=', update.id)
          .where('owner_id', '=', ownerId)
          .execute();
      }
      for (const estimate of plan.estimates) {
        await trx
          .updateTable('estimate')
          .set({ is_current: false, updated_at: nowDate })
          .where('id', '=', estimate.currentId)
          .where('owner_id', '=', ownerId)
          .execute();
        const id = this.#ids.next() as Id;
        await trx
          .insertInto('estimate')
          .values({
            id,
            owner_id: ownerId,
            task_id: estimate.taskId,
            p50_min: estimate.result.p50Min,
            p90_min: estimate.result.p90Min,
            method: estimate.result.method,
            confidence: estimate.result.confidence,
            is_current: true,
            created_at: nowDate,
            updated_at: nowDate,
          })
          .execute();
        for (const evidence of estimate.result.evidence) {
          await trx
            .insertInto('estimate_evidence')
            .values({
              id: this.#ids.next(),
              owner_id: ownerId,
              estimate_id: id,
              kind: evidence.kind,
              ref: evidence.ref ?? null,
              summary: evidence.summary,
              created_at: nowDate,
              updated_at: nowDate,
            })
            .execute();
        }
      }
      for (const entry of plan.templateStats) {
        if (entry.stats === null) {
          // No personal samples (left): clear only stats this estimator wrote;
          // seeded/system stats are template input, not learned values.
          await trx
            .updateTable('task_template')
            .set({ stats: jsonb({}), updated_at: nowDate })
            .where('id', '=', entry.templateId)
            .where('owner_id', '=', ownerId)
            .where(sql<boolean>`stats->>'source' = ${LEARNED_STATS_SOURCE}`)
            .execute();
          continue;
        }
        const stats = { ...entry.stats, source: LEARNED_STATS_SOURCE } as unknown as JsonValue;
        await trx
          .updateTable('task_template')
          .set({ stats: jsonb(stats), updated_at: nowDate })
          .where('id', '=', entry.templateId)
          .where('owner_id', '=', ownerId)
          .where(sql<boolean>`stats is distinct from ${JSON.stringify(stats)}::jsonb`)
          .execute();
      }
      return this.#snapshot(trx, ownerId);
    });
  }

  async baseP50(ownerId: Id, taskId: Id): Promise<number | null> {
    const row = await this.#db
      .selectFrom('estimate')
      .select('p50_min')
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .executeTakeFirst();
    return row?.p50_min ?? null;
  }

  async templateExists(ownerId: Id, templateId: Id): Promise<boolean> {
    const row = await this.#db
      .selectFrom('task_template')
      .select('id')
      .where('id', '=', templateId)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  async #setExcluded(
    trx: Trx,
    ownerId: Id,
    mutation: Extract<EstimationMutation, { kind: 'exclude' }>,
    now: Date,
  ): Promise<void> {
    const current = await trx
      .selectFrom('estimation_feedback')
      .select(['id', 'version'])
      .where('id', '=', mutation.feedbackId)
      .where('owner_id', '=', ownerId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw new NotFoundError('estimation feedback', mutation.feedbackId);
    if (current.version !== mutation.expectedVersion) {
      throw new VersionConflictError(
        mutation.expectedVersion as never,
        current.version as never,
      );
    }
    await trx
      .updateTable('estimation_feedback')
      .set({
        excluded: mutation.excluded,
        version: mutation.expectedVersion + 1,
        updated_at: now,
      })
      .where('id', '=', mutation.feedbackId)
      .where('owner_id', '=', ownerId)
      .execute();
  }

  /** Forget learning samples (all, or those of one template) and its stats. */
  async #reset(trx: Trx, ownerId: Id, templateId: Id | undefined): Promise<void> {
    if (templateId === undefined) {
      await trx.deleteFrom('estimation_feedback').where('owner_id', '=', ownerId).execute();
      await trx
        .updateTable('task_template')
        .set({ stats: jsonb({}) })
        .where('owner_id', '=', ownerId)
        .where(sql<boolean>`stats->>'source' = ${LEARNED_STATS_SOURCE}`)
        .execute();
      return;
    }
    const feedback = await trx
      .selectFrom('estimation_feedback')
      .select(['id', 'task_id'])
      .where('owner_id', '=', ownerId)
      .execute();
    const contexts = await this.#contexts(
      trx,
      ownerId,
      [...new Set(feedback.map((row) => row.task_id as Id))],
    );
    const ids = feedback
      .filter((row) => contexts.get(row.task_id)?.templateId === templateId)
      .map((row) => row.id);
    if (ids.length > 0) {
      await trx
        .deleteFrom('estimation_feedback')
        .where('owner_id', '=', ownerId)
        .where('id', 'in', ids)
        .execute();
    }
    await trx
      .updateTable('task_template')
      .set({ stats: jsonb({}) })
      .where('owner_id', '=', ownerId)
      .where('id', '=', templateId)
      .where(sql<boolean>`stats->>'source' = ${LEARNED_STATS_SOURCE}`)
      .execute();
  }

  async #snapshot(
    db: Db | Trx,
    ownerId: Id,
    includeFeedbackId?: Id,
  ): Promise<EstimationSnapshot> {
    // FU-64: bound the classification window instead of scanning all of the
    // owner's history. Newest-first LIMIT is served by
    // estimation_feedback_owner_created_idx; the rows are re-sorted ascending
    // so the classifier's "latest per task" rule sees the same order.
    const windowRows = await db
      .selectFrom('estimation_feedback')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(MAX_LEARNING_FEEDBACK_ROWS)
      .execute();
    const feedbackRows = [...windowRows].reverse();
    const seen = new Set(feedbackRows.map((row) => row.id));
    let appendedTarget = false;
    if (includeFeedbackId !== undefined && !seen.has(includeFeedbackId)) {
      const target = await db
        .selectFrom('estimation_feedback')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .where('id', '=', includeFeedbackId)
        .executeTakeFirst();
      if (target !== undefined) {
        feedbackRows.push(target);
        appendedTarget = true;
      }
    }
    if (appendedTarget) {
      feedbackRows.sort((a, b) => {
        const aAt = toInstant(a.created_at);
        const bAt = toInstant(b.created_at);
        return aAt < bAt ? -1 : aAt > bAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }
    const feedback: FeedbackRow[] = feedbackRows.map((row) => ({
      id: row.id as Id,
      taskId: row.task_id as Id,
      estimatedP50: row.estimated_p50,
      actualFocusMin: row.actual_focus_min,
      quality: row.quality === 'outlier' ? 'outlier' : row.quality === 'excluded' ? 'excluded' : 'ok',
      excluded: row.excluded,
      createdAt: toInstant(row.created_at),
      version: row.version,
    }));

    // Open tasks (planner cache) that have a current estimate.
    const currentRows = await db
      .selectFrom('estimate')
      .innerJoin('task', (join) =>
        join.onRef('task.id', '=', 'estimate.task_id').onRef('task.owner_id', '=', 'estimate.owner_id'),
      )
      .select([
        'estimate.id',
        'estimate.task_id',
        'estimate.p50_min',
        'estimate.p90_min',
        'estimate.method',
        'estimate.confidence',
      ])
      .where('estimate.owner_id', '=', ownerId)
      .where('estimate.is_current', '=', true)
      .where('task.deleted_at', 'is', null)
      .where('task.status_cache', '<>', 'done')
      .orderBy('estimate.task_id', 'asc')
      .execute();
    const openIds = currentRows.map((row) => row.task_id as Id);
    const bases = new Map<string, StoredEstimate>();
    if (openIds.length > 0) {
      const history = await db
        .selectFrom('estimate')
        .select(['id', 'task_id', 'p50_min', 'p90_min', 'method', 'confidence'])
        .where('owner_id', '=', ownerId)
        .where('task_id', 'in', openIds)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute();
      for (const row of history) {
        if (!bases.has(row.task_id)) bases.set(row.task_id, mapEstimate(row));
      }
    }
    const tasks: EstimatedTask[] = currentRows.map((row) => {
      const current = mapEstimate(row);
      return { taskId: current.taskId, base: bases.get(current.taskId) ?? current, current };
    });

    const contextIds = [...new Set([...feedback.map((row) => row.taskId), ...openIds])];
    const contexts = await this.#contexts(db, ownerId, contextIds);
    const templates = await db
      .selectFrom('task_template')
      .select('id')
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .execute();
    return {
      feedback,
      contexts,
      tasks,
      templateIds: new Set(templates.map((row) => row.id)),
    };
  }

  /**
   * Task -> (template, step kind) through the intake approval ledger: the
   * approved step names the task, its session names the confirmed template,
   * and the session's latest decomposition draft names the step kind.
   */
  async #contexts(
    db: Db | Trx,
    ownerId: Id,
    taskIds: readonly Id[],
  ): Promise<Map<string, TaskEstimationContext>> {
    const contexts = new Map<string, TaskEstimationContext>();
    if (taskIds.length === 0) return contexts;
    const steps = await db
      .selectFrom('intake_approval_step')
      .innerJoin('intake_session', 'intake_session.id', 'intake_approval_step.session_id')
      .select([
        'intake_approval_step.task_id',
        'intake_approval_step.step_key',
        'intake_approval_step.session_id',
        'intake_session.template_id',
      ])
      .where('intake_session.owner_id', '=', ownerId)
      .where('intake_approval_step.state', '=', 'created')
      .where('intake_approval_step.task_id', 'in', taskIds)
      .execute();
    const kindsBySession = new Map<string, Map<string, EstimationStepKind>>();
    for (const sessionId of [...new Set(steps.map((row) => row.session_id))].sort()) {
      const draft = await db
        .selectFrom('agent_proposal')
        .select('payload')
        .where('owner_id', '=', ownerId)
        .where('kind', '=', `intake.decomposition:${sessionId}`)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      kindsBySession.set(sessionId, stepKinds(draft?.payload));
    }
    for (const row of steps) {
      if (row.task_id === null) continue;
      const kind = kindsBySession.get(row.session_id)?.get(row.step_key);
      contexts.set(row.task_id, {
        ...(row.template_id === null ? {} : { templateId: row.template_id as Id }),
        ...(kind === undefined ? {} : { kind }),
      });
    }
    return contexts;
  }
}
