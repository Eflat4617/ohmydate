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
import { appendMarker, extractMarker, stripMarker } from './marker.js';
import { normalizeRemoteInstant } from './time.js';
import {
  defaultPlannerTaskFields,
  InMemoryPlannerFieldStore,
  type PlannerFieldStore,
  type PlannerTaskFields,
} from './planner-field-store.js';
import { type NormalizedTaskCreate, validateTaskCreate, validateTaskPatch } from './validation.js';
import { VikunjaProjectRepository } from './project-repository.js';

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
function contentFingerprint(
  remote: VikunjaTask,
  dependencyExternalIds?: readonly string[],
): string {
  const related = remote.related_tasks?.[DEPENDENCY_RELATION_KIND] ?? [];
  // `dependencyExternalIds` lets create() record the relations it just wrote
  // even though the POST/follow-up payload predates the createRelation calls.
  const relationIds = (
    dependencyExternalIds === undefined
      ? related.map((task) => String(task.id))
      : [...dependencyExternalIds]
  ).sort();
  return JSON.stringify({
    title: remote.title,
    description: stripMarker(remote.description) ?? '',
    done: remote.done === true,
    dueAt: normalizeRemoteInstant(remote.due_date) ?? '',
    projectId: remote.project_id === undefined ? '' : String(remote.project_id),
    relations: relationIds,
  });
}

/**
 * FU-73: Vikunja v2.8.0 touches the base task's `updated` column (and with it
 * the second-precision ETag) from an asynchronous event listener *after* a
 * relation create/delete response has returned. Measured live: 10-60 ms on an
 * idle host, longer under load; the task on the other side of the relation is
 * not touched. When the touch lands in a later second than the adapter's last
 * read, the ETag moves although nothing the planner maps changed. That used to
 * surface as a phantom version bump on the next poll, and the next write at the
 * version the adapter had just returned got a 412.
 *
 * After its own relation writes the adapter therefore raises the mapping's
 * `externalUpdatedAt` to an accounted-for watermark: the provider-clock time of
 * the relation write plus this grace (never the planner clock). An observation
 * whose content fingerprint is unchanged and whose `updated` is still before
 * the watermark is the adapter's own touch and is adopted without a bump.
 * Content changes always bump. ETag-only changes at or after the watermark bump
 * as before. Mappings without an adapter relation write keep
 * `externalUpdatedAt` equal to the observed `updated`, so their behaviour is
 * unchanged.
 */
const SELF_TOUCH_GRACE_MS = 10_000;

/**
 * FU-81: upper bound on dependents re-read by one delete follow-up (one
 * `softDelete`, or one poll). Dependents beyond it still name the deleted
 * task in their fingerprint, so the next poll picks them up.
 */
export const DELETED_DEPENDENT_RESCAN_LIMIT = 50;

/**
 * External ids of the dependency relations a mapping fingerprint recorded.
 * This is the adapter's reverse edge set (FU-81): the relations the mapping's
 * current version was reconciled against. A dependent whose fingerprint still
 * names a deleted task has not yet been versioned for losing that dependency.
 */
