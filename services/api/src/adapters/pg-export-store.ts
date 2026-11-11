import type { Export } from '@ohmydate/contracts';
import {
  instantToEpochMs,
  type Id,
  type Instant,
} from '@ohmydate/domain';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type {
  ExportArtifact,
  ExportPayloadBuilder,
  ExportRecord,
  ExportStore,
} from '../application/export-service.js';

type Db = Kysely<Database>;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function toDate(value: string): Date {
  return new Date(instantToEpochMs(value as Instant));
}

export class PgExportStore implements ExportStore {
  readonly #db: Db;

  constructor(options: { db: Db }) {
    this.#db = options.db;
  }

  async createQueued(ownerId: Id, id: Id, now: Instant): Promise<void> {
    await this.#db
      .insertInto('export_job')
      .values({
        id,
        owner_id: ownerId,
        state: 'queued',
        requested_at: toDate(now),
        created_at: toDate(now),
        updated_at: toDate(now),
      })
      .execute();
  }

  async markRunning(ownerId: Id, id: Id, now: Instant): Promise<void> {
    await this.#db
      .updateTable('export_job')
      .set({ state: 'running', started_at: toDate(now), updated_at: toDate(now) })
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .execute();
  }

  async markFailed(ownerId: Id, id: Id, code: string, now: Instant): Promise<void> {
    await this.#db
      .updateTable('export_job')
      .set({
        state: 'failed',
        failure_code: code,
        updated_at: toDate(now),
      })
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .execute();
  }

  async saveReady(
    ownerId: Id,
    id: Id,
    content: Buffer,
    now: Instant,
    expiresAt: Instant,
  ): Promise<ExportRecord> {
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('job')
        .values({
          id,
          owner_id: ownerId,
          kind: 'export_artifact',
          run_at: toDate(now),
          unique_key: content.toString('utf8'),
          status: 'completed',
          created_at: toDate(now),
          updated_at: toDate(now),
        })
        .onConflict((oc) => oc.column('id').doUpdateSet({ unique_key: content.toString('utf8'), updated_at: toDate(now) }))
        .execute();
    });
    const row = await this.#db
      .updateTable('export_job')
      .set({
        state: 'ready',
        artifact_key: `export:${id}`,
        size_bytes: content.byteLength,
        expires_at: toDate(expiresAt),
        completed_at: toDate(now),
        updated_at: toDate(now),
      })
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.#map(row);
  }

  async get(ownerId: Id, id: Id): Promise<ExportRecord | null> {
    const row = await this.#db
      .selectFrom('export_job')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row === undefined ? null : this.#map(row);
  }

  async readArtifact(ownerId: Id, id: Id): Promise<ExportArtifact | null> {
    const row = await this.#db
      .selectFrom('export_job')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('state', '=', 'ready')
      .executeTakeFirst();
    if (row === undefined) return null;
    const artifact = await this.#db
      .selectFrom('job')
      .select('unique_key')
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('kind', '=', 'export_artifact')
      .executeTakeFirst();
    if (artifact === undefined) return null;
    return {
      record: this.#map(row),
      content: Buffer.from(artifact.unique_key, 'utf8'),
    };
  }

  #map(row: {
    id: string;
    owner_id: string;
    state: string;
    created_at: Date | string;
    expires_at: Date | string | null;
    size_bytes: number | null;
    failure_code: string | null;
  }): ExportRecord {
    return {
      id: row.id as Id,
      ownerId: row.owner_id as Id,
      state: row.state as Export['state'],
      createdAt: toInstant(row.created_at),
      ...(row.expires_at === null ? {} : { expiresAt: toInstant(row.expires_at) }),
      ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
      ...(row.failure_code === null ? {} : { failureReason: row.failure_code }),
    };
  }
}

/** Builds the JSON export artifact from owner-scoped tables only. */
export class PgExportPayloadBuilder implements ExportPayloadBuilder {
  readonly #db: Db;

  constructor(options: { db: Db }) {
    this.#db = options.db;
  }

