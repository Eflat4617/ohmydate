import { HttpResponse, http } from 'msw';
import type {
  ContextDocument,
  ContextDocumentCreate,
  ContextDocumentPatch,
  DecompositionEvidence,
  DocumentLinkCreate,
  DocumentTargetKind,
  NoteAiUsage,
} from '../api/client';
import { TODAY_TASK_ONE_ID, createUuidV7, type MockDb } from './db';
import { NOTE_MEETING_ID, bodyHash, mockSectionHash, seedLink, type StoredNote } from './notes-seed';
import {
  etag,
  json,
  parseBody,
  parseIdempotency,
  parseIfMatch,
  problem,
  remember,
  rememberDomainResult,
} from './handlers';

/**
 * M6-03 MSW handlers for notes (08 §2.7) with the API's semantics: owner
 * scope (other owners' notes are 404), soft delete, `If-Match` on the note
 * version for edits and links (428 without it, 412 when stale), the task
 * version for promotion (409 `illegal_transition` when a live promoted note
 * exists, 422 without a description), stored idempotent replays, and the AI
 * usage history (ids and hashes only, `stale` once the note changed).
 */

const MAX_TITLE = 200;
const MAX_BODY = 65_536;
const MAX_LINKS = 50;
const TARGET_KINDS: readonly DocumentTargetKind[] = ['goal', 'project', 'task'];

function codePoints(text: string): number {
  return Array.from(text).length;
}

/** M6-03 screenshots: a note linked to the first Today task (Focus → RelatedNotes). */
export function seedFocusNote(db: MockDb): void {
  const note = db.notes.documents.get(NOTE_MEETING_ID);
  if (note === undefined) return;
  note.links = [...note.links, seedLink(createUuidV7(), note.id, 'task', TODAY_TASK_ONE_ID, note.createdAt)];
  note.version += 1;
}

function live(db: MockDb, id: string): StoredNote | undefined {
  const note = db.notes.documents.get(id);
  return note === undefined || note.deletedAt !== undefined || note.ownerId !== db.user.id ? undefined : note;
}

function dto(note: StoredNote): ContextDocument {
  const copy: StoredNote = structuredClone(note);
  delete copy.deletedAt;
  return copy;
}

function usageDto(db: MockDb, entry: NoteAiUsage): NoteAiUsage {
  const note = db.notes.documents.get(entry.documentId);
  return { ...entry, stale: note === undefined ? entry.stale : entry.documentVersion < note.version };
}

function targetExists(db: MockDb, kind: DocumentTargetKind, id: string): boolean {
  if (kind === 'project') return db.projects.has(id);
  if (kind === 'task') {
    const task = db.tasks.get(id);
    return task !== undefined && task.deletedAt === undefined;
  }
  return db.notes.goals.has(id);
}

function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** `simple` tsvector stand-in: every query token must prefix a word (AND). */
function matches(note: StoredNote, q: string): boolean {
  const tokens = words(q).slice(0, 8);
  if (tokens.length === 0) return false;
  const haystack = words(`${note.title}\n${note.bodyMd}`);
  return tokens.every((token) => haystack.some((word) => word.startsWith(token)));
}

function pageOf<T>(items: readonly T[], url: URL): { items: T[]; nextCursor: string | null } | Response {
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return problem(422, 'validation_failed', 'limit must be 1-100');
  const cursor = url.searchParams.get('cursor');
  let offset = 0;
  if (cursor !== null) {
    const match = /^o(\d+)$/.exec(cursor);
    if (match === null) return problem(422, 'validation_failed', 'invalid cursor');
    offset = Number(match[1]);
  }
  const slice = items.slice(offset, offset + limit);
  return { items: [...slice], nextCursor: offset + limit < items.length ? `o${offset + limit}` : null };
}

