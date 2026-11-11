import type {
  Id,
  Instant,
  LinkTargetKind,
  NoteSensitivity,
  NoteSource,
  Version,
} from '@ohmydate/domain';
import type { NoteContextDocument, NoteContextDocumentUsage } from '@ohmydate/llm';

export interface NoteLinkRecord {
  readonly id: Id;
  readonly documentId: Id;
  readonly targetKind: LinkTargetKind;
  readonly targetId: Id;
  readonly createdAt: Instant;
}

export interface NoteRecord {
  readonly id: Id;
  readonly ownerId: Id;
  readonly title: string;
  readonly bodyMd: string;
  readonly sensitivity: NoteSensitivity;
  readonly llmAllowed: boolean;
  readonly source: NoteSource;
  readonly sourceTaskId?: Id;
  readonly links: readonly NoteLinkRecord[];
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface NoteCreateRecord {
  readonly id: Id;
  readonly ownerId: Id;
  readonly title: string;
  readonly bodyMd: string;
  readonly sensitivity: NoteSensitivity;
  readonly llmAllowed: boolean;
  readonly source: NoteSource;
  readonly sourceTaskId?: Id;
  readonly links: readonly {
    readonly id: Id;
    readonly targetKind: LinkTargetKind;
    readonly targetId: Id;
  }[];
}

export interface NotePatchRecord {
  readonly title?: string;
  readonly bodyMd?: string;
  readonly sensitivity?: NoteSensitivity;
  readonly llmAllowed?: boolean;
}

export interface LinkTarget {
  readonly kind: LinkTargetKind;
  readonly id: Id;
}

export interface NoteListQuery {
  /** Letter/digit tokens; each becomes a `token:*` prefix term ANDed together. */
  readonly terms?: readonly string[];
  readonly target?: LinkTarget;
  readonly offset: number;
  readonly limit: number;
}

export interface NoteUsageRecord {
  readonly id: Id;
  readonly documentId: Id;
  readonly agentRunId: Id;
  readonly purpose: string;
  readonly promptIdVersion: string;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'budget_exceeded';
  readonly provider: string;
  readonly model: string;
  readonly documentVersion: number;
  readonly bodyHash: string;
  readonly sectionHashes: readonly string[];
  readonly sentBytes: number;
  readonly currentVersion: number;
  readonly createdAt: Instant;
}

/** Owner-scoped persistence for notes; every method filters by `ownerId`. */
export interface NoteStore {
  create(input: NoteCreateRecord): Promise<NoteRecord>;
  /** Live (not soft-deleted) note or null. */
  get(ownerId: Id, id: Id): Promise<NoteRecord | null>;
  list(ownerId: Id, query: NoteListQuery): Promise<{ readonly items: readonly NoteRecord[]; readonly hasMore: boolean }>;
  /** CAS on version; throws NotFoundError / VersionConflictError. */
  update(ownerId: Id, id: Id, patch: NotePatchRecord, expectedVersion: number): Promise<NoteRecord>;
  softDelete(ownerId: Id, id: Id, expectedVersion: number): Promise<void>;
  /** Duplicate or over-cap links are ValidationFailedError; bumps the note version. */
  addLink(
    ownerId: Id,
    id: Id,
    link: { readonly id: Id; readonly targetKind: LinkTargetKind; readonly targetId: Id },
    expectedVersion: number,
  ): Promise<NoteRecord>;
  removeLink(ownerId: Id, id: Id, linkId: Id, expectedVersion: number): Promise<NoteRecord>;
  findLivePromoted(ownerId: Id, taskId: Id): Promise<NoteRecord | null>;
  goalExists(ownerId: Id, goalId: Id): Promise<boolean>;
  listUsage(
    ownerId: Id,
    documentId: Id,
    offset: number,
    limit: number,
  ): Promise<{ readonly items: readonly NoteUsageRecord[]; readonly hasMore: boolean }>;
}

export interface NoteUsageInput {
  readonly ownerId: Id;
  readonly agentRunId: Id;
  /** agent_run purpose, e.g. `decomposition`. */
  readonly purpose: string;
  readonly entries: readonly NoteContextDocumentUsage[];
}

export interface HallucinatedRefEventInput {
  readonly id: Id;
  readonly ownerId: Id;
  readonly agentRunId: Id;
  /** Counts per reason only (`unknown_document`, ...); never ids or text. */
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Narrow port the intake flow uses for note grounding (M6-01). Implementations
 * return ONLY live notes of the owner with `llm_allowed = true` linked to one of
 * the targets; the context builder re-checks the same conditions.
 */
export interface NoteContextSource {
  linkedForContext(
    ownerId: Id,
    targets: readonly LinkTarget[],
    limit: number,
  ): Promise<readonly NoteContextDocument[]>;
  recordUsage(input: NoteUsageInput, ids: () => Id): Promise<void>;
  recordHallucinatedRefs(input: HallucinatedRefEventInput): Promise<void>;
}
