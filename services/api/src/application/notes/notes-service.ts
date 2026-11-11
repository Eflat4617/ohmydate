import {
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  taskDescriptionToMarkdown,
  truncateCodePoints,
  validateNoteContent,
  type Id,
  type IdGenerator,
  type LinkTargetKind,
  type NoteSensitivity,
  type ProjectRepository,
  type TaskRepository,
  type Version,
} from '@ohmydate/domain';
import { DailyProblemError } from '../daily-errors.js';
import type { LinkTarget, NoteRecord, NoteStore, NoteUsageRecord } from './ports.js';

export const DEFAULT_NOTE_PAGE_LIMIT = 20;
export const MAX_NOTE_PAGE_LIMIT = 100;
/** Search terms per query; longer queries keep the first ones. */
export const MAX_SEARCH_TERMS = 8;
const MAX_TERM_LENGTH = 64;

export interface NotesServiceOptions {
  readonly store: NoteStore;
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly ids: IdGenerator;
}

export interface NoteListInput {
  readonly q?: string;
  readonly targetKind?: LinkTargetKind;
  readonly targetId?: Id;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface NoteCreateInput {
  readonly title: string;
  readonly bodyMd?: string;
  readonly sensitivity?: NoteSensitivity;
  readonly llmAllowed?: boolean;
  readonly links?: readonly { readonly targetKind: LinkTargetKind; readonly targetId: Id }[];
}

export interface NotePatchInput {
  readonly title?: string;
  readonly bodyMd?: string;
  readonly sensitivity?: NoteSensitivity;
  readonly llmAllowed?: boolean;
}

export interface Paged<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Letter/digit tokens of a search string (NFKC, lower-case, de-duplicated). Only
 * `\p{L}`/`\p{N}` survive, so a token can never contain a tsquery operator.
 */
export function noteSearchTerms(q: string): string[] {
  const terms: string[] = [];
  for (const token of q.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length === 0) continue;
    const term = truncateCodePoints(token, MAX_TERM_LENGTH);
    if (!terms.includes(term)) terms.push(term);
    if (terms.length === MAX_SEARCH_TERMS) break;
  }
  return terms;
}

const CURSOR_PREFIX = 'n1:';

function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^n1:(0|[1-9][0-9]{0,6})$/.exec(text);
  if (match === null) {
    throw new ValidationFailedError([{ path: '/cursor', message: 'invalid cursor' }]);
  }
  return Number(match[1]);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_NOTE_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_NOTE_PAGE_LIMIT, Math.floor(limit)));
}

function assertValid(input: { readonly title?: string; readonly bodyMd?: string }): void {
  const issues = validateNoteContent(input);
  if (issues.length > 0) throw new ValidationFailedError(issues);
}

/**
 * M6-01 notes use-cases (08 §2.7). Every operation is owner-scoped; link
 * targets and the promoted task are resolved through the owner's own
 * repositories, so a foreign or missing target is indistinguishable from a
 * missing one (404).
 */
export class NotesService {
  readonly #store: NoteStore;
  readonly #tasks: TaskRepository;
  readonly #projects: ProjectRepository;
  readonly #ids: IdGenerator;

  constructor(options: NotesServiceOptions) {
    this.#store = options.store;
    this.#tasks = options.tasks;
    this.#projects = options.projects;
    this.#ids = options.ids;
  }