function validFields(input: Partial<ContextDocumentCreate & ContextDocumentPatch>, creating: boolean): string | null {
  if (creating || input.title !== undefined) {
    if (typeof input.title !== 'string' || codePoints(input.title) < 1 || codePoints(input.title) > MAX_TITLE) {
      return 'title must be 1-200 characters';
    }
  }
  if (input.bodyMd !== undefined && (typeof input.bodyMd !== 'string' || codePoints(input.bodyMd) > MAX_BODY)) {
    return 'bodyMd must be at most 65536 characters';
  }
  if (input.sensitivity !== undefined && input.sensitivity !== 'P1' && input.sensitivity !== 'P2') {
    return 'sensitivity must be P1 or P2';
  }
  if (input.llmAllowed !== undefined && typeof input.llmAllowed !== 'boolean') return 'llmAllowed must be boolean';
  return null;
}

function isLinkInput(value: unknown): value is DocumentLinkCreate {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['targetKind'] === 'string' &&
    (TARGET_KINDS as readonly string[]).includes(record['targetKind']) &&
    typeof record['targetId'] === 'string'
  );
}

function idFrom(request: Request, pattern: RegExp): string {
  const match = pattern.exec(new URL(request.url).pathname);
  return match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
}

function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'Authentication is required');
}

function touch(note: StoredNote): void {
  note.version += 1;
  note.updatedAt = new Date().toISOString();
}

/** What the grounded decomposition "sent" and the evidence it cites (mock intake). */
export function mockGroundedEvidence(
  db: MockDb,
  goalId: string | undefined,
  stepKeys: readonly string[],
): { evidence: DecompositionEvidence[] } | null {
  if (goalId === undefined) return null;
  const notes = [...db.notes.documents.values()].filter(
    (note) =>
      note.deletedAt === undefined &&
      note.llmAllowed &&
      note.links.some((item) => item.targetKind === 'goal' && item.targetId === goalId),
  );
  const first = notes[0];
  if (first === undefined) return null;
  const now = new Date().toISOString();
  const evidence: DecompositionEvidence[] = [];
  for (const note of notes.slice(0, 3)) {
    const sectionHash = mockSectionHash(`${note.id}#0#${note.version}`);
    db.notes.usage.push({
      id: createUuidV7(),
      documentId: note.id,
      agentRunId: createUuidV7(),
      purpose: 'decomposition',
      promptIdVersion: 'decomposition@v2',
      status: 'succeeded',
      provider: 'fake',
      model: 'fake-llm',
      documentVersion: note.version,
      bodyHash: bodyHash(note.bodyMd),
      sectionHashes: [sectionHash],
      sentBytes: Math.min(1_536, new TextEncoder().encode(note.bodyMd).length),
      stale: false,
      createdAt: now,
    });
    const quoted = Array.from(note.bodyMd.replace(/\s+/g, ' ').trim()).slice(0, 120).join('');
    evidence.push({
      kind: 'fact',
      statement: `노트에 적힌 내용: ${quoted}`.slice(0, 200),
      source: { kind: 'note', docId: note.id, sectionHash },
      stepKeys: stepKeys.slice(0, 2),
      updatedAt: note.updatedAt,
    });
    if (note === first) {
      evidence.push({
        kind: 'inference',
        statement: '노트 내용으로 보아 초안 전에 자료를 먼저 정리하는 편이 좋아요.',
        source: { kind: 'note', docId: note.id, sectionHash },
        stepKeys: stepKeys.slice(1, 2),
        updatedAt: note.updatedAt,
      });
    }
  }
  return { evidence };
}

