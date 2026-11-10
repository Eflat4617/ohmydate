import {
  CursorInvalidatedError,
  DependencyCycleError,
  NotFoundError,
  ProviderUnavailableError,
  ValidationFailedError,
  VersionConflictError,
  epochMsToInstant,
  type Clock,
  type Id,
  type IdGenerator,
  type Instant,
  type Page,
  type RepositoryCapabilities,
  type Task,
  type TaskChange,
  type TaskChangePage,
  type TaskCreate,
  type TaskPatch,
  type TaskQuery,
  type TaskRepository,
  type TaskStatus,
  type Version,
} from '@ohmydate/domain';
import {
  VikunjaClient,
  type VikunjaTask,
} from './client.js';
import {
  EMPTY_CHANGE_CURSOR,
  decodeChangeCursor,
  decodeListCursor,
  encodeChangeCursor,
  encodeListCursor,
  epochSeconds,
  compareListPosition,
  type ChangeCursor,
} from './cursor.js';
import {
  InMemoryMappingStore,
  type ExternalMapping,
  type MappingStore,
  type PendingCompletion,
} from './mapping-store.js';
import {
  InMemoryChangeJournalStore,
  type ChangeJournalStore,
  type JournalAppend,
} from './change-journal-store.js';
import { appendMarker, stripMarker } from './marker.js';
import { normalizeRemoteInstant } from './time.js';
import {
  defaultPlannerTaskFields,
  InMemoryPlannerFieldStore,
  type PlannerFieldStore,
  type PlannerTaskFields,
} from './planner-field-store.js';
import { validateTaskCreate, validateTaskPatch } from './validation.js';

/**
 * Relation kind used for `Task.dependsOn`.
 *
 * Vikunja's relation direction is "from the base task to the other task". The
 * `blocked` kind means the base task is blocked by `other_task_id`, which is
 * exactly `dependsOn`. Reading therefore uses `task.related_tasks.blocked`.
 * The inverse `blocking` relation is created by the server automatically.
 */
const DEPENDENCY_RELATION_KIND = 'blocked';

