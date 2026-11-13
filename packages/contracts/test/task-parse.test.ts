import {
  TASK_DRAFTS_MAX,
  TASK_DRAFT_NOTES,
  TaskDraftSchema,
  TaskParseRequestSchema,
  TaskParseResponseSchema,
  contractRoutes,
  schemaRegistry,
} from '../src/index.js';
import { compile } from './ajv.js';

/** CAL-05: POST /tasks:parse request/response contract. */

const draft = {
  title: '보고서 초안',
  dueAt: '2026-11-13T14:59:00.000Z',
  notes: ['due_time_defaulted'],
};

describe('TaskParseRequest', () => {
  const validate = compile(TaskParseRequestSchema);

  test('accepts a note with or without a time zone', () => {
    expect(validate({ text: '금요일까지 보고서 초안, 내일까지 교수님께 메일' })).toBe(true);
    expect(validate({ text: '장보기', timeZone: 'America/New_York' })).toBe(true);
    expect(validate({ text: 'x'.repeat(500) })).toBe(true);
  });

  test.each([
    ['an empty note', { text: '' }],
    ['a note of spaces and line breaks only', { text: '   \n\t ' }],
    ['a 501-character note', { text: 'x'.repeat(501) }],
    ['an unknown zone', { text: '장보기', timeZone: 'Mars/Olympus' }],
    ['an extra key', { text: '장보기', projectId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55' }],
    ['a missing note', {}],
  ])('rejects %s (negative)', (_label, body) => {
    expect(validate(body)).toBe(false);
  });
});

describe('TaskParseResponse', () => {
  const validate = compile(TaskParseResponseSchema);
  const validateDraft = compile(TaskDraftSchema);

  test('accepts drafts with and without a deadline, and every documented note', () => {
    expect(validateDraft(draft)).toBe(true);
    expect(validateDraft({ title: '장보기', notes: [] })).toBe(true);
    expect(validateDraft({ title: '과제', notes: ['due_dropped'] })).toBe(true);
    expect(validateDraft({ ...draft, notes: ['date_assumed', 'meridiem_assumed'] })).toBe(true);
    expect(validate({ drafts: [draft], leftover: '요즘 너무 피곤하다' })).toBe(true);
    expect(validate({ drafts: [], leftover: '' })).toBe(true);
    expect(validate({ drafts: Array.from({ length: TASK_DRAFTS_MAX }, () => draft), leftover: '' })).toBe(true);
  });

  test.each([
    ['eleven drafts', { drafts: Array.from({ length: 11 }, () => draft), leftover: '' }],
    ['an unknown note code', { drafts: [{ ...draft, notes: ['duration_defaulted'] }], leftover: '' }],
    ['a local date-time instead of an instant', { drafts: [{ ...draft, dueAt: '2026-11-13 23:59' }], leftover: '' }],
    ['an empty title', { drafts: [{ ...draft, title: '' }], leftover: '' }],
    ['an extra draft key', { drafts: [{ ...draft, projectId: 'x' }], leftover: '' }],
    ['a missing leftover', { drafts: [] }],
  ])('rejects %s (negative)', (_label, body) => {
    expect(validate(body)).toBe(false);
  });

  test('the note codes are the four documented ones', () => {
    expect([...TASK_DRAFT_NOTES]).toEqual(['due_time_defaulted', 'date_assumed', 'meridiem_assumed', 'due_dropped']);
  });
});

test('the route is a creation-style POST next to the task routes: Idempotency-Key, no If-Match, named components', () => {
  const route = contractRoutes.find((candidate) => candidate.operationId === 'parseTasks');
  expect(route).toMatchObject({ method: 'post', path: '/tasks:parse' });
  expect(route?.body).toBe(TaskParseRequestSchema);
  expect(route?.responses[200]?.schema).toBe(TaskParseResponseSchema);
  expect(schemaRegistry.TaskParseRequest).toBe(TaskParseRequestSchema);
  expect(schemaRegistry.TaskDraft).toBe(TaskDraftSchema);
  expect(schemaRegistry.TaskParseResponse).toBe(TaskParseResponseSchema);
});