export function createNotesHandlers(db: MockDb) {
  return [
    http.get('*/api/v1/documents', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const q = url.searchParams.get('q');
      const kind = url.searchParams.get('targetKind');
      const targetId = url.searchParams.get('targetId');
      if ((kind === null) !== (targetId === null)) {
        return problem(422, 'validation_failed', 'targetKind and targetId must be given together');
      }
      if (kind !== null && !(TARGET_KINDS as readonly string[]).includes(kind)) {
        return problem(400, 'validation_failed', 'targetKind must be goal, project or task');
      }
      if (q !== null && (q.length < 1 || q.length > 200)) return problem(400, 'validation_failed', 'q must be 1-200 characters');
      let items = [...db.notes.documents.values()].filter((note) => note.deletedAt === undefined && note.ownerId === db.user.id);
      if (kind !== null && targetId !== null) {
        items = items.filter((note) => note.links.some((item) => item.targetKind === kind && item.targetId === targetId));
      }
      if (q !== null) items = items.filter((note) => matches(note, q));
      items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
      const page = pageOf(items.map(dto), url);
      if (page instanceof Response) return page;
      return json(page);
    }),

    http.post('*/api/v1/documents', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<ContextDocumentCreate>(raw);
      if (body === undefined) return rememberDomainResult(db, token, 422, 'validation_failed', 'body is required');
      const invalid = validFields(body, true);
      if (invalid !== null) return rememberDomainResult(db, token, 422, 'validation_failed', invalid);
      const requested = body.links ?? [];
      if (!Array.isArray(requested) || requested.length > MAX_LINKS || !requested.every(isLinkInput)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'links are invalid');
      }
      for (const item of requested) {
        if (!targetExists(db, item.targetKind, item.targetId)) {
          return rememberDomainResult(db, token, 404, 'not_found', `${item.targetKind} not found`);
        }
      }
      const now = new Date().toISOString();
      const id = createUuidV7();
      const note: StoredNote = {
        id,
        ownerId: db.user.id,
        title: body.title,
        bodyMd: body.bodyMd ?? '',
        sensitivity: body.sensitivity ?? 'P2',
        llmAllowed: body.llmAllowed ?? false,
        source: 'manual',
        links: requested.map((item) => seedLink(createUuidV7(), id, item.targetKind, item.targetId, now)),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.notes.documents.set(id, note);
      const out = dto(note);
      remember(db, token, 201, out, { ETag: etag(note.version) });
      return json(out, 201, { ETag: etag(note.version) });
    }),

    http.get('*/api/v1/documents/:id', ({ params }) => {
      if (!db.authenticated) return unauthenticated();
      const note = live(db, String(params['id']));
      if (note === undefined) return problem(404, 'not_found', 'note not found');
      return json(dto(note), 200, { ETag: etag(note.version) });
    }),

    http.patch('*/api/v1/documents/:id', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const note = live(db, String(params['id']));
      if (note === undefined) return problem(404, 'not_found', 'note not found');
      if (note.version !== ifMatch.version) {
        return problem(412, 'version_conflict', 'note version changed', 'Precondition failed', { ETag: etag(note.version) });
      }
      const patch = parseBody<ContextDocumentPatch>(raw);
      if (patch === undefined || Object.keys(patch).length === 0) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'at least one field is required');
      }
      const invalid = validFields(patch, false);
      if (invalid !== null) return rememberDomainResult(db, token, 422, 'validation_failed', invalid);
      if (patch.title !== undefined) note.title = patch.title;
      if (patch.bodyMd !== undefined) note.bodyMd = patch.bodyMd;
      if (patch.sensitivity !== undefined) note.sensitivity = patch.sensitivity;
      if (patch.llmAllowed !== undefined) note.llmAllowed = patch.llmAllowed;
      touch(note);
      const out = dto(note);
      remember(db, token, 200, out, { ETag: etag(note.version) });
      return json(out, 200, { ETag: etag(note.version) });
    }),

    http.delete('*/api/v1/documents/:id', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const token = parseIdempotency(db, request, '');
      if (token instanceof Response) return token;
      const note = live(db, String(params['id']));
      if (note === undefined) return problem(404, 'not_found', 'note not found');
      if (note.version !== ifMatch.version) return problem(412, 'version_conflict', 'note version changed');
      note.deletedAt = new Date().toISOString();
      remember(db, token, 204, null);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post('*/api/v1/documents/:id/links', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const note = live(db, String(params['id']));
      if (note === undefined) return problem(404, 'not_found', 'note not found');
      if (note.version !== ifMatch.version) return problem(412, 'version_conflict', 'note version changed');
      const body = parseBody<unknown>(raw);
      if (!isLinkInput(body)) return rememberDomainResult(db, token, 422, 'validation_failed', 'targetKind and targetId are required');
      if (!targetExists(db, body.targetKind, body.targetId)) {
        return rememberDomainResult(db, token, 404, 'not_found', `${body.targetKind} not found`);
      }
      if (note.links.some((item) => item.targetKind === body.targetKind && item.targetId === body.targetId)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'duplicate link');
      }
      if (note.links.length >= MAX_LINKS) return rememberDomainResult(db, token, 422, 'validation_failed', 'too many links');
      note.links = [...note.links, seedLink(createUuidV7(), note.id, body.targetKind, body.targetId, new Date().toISOString())];
      touch(note);
      const out = dto(note);
      remember(db, token, 201, out, { ETag: etag(note.version) });
      return json(out, 201, { ETag: etag(note.version) });
    }),

    http.delete('*/api/v1/documents/:id/links/:linkId', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const token = parseIdempotency(db, request, '');
      if (token instanceof Response) return token;
      const note = live(db, String(params['id']));
      if (note === undefined) return problem(404, 'not_found', 'note not found');
      if (note.version !== ifMatch.version) return problem(412, 'version_conflict', 'note version changed');
      const linkId = String(params['linkId']);
      if (!note.links.some((item) => item.id === linkId)) return problem(404, 'not_found', 'link not found');
      note.links = note.links.filter((item) => item.id !== linkId);
      touch(note);
      const out = dto(note);
      remember(db, token, 200, out, { ETag: etag(note.version) });
      return json(out, 200, { ETag: etag(note.version) });
    }),

    http.get('*/api/v1/documents/:id/ai-usage', ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const id = String(params['id']);
      if (live(db, id) === undefined) return problem(404, 'not_found', 'note not found');
      const entries = db.notes.usage
        .filter((entry) => entry.documentId === id)
        .map((entry) => usageDto(db, entry))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const page = pageOf(entries, new URL(request.url));
      if (page instanceof Response) return page;
      return json(page);
    }),

    http.post(/\/api\/v1\/tasks\/([^/]+):promote-description$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const token = parseIdempotency(db, request, '');
      if (token instanceof Response) return token;
      const taskId = idFrom(request, /\/api\/v1\/tasks\/([^/]+):promote-description$/);
      const task = db.tasks.get(taskId);
      if (task === undefined || task.deletedAt !== undefined) return problem(404, 'not_found', 'task not found');
      if (task.version !== ifMatch.version) return problem(412, 'version_conflict', 'task version changed');
      const promoted = [...db.notes.documents.values()].find(
        (note) => note.deletedAt === undefined && note.source === 'task_description' && note.sourceTaskId === taskId,
      );
      if (promoted !== undefined) {
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'this task description was already promoted', 'State conflict');
      }
      const description = (task.description ?? '').replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim();
      if (description.length === 0) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'the task has no description to promote');
      }
      const now = new Date().toISOString();
      const id = createUuidV7();
      const note: StoredNote = {
        id,
        ownerId: db.user.id,
        title: task.title,
        bodyMd: description,
        sensitivity: 'P2',
        llmAllowed: false,
        source: 'task_description',
        sourceTaskId: taskId,
        links: [seedLink(createUuidV7(), id, 'task', taskId, now)],
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.notes.documents.set(id, note);
      const out = dto(note);
      remember(db, token, 201, out, { ETag: etag(note.version) });
      return json(out, 201, { ETag: etag(note.version) });
    }),
  ];
}
