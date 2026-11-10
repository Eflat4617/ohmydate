function randomKey(): string {
  const subtleCrypto = globalThis.crypto as Crypto | undefined;
  if (subtleCrypto !== undefined && typeof subtleCrypto.randomUUID === 'function') {
    return subtleCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (subtleCrypto !== undefined && typeof subtleCrypto.getRandomValues === 'function') {
    subtleCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Keeps one idempotency key per logical user action until the action settles.
 * A retry of the same action therefore reuses the key, as required by 08 §1.
 */
export class IdempotencyKeyStore {
  private readonly keys = new Map<string, string>();

  keyFor(actionId: string): string {
    const existing = this.keys.get(actionId);
    if (existing !== undefined) return existing;
    const key = randomKey();
    this.keys.set(actionId, key);
    return key;
  }

  settle(actionId: string): void {
    this.keys.delete(actionId);
  }

  has(actionId: string): boolean {
    return this.keys.has(actionId);
  }

  clear(): void {
    this.keys.clear();
  }
}

export function newActionId(prefix: string): string {
  return `${prefix}:${randomKey()}`;
}

export interface IdempotentAction<T> {
  readonly payload: T;
  readonly key: string;
}

/**
 * Keeps one immutable action (payload + idempotency key) per logical
 * submission scope. Repeating the same payload is a retry and reuses the key;
 * changing the payload is a new user action and gets a fresh key.
 */
export class ActionStore {
  private readonly actions = new Map<string, IdempotentAction<unknown>>();

  begin<T>(scope: string, payload: T, same: (left: T, right: T) => boolean): IdempotentAction<T> {
    const existing = this.actions.get(scope) as IdempotentAction<T> | undefined;
    if (existing !== undefined && same(existing.payload, payload)) return existing;
    const action: IdempotentAction<T> = { payload, key: randomKey() };
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