const CAPABILITIES: RepositoryCapabilities = {
  strictConcurrency: false,
  idempotentCreate: false,
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/**
 * The reconciliation query is `updated >= watermark`. Re-querying the newest
 * observed second guarantees that an edit landing in that same second after the
 * scan is picked up on the next poll.
 */
const REMOTE_OVERLAP_SECONDS = 1;

/**
 * Provider-visible content used to detect changes that an ETag cannot: Vikunja
 * ETags are second-precision, so two writes inside one second can share one.
 * The description is marker-free because the planner marker is not user
 * content, and only the mapped dependency relation kind is included so the
 * server-generated inverse relation cannot cause fingerprint churn (FU-16).
 */
function contentFingerprint(remote: VikunjaTask): string {
  const related = remote.related_tasks?.[DEPENDENCY_RELATION_KIND] ?? [];
  const relationIds = related.map((task) => String(task.id)).sort();
  return JSON.stringify({
    title: remote.title,
    description: stripMarker(remote.description) ?? '',
    done: remote.done === true,
    dueAt: normalizeRemoteInstant(remote.due_date) ?? '',
    projectId: remote.project_id === undefined ? '' : String(remote.project_id),
    relations: relationIds,
  });
}

export interface VikunjaTaskRepositoryOptions {
  readonly clients: ReadonlyMap<Id, VikunjaClient>;
  readonly mappings?: MappingStore;
  readonly plannerFields?: PlannerFieldStore;
  readonly journal?: ChangeJournalStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function withoutPending(mapping: ExternalMapping): ExternalMapping {
  const { pendingCompletion, ...rest } = mapping;
  void pendingCompletion;
  return rest;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationFailedError([
      { path: 'limit', message: `expected an integer between 1 and ${MAX_LIMIT}` },
    ]);
  }
  return limit;
}

/**
 * Vikunja-backed `TaskRepository`.
 *
 * Capability notes (ADR-016):
 * - `strictConcurrency: false` — Vikunja accepts stale `If-Match` on writes.
 *   `update`/`complete`/`softDelete` read the current ETag, compare it with the
 *   mapping and only then write. The window between the read and the write
 *   cannot be closed at the provider; this is best-effort conflict detection and
 *   assumes a single planner-side writer per task.
 * - `idempotentCreate: false` — `Idempotency-Key` is ignored upstream. The API
 *   layer must reserve the key before calling `create` (ADR-016 §2); the
 *   `<!-- ohmydate:<uuid> -->` marker in the description supports orphan
 *   recovery.
 *
 * Partial remote failures are staged: planner-only fields are committed (with
 * the version bump and journal entry) only after every remote operation and the
 * final ETag read succeed. If a remote write succeeds but a later step fails,
 * the mapping is marked `needsReconcile` and the next get/list/update first
 * reconciles the provider state, so no staged planner field becomes visible
 * under an unchanged version.
 *
 * `listChangedSince` has two layers:
 * 1. An injectable `ChangeJournalStore` records every mutation this adapter
 *    performs. Vikunja's `updated` column has second precision, so the journal
 *    is the only way to keep multiple same-second changes ordered and
 *    exactly-once. Cursors carry the store epoch; reusing the same store across
 *    repository instances keeps old cursors valid, while a different epoch or a
 *    sequence beyond the journal head raises `CursorInvalidatedError`.
 *    In a new epoch the first use of an owner (any read or append) seeds the
 *    journal with a snapshot of every mapped task at its current version, so a
 *    write after a restart cannot hide pre-existing mappings from a null resync
 *    (FU-15).
 * 2. Remote reconciliation queries `filter=updated >= <remote watermark>` and
 *    `/tasks/deleted`, de-duplicating with the stored ETag, content fingerprint
 *    / deletion marker. The watermark comes from the Vikunja scan (`max updated`
 *    seen minus a one-second overlap), never from journal entry times, so a
 *    skewed planner clock cannot step over an external edit. The journal
 *    sequence removes the deliberate one-second overlap (FU-14/FU-16).
 */
export class VikunjaTaskRepository implements TaskRepository {
  readonly capabilities: RepositoryCapabilities = CAPABILITIES;

  readonly #clients: ReadonlyMap<Id, VikunjaClient>;
  readonly #mappings: MappingStore;
  readonly #plannerFields: PlannerFieldStore;
  readonly #journal: ChangeJournalStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(options: VikunjaTaskRepositoryOptions) {
    this.#clients = options.clients;
    this.#mappings = options.mappings ?? new InMemoryMappingStore();
    this.#plannerFields = options.plannerFields ?? new InMemoryPlannerFieldStore();
    this.#journal = options.journal ?? new InMemoryChangeJournalStore();
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  async create(ownerId: Id, input: TaskCreate, _idemKey: string): Promise<Task> {
    void _idemKey;
    await this.#ensureSnapshot(ownerId);
    const client = this.#requireClient(ownerId);
    const normalized = validateTaskCreate(input);
    const projectMapping = await this.#projectMappingForCreate(
      ownerId,
      client,
      normalized.projectId,
    );
    await this.#assertDependencies(ownerId, normalized.dependsOn);

    const id = this.#ids.next();
    await this.#assertAcyclic(client, ownerId, id, normalized.dependsOn);

    const created = await client.createTask(projectMapping.externalId, {
      title: normalized.title,
      description: appendMarker(normalized.description, id),
      done: normalized.status === 'done',
      ...(normalized.dueAt === undefined ? {} : { due_date: normalized.dueAt }),
    });

    const now = this.#clock.now();
    let remote: VikunjaTask;
    let etag: string | null = null;
    let followUpFailed = false;
    try {
      const fetched = await client.getTask(String(created.id));
      remote = fetched.data;
      etag = fetched.etag;
    } catch {
      // The POST itself succeeded, so the task exists upstream. Persist a
      // needsReconcile mapping instead of orphaning it; the next read/list will
      // refresh the ETag before serving.
      remote = created;
      followUpFailed = true;
    }

    const remoteUpdatedAt = normalizeRemoteInstant(remote.updated);
    const mapping: ExternalMapping = {
      provider: 'vikunja',
      entityType: 'task',
      entityId: id,
      externalId: String(remote.id),
      ownerId,
      ...(etag === null ? {} : { externalEtag: etag }),
      ...(remoteUpdatedAt === undefined ? {} : { externalUpdatedAt: remoteUpdatedAt }),
      contentFingerprint: contentFingerprint(remote),
      ...(followUpFailed ? { needsReconcile: true } : {}),
      localVersion: 1 as Version,
      createdAt: now,
      updatedAt: now,
    };
    await this.#mappings.put(mapping);

    const fields: PlannerTaskFields = {
      splittable: normalized.splittable,
      ...(normalized.session === undefined ? {} : { session: normalized.session }),
      priority: normalized.priority,
      status: normalized.status,
      dependsOn: [...normalized.dependsOn],
    };
    await this.#plannerFields.putTask(id, fields);

    try {
      for (const dependencyId of normalized.dependsOn) {
        const dependency = await this.#requireMapping(ownerId, 'task', dependencyId);
        await client.createRelation(
          mapping.externalId,
          dependency.externalId,
          DEPENDENCY_RELATION_KIND,
        );
      }
    } catch (error) {
      // The relation write may have been applied before its response was lost.
      if (error instanceof ProviderUnavailableError) {
        await this.#markNeedsReconcile(mapping);
      }
      // Best-effort rollback: the task exists upstream, so remove it before
      // surfacing the failure. The marker stays for orphan recovery if this
      // rollback also fails.
      try {
        await client.deleteTask(mapping.externalId);
        await client.permanentDeleteTask(mapping.externalId);
      } catch {
        // Leave the mapping/marker in place for orphan recovery.
      }
      throw error;
    }

    await this.#appendJournal(ownerId, mapping, mapping.externalUpdatedAt ?? now);
    return this.#toTask(ownerId, mapping, remote, fields, normalized.dependsOn);
  }

  async get(ownerId: Id, id: Id): Promise<Task | null> {
    await this.#ensureSnapshot(ownerId);
    const client = this.#clientFor(ownerId);
    if (client === undefined) return null;
    let mapping = await this.#mappings.get('task', id);
    if (mapping === null || mapping.ownerId !== ownerId || mapping.deletedAt !== undefined) {
      return null;
    }
    if (mapping.needsReconcile === true || mapping.pendingCompletion !== undefined) {
      try {
        mapping = await this.#reconcileMapping(ownerId, client, mapping);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    }
    try {
      const { data: remote } = await client.getTask(mapping.externalId);
      const fields = (await this.#plannerFields.getTask(id)) ?? defaultPlannerTaskFields();
      const dependsOn = await this.#remoteDependencies(ownerId, remote);
      return this.#toTask(ownerId, mapping, remote, fields, dependsOn);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async list(ownerId: Id, query: TaskQuery): Promise<Page<Task>> {
    await this.#ensureSnapshot(ownerId);
    const client = this.#clientFor(ownerId);
    if (client === undefined) return { items: [], nextCursor: null };
    const limit = normalizeLimit(query.limit);

    let externalProjectId: string | undefined;
    if (query.projectId !== undefined) {
      const projectMapping = await this.#mappings.get('project', query.projectId);
      if (
        projectMapping === null ||
        projectMapping.ownerId !== ownerId ||
        projectMapping.deletedAt !== undefined
      ) {
        return { items: [], nextCursor: null };
      }
      externalProjectId = projectMapping.externalId;
    }

    const remoteTasks =
      externalProjectId === undefined
        ? await client.listAllTasks()
        : await client.listAllProjectTasks(externalProjectId);

    const tasks: Task[] = [];
    for (const remote of remoteTasks) {
      let mapping = await this.#mappings.getByExternal(
        'vikunja',
        'task',
        String(remote.id),
      );
      if (
        mapping === null ||
        mapping.ownerId !== ownerId ||
        mapping.deletedAt !== undefined
      ) {
        continue;
      }
      let full: VikunjaTask;
      let etag: string | null;
      try {
        const loaded = await client.getTask(mapping.externalId);
        full = loaded.data;
        etag = loaded.etag;
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      if (mapping.needsReconcile === true || mapping.pendingCompletion !== undefined) {
        mapping = await this.#commitReconciled(ownerId, mapping, full, etag);
      }
      const fields = (await this.#plannerFields.getTask(mapping.entityId)) ?? defaultPlannerTaskFields();
      const dependsOn = await this.#remoteDependencies(ownerId, full);
      const task = await this.#toTask(ownerId, mapping, full, fields, dependsOn);
      if (query.status !== undefined && task.status !== query.status) continue;
      tasks.push(task);
    }

    tasks.sort((left, right) =>
      compareListPosition(
        { createdAt: left.createdAt, id: left.id },
        { createdAt: right.createdAt, id: right.id },
      ),
    );

    let candidates = tasks;
    if (query.cursor !== undefined) {
      const cursor = decodeListCursor(query.cursor);
      candidates = tasks.filter(
        (task) =>
          compareListPosition(
            { createdAt: task.createdAt, id: task.id },
            { createdAt: cursor.createdAt, id: cursor.id },
          ) > 0,
      );
    }

    const items = candidates.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      last === undefined || candidates.length <= items.length
        ? null
        : encodeListCursor({ createdAt: last.createdAt, id: last.id });
    return { items, nextCursor };
  }

  async update(
    ownerId: Id,
    id: Id,
    patch: TaskPatch,
    expectedVersion: Version,
  ): Promise<Task> {
    await this.#ensureSnapshot(ownerId);
    const client = this.#requireClient(ownerId);
    let mapping = await this.#requireMapping(ownerId, 'task', id);
    if (mapping.needsReconcile === true || mapping.pendingCompletion !== undefined) {
      mapping = await this.#reconcileMapping(ownerId, client, mapping);
    }
    if (mapping.deletedAt !== undefined) throw new NotFoundError('task', id);
    if (mapping.localVersion !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }

    // (a) read the current ETag. The provider will not enforce a precondition
    // on write, so (a)-(c) is best-effort and there is a race window here.
    const current = await this.#requireRemoteTask(client, id, mapping.externalId);
    if (this.#remoteChanged(mapping, current.data, current.etag)) {
      const reconciled = await this.#commitReconciled(
        ownerId,
        mapping,
        current.data,
        current.etag,
      );
      throw new VersionConflictError(expectedVersion, reconciled.localVersion);
    }

    const normalized = validateTaskPatch(patch);
    const fields = (await this.#plannerFields.getTask(id)) ?? defaultPlannerTaskFields();
    const currentDependencies = await this.#remoteDependencies(ownerId, current.data);
    const desiredDependencies = normalized.dependsOn ?? currentDependencies;

    if (normalized.dependsOn !== undefined) {
      await this.#assertDependencies(ownerId, desiredDependencies);
      await this.#assertAcyclic(client, ownerId, id, desiredDependencies);
    }

    const body: Record<string, unknown> = {};
    if (normalized.projectId !== undefined) {
      const projectMapping = await this.#requireMapping(ownerId, 'project', normalized.projectId);
      body.project_id = Number(projectMapping.externalId);
    }
    if (normalized.title !== undefined) body.title = normalized.title;
    if (patch.description !== undefined) {
      body.description =
        normalized.description === null || normalized.description === undefined
          ? appendMarker(undefined, id)
          : appendMarker(normalized.description, id);
    }
    if (normalized.status !== undefined) body.done = normalized.status === 'done';
    if (patch.dueAt !== undefined) {
      body.due_date = normalized.dueAt === null ? null : normalized.dueAt;
    }

    // Planner fields are staged, not committed. Any remote failure leaves the
    // observable task at its previous version until reconciliation has run.
    const nextStatus = normalized.status ?? this.#resolveStatus(current.data, fields);
    const nextFields: PlannerTaskFields = {
      splittable: normalized.splittable ?? fields.splittable,
      ...(normalized.session === null
        ? {}
        : normalized.session !== undefined
          ? { session: normalized.session }
          : fields.session === undefined
            ? {}
            : { session: fields.session }),
      priority: normalized.priority ?? fields.priority,
      status: nextStatus,
      dependsOn: [...desiredDependencies],
    };

    let remoteWriteApplied = false;
    try {
      if (Object.keys(body).length > 0) {
        await client.patchTask(mapping.externalId, body);
        remoteWriteApplied = true;
      }
      await this.#applyDependencyDiff(
        client,
        mapping.externalId,
        currentDependencies,
        desiredDependencies,
        () => {
          remoteWriteApplied = true;
        },
      );
    } catch (error) {
      // ProviderUnavailable means the write may have been applied before the
      // response was lost. Anything else (4xx validation/conflict) is a
      // definitive non-application unless an earlier write already succeeded.
      if (error instanceof ProviderUnavailableError || remoteWriteApplied) {
        await this.#markNeedsReconcile(mapping);
      }
      throw error;
    }

    let latest: { readonly data: VikunjaTask; readonly etag: string | null };
    try {
      latest = await client.getTask(mapping.externalId);
    } catch (error) {
      // The PATCH/relation write may already be visible upstream. Never commit
      // staged planner fields; force a reconciliation on the next read.
      await this.#markNeedsReconcile(mapping);
      throw error;
    }

    const now = this.#clock.now();
    const latestUpdatedAt = normalizeRemoteInstant(latest.data.updated);
    const updated: ExternalMapping = {
      ...mapping,
      ...(latest.etag === null ? {} : { externalEtag: latest.etag }),
      ...(latestUpdatedAt === undefined ? {} : { externalUpdatedAt: latestUpdatedAt }),
      contentFingerprint: contentFingerprint(latest.data),
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    await this.#mappings.put(updated);
    await this.#plannerFields.putTask(id, nextFields);
    await this.#appendJournal(ownerId, updated, updated.externalUpdatedAt ?? now);
    return this.#toTask(ownerId, updated, latest.data, nextFields, desiredDependencies);
  }

  /**
   * Completion is a planner-owned fact (ADR-016 §4). For non-recurring tasks
   * Vikunja reports `done:true`; for recurring tasks the provider immediately
   * reopens the task, bumps the due date and returns `done:false`. In both
   * cases a journal change with `completedOccurrenceAt` records the completion,
   * while the returned task status/dueAt reflect the provider state (a reopened
   * recurring task therefore reads as `todo` with its next due date).
   *
   * `completedOccurrenceAt` is the dueAt of the occurrence that was completed
   * (`pendingCompletion.dueAtBefore`), not the wall-clock completion time. Only
   * a task that had no due date falls back to the completion instant. The same
   * rule applies when a lost response is reconciled later.
   *
   * A completion intent is persisted on the mapping before the PATCH. If the
   * write response is lost, reconciliation compares the provider state (done or
   * an advanced due date), emits the completion record exactly once and applies
   * the same planner status the normal path would (done, or todo when Vikunja
   * reopened a recurring task). A retry with the same expectedVersion therefore
   * conflicts after reconciliation instead of completing the next occurrence.
   */
  async complete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Task> {
    await this.#ensureSnapshot(ownerId);
    const client = this.#requireClient(ownerId);
    let mapping = await this.#requireMapping(ownerId, 'task', id);
    if (mapping.needsReconcile === true || mapping.pendingCompletion !== undefined) {
      mapping = await this.#reconcileMapping(ownerId, client, mapping);
      if (mapping.localVersion !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, mapping.localVersion);
      }
    }
    if (mapping.deletedAt !== undefined) throw new NotFoundError('task', id);
    // Completing a done task is only a no-op when the caller's version is
    // current. A stale expectedVersion still conflicts (the stronger contract
    // suite checks this).
    if (mapping.localVersion !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }

    const current = await this.#requireRemoteTask(client, id, mapping.externalId);
    if (this.#remoteChanged(mapping, current.data, current.etag)) {
      const reconciled = await this.#commitReconciled(
        ownerId,
        mapping,
        current.data,
        current.etag,
      );
      throw new VersionConflictError(expectedVersion, reconciled.localVersion);
    }

    const fields = (await this.#plannerFields.getTask(id)) ?? defaultPlannerTaskFields();
    if (current.data.done === true) {
      const dependsOn = await this.#remoteDependencies(ownerId, current.data);
      return this.#toTask(ownerId, mapping, current.data, fields, dependsOn);
    }

    const now = this.#clock.now();
    const dueAtBefore = normalizeRemoteInstant(current.data.due_date);
    const intent: PendingCompletion = {
      expectedVersion,
      at: now,
      ...(dueAtBefore === undefined ? {} : { dueAtBefore }),
    };
    const withIntent: ExternalMapping = { ...mapping, pendingCompletion: intent };
    await this.#mappings.put(withIntent);
    mapping = withIntent;

    try {
      await client.patchTask(mapping.externalId, { done: true });
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        await this.#markNeedsReconcile(mapping);
      } else {
        // Definitive 4xx: the completion was not applied.
        await this.#mappings.put(withoutPending(mapping));
      }
      throw error;
    }

    let latest: { readonly data: VikunjaTask; readonly etag: string | null };
    try {
      latest = await client.getTask(mapping.externalId);
    } catch (error) {
      // The PATCH succeeded; keep the intent so reconciliation can emit the
      // completion record even though the final read failed.
      await this.#markNeedsReconcile(mapping);
      throw error;
    }

    const latestUpdatedAt = normalizeRemoteInstant(latest.data.updated);
    const base = withoutPending(mapping);
    const updated: ExternalMapping = {
      ...base,
      ...(latest.etag === null ? {} : { externalEtag: latest.etag }),
      ...(latestUpdatedAt === undefined ? {} : { externalUpdatedAt: latestUpdatedAt }),
      contentFingerprint: contentFingerprint(latest.data),
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    // A repeating task may reopen upstream immediately; reflect the provider.
    const nextStatus: TaskStatus = latest.data.done === true ? 'done' : 'todo';
    const nextFields: PlannerTaskFields = { ...fields, status: nextStatus };
    await this.#mappings.put(updated);
    await this.#plannerFields.putTask(id, nextFields);
    // The completion record belongs to the occurrence that was due when the
    // task was completed. Fall back to the completion time only when the task
    // had no due date (FU-17).
    await this.#appendJournal(
      ownerId,
      updated,
      updated.externalUpdatedAt ?? now,
      undefined,
      dueAtBefore ?? now,
    );
    const dependsOn = await this.#remoteDependencies(ownerId, latest.data);
    return this.#toTask(ownerId, updated, latest.data, nextFields, dependsOn);
  }

  async softDelete(ownerId: Id, id: Id, expectedVersion: Version): Promise<void> {
    await this.#ensureSnapshot(ownerId);
    const client = this.#requireClient(ownerId);
    let mapping = await this.#requireMapping(ownerId, 'task', id);
    if (mapping.needsReconcile === true || mapping.pendingCompletion !== undefined) {
      mapping = await this.#reconcileMapping(ownerId, client, mapping);
    }
    if (mapping.deletedAt !== undefined) throw new NotFoundError('task', id);
    if (mapping.localVersion !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }
    const current = await this.#requireRemoteTask(client, id, mapping.externalId);
    if (this.#remoteChanged(mapping, current.data, current.etag)) {
      const reconciled = await this.#commitReconciled(
        ownerId,
        mapping,
        current.data,
        current.etag,
      );
      throw new VersionConflictError(expectedVersion, reconciled.localVersion);
    }

    try {
      await client.deleteTask(mapping.externalId);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        await this.#markNeedsReconcile(mapping);
      }
      throw error;
    }
    const now = this.#clock.now();
    const updated: ExternalMapping = {
      ...mapping,
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      deletedAt: now,
    };
    await this.#mappings.put(updated);
    await this.#appendJournal(ownerId, updated, now, now);
  }

  async listChangedSince(ownerId: Id, cursor: string | null): Promise<TaskChangePage> {
    const epoch = await this.#journal.epoch();
    let decoded: ChangeCursor;
    try {
      decoded = decodeChangeCursor(cursor);
    } catch (error) {
      if (error instanceof ValidationFailedError) {
        throw new CursorInvalidatedError(
          'change cursor is malformed or predates journal epochs; full resync required',
        );
      }
      throw error;
    }
    const ownerKey = String(ownerId);
    let baseline: ChangeCursor;
    if (cursor === null) {
      // Full resync: read the whole retained journal for this owner.
      baseline = { ...EMPTY_CHANGE_CURSOR, epoch, owner: ownerKey };
    } else {
      if (decoded.epoch !== epoch) {
        throw new CursorInvalidatedError(
          'change cursor belongs to a different journal epoch; full resync required',
        );
      }
      if (decoded.owner !== ownerKey) {
        throw new CursorInvalidatedError(
          'change cursor belongs to another owner; full resync required',
        );
      }
      const head = await this.#journal.head(ownerId);
      if (decoded.sequence > head) {
        throw new CursorInvalidatedError(
          'change cursor is beyond the journal head; full resync required',
        );
      }
      baseline = decoded;
    }

    // FU-15: seed the epoch from the mappings before serving any journal
    // entry, whether this is a full resync or an incremental read.
    await this.#ensureSnapshot(ownerId);

    const client = this.#clientFor(ownerId);
    let remoteSeconds = baseline.remoteSeconds;
    if (client !== undefined) {
      remoteSeconds = await this.#reconcileRemote(
        ownerId,
        client,
        baseline.remoteSeconds,
      );
    }

    const entries = await this.#journal.readAfter(ownerId, baseline.sequence);
    const changes: TaskChange[] = entries.map((entry) => ({
      id: entry.taskId,
      version: entry.version,
      ...(entry.deletedAt === undefined ? {} : { deletedAt: entry.deletedAt }),
      ...(entry.completedOccurrenceAt === undefined
        ? {}
        : { completedOccurrenceAt: entry.completedOccurrenceAt }),
    }));
    const last = entries[entries.length - 1];
    const nextCursor: ChangeCursor =
      last === undefined
        ? { ...baseline, remoteSeconds, epoch, owner: ownerKey }
        : {
            seconds: epochSeconds(last.at),
            remoteSeconds,
            externalId: last.externalId,
            sequence: last.sequence,
            epoch,
            owner: ownerKey,
          };
    return { changes, cursor: encodeChangeCursor(nextCursor) };
  }

  #clientFor(ownerId: Id): VikunjaClient | undefined {
    return this.#clients.get(ownerId);
  }

  #requireClient(ownerId: Id): VikunjaClient {
    const client = this.#clients.get(ownerId);
    if (client === undefined) throw new NotFoundError('owner', ownerId);
    return client;
  }

  /**
   * Tasks are project-scoped in Vikunja and `TaskCreate.projectId` is optional
   * in the domain port. When omitted, use the owner's real Inbox project and
   * register the same planner mapping for every subsequent no-project create.
   */
  async #projectMappingForCreate(
    ownerId: Id,
    client: VikunjaClient,
    projectId: Id | undefined,
  ): Promise<ExternalMapping> {
    if (projectId !== undefined) {
      return this.#requireMapping(ownerId, 'project', projectId);
    }
    const projects = await client.listAllProjects();
    const inbox = projects.find((project) => project.title.toLowerCase() === 'inbox');
    const externalId =
      inbox === undefined
        ? String((await client.createProject('Inbox')).id)
        : String(inbox.id);
    const existing = await this.#mappings.getByExternal('vikunja', 'project', externalId);
    if (existing !== null) {
      if (existing.ownerId !== ownerId) throw new NotFoundError('project', externalId);
      return existing;
    }
    const now = this.#clock.now();
    const mapping: ExternalMapping = {
      provider: 'vikunja',
      entityType: 'project',
      entityId: this.#ids.next(),
      externalId,
      ownerId,
      localVersion: 1 as Version,
      createdAt: now,
      updatedAt: now,
    };
    await this.#mappings.put(mapping);
    return mapping;
  }

  async #requireMapping(
    ownerId: Id,
    entityType: 'task' | 'project',
    entityId: Id,
  ): Promise<ExternalMapping> {
    const mapping = await this.#mappings.get(entityType, entityId);
    if (mapping === null || mapping.ownerId !== ownerId || mapping.deletedAt !== undefined) {
      throw new NotFoundError(entityType, entityId);
    }
    return mapping;
  }

  async #requireRemoteTask(
    client: VikunjaClient,
    taskId: Id,
    externalId: string,
  ): Promise<{ readonly data: VikunjaTask; readonly etag: string | null }> {
    try {
      return await client.getTask(externalId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError('task', taskId);
      throw error;
    }
  }

  async #assertDependencies(ownerId: Id, dependsOn: readonly Id[]): Promise<void> {
    for (const dependencyId of dependsOn) {
      const mapping = await this.#mappings.get('task', dependencyId);
      if (
        mapping === null ||
        mapping.ownerId !== ownerId ||
        mapping.deletedAt !== undefined
      ) {
        throw new NotFoundError('task', dependencyId);
      }
    }
  }

  async #assertAcyclic(
    client: VikunjaClient,
    ownerId: Id,
    taskId: Id,
    dependsOn: readonly Id[],
  ): Promise<void> {
    const visited = new Set<Id>();
    const visit = async (current: Id, path: readonly Id[]): Promise<void> => {
      if (current === taskId) {
        throw new DependencyCycleError([taskId, ...path]);
      }
      if (visited.has(current)) return;
      visited.add(current);
      const mapping = await this.#mappings.get('task', current);
      if (
        mapping === null ||
        mapping.ownerId !== ownerId ||
        mapping.deletedAt !== undefined
      ) {
        throw new NotFoundError('task', current);
      }
      let remote: VikunjaTask;
      try {
        remote = (await client.getTask(mapping.externalId)).data;
      } catch (error) {
        if (error instanceof NotFoundError) throw new NotFoundError('task', current);
        throw error;
      }
      const dependencies = await this.#remoteDependencies(ownerId, remote);
      for (const dependency of dependencies) {
        await visit(dependency, [...path, dependency]);
      }
    };
    for (const dependencyId of dependsOn) {
      await visit(dependencyId, [dependencyId]);
    }
  }

  async #remoteDependencies(ownerId: Id, remote: VikunjaTask): Promise<readonly Id[]> {
    const blocked = remote.related_tasks?.[DEPENDENCY_RELATION_KIND] ?? [];
    const ids: Id[] = [];
    const seen = new Set<string>();
    for (const dependency of blocked) {
      const mapping = await this.#mappings.getByExternal(
        'vikunja',
        'task',
        String(dependency.id),
      );
      if (
        mapping === null ||
        mapping.ownerId !== ownerId ||
        mapping.deletedAt !== undefined ||
        seen.has(mapping.entityId)
      ) {
        continue;
      }
      seen.add(mapping.entityId);
      ids.push(mapping.entityId);
    }
    return ids;
  }

  async #applyDependencyDiff(
    client: VikunjaClient,
    externalTaskId: string,
    current: readonly Id[],
    desired: readonly Id[],
    onApplied: () => void,
  ): Promise<void> {
    const currentSet = new Set(current);
    const desiredSet = new Set(desired);
    for (const dependencyId of current) {
      if (desiredSet.has(dependencyId)) continue;
      const mapping = await this.#mappings.get('task', dependencyId);
      if (mapping === null) continue;
      await client.deleteRelation(
        externalTaskId,
        DEPENDENCY_RELATION_KIND,
        mapping.externalId,
      );
      onApplied();
    }
    for (const dependencyId of desired) {
      if (currentSet.has(dependencyId)) continue;
      const mapping = await this.#mappings.get('task', dependencyId);
      if (mapping === null) throw new NotFoundError('task', dependencyId);
      await client.createRelation(
        externalTaskId,
        mapping.externalId,
        DEPENDENCY_RELATION_KIND,
      );
      onApplied();
    }
  }

  #resolveStatus(remote: VikunjaTask, fields: PlannerTaskFields): TaskStatus {
    if (remote.done === true) return 'done';
    return fields.status === 'in_progress' ? 'in_progress' : 'todo';
  }

  async #toTask(
    ownerId: Id,
    mapping: ExternalMapping,
    remote: VikunjaTask,
    fields: PlannerTaskFields,
    dependsOn: readonly Id[],
  ): Promise<Task> {
    const projectMapping =
      remote.project_id === undefined
        ? null
        : await this.#mappings.getByExternal(
            'vikunja',
            'project',
            String(remote.project_id),
          );
    if (projectMapping === null || projectMapping.ownerId !== ownerId) {
      throw new NotFoundError('project', String(remote.project_id ?? 'unknown'));
    }
    const description = stripMarker(remote.description);
    const dueAt = normalizeRemoteInstant(remote.due_date);
    const status = this.#resolveStatus(remote, fields);
    const task: Task = {
      id: mapping.entityId,
      ownerId,
      projectId: projectMapping.entityId,
      title: remote.title,
      ...(description === undefined ? {} : { description }),
      status,
      ...(dueAt === undefined ? {} : { dueAt }),
      splittable: fields.splittable,
      ...(fields.session === undefined ? {} : { session: fields.session }),
      priority: fields.priority,
      dependsOn: [...dependsOn],
      version: mapping.localVersion,
      createdAt: mapping.createdAt,
      updatedAt: mapping.updatedAt,
      ...(mapping.deletedAt === undefined ? {} : { deletedAt: mapping.deletedAt }),
      external: [{ provider: 'vikunja', externalId: mapping.externalId }],
    };
    return task;
  }

  async #appendJournal(
    ownerId: Id,
    mapping: ExternalMapping,
    at: Instant,
    deletedAt?: Instant,
    completedOccurrenceAt?: Instant,
  ): Promise<void> {
    const entry: JournalAppend = {
      ownerId,
      taskId: mapping.entityId,
      externalId: mapping.externalId,
      version: mapping.localVersion,
      at,
      ...(deletedAt === undefined ? {} : { deletedAt }),
      ...(completedOccurrenceAt === undefined ? {} : { completedOccurrenceAt }),
    };
    await this.#journal.append(entry);
  }

  async #markNeedsReconcile(mapping: ExternalMapping): Promise<void> {
    await this.#mappings.put({ ...mapping, needsReconcile: true });
  }

  async #reconcileMapping(
    ownerId: Id,
    client: VikunjaClient,
    mapping: ExternalMapping,
  ): Promise<ExternalMapping> {
    let current: { readonly data: VikunjaTask; readonly etag: string | null };
    try {
      current = await client.getTask(mapping.externalId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundError('task', mapping.entityId);
      }
      throw error;
    }
    return this.#commitReconciled(ownerId, mapping, current.data, current.etag);
  }

  /**
   * True when the provider content no longer matches what the mapping recorded.
   * The ETag is authoritative when both sides have one; the content fingerprint
   * catches same-second writes that reuse an ETag. A missing local baseline is
   * treated as unknown so the first reconciliation after a failed create
   * follow-up adopts the observed ETag without inventing a version bump.
   */
  #remoteChanged(
    mapping: ExternalMapping,
    remote: VikunjaTask,
    etag: string | null,
  ): boolean {
    const etagChanged =
      mapping.externalEtag !== undefined &&
      etag !== null &&
      etag !== mapping.externalEtag;
    const fingerprintChanged =
      mapping.contentFingerprint !== undefined &&
      mapping.contentFingerprint !== contentFingerprint(remote);
    return etagChanged || fingerprintChanged;
  }

  async #commitReconciled(
    ownerId: Id,
    mapping: ExternalMapping,
    remote: VikunjaTask,
    etag: string | null,
  ): Promise<ExternalMapping> {
    const updatedAt = normalizeRemoteInstant(remote.updated);
    const pending = mapping.pendingCompletion;
    const remoteDueAt = normalizeRemoteInstant(remote.due_date);
    const completed =
      pending !== undefined &&
      (remote.done === true ||
        (pending.dueAtBefore !== undefined &&
          remoteDueAt !== undefined &&
          Date.parse(remoteDueAt) > Date.parse(pending.dueAtBefore)));
    const fingerprint = contentFingerprint(remote);
    const etagChanged =
      mapping.externalEtag !== undefined &&
      etag !== null &&
      etag !== mapping.externalEtag;
    const updatedChanged =
      mapping.externalUpdatedAt !== undefined &&
      etag === null &&
      updatedAt !== undefined &&
      mapping.externalUpdatedAt !== updatedAt;
    const fingerprintChanged =
      mapping.contentFingerprint !== undefined &&
      mapping.contentFingerprint !== fingerprint;
    const changed = etagChanged || updatedChanged || completed || fingerprintChanged;
    const now = this.#clock.now();

    if (!changed) {
      // Settle an unknown-outcome intent or a reconcile marker without
      // inventing a version when the provider state did not change. Adopting
      // the first observed ETag/updated/fingerprint keeps a failed create
      // follow-up from looking changed forever (FU-17).
      const settled: ExternalMapping = {
        ...withoutPending(mapping),
        ...(etag === null ? {} : { externalEtag: etag }),
        ...(updatedAt === undefined ? {} : { externalUpdatedAt: updatedAt }),
        contentFingerprint: fingerprint,
        needsReconcile: false,
      };
      if (
        mapping.needsReconcile === true ||
        mapping.pendingCompletion !== undefined ||
        mapping.externalEtag !== settled.externalEtag ||
        mapping.externalUpdatedAt !== settled.externalUpdatedAt ||
        mapping.contentFingerprint !== fingerprint
      ) {
        await this.#mappings.put(settled);
      }
      return settled;
    }

    const base = withoutPending(mapping);
    const updated: ExternalMapping = {
      ...base,
      ...(etag === null ? {} : { externalEtag: etag }),
      ...(updatedAt === undefined ? {} : { externalUpdatedAt: updatedAt }),
      contentFingerprint: fingerprint,
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    await this.#mappings.put(updated);
    if (completed) {
      // A reconciled recurring completion must leave the same planner status
      // as the normal completion path: done when the provider stays done, todo
      // when it reopened the next occurrence (FU-17).
      const fields =
        (await this.#plannerFields.getTask(mapping.entityId)) ?? defaultPlannerTaskFields();
      await this.#plannerFields.putTask(mapping.entityId, {
        ...fields,
        status: remote.done === true ? 'done' : 'todo',
      });
    }
    await this.#appendJournal(
      ownerId,
      updated,
      updatedAt ?? now,
      undefined,
      // The completion belongs to the occurrence that was due when the intent
      // was staged. Fall back to the completion time only when the task had no
      // due date (FU-17).
      completed ? (pending.dueAtBefore ?? pending.at) : undefined,
    );
    return updated;
  }

  /**
   * Returns the remote watermark for the next poll. It is derived only from
   * what the Vikunja scan observed (`max updated` minus the one-second
   * overlap), so planner-clock skew in journal entry times cannot move the
   * incremental feed past an external edit (FU-14). When the scan observed
   * nothing newer than the previous watermark, the watermark is unchanged.
   */
  async #reconcileRemote(
    ownerId: Id,
    client: VikunjaClient,
    fromSeconds: number,
  ): Promise<number> {
    const fromInstant = epochMsToInstant(Math.max(0, fromSeconds) * 1000);
    const live = await client.listAllTasks({
      filter: `updated >= "${fromInstant}"`,
      sort_by: 'updated',
      order_by: 'asc',
    });
    let maxUpdatedSeconds = fromSeconds;
    let observedNewer = false;
    for (const candidate of live) {
      const candidateUpdatedAt = normalizeRemoteInstant(candidate.updated);
      if (candidateUpdatedAt !== undefined) {
        const candidateSeconds = epochSeconds(candidateUpdatedAt);
        if (candidateSeconds > maxUpdatedSeconds) {
          maxUpdatedSeconds = candidateSeconds;
          observedNewer = true;
        }
      }
      const mapping = await this.#mappings.getByExternal(
        'vikunja',
        'task',
        String(candidate.id),
      );
      if (
        mapping === null ||
        mapping.ownerId !== ownerId ||
        mapping.deletedAt !== undefined
      ) {
        continue;
      }
      let current: { readonly data: VikunjaTask; readonly etag: string | null };
      try {
        current = await client.getTask(mapping.externalId);
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      const updatedAt = normalizeRemoteInstant(current.data.updated);
      const etagSame =
        current.etag !== null && mapping.externalEtag === current.etag;
      const updatedSame =
        updatedAt !== undefined && mapping.externalUpdatedAt === updatedAt;
      const fingerprintSame =
        mapping.contentFingerprint === undefined ||
        mapping.contentFingerprint === contentFingerprint(current.data);
      if (
        mapping.needsReconcile !== true &&
        mapping.pendingCompletion === undefined &&
        fingerprintSame &&
        (etagSame || (current.etag === null && updatedSame))
      ) {
        continue;
      }
      await this.#commitReconciled(ownerId, mapping, current.data, current.etag);
    }

    const deleted = await client.listAllDeletedTasks();
    for (const candidate of deleted) {
      const mapping = await this.#mappings.getByExternal(
        'vikunja',
        'task',
        String(candidate.id),
      );
      if (
        mapping === null ||
        mapping.ownerId !== ownerId ||
        mapping.deletedAt !== undefined
      ) {
        continue;
      }
      const deletedAt = normalizeRemoteInstant(candidate.deleted_at) ?? this.#clock.now();
      const now = this.#clock.now();
      const updated: ExternalMapping = {
        ...withoutPending(mapping),
        localVersion: (mapping.localVersion + 1) as Version,
        updatedAt: now,
        deletedAt,
        needsReconcile: false,
      };
      await this.#mappings.put(updated);
      await this.#appendJournal(ownerId, updated, deletedAt, deletedAt);
    }

    if (!observedNewer) return fromSeconds;
    return Math.max(0, maxUpdatedSeconds - REMOTE_OVERLAP_SECONDS);
  }

  /**
   * FU-15/FU-17: the first use of an owner in a journal epoch emits a snapshot
   * of every mapped task at its current `localVersion`, before any read result
   * or new append is observed. A null resync alone is not enough: a normal
   * write after a restart makes the journal non-empty and would otherwise hide
   * the mappings that predate it. `appendSnapshotOnce` makes concurrent first
   * uses emit it exactly once.
   */
  async #ensureSnapshot(ownerId: Id): Promise<void> {
    if (await this.#journal.hasSnapshot(ownerId)) return;
    const mappings = await this.#mappings.listByOwner(ownerId);
    const entries: JournalAppend[] = [];
    for (const mapping of mappings) {
      if (mapping.entityType !== 'task' || mapping.deletedAt === undefined) continue;
      entries.push(this.#snapshotEntry(mapping, mapping.deletedAt));
    }
    for (const mapping of mappings) {
      if (mapping.entityType !== 'task' || mapping.deletedAt !== undefined) continue;
      entries.push(this.#snapshotEntry(mapping));
    }
    await this.#journal.appendSnapshotOnce(ownerId, entries);
  }

  #snapshotEntry(mapping: ExternalMapping, deletedAt?: Instant): JournalAppend {
    return {
      ownerId: mapping.ownerId,
      taskId: mapping.entityId,
      externalId: mapping.externalId,
      version: mapping.localVersion,
      at: mapping.externalUpdatedAt ?? mapping.updatedAt,
      ...(deletedAt === undefined ? {} : { deletedAt }),
    };
  }
}

export function createVikunjaTaskRepository(
  options: VikunjaTaskRepositoryOptions,
): VikunjaTaskRepository {
  return new VikunjaTaskRepository(options);
}
