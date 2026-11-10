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
