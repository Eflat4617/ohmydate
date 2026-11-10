import {
  CursorInvalidatedError,
  DependencyCycleError,
  NotFoundError,
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

export interface VikunjaTaskRepositoryOptions {
  readonly clients: ReadonlyMap<Id, VikunjaClient>;
  readonly mappings?: MappingStore;
  readonly plannerFields?: PlannerFieldStore;
  readonly journal?: ChangeJournalStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
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
 * 2. Remote reconciliation queries `filter=updated >= <cursor seconds>` and
 *    `/tasks/deleted`, de-duplicating with the stored ETag / deletion marker.
 *    The `>=` query deliberately overlaps by one second; the journal sequence
 *    and ETag comparisons remove the overlap.
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
    try {
      const fetched = await client.getTask(String(created.id));
      remote = fetched.data;
      etag = fetched.etag;
    } catch (error) {
      // A create response can omit server-set fields; a follow-up GET is
      // advisable (capabilities doc). If it failed, keep the create result but
      // still persist a mapping so the task can be recovered.
      remote = created;
      if (!(error instanceof NotFoundError)) throw error;
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
    this.#plannerFields.putTask(id, fields);

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
      // Best-effort rollback: the task exists upstream, so remove it (and its
      // mapping) before surfacing the failure.
      try {
        await client.deleteTask(mapping.externalId);
        await client.permanentDeleteTask(mapping.externalId);
      } catch {
        // Leave the marker in place for orphan recovery.
      }
      throw error;
    }

    await this.#appendJournal(ownerId, mapping, mapping.externalUpdatedAt ?? now);
    return this.#toTask(ownerId, mapping, remote, fields, normalized.dependsOn);
  }

  async get(ownerId: Id, id: Id): Promise<Task | null> {
    const client = this.#clientFor(ownerId);
    if (client === undefined) return null;
    let mapping = await this.#mappings.get('task', id);
    if (mapping === null || mapping.ownerId !== ownerId || mapping.deletedAt !== undefined) {
      return null;
    }
    if (mapping.needsReconcile === true) {
      try {
        mapping = await this.#reconcileMapping(ownerId, client, mapping);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    }
    try {
      const { data: remote } = await client.getTask(mapping.externalId);
      const fields = this.#plannerFields.getTask(id) ?? defaultPlannerTaskFields();
      const dependsOn = await this.#remoteDependencies(ownerId, remote);
      return this.#toTask(ownerId, mapping, remote, fields, dependsOn);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async list(ownerId: Id, query: TaskQuery): Promise<Page<Task>> {
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
      if (mapping.needsReconcile === true) {
        mapping = await this.#commitReconciled(ownerId, mapping, full, etag);
      }
      const fields = this.#plannerFields.getTask(mapping.entityId) ?? defaultPlannerTaskFields();
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
    const client = this.#requireClient(ownerId);
    let mapping = await this.#requireMapping(ownerId, 'task', id);
    if (mapping.needsReconcile === true) {
      mapping = await this.#reconcileMapping(ownerId, client, mapping);
    }
    if (mapping.deletedAt !== undefined) throw new NotFoundError('task', id);
    if (mapping.localVersion !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }

    // (a) read the current ETag. The provider will not enforce a precondition
    // on write, so (a)-(c) is best-effort and there is a race window here.
    const current = await this.#requireRemoteTask(client, id, mapping.externalId);
    if (
      mapping.externalEtag !== undefined &&
      current.etag !== null &&
      current.etag !== mapping.externalEtag
    ) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }

    const normalized = validateTaskPatch(patch);
    const fields = this.#plannerFields.getTask(id) ?? defaultPlannerTaskFields();
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
      if (remoteWriteApplied) await this.#markNeedsReconcile(mapping);
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
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    await this.#mappings.put(updated);
    this.#plannerFields.putTask(id, nextFields);
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
   */
  async complete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Task> {
    const client = this.#requireClient(ownerId);
    let mapping = await this.#requireMapping(ownerId, 'task', id);
    if (mapping.needsReconcile === true) {
      mapping = await this.#reconcileMapping(ownerId, client, mapping);
    }
    if (mapping.deletedAt !== undefined) throw new NotFoundError('task', id);
    // Completing a done task is only a no-op when the caller's version is
    // current. A stale expectedVersion still conflicts (the stronger contract
    // suite checks this).
    if (mapping.localVersion !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }

    const current = await this.#requireRemoteTask(client, id, mapping.externalId);
    if (
      mapping.externalEtag !== undefined &&
      current.etag !== null &&
      current.etag !== mapping.externalEtag
    ) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }

    const fields = this.#plannerFields.getTask(id) ?? defaultPlannerTaskFields();
    if (current.data.done === true) {
      const dependsOn = await this.#remoteDependencies(ownerId, current.data);
      return this.#toTask(ownerId, mapping, current.data, fields, dependsOn);
    }

    await client.patchTask(mapping.externalId, { done: true });

    let latest: { readonly data: VikunjaTask; readonly etag: string | null };
    try {
      latest = await client.getTask(mapping.externalId);
    } catch (error) {
      await this.#markNeedsReconcile(mapping);
      throw error;
    }

    const now = this.#clock.now();
    const latestUpdatedAt = normalizeRemoteInstant(latest.data.updated);
    const updated: ExternalMapping = {
      ...mapping,
      ...(latest.etag === null ? {} : { externalEtag: latest.etag }),
      ...(latestUpdatedAt === undefined ? {} : { externalUpdatedAt: latestUpdatedAt }),
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    // A repeating task may reopen upstream immediately; reflect the provider.
    const nextStatus: TaskStatus = latest.data.done === true ? 'done' : 'todo';
    const nextFields: PlannerTaskFields = { ...fields, status: nextStatus };
    await this.#mappings.put(updated);
    this.#plannerFields.putTask(id, nextFields);
    await this.#appendJournal(
      ownerId,
      updated,
      updated.externalUpdatedAt ?? now,
      undefined,
      now,
    );
    const dependsOn = await this.#remoteDependencies(ownerId, latest.data);
    return this.#toTask(ownerId, updated, latest.data, nextFields, dependsOn);
  }

  async softDelete(ownerId: Id, id: Id, expectedVersion: Version): Promise<void> {
    const client = this.#requireClient(ownerId);
    let mapping = await this.#requireMapping(ownerId, 'task', id);
    if (mapping.needsReconcile === true) {
      mapping = await this.#reconcileMapping(ownerId, client, mapping);
    }
    if (mapping.deletedAt !== undefined) throw new NotFoundError('task', id);
    if (mapping.localVersion !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }
    const current = await this.#requireRemoteTask(client, id, mapping.externalId);
    if (
      mapping.externalEtag !== undefined &&
      current.etag !== null &&
      current.etag !== mapping.externalEtag
    ) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }

    await client.deleteTask(mapping.externalId);
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
    let baseline: ChangeCursor;
    if (cursor === null) {
      // Full resync: read the whole retained journal for this owner.
      baseline = { ...EMPTY_CHANGE_CURSOR, epoch };
    } else {
      if (decoded.epoch !== epoch) {
        throw new CursorInvalidatedError(
          'change cursor belongs to a different journal epoch; full resync required',
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

    const client = this.#clientFor(ownerId);
    if (client !== undefined) {
      await this.#reconcileRemote(ownerId, client, baseline.seconds);
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
        ? baseline
        : {
            seconds: epochSeconds(last.at),
            externalId: last.externalId,
            sequence: last.sequence,
            epoch,
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

  async #commitReconciled(
    ownerId: Id,
    mapping: ExternalMapping,
    remote: VikunjaTask,
    etag: string | null,
  ): Promise<ExternalMapping> {
    const updatedAt = normalizeRemoteInstant(remote.updated);
    const now = this.#clock.now();
    const updated: ExternalMapping = {
      ...mapping,
      ...(etag === null ? {} : { externalEtag: etag }),
      ...(updatedAt === undefined ? {} : { externalUpdatedAt: updatedAt }),
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    await this.#mappings.put(updated);
    await this.#appendJournal(ownerId, updated, updatedAt ?? now);
    return updated;
  }

  async #reconcileRemote(
    ownerId: Id,
    client: VikunjaClient,
    fromSeconds: number,
  ): Promise<void> {
    const fromInstant = epochMsToInstant(Math.max(0, fromSeconds) * 1000);
    const live = await client.listAllTasks({
      filter: `updated >= "${fromInstant}"`,
      sort_by: 'updated',
      order_by: 'asc',
    });
    for (const candidate of live) {
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
      if (
        mapping.needsReconcile !== true &&
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
        ...mapping,
        localVersion: (mapping.localVersion + 1) as Version,
        updatedAt: now,
        deletedAt,
        needsReconcile: false,
      };
      await this.#mappings.put(updated);
      await this.#appendJournal(ownerId, updated, deletedAt, deletedAt);
    }
  }
}

export function createVikunjaTaskRepository(
  options: VikunjaTaskRepositoryOptions,
): VikunjaTaskRepository {
  return new VikunjaTaskRepository(options);
}