  async #assertTarget(ownerId: Id, target: LinkTarget): Promise<void> {
    let found: boolean;
    switch (target.kind) {
      case 'goal':
        found = await this.#store.goalExists(ownerId, target.id);
        break;
      case 'project':
        found = (await this.#projects.get(ownerId, target.id)) !== null;
        break;
      case 'task':
        found = (await this.#tasks.get(ownerId, target.id)) !== null;
        break;
    }
    if (!found) throw new NotFoundError(target.kind, target.id);
  }

  async list(ownerId: Id, input: NoteListInput): Promise<Paged<NoteRecord>> {
    if ((input.targetKind === undefined) !== (input.targetId === undefined)) {
      throw new ValidationFailedError([
        { path: '/targetId', message: 'targetKind and targetId must be given together' },
      ]);
    }
    const offset = decodeCursor(input.cursor);
    const limit = normalizeLimit(input.limit);
    let terms: string[] | undefined;
    if (input.q !== undefined) {
      terms = noteSearchTerms(input.q);
      // A query with no searchable token matches nothing rather than everything.
      if (terms.length === 0) return { items: [], nextCursor: null };
    }
    const page = await this.#store.list(ownerId, {
      ...(terms === undefined ? {} : { terms }),
      ...(input.targetKind === undefined || input.targetId === undefined
        ? {}
        : { target: { kind: input.targetKind, id: input.targetId } }),
      offset,
      limit,
    });
    return { items: page.items, nextCursor: page.hasMore ? encodeCursor(offset + limit) : null };
  }

  async get(ownerId: Id, id: Id): Promise<NoteRecord> {
    const note = await this.#store.get(ownerId, id);
    if (note === null) throw new NotFoundError('document', id);
    return note;
  }

  async create(ownerId: Id, input: NoteCreateInput): Promise<NoteRecord> {
    assertValid({ title: input.title, ...(input.bodyMd === undefined ? {} : { bodyMd: input.bodyMd }) });
    const links: { id: Id; targetKind: LinkTargetKind; targetId: Id }[] = [];
    for (const link of input.links ?? []) {
      if (links.some((existing) => existing.targetKind === link.targetKind && existing.targetId === link.targetId)) {
        throw new ValidationFailedError([{ path: '/links', message: 'duplicate link target' }]);
      }
      await this.#assertTarget(ownerId, { kind: link.targetKind, id: link.targetId });
      links.push({ id: this.#ids.next(), targetKind: link.targetKind, targetId: link.targetId });
    }
    return this.#store.create({
      id: this.#ids.next(),
      ownerId,
      title: input.title,
      bodyMd: input.bodyMd ?? '',
      sensitivity: input.sensitivity ?? 'P2',
      llmAllowed: input.llmAllowed ?? false,
      source: 'manual',
      links,
    });
  }

  async update(ownerId: Id, id: Id, patch: NotePatchInput, expectedVersion: number): Promise<NoteRecord> {
    assertValid(patch);
    return this.#store.update(ownerId, id, patch, expectedVersion);
  }

  async remove(ownerId: Id, id: Id, expectedVersion: number): Promise<void> {
    await this.#store.softDelete(ownerId, id, expectedVersion);
  }

  async addLink(ownerId: Id, id: Id, target: LinkTarget, expectedVersion: number): Promise<NoteRecord> {
    // Fail on a missing/foreign note before touching the provider for the target.
    const note = await this.get(ownerId, id);
    if (note.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion as Version, note.version);
    }
    await this.#assertTarget(ownerId, target);
    return this.#store.addLink(
      ownerId,
      id,
      { id: this.#ids.next(), targetKind: target.kind, targetId: target.id },
      expectedVersion,
    );
  }

  async removeLink(ownerId: Id, id: Id, linkId: Id, expectedVersion: number): Promise<NoteRecord> {
    return this.#store.removeLink(ownerId, id, linkId, expectedVersion);
  }

  /**
   * 07 §7: copy the task's CURRENT provider description into a new note once,
   * linked to the task. Nothing is synced afterwards in either direction.
   */
  async promoteTaskDescription(ownerId: Id, taskId: Id, expectedVersion: number): Promise<NoteRecord> {
    const task = await this.#tasks.get(ownerId, taskId);
    if (task === null) throw new NotFoundError('task', taskId);
    if (task.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion as Version, task.version);
    }
    if ((await this.#store.findLivePromoted(ownerId, taskId)) !== null) {
      throw new DailyProblemError({
        status: 409,
        code: 'illegal_transition',
        title: 'State conflict',
        detail: 'this task description was already promoted to a note; edit that note instead',
      });
    }
    const bodyMd = truncateCodePoints(taskDescriptionToMarkdown(task.description ?? ''), MAX_NOTE_BODY_LENGTH);
    if (bodyMd.length === 0) {
      throw new ValidationFailedError([
        { path: '/description', message: 'the task has no description to promote' },
      ]);
    }
    const title = truncateCodePoints(task.title.trim(), MAX_NOTE_TITLE_LENGTH);
    return this.#store.create({
      id: this.#ids.next(),
      ownerId,
      title: title.length === 0 ? 'Task description' : title,
      bodyMd,
      sensitivity: 'P2',
      llmAllowed: false,
      source: 'task_description',
      sourceTaskId: taskId,
      links: [{ id: this.#ids.next(), targetKind: 'task', targetId: taskId }],
    });
  }

  async listAiUsage(
    ownerId: Id,
    documentId: Id,
    input: { readonly cursor?: string; readonly limit?: number },
  ): Promise<Paged<NoteUsageRecord>> {
    await this.get(ownerId, documentId);
    const offset = decodeCursor(input.cursor);
    const limit = normalizeLimit(input.limit);
    const page = await this.#store.listUsage(ownerId, documentId, offset, limit);
    return { items: page.items, nextCursor: page.hasMore ? encodeCursor(offset + limit) : null };
  }
}