  async build(ownerId: Id, now: Instant): Promise<Buffer> {
    const tasks = await this.#db
      .selectFrom('task')
      .select([
        'id',
        'project_id',
        'title_cache',
        'status_cache',
        'due_at',
        'splittable',
        'min_session_min',
        'max_session_min',
        'priority',
        'created_at',
        'updated_at',
        'deleted_at',
        'version',
      ])
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'asc')
      .execute();
    const projects = await this.#db
      .selectFrom('project')
      .select(['id', 'title', 'kind', 'archived', 'version', 'created_at', 'updated_at'])
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'asc')
      .execute();
    const plans = await this.#db
      .selectFrom('plan')
      .select([
        'id',
        'scope',
        'status',
        'current_version_id',
        'availability_version',
        'horizon_start',
        'horizon_end',
        'time_zone',
        'version',
        'created_at',
        'updated_at',
      ])
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute();
    const planIds = plans.map((plan) => plan.id);
    const versions = planIds.length === 0
      ? []
      : await this.#db
          .selectFrom('plan_version')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('plan_id', 'in', planIds)
          .orderBy('plan_id', 'asc')
          .orderBy('seq', 'asc')
          .execute();
    const versionIds = versions.map((version) => version.id);
    const blocks = versionIds.length === 0
      ? []
      : await this.#db
          .selectFrom('schedule_block')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('plan_version_id', 'in', versionIds)
          .orderBy('start_at', 'asc')
          .execute();
    const sessions = await this.#db
      .selectFrom('work_session')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('started_at', 'asc')
      .execute();
    const reviews = await this.#db
      .selectFrom('task_completion_review')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'asc')
      .execute();
    const feedback = await this.#db
      .selectFrom('estimation_feedback')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'asc')
      .execute();

    const payload = {
      format: 'ohmydate-export',
      formatVersion: 1,
      exportedAt: now,
      ownerId,
      tasks: tasks.map((task) => ({
        id: task.id,
        projectId: task.project_id,
        title: task.title_cache,
        status: task.status_cache,
        dueAt: task.due_at === null ? null : toInstant(task.due_at),
        splittable: task.splittable,
        minSessionMin: task.min_session_min,
        maxSessionMin: task.max_session_min,
        priority: task.priority,
        createdAt: toInstant(task.created_at),
        updatedAt: toInstant(task.updated_at),
        deletedAt: task.deleted_at === null ? null : toInstant(task.deleted_at),
        version: task.version,
      })),
      projects: projects.map((project) => ({
        id: project.id,
        title: project.title,
        kind: project.kind,
        archived: project.archived,
        version: project.version,
        createdAt: toInstant(project.created_at),
        updatedAt: toInstant(project.updated_at),
      })),
      plans: plans.map((plan) => ({
        id: plan.id,
        scope: plan.scope,
        status: plan.status,
        currentVersionId: plan.current_version_id,
        availabilityVersion: plan.availability_version,
        horizon: {
          start: toInstant(plan.horizon_start),
          end: toInstant(plan.horizon_end),
        },
        timeZone: plan.time_zone,
        version: plan.version,
        createdAt: toInstant(plan.created_at),
        updatedAt: toInstant(plan.updated_at),
        versions: versions
          .filter((version) => version.plan_id === plan.id)
          .map((version) => ({
            id: version.id,
            seq: version.seq,
            candidateId: version.candidate_id,
            reason: version.reason,
            createdBy: version.created_by,
            availabilityVersion: version.availability_version,
            createdAt: toInstant(version.created_at),
            blocks: blocks
              .filter((block) => block.plan_version_id === version.id)
              .map((block) => ({
                id: block.id,
                taskId: block.task_id,
                startAt: toInstant(block.start_at),
                endAt: toInstant(block.end_at),
                locked: block.locked,
                status: block.status,
                version: block.version,
              })),
          })),
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        taskId: session.task_id,
        blockId: session.block_id,
        state: session.state,
        startedAt: toInstant(session.started_at),
        endedAt: session.ended_at === null ? null : toInstant(session.ended_at),
        focusedSec: session.focused_sec,
        pausedSec: session.paused_sec,
        clientId: session.client_id,
        version: session.version,
      })),
      reviews: reviews.map((review) => ({
        id: review.id,
        sessionId: review.session_id,
        outcome: review.outcome,
        reasonChips: review.reason_chips,
        note: review.note,
        version: review.version,
        createdAt: toInstant(review.created_at),
        updatedAt: toInstant(review.updated_at),
      })),
      estimationFeedback: feedback.map((entry) => ({
        id: entry.id,
        taskId: entry.task_id,
        estimatedP50: entry.estimated_p50,
        actualFocusMin: entry.actual_focus_min,
        quality: entry.quality,
        version: entry.version,
        createdAt: toInstant(entry.created_at),
      })),
    };
    return Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  }
}
