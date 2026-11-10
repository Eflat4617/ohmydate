import { ValidationFailedError, type Id } from '@ohmydate/domain';
import {
  EMPTY_CHANGE_CURSOR,
  compareListPosition,
  decodeChangeCursor,
  decodeListCursor,
  encodeChangeCursor,
  encodeListCursor,
  isChangeAfterCursor,
} from '../../src/cursor.js';

const TASK_ID = '0190a000-0000-7000-8000-000000000001' as Id;

describe('change cursor', () => {
  test('null decodes to the empty baseline', () => {
    expect(decodeChangeCursor(null)).toEqual(EMPTY_CHANGE_CURSOR);
  });

  test('round-trips the updated second, external id and sequence', () => {
    const cursor = {
      seconds: 1_794_332_393,
      externalId: '42',
      sequence: 7,
      epoch: 'epoch-1',
      owner: TASK_ID,
    };
    expect(decodeChangeCursor(encodeChangeCursor(cursor))).toEqual(cursor);
  });

  test('overlaps the same second and orders by external id', () => {
    const cursor = {
      seconds: 100,
      externalId: '20',
      sequence: 3,
      epoch: 'epoch-1',
      owner: TASK_ID,
    };
    expect(isChangeAfterCursor({ seconds: 99, externalId: '99' }, cursor)).toBe(false);
    expect(isChangeAfterCursor({ seconds: 100, externalId: '19' }, cursor)).toBe(false);
    expect(isChangeAfterCursor({ seconds: 100, externalId: '21' }, cursor)).toBe(true);
    expect(isChangeAfterCursor({ seconds: 101, externalId: '1' }, cursor)).toBe(true);
  });

  test('rejects malformed cursors with ValidationFailedError', () => {
    expect(() => decodeChangeCursor('not-base64-json')).toThrow(ValidationFailedError);
    expect(() =>
      decodeChangeCursor(
        Buffer.from(JSON.stringify({ s: 0, e: '', q: 0 })).toString('base64url'),
      ),
    ).toThrow(ValidationFailedError);
    expect(() =>
      decodeChangeCursor(
        Buffer.from(
          JSON.stringify({ s: -1, e: '1', q: 0, ep: 'epoch-1', o: TASK_ID }),
        ).toString('base64url'),
      ),
    ).toThrow(ValidationFailedError);
  });
});

describe('list cursor', () => {
  test('round-trips createdAt and planner id', () => {
    const cursor = {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: TASK_ID,
    };
    expect(decodeListCursor(encodeListCursor(cursor))).toEqual(cursor);
  });

  test('sorts by createdAt then id and rejects malformed input', () => {
    expect(
      compareListPosition(
        { createdAt: '2026-01-01T00:00:00.000Z', id: TASK_ID },
        { createdAt: '2026-01-01T00:00:01.000Z', id: TASK_ID },
      ),
    ).toBe(-1);
    expect(() => decodeListCursor('bad')).toThrow(ValidationFailedError);
  });
});