function recordedRelations(fingerprint: string | undefined): readonly string[] {
  if (fingerprint === undefined) return [];
  try {
    const parsed = JSON.parse(fingerprint) as { readonly relations?: unknown };
    return Array.isArray(parsed.relations)
      ? parsed.relations.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

function namesAnyOf(mapping: ExternalMapping, externalIds: ReadonlySet<string>): boolean {
  return recordedRelations(mapping.contentFingerprint).some((id) => externalIds.has(id));
}

function latestInstant(...values: readonly (Instant | undefined)[]): Instant | undefined {
  let latest: Instant | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (latest === undefined || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}

/**
 * Accounted-for watermark after the adapter's own relation writes (FU-73).
 * Provider time only: the write times Vikunja reported, falling back to the
 * newest observed `updated` when it reported none.
 */
function selfTouchWatermark(
  writeTimes: readonly (Instant | undefined)[],
  observedUpdatedAt: Instant | undefined,
): Instant | undefined {
  const base = latestInstant(...writeTimes, observedUpdatedAt);
  return base === undefined
    ? undefined
    : epochMsToInstant(Date.parse(base) + SELF_TOUCH_GRACE_MS);
}

interface RemoteObservation {
  readonly fingerprint: string;
  readonly updatedAt: Instant | undefined;
  /** The mapped provider content differs from the mapping baseline. */
  readonly contentChanged: boolean;
  /** The ETag moved and the move is not the adapter's own relation touch. */
  readonly etagChanged: boolean;
  /** No ETag was sent and `updated` moved without being accounted for. */
  readonly updatedChanged: boolean;
}

/**
 * Compares a provider observation with the mapping baseline. The ETag is
 * authoritative when both sides have one. The content fingerprint catches
 * same-second writes that reuse an ETag. A missing local baseline is treated as
 * unknown, so the first reconciliation after a failed create follow-up adopts
 * the observed ETag without inventing a version bump (FU-17). An ETag move with
 * unchanged content whose `updated` is still before the accounted-for
 * watermark is the adapter's own asynchronous relation touch (FU-73).
 */
function observeRemote(
  mapping: ExternalMapping,
  remote: VikunjaTask,
  etag: string | null,
): RemoteObservation {
  const fingerprint = contentFingerprint(remote);
  const updatedAt = normalizeRemoteInstant(remote.updated);
  const contentChanged =
    mapping.contentFingerprint !== undefined && mapping.contentFingerprint !== fingerprint;
  const ownTouch =
    mapping.contentFingerprint !== undefined &&
    !contentChanged &&
    updatedAt !== undefined &&
    mapping.externalUpdatedAt !== undefined &&
    Date.parse(updatedAt) < Date.parse(mapping.externalUpdatedAt);
  const etagChanged =
    !ownTouch &&
    mapping.externalEtag !== undefined &&
    etag !== null &&
    etag !== mapping.externalEtag;
  const updatedChanged =
    !ownTouch &&
    mapping.externalUpdatedAt !== undefined &&
    etag === null &&
    updatedAt !== undefined &&
    mapping.externalUpdatedAt !== updatedAt;
  return { fingerprint, updatedAt, contentChanged, etagChanged, updatedChanged };
}

export interface VikunjaTaskRepositoryOptions {
  readonly clients: ReadonlyMap<Id, VikunjaClient>;
  readonly mappings?: MappingStore;
  readonly plannerFields?: PlannerFieldStore;
  readonly journal?: ChangeJournalStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The served project repository. Injecting it shares the per-owner Inbox
   * coalescing with GET /projects instead of building a second instance.
   */
  readonly projects?: VikunjaProjectRepository;
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
 *    A delete changes the dependents' relations without touching them, so
 *    every trashed task also re-reads the dependents that still name it
 *    (FU-81, `#reconcileDeletedDependents`).
 */
export class VikunjaTaskRepository implements TaskRepository {
  readonly capabilities: RepositoryCapabilities = CAPABILITIES;

  readonly #clients: ReadonlyMap<Id, VikunjaClient>;
  readonly #mappings: MappingStore;
  readonly #plannerFields: PlannerFieldStore;
  readonly #journal: ChangeJournalStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #projects: VikunjaProjectRepository;

  constructor(options: VikunjaTaskRepositoryOptions) {
    this.#clients = options.clients;
    this.#mappings = options.mappings ?? new InMemoryMappingStore();
    this.#plannerFields = options.plannerFields ?? new InMemoryPlannerFieldStore();
    this.#journal = options.journal ?? new InMemoryChangeJournalStore();
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#projects =
      options.projects ??
      new VikunjaProjectRepository({
        clients: options.clients,
        mappings: this.#mappings,
        clock: options.clock,
        ids: options.ids,
      });
  }

  async create(
    ownerId: Id,
    input: TaskCreate,
    _idemKey: string,
    opts?: { readonly plannedId?: Id },
  ): Promise<Task> {
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

    if (opts?.plannedId !== undefined) {
      const plannedId = opts.plannedId;
      const mapping = await this.#mappings.get('task', plannedId);
      if (mapping !== null && mapping.ownerId === ownerId && mapping.deletedAt === undefined) {
        const existing = await this.get(ownerId, plannedId);
        if (existing !== null) return existing;
      }
      // ADR-016 §2: recover an upstream task whose marker already carries the
      // planned planner id before attempting a re-create.
      //
      // knownLimitation (ADR-020 §3): if a user edits the orphan's description
      // and removes/alters the marker before the retry, the orphan cannot be
      // found and the retry creates a duplicate. Single-user intake tasks are
      // not exposed before an approval completes, so this is accepted; the
      // behaviour is pinned by a live regression test.
      const candidates = await client.listAllProjectTasks(projectMapping.externalId);
      const orphan = candidates.find(
        (candidate) => extractMarker(candidate.description) === plannedId,
      );
      if (orphan !== undefined) {
        return this.#adoptOrphan(ownerId, client, plannedId, normalized, orphan);
      }
    }

    const id = opts?.plannedId ?? this.#ids.next();
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
    // FU-73: the relation writes below touch `updated` asynchronously. Account
    // for them before the first write, so a poll inside the create window
    // cannot adopt the pre-touch ETag as the final baseline.
    const baselineUpdatedAt =
      normalized.dependsOn.length > 0
        ? selfTouchWatermark([], remoteUpdatedAt)
        : remoteUpdatedAt;
    const mapping: ExternalMapping = {
      provider: 'vikunja',
      entityType: 'task',
      entityId: id,
      externalId: String(remote.id),
      ownerId,
      ...(etag === null ? {} : { externalEtag: etag }),
      ...(baselineUpdatedAt === undefined ? {} : { externalUpdatedAt: baselineUpdatedAt }),
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

    const dependencyExternalIds: string[] = [];
    const relationWriteTimes: (Instant | undefined)[] = [];
    try {
      for (const dependencyId of normalized.dependsOn) {
        const dependency = await this.#requireMapping(ownerId, 'task', dependencyId);
        relationWriteTimes.push(
          await client.createRelation(
            mapping.externalId,
            dependency.externalId,
            DEPENDENCY_RELATION_KIND,
          ),
        );
        dependencyExternalIds.push(dependency.externalId);
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

    // Relations are written after the task payload, so the POST/follow-up body
    // cannot carry them. Record the fingerprint only now: storing it earlier
    // made every first write at the returned v1 look externally changed and
    // produced a phantom v2 (FU-14R HIGH). This also covers followUpFailed,
    // where `remote` is the POST body and the next GET will include the
    // relations created below.
    //
    // The ETag stays the pre-relation one: Vikunja touches `updated` for every
    // relation write asynchronously (FU-73), so no read here could be relied on
    // to see the final ETag. The watermark accounts for those touches instead,
    // based on the provider time of the last relation write.
    if (dependencyExternalIds.length > 0) {
      const targetFingerprint = contentFingerprint(remote, dependencyExternalIds);
      const watermark = latestInstant(
        mapping.externalUpdatedAt,
        selfTouchWatermark(relationWriteTimes, remoteUpdatedAt),
      );
      const withRelations: ExternalMapping = {
        ...mapping,
        ...(watermark === undefined ? {} : { externalUpdatedAt: watermark }),
        contentFingerprint: targetFingerprint,
      };
      const committed = await this.#putWithPrecondition(
        withRelations,
        mapping.localVersion,
        targetFingerprint,
      );
      if (committed.fresh) {
        await this.#appendJournal(ownerId, committed.mapping, remoteUpdatedAt ?? now);
      }
      return this.#toTask(
        ownerId,
        committed.mapping,
        remote,
        fields,
        normalized.dependsOn,
      );
    }

    await this.#appendJournal(ownerId, mapping, remoteUpdatedAt ?? now);
    return this.#toTask(ownerId, mapping, remote, fields, normalized.dependsOn);
  }

  async #adoptOrphan(
    ownerId: Id,
    client: VikunjaClient,
    id: Id,
    normalized: NormalizedTaskCreate,
    remote: VikunjaTask,
  ): Promise<Task> {
    let full = remote;
    let etag: string | null = null;
    try {
      const fetched = await client.getTask(String(remote.id));
      full = fetched.data;
      etag = fetched.etag;
    } catch {
      // Keep the list payload; a later get/list refreshes the ETag.
    }

    // ADR-020 §4: an adopted orphan must actually have its intended dependency
    // relations upstream before the step is reported as created. Resolve the
    // current relation set first so a retry after a partial write only adds
    // what is still missing.
    const dependencyExternalIds: string[] = [];
    for (const dependencyId of normalized.dependsOn) {
      const dependency = await this.#requireMapping(ownerId, 'task', dependencyId);
      dependencyExternalIds.push(dependency.externalId);
    }
    const present = new Set(
      (full.related_tasks?.[DEPENDENCY_RELATION_KIND] ?? []).map((task) =>
        String(task.id),
      ),
    );
    const relationWriteTimes: (Instant | undefined)[] = [];
    for (const externalId of dependencyExternalIds) {
      if (present.has(externalId)) continue;
      relationWriteTimes.push(
        await client.createRelation(String(full.id), externalId, DEPENDENCY_RELATION_KIND),
      );
    }
    if (dependencyExternalIds.length > 0) {
      // Refresh so the persisted fingerprint reflects the relations just
      // written (including ones added by an earlier partial attempt).
      try {
        const refreshed = await client.getTask(String(full.id));
        full = refreshed.data;
        etag = refreshed.etag;
      } catch {
        // Keep the payload; the fingerprint below records the intended ids.
      }
    }

    const now = this.#clock.now();
    const remoteUpdatedAt = normalizeRemoteInstant(full.updated);
    // FU-73: the refresh above can precede the asynchronous `updated` touch of
    // the relation writes (this attempt's, or a just-failed earlier attempt's).
    const baselineUpdatedAt =
      dependencyExternalIds.length > 0
        ? selfTouchWatermark(relationWriteTimes, remoteUpdatedAt)
        : remoteUpdatedAt;
    const mapping: ExternalMapping = {
      provider: 'vikunja',
      entityType: 'task',
      entityId: id,
      externalId: String(full.id),
      ownerId,
      ...(etag === null ? {} : { externalEtag: etag }),
      ...(baselineUpdatedAt === undefined ? {} : { externalUpdatedAt: baselineUpdatedAt }),
      contentFingerprint: contentFingerprint(full, dependencyExternalIds),
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
    await this.#appendJournal(ownerId, mapping, remoteUpdatedAt ?? now);
    return this.#toTask(ownerId, mapping, full, fields, normalized.dependsOn);
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
    const relationWriteTimes: (Instant | undefined)[] = [];
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
        (at) => {
          remoteWriteApplied = true;
          relationWriteTimes.push(at);
        },
      );
    } catch (error) {
      // ProviderUnavailable means the write may have been applied before the
      // response was lost. Anything else (4xx validation/conflict) is a
      // definitive non-application unless an earlier write already succeeded.
      if (error instanceof ProviderUnavailableError || remoteWriteApplied) {
        await this.#markNeedsReconcile(
          mapping,
          selfTouchWatermark(relationWriteTimes, undefined),
        );
      }
      throw error;
    }

    let latest: { readonly data: VikunjaTask; readonly etag: string | null };
    try {
      latest = await client.getTask(mapping.externalId);
    } catch (error) {
      // The PATCH/relation write may already be visible upstream. Never commit
      // staged planner fields; force a reconciliation on the next read.
      await this.#markNeedsReconcile(
        mapping,
        selfTouchWatermark(relationWriteTimes, undefined),
      );
      throw error;
    }

    const now = this.#clock.now();
    const latestUpdatedAt = normalizeRemoteInstant(latest.data.updated);
    const targetFingerprint = contentFingerprint(latest.data);
    // FU-73: the final read can precede the asynchronous `updated` touch of the
    // relation writes above; an earlier write's watermark is kept as well.
    const watermark = latestInstant(
      mapping.externalUpdatedAt,
      latestUpdatedAt,
      relationWriteTimes.length > 0
        ? selfTouchWatermark(relationWriteTimes, latestUpdatedAt)
        : undefined,
    );
    const updated: ExternalMapping = {
      ...mapping,
      ...(latest.etag === null ? {} : { externalEtag: latest.etag }),
      ...(watermark === undefined ? {} : { externalUpdatedAt: watermark }),
      contentFingerprint: targetFingerprint,
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    const committed = await this.#putWithPrecondition(
      updated,
      mapping.localVersion,
      targetFingerprint,
      plannerFieldsEqual(fields, nextFields),
    );
    await this.#plannerFields.putTask(id, nextFields);
    if (committed.fresh) {
      await this.#appendJournal(ownerId, committed.mapping, latestUpdatedAt ?? now);
    }
    return this.#toTask(
      ownerId,
      committed.mapping,
      latest.data,
      nextFields,
      desiredDependencies,
    );
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
    await this.#mappings.put(withIntent, {
      expectedLocalVersion: mapping.localVersion,
    });
    mapping = withIntent;

    try {
      await client.patchTask(mapping.externalId, { done: true });
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        await this.#markNeedsReconcile(mapping);
      } else {
        // Definitive 4xx: the completion was not applied. A concurrent poll
        // may already own a newer version; never overwrite it with this one.
        const pendingVersion = mapping.localVersion;
        try {
          await this.#mappings.put(withoutPending(mapping), {
            expectedLocalVersion: pendingVersion,
          });
        } catch (settleError) {
          if (!(settleError instanceof VersionConflictError)) throw settleError;
        }
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
    const targetFingerprint = contentFingerprint(latest.data);
    // Keep an earlier relation write's FU-73 watermark if it is still ahead.
    const watermark = latestInstant(mapping.externalUpdatedAt, latestUpdatedAt);
    const updated: ExternalMapping = {
      ...base,
      ...(latest.etag === null ? {} : { externalEtag: latest.etag }),
      ...(watermark === undefined ? {} : { externalUpdatedAt: watermark }),
      contentFingerprint: targetFingerprint,
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    // A repeating task may reopen upstream immediately; reflect the provider.
    const nextStatus: TaskStatus = latest.data.done === true ? 'done' : 'todo';
    const nextFields: PlannerTaskFields = { ...fields, status: nextStatus };
    const committed = await this.#putWithPrecondition(
      updated,
      mapping.localVersion,
      targetFingerprint,
    );
    await this.#plannerFields.putTask(id, nextFields);
    // The completion record belongs to the occurrence that was due when the
    // task was completed. Fall back to the completion time only when the task
    // had no due date (FU-17).
    if (!committed.fresh) {
      const dependsOn = await this.#remoteDependencies(ownerId, latest.data);
      return this.#toTask(
        ownerId,
        committed.mapping,
        latest.data,
        nextFields,
        dependsOn,
      );
    }
    await this.#appendJournal(
      ownerId,
      committed.mapping,
      latestUpdatedAt ?? now,
      undefined,
      dueAtBefore ?? now,
    );
    const dependsOn = await this.#remoteDependencies(ownerId, latest.data);
    return this.#toTask(ownerId, committed.mapping, latest.data, nextFields, dependsOn);
  }

  /**
   * Soft-deletes the task upstream. Vikunja drops the dependents' `blocked`
   * relation in the same request but does not touch their `updated` or ETag
   * (measured live, FU-81), so the incremental `updated >=` scan would never
   * see them. After committing the tombstone the adapter therefore re-reads
   * the dependents its reverse edges name (`#reconcileDeletedDependents`) and
   * commits each one once with a new version and the dependency dropped.
   * A client still holding the dependent's old version therefore gets a
   * `VersionConflictError` on its next write; this is intentional,
   * provider-faithful behavior (FU-14R LOW).
   *
   * That follow-up is best-effort: the delete is already committed and
   * reported, and a dependent left unreconciled still names the deleted task,
   * which stays in Vikunja's trash, so the next poll retries it.
   */
  async softDelete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Version> {
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
    const committed = await this.#putWithPrecondition(
      updated,
      mapping.localVersion,
      updated.contentFingerprint,
    );
    if (committed.fresh) {
      await this.#appendJournal(ownerId, committed.mapping, now, now);
    }
    try {
      await this.#reconcileDeletedDependents(
        ownerId,
        client,
        new Set([mapping.externalId]),
      );
    } catch {
      // Best-effort (see above): the next poll retries the dependents.
    }
    return committed.mapping.localVersion;
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
    _client: VikunjaClient,
    projectId: Id | undefined,
  ): Promise<ExternalMapping> {
    if (projectId !== undefined) {
      return this.#requireMapping(ownerId, 'project', projectId);
    }
    // ADR-018: no projectId means the owner's Inbox. getInbox is idempotent and
    // concurrency-safe; routing through the project adapter keeps the mapping
    // and the Vikunja default project in one place.
    const inbox = await this.#projects.getInbox(ownerId);
    return this.#requireMapping(ownerId, 'project', inbox.id);
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

  /**
   * `onApplied` receives the provider-clock time of each relation write (FU-73:
   * Vikunja touches the base task's `updated` asynchronously afterwards).
   */
  async #applyDependencyDiff(
    client: VikunjaClient,
    externalTaskId: string,
    current: readonly Id[],
    desired: readonly Id[],
    onApplied: (at: Instant | undefined) => void,
  ): Promise<void> {
    const currentSet = new Set(current);
    const desiredSet = new Set(desired);
    for (const dependencyId of current) {
      if (desiredSet.has(dependencyId)) continue;
      const mapping = await this.#mappings.get('task', dependencyId);
      if (mapping === null) continue;
      onApplied(
        await client.deleteRelation(
          externalTaskId,
          DEPENDENCY_RELATION_KIND,
          mapping.externalId,
        ),
      );
    }
    for (const dependencyId of desired) {
      if (currentSet.has(dependencyId)) continue;
      const mapping = await this.#mappings.get('task', dependencyId);
      if (mapping === null) throw new NotFoundError('task', dependencyId);
      onApplied(
        await client.createRelation(
          externalTaskId,
          mapping.externalId,
          DEPENDENCY_RELATION_KIND,
        ),
      );
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

  /**
   * FU-22: every mapping write that follows a version bump is a compare-and-set
   * on `localVersion`. When a concurrent poll/writer already committed the same
   * provider state (matching content fingerprint and deletion marker) this
   * adopts it instead of reissuing a second version for one state. Otherwise it
   * retries once from the freshly read mapping, so a stale snapshot can never
   * regress `localVersion` or reuse a version number.
   */
  async #putWithPrecondition(
    candidate: ExternalMapping,
    expected: Version,
    adoptFingerprint: string | undefined,
    allowAdopt = true,
  ): Promise<{ readonly mapping: ExternalMapping; readonly fresh: boolean }> {
    try {
      await this.#mappings.put(candidate, { expectedLocalVersion: expected });
      return { mapping: candidate, fresh: true };
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      const current = await this.#mappings.get(
        candidate.entityType,
        candidate.entityId,
      );
      if (current === null) throw error;
      const deletedMatches =
        current.deletedAt === candidate.deletedAt ||
        (current.deletedAt !== undefined && candidate.deletedAt !== undefined);
      if (
        allowAdopt &&
        adoptFingerprint !== undefined &&
        current.localVersion > expected &&
        current.contentFingerprint === adoptFingerprint &&
        deletedMatches
      ) {
        return { mapping: current, fresh: false };
      }
      const retried: ExternalMapping = {
        ...candidate,
        localVersion: (current.localVersion + 1) as Version,
      };
      await this.#mappings.put(retried, {
        expectedLocalVersion: current.localVersion,
      });
      return { mapping: retried, fresh: true };
    }
  }

  /**
   * `watermark` accounts for the asynchronous `updated` touch of relation writes
   * that were applied before the failure (FU-73), so the reconciliation that
   * follows cannot settle on a pre-touch ETag.
   */
  async #markNeedsReconcile(mapping: ExternalMapping, watermark?: Instant): Promise<void> {
    const externalUpdatedAt = latestInstant(mapping.externalUpdatedAt, watermark);
    try {
      await this.#mappings.put(
        {
          ...mapping,
          ...(externalUpdatedAt === undefined ? {} : { externalUpdatedAt }),
          needsReconcile: true,
        },
        { expectedLocalVersion: mapping.localVersion },
      );
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      // A newer writer won the race. Never mark that version for reconcile on
      // behalf of this stale snapshot; the newer path owns its own state.
    }
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
   * True when the provider state no longer matches what the mapping recorded
   * (see `observeRemote`; the adapter's own FU-73 relation touch does not
   * count).
   */
  #remoteChanged(
    mapping: ExternalMapping,
    remote: VikunjaTask,
    etag: string | null,
  ): boolean {
    const observation = observeRemote(mapping, remote, etag);
    return observation.etagChanged || observation.contentChanged;
  }

  async #commitReconciled(
    ownerId: Id,
    mapping: ExternalMapping,
    remote: VikunjaTask,
    etag: string | null,
  ): Promise<ExternalMapping> {
    const pending = mapping.pendingCompletion;
    const remoteDueAt = normalizeRemoteInstant(remote.due_date);
    const completed =
      pending !== undefined &&
      (remote.done === true ||
        (pending.dueAtBefore !== undefined &&
          remoteDueAt !== undefined &&
          Date.parse(remoteDueAt) > Date.parse(pending.dueAtBefore)));
    const observation = observeRemote(mapping, remote, etag);
    const { fingerprint, updatedAt } = observation;
    const changed =
      observation.etagChanged ||
      observation.updatedChanged ||
      completed ||
      observation.contentChanged;
    // FU-73: never lower an accounted-for watermark that is still ahead of the
    // observation; an own relation touch may not have landed yet.
    const watermark = latestInstant(mapping.externalUpdatedAt, updatedAt);
    const now = this.#clock.now();

    if (!changed) {
      // Settle an unknown-outcome intent or a reconcile marker without
      // inventing a version when the provider state did not change. Adopting
      // the first observed ETag/updated/fingerprint keeps a failed create
      // follow-up from looking changed forever (FU-17).
      const settled: ExternalMapping = {
        ...withoutPending(mapping),
        ...(etag === null ? {} : { externalEtag: etag }),
        ...(watermark === undefined ? {} : { externalUpdatedAt: watermark }),
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
        try {
          await this.#mappings.put(settled, {
            expectedLocalVersion: mapping.localVersion,
          });
        } catch (error) {
          if (!(error instanceof VersionConflictError)) throw error;
          // A concurrent commit already settled a newer version; skip rather
          // than regress it with this stale observation.
          const current = await this.#mappings.get('task', mapping.entityId);
          if (current === null) throw error;
          return current;
        }
      }
      return settled;
    }

    const base = withoutPending(mapping);
    const updated: ExternalMapping = {
      ...base,
      ...(etag === null ? {} : { externalEtag: etag }),
      ...(watermark === undefined ? {} : { externalUpdatedAt: watermark }),
      contentFingerprint: fingerprint,
      localVersion: (mapping.localVersion + 1) as Version,
      updatedAt: now,
      needsReconcile: false,
    };
    try {
      await this.#mappings.put(updated, {
        expectedLocalVersion: mapping.localVersion,
      });
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      // A concurrent writer advanced the mapping while this sweep held a
      // stale remote observation. Skip it: retrying would stamp an old
      // etag/fingerprint (and possibly a stale pendingCompletion) onto a newer
      // version. The next sweep re-reads fresh provider state.
      const current = await this.#mappings.get('task', mapping.entityId);
      if (current === null) throw error;
      return current;
    }
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
    // FU-81: every trashed task of this owner, tombstoned now or earlier. A
    // dependent that still names one of them was not reconciled yet (first
    // sighting, or an earlier follow-up failed) and is re-read below.
    const trashed = new Set<string>();
    for (const candidate of deleted) {
      const mapping = await this.#mappings.getByExternal(
        'vikunja',
        'task',
        String(candidate.id),
      );
      if (mapping === null || mapping.ownerId !== ownerId) continue;
      trashed.add(mapping.externalId);
      if (mapping.deletedAt !== undefined) continue;
      const deletedAt = normalizeRemoteInstant(candidate.deleted_at) ?? this.#clock.now();
      const now = this.#clock.now();
      const updated: ExternalMapping = {
        ...withoutPending(mapping),
        localVersion: (mapping.localVersion + 1) as Version,
        updatedAt: now,
        deletedAt,
        needsReconcile: false,
      };
      try {
        await this.#mappings.put(updated, {
          expectedLocalVersion: mapping.localVersion,
        });
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        // The scan and softDelete both observed the delete (or another writer
        // already advanced the tombstone). Adopt the current mapping: one
        // tombstone version is enough and a retry would duplicate the journal.
        continue;
      }
      await this.#appendJournal(ownerId, updated, deletedAt, deletedAt);
    }
    await this.#reconcileDeletedDependents(ownerId, client, trashed);

    if (!observedNewer) return fromSeconds;
    return Math.max(0, maxUpdatedSeconds - REMOTE_OVERLAP_SECONDS);
  }

  /**
   * FU-81: Vikunja drops a deleted task's incoming `blocked` relations without
   * touching the dependents' `updated` or ETag, so neither the incremental
   * `updated >=` scan nor an ETag comparison would ever surface them. The
   * reverse edges are the relations each mapping fingerprint recorded:
   * a live task mapping whose fingerprint names one of `deletedExternalIds` is
   * re-read and reconciled through `#commitReconciled`. The missing relation
   * is a content change, so it bumps the version and journals exactly once.
   * The FU-73 watermark is kept as-is.
   *
   * - Bounded: one owner-scoped `listByOwner`, then at most
   *   `DELETED_DEPENDENT_RESCAN_LIMIT` provider reads, only for dependents.
   *   Unrelated tasks are never read.
   * - Idempotent: a reconciled dependent no longer names the deleted task, so
   *   repeated polls (or a concurrent poll and `softDelete`) skip it. A
   *   concurrent commit wins the `localVersion` compare-and-set and the loser
   *   adopts it without journaling.
   * - Durable: a dependent left unreconciled after a failure still names the
   *   deleted task, which stays in `/tasks/deleted`, so the next poll retries.
   *   If the trash is emptied first, the next null-cursor scan (the periodic
   *   reconciler) re-reads every mapped task and reconciles it there.
   */
  async #reconcileDeletedDependents(
    ownerId: Id,
    client: VikunjaClient,
    deletedExternalIds: ReadonlySet<string>,
  ): Promise<void> {
    if (deletedExternalIds.size === 0) return;
    let budget = DELETED_DEPENDENT_RESCAN_LIMIT;
    for (const candidate of await this.#mappings.listByOwner(ownerId)) {
      if (budget === 0) return;
      if (
        candidate.entityType !== 'task' ||
        candidate.deletedAt !== undefined ||
        !namesAnyOf(candidate, deletedExternalIds)
      ) {
        continue;
      }
      // The listing is a snapshot; a concurrent writer may have reconciled or
      // deleted this dependent since.
      const mapping = await this.#mappings.get('task', candidate.entityId);
      if (
        mapping === null ||
        mapping.ownerId !== ownerId ||
        mapping.deletedAt !== undefined ||
        !namesAnyOf(mapping, deletedExternalIds)
      ) {
        continue;
      }
      budget -= 1;
      let current: { readonly data: VikunjaTask; readonly etag: string | null };
      try {
        current = await client.getTask(mapping.externalId);
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      await this.#commitReconciled(ownerId, mapping, current.data, current.etag);
    }
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

function plannerFieldsEqual(a: PlannerTaskFields, b: PlannerTaskFields): boolean {
  return (
    a.splittable === b.splittable &&
    a.priority === b.priority &&
    a.status === b.status &&
    a.session?.minMinutes === b.session?.minMinutes &&
    a.session?.maxMinutes === b.session?.maxMinutes &&
    a.dependsOn.length === b.dependsOn.length &&
    a.dependsOn.every((id, index) => id === b.dependsOn[index])
  );
}

export function createVikunjaTaskRepository(
  options: VikunjaTaskRepositoryOptions,
): VikunjaTaskRepository {
  return new VikunjaTaskRepository(options);
}
