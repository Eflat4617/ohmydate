import {
  ContextDocumentCreateSchema,
  ContextDocumentListQuerySchema,
  ContextDocumentPatchSchema,
  ContextDocumentSchema,
  DecompositionDraftPatchSchema,
  DecompositionDraftSchema,
  DecompositionEvidenceSchema,
  DocumentLinkCreateSchema,
  NoteAiUsageSchema,
} from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const ID2 = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56';
const NOW = '2026-11-12T00:00:00.000Z';

const note = {
  id: ID,
  ownerId: ID2,
  title: '논문 메모',
  bodyMd: '# Heading\n\n<b>raw markdown stays raw</b>',
  sensitivity: 'P2',
  llmAllowed: false,
  source: 'manual',
  links: [{ id: ID, documentId: ID, targetKind: 'task', targetId: ID2, createdAt: NOW }],
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

test('a note DTO is raw Markdown only; no rendered HTML field can be added', () => {
  const validate = compile(ContextDocumentSchema);
  expect(validate(note)).toBe(true);
  expect(validate({ ...note, bodyHtml: '<p>x</p>' })).toBe(false);
  expect(validate({ ...note, sensitivity: 'P0' })).toBe(false);
  expect(validate({ ...note, source: 'vikunja_sync' })).toBe(false);
  expect(validate({ ...note, links: [{ ...note.links[0], targetKind: 'document' }] })).toBe(false);
});

test('create enforces title/body limits and the closed field set', () => {
  const validate = compile(ContextDocumentCreateSchema);
  expect(validate({ title: 'x' })).toBe(true);
  expect(
    validate({ title: 'x', bodyMd: 'b', sensitivity: 'P1', llmAllowed: true, links: [{ targetKind: 'goal', targetId: ID }] }),
  ).toBe(true);
  expect(validate({ title: '' })).toBe(false);
  expect(validate({ title: 'x'.repeat(201) })).toBe(false);
  expect(validate({ title: '가'.repeat(200) })).toBe(true);
  expect(validate({ title: 'x', bodyMd: 'x'.repeat(65_537) })).toBe(false);
  expect(validate({ title: 'x', ownerId: ID })).toBe(false);
  expect(validate({ title: 'x', links: Array.from({ length: 51 }, () => ({ targetKind: 'goal', targetId: ID })) })).toBe(false);
});

test('patch needs at least one field and cannot change ownership or source', () => {
  const validate = compile(ContextDocumentPatchSchema);
  expect(validate({ llmAllowed: true })).toBe(true);
  expect(validate({})).toBe(false);
  expect(validate({ source: 'task_description' })).toBe(false);
  expect(validate({ ownerId: ID })).toBe(false);
});

test('links target only goals, projects and tasks by UUIDv7', () => {
  const validate = compile(DocumentLinkCreateSchema);
  expect(validate({ targetKind: 'project', targetId: ID })).toBe(true);
  expect(validate({ targetKind: 'note', targetId: ID })).toBe(false);
  expect(validate({ targetKind: 'task', targetId: 'not-a-uuid' })).toBe(false);
});

test('list query bounds the search string and page size', () => {
  const validate = compile(ContextDocumentListQuerySchema);
  expect(validate({ q: '논문', limit: 20 })).toBe(true);
  expect(validate({ q: '' })).toBe(false);
  expect(validate({ q: 'x'.repeat(201) })).toBe(false);
  expect(validate({ limit: 101 })).toBe(false);
});

test('AI usage entries carry ids, hashes and counts only', () => {
  const validate = compile(NoteAiUsageSchema);
  const usage = {
    id: ID,
    documentId: ID2,
    agentRunId: ID,
    purpose: 'decomposition',
    promptIdVersion: 'decomposition@v2',
    status: 'succeeded',
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
    documentVersion: 3,
    bodyHash: 'a'.repeat(64),
    sectionHashes: ['0123456789abcdef'],
    sentBytes: 120,
    stale: false,
    createdAt: NOW,
  };
  expect(validate(usage)).toBe(true);
  expect(validate({ ...usage, sectionText: 'leak' })).toBe(false);
  expect(validate({ ...usage, sectionHashes: [] })).toBe(false);
  expect(validate({ ...usage, sectionHashes: ['XYZ'] })).toBe(false);
});

test('draft evidence is optional, server-shaped, and cannot be set through PATCH', () => {
  const evidence = {
    kind: 'fact',
    statement: '마감은 11/20',
    source: { kind: 'note', docId: ID, sectionHash: '0123456789abcdef' },
    stepKeys: ['s1'],
    updatedAt: NOW,
  };
  expect(compile(DecompositionEvidenceSchema)(evidence)).toBe(true);
  expect(compile(DecompositionEvidenceSchema)({ ...evidence, kind: 'guess' })).toBe(false);
  expect(
    compile(DecompositionEvidenceSchema)({ ...evidence, source: { ...evidence.source, sectionHash: 'deadbeef' } }),
  ).toBe(false);

  const step = {
    key: 's1',
    title: 'Read',
    deliverable: 'notes',
    doneCriteria: 'done',
    kind: 'work',
    estimate: { p50Minutes: 60, p90Minutes: 120 },
    dependsOn: [],
    splittable: true,
  };
  const draft = { steps: [step], assumptions: [], questionsRemaining: [] };
  const validateDraft = compile(DecompositionDraftSchema);
  expect(validateDraft(draft)).toBe(true);
  expect(validateDraft({ ...draft, evidence: [evidence] })).toBe(true);
  expect(compile(DecompositionDraftPatchSchema)({ evidence: [evidence] })).toBe(false);
});
