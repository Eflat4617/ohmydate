import {
  COMMITMENT_DRAFTS_MAX,
  COMMITMENT_DRAFT_NOTES,
  CommitmentDraftSchema,
  CommitmentParseRequestSchema,
  CommitmentParseResponseSchema,
  contractRoutes,
  schemaRegistry,
} from '../src/index.js';
import { compile } from './ajv.js';

/** CAL-02: POST /commitments:parse request/response contract. */

const draft = {
  title: '치과',
  timeZone: 'Asia/Seoul',
  date: '2026-11-17',
  startAt: '2026-11-17T06:00:00.000Z',
  endAt: '2026-11-17T07:00:00.000Z',
  notes: ['duration_defaulted'],
};

describe('CommitmentParseRequest', () => {
  const validate = compile(CommitmentParseRequestSchema);

  test('accepts a note with or without a time zone', () => {
    expect(validate({ text: '다음 주 화요일 오후 3시에 치과' })).toBe(true);
    expect(validate({ text: '14일 저녁 7시 동창 모임', timeZone: 'America/New_York' })).toBe(true);
    expect(validate({ text: 'x'.repeat(500) })).toBe(true);
  });

  test.each([
    ['an empty note', { text: '' }],
    ['a note of spaces and line breaks only', { text: '   \n\t ' }],
    ['a 501-character note', { text: 'x'.repeat(501) }],
    ['an unknown zone', { text: '내일 3시', timeZone: 'Mars/Olympus' }],
    ['an offset instead of a zone', { text: '내일 3시', timeZone: '+09:00' }],
    ['an extra key', { text: '내일 3시', now: '2026-11-13T00:00:00Z' }],
    ['a missing note', {}],
  ])('rejects %s (negative)', (_label, body) => {
    expect(validate(body)).toBe(false);
  });
});

describe('CommitmentParseResponse', () => {
  const validate = compile(CommitmentParseResponseSchema);
  const validateDraft = compile(CommitmentDraftSchema);

  test('accepts timed, untimed and weekly drafts', () => {
    expect(validateDraft(draft)).toBe(true);
    expect(validateDraft({ title: '영화', timeZone: 'Asia/Seoul', date: '2026-11-14', notes: ['date_assumed'] })).toBe(true);
    expect(
      validateDraft({ ...draft, rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231', notes: ['repeats_weekly', 'duration_defaulted'] }),
    ).toBe(true);
    expect(validate({ drafts: [draft], leftover: '보고서 쓰기' })).toBe(true);
    expect(validate({ drafts: [], leftover: '' })).toBe(true);
    expect(validate({ drafts: Array.from({ length: COMMITMENT_DRAFTS_MAX }, () => draft), leftover: '' })).toBe(true);
  });

  test.each([
    ['eleven drafts', { drafts: Array.from({ length: 11 }, () => draft), leftover: '' }],
    ['an unknown note code', { drafts: [{ ...draft, notes: ['guessed_everything'] }], leftover: '' }],
    ['a local time instead of an instant', { drafts: [{ ...draft, startAt: '2026-11-17 15:00' }], leftover: '' }],
    ['a non-RRULE repeat', { drafts: [{ ...draft, rrule: 'every thursday' }], leftover: '' }],
    ['an extra draft key', { drafts: [{ ...draft, id: 'x' }], leftover: '' }],
    ['a missing leftover', { drafts: [] }],
  ])('rejects %s (negative)', (_label, body) => {
    expect(validate(body)).toBe(false);
  });

  test('the note codes are the three documented ones', () => {
    expect([...COMMITMENT_DRAFT_NOTES]).toEqual(['duration_defaulted', 'date_assumed', 'repeats_weekly']);
  });
});

test('the route is a creation-style POST: Idempotency-Key, no If-Match, named components', () => {
  const route = contractRoutes.find((candidate) => candidate.operationId === 'parseCommitments');
  expect(route).toMatchObject({ method: 'post', path: '/commitments:parse' });
  expect(route?.body).toBe(CommitmentParseRequestSchema);
  expect(route?.responses[200]?.schema).toBe(CommitmentParseResponseSchema);
  expect(schemaRegistry.CommitmentParseRequest).toBe(CommitmentParseRequestSchema);
  expect(schemaRegistry.CommitmentDraft).toBe(CommitmentDraftSchema);
  expect(schemaRegistry.CommitmentParseResponse).toBe(CommitmentParseResponseSchema);
});
