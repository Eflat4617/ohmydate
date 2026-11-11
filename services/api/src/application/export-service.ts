import type { Export, ExportStartResponse } from '@ohmydate/contracts';
import {
  NotFoundError,
  epochMsToInstant,
  instantToEpochMs,
  type Clock,
  type Id,
  type IdGenerator,
  type Instant,
} from '@ohmydate/domain';

const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURE_LENGTH = 100;

export interface ExportRecord {
  readonly id: Id;
  readonly ownerId: Id;
  readonly state: Export['state'];
  readonly createdAt: Instant;
  readonly expiresAt?: Instant;
  readonly sizeBytes?: number;
  readonly failureReason?: string;
}

export interface ExportArtifact {
  readonly record: ExportRecord;
  readonly content: Buffer;
}

export interface ExportStore {
  createQueued(ownerId: Id, id: Id, now: Instant): Promise<void>;
  markRunning(ownerId: Id, id: Id, now: Instant): Promise<void>;
  markFailed(ownerId: Id, id: Id, code: string, now: Instant): Promise<void>;
  saveReady(
    ownerId: Id,
    id: Id,
    content: Buffer,
    now: Instant,
    expiresAt: Instant,
  ): Promise<ExportRecord>;
  get(ownerId: Id, id: Id): Promise<ExportRecord | null>;
  readArtifact(ownerId: Id, id: Id): Promise<ExportArtifact | null>;
}

export interface ExportServiceDependencies {
  readonly store: ExportStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface ExportPayloadBuilder {
  build(ownerId: Id, now: Instant): Promise<Buffer>;
}

export class ExportService {
  readonly #store: ExportStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #builder: ExportPayloadBuilder;

  constructor(deps: ExportServiceDependencies & { readonly builder: ExportPayloadBuilder }) {
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#builder = deps.builder;
  }

  /**
   * Creates the job row, then runs the (bounded, owner-scoped) export job.
   * The HTTP response stays 202: the job is complete by the time the caller
   * reads the returned export id, so GET is deterministic for small M4 data.
   */
  async start(ownerId: Id): Promise<ExportStartResponse> {
    const now = this.#clock.now();
    const id = this.#ids.next();
    await this.#store.createQueued(ownerId, id, now);
    await this.#process(ownerId, id);
    return { exportId: id };
  }

  async get(ownerId: Id, id: Id, baseUrl = 'http://localhost'): Promise<Export> {
    const record = await this.#store.get(ownerId, id);
    if (record === null) throw new NotFoundError('export', id);
    return toDto(record, baseUrl.replace(/\/+$/, ''));
  }

  async download(ownerId: Id, id: Id): Promise<ExportArtifact> {
    const artifact = await this.#store.readArtifact(ownerId, id);
    if (artifact === null) throw new NotFoundError('export', id);
    return artifact;
  }

  async #process(ownerId: Id, id: Id): Promise<void> {
    const started = this.#clock.now();
    try {
      await this.#store.markRunning(ownerId, id, started);
      const content = await this.#builder.build(ownerId, started);
      const expiresAt = epochMsToInstant(instantToEpochMs(started) + EXPORT_TTL_MS);
      await this.#store.saveReady(ownerId, id, content, started, expiresAt);
    } catch (error) {
      const code = (
        error instanceof Error ? error.message : 'export_failed'
      ).slice(0, MAX_FAILURE_LENGTH);
      await this.#store.markFailed(ownerId, id, code.length === 0 ? 'export_failed' : code, started);
    }
  }
}

function toDto(record: ExportRecord, baseUrl: string): Export {
  return {
    id: record.id,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.state === 'ready'
      ? { downloadUrl: `${baseUrl}/api/v1/exports/${record.id}?download=1` }
      : {}),
    ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }),
    ...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
  };
}
