import { ApiError, type ApiErrorCode } from './errors';

const HEX = '0123456789abcdef';
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const subtleCrypto = globalThis.crypto as Crypto | undefined;
  if (subtleCrypto !== undefined && typeof subtleCrypto.getRandomValues === 'function') {
    subtleCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < 16; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) throw new RangeError('uuid buffer too short');
    if (index === 4 || index === 6 || index === 8 || index === 10) out += '-';
    out += HEX[byte >> 4];
    out += HEX[byte & 0x0f];
  }
  return out;
}

/**
 * Generates a UUIDv7 idempotency key using `crypto.getRandomValues`.
 * 07 §6 requires every mutation's Idempotency-Key to be a client UUIDv7.
 */
export function uuidV7Key(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(nowMs);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function isUuidV7Key(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

/**
 * Mints a standalone UUIDv7 action id. The prefix is accepted for call-site
 * readability but is not part of the key, so the header value stays a UUIDv7.
 */
export function newActionId(prefix: string): string {
  void prefix;
  return uuidV7Key();
}

/** Conflicts the server answers while the key is still pending, never stored (08 §1, ADR-020 §11). */
const TRANSIENT_CONFLICTS: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'idempotency_in_progress',
  'approval_in_progress',
]);

/**
 * 08 §1: only 2xx and domain 409/422 answers are stored under an
 * Idempotency-Key. After such a final result the logical action is over and the
 * next submission needs a fresh key; anything else (network loss, timeouts,
 * `idempotency_in_progress`, `approval_in_progress`, 5xx, 429, precondition
 * failures) leaves the action open, so a retry must reuse the same key and
 * replay — not duplicate — the original request (M5-03R-1 M1).
 */
export function isStoredFinalResult(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    (cause.status === 409 || cause.status === 422) &&
    !TRANSIENT_CONFLICTS.has(cause.code)
  );
}

export interface IdempotentAction<T> {
  readonly payload: T;
  readonly key: string;
  /** If-Match last sent under this key; a change rotates the key. */
  readonly ifMatch?: number;
}

/**
 * Keeps one immutable action (payload + idempotency key) per logical
 * submission scope. Repeating the same payload is a retry and reuses the key;
 * changing the payload is a new user action and gets a fresh key.
 */
export class ActionStore {
  private readonly actions = new Map<string, IdempotentAction<unknown>>();

  begin<T>(
    scope: string,
    payload: T,
    same: (left: T, right: T) => boolean,
    ifMatch?: number,
  ): IdempotentAction<T> {
    const existing = this.actions.get(scope) as IdempotentAction<T> | undefined;
    if (existing !== undefined && same(existing.payload, payload)) {
      if (
        ifMatch === undefined ||
        existing.ifMatch === undefined ||
        existing.ifMatch === ifMatch
      ) {
        return existing;
      }
    }
    const action: IdempotentAction<T> = {
      payload,
      key: uuidV7Key(),
      ...(ifMatch === undefined ? {} : { ifMatch }),
    };
    this.actions.set(scope, action as IdempotentAction<unknown>);
    return action;
  }

  peek<T>(scope: string): IdempotentAction<T> | undefined {
    return this.actions.get(scope) as IdempotentAction<T> | undefined;
  }

  settle(scope: string, action: IdempotentAction<unknown>): void {
    const existing = this.actions.get(scope);
    if (existing !== undefined && existing.key === action.key) {
      this.actions.delete(scope);
    }
  }

  has(scope: string): boolean {
    return this.actions.has(scope);
  }

  clear(): void {
    this.actions.clear();
  }
}
