import { ValidationFailedError, isInstant, isUuidV7, type Id } from '@ohmydate/domain';

export interface ListCursor {
  readonly createdAt: string;
  readonly id: Id;
}

/**
 * Change cursor described by ADR-016 §3: `(updated_seconds, externalId)` with
 * an additional local sequence. The sequence makes same-second local mutations
 * (which Vikunja cannot distinguish) totally ordered. `seconds` is still used
 * for the overlapping `updated >= cursor` remote query.
 */
export interface ChangeCursor {
  readonly seconds: number;
  readonly externalId: string;
  readonly sequence: number;
  readonly epoch: string;
  readonly owner: string;
}

export const EMPTY_CHANGE_CURSOR: ChangeCursor = {
  seconds: 0,
  externalId: '',
  sequence: 0,
  epoch: '',
  owner: '',
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function encodeListCursor(cursor: ListCursor): string {
  return encode({ c: cursor.createdAt, i: cursor.id });
}

export function decodeListCursor(value: string): ListCursor {
  const parsed = decode(value) as { c?: unknown; i?: unknown } | null;
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.c === 'string' &&
    isInstant(parsed.c) &&
    typeof parsed.i === 'string' &&
    isUuidV7(parsed.i)
  ) {
    return { createdAt: parsed.c, id: parsed.i };
  }
  throw new ValidationFailedError([{ path: 'cursor', message: 'invalid list cursor' }]);
}

export function encodeChangeCursor(cursor: ChangeCursor): string {
  return encode({
    s: cursor.seconds,
    e: cursor.externalId,
    q: cursor.sequence,
    ep: cursor.epoch,
    o: cursor.owner,
  });
}

export function decodeChangeCursor(value: string | null): ChangeCursor {
  if (value === null) return EMPTY_CHANGE_CURSOR;
  const parsed = decode(value) as {
    s?: unknown;
    e?: unknown;
    q?: unknown;
    ep?: unknown;
    o?: unknown;
  } | null;
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.s === 'number' &&
    Number.isInteger(parsed.s) &&
    parsed.s >= 0 &&
    typeof parsed.e === 'string' &&
    typeof parsed.q === 'number' &&
    Number.isInteger(parsed.q) &&
    parsed.q >= 0 &&
    typeof parsed.ep === 'string' &&
    parsed.ep.length > 0 &&
    typeof parsed.o === 'string' &&
    parsed.o.length > 0
  ) {
    return {
      seconds: parsed.s,
      externalId: parsed.e,
      sequence: parsed.q,
      epoch: parsed.ep,
      owner: parsed.o,
    };
  }
  throw new ValidationFailedError([{ path: 'cursor', message: 'invalid change cursor' }]);
}

/**
 * Same-second overlapping query rule: a remote row is a candidate when its
 * `updated` second is at or after the cursor second. The sequence / external id
 * then de-duplicates entries already observed by the local journal.
 */
export function isChangeAfterCursor(
  candidate: { readonly seconds: number; readonly externalId: string },
  cursor: ChangeCursor,
): boolean {
  if (candidate.seconds !== cursor.seconds) return candidate.seconds > cursor.seconds;
  return candidate.externalId > cursor.externalId;
}

export function compareListPosition(
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function epochSeconds(instant: string): number {
  return Math.floor(Date.parse(instant) / 1000);
}
