import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { atRestKey, encryptAtRest, parseKeyMaterial, type AtRestKey } from './at-rest-crypto.js';

export type PushKey = AtRestKey;

/**
 * Resolves the Web Push at-rest key (09 §6, §7). Never log the key or the file
 * contents. `provider=memory` may run with an ephemeral key for tests; any
 * other provider fails closed at boot when no key is configured.
 */
export function resolvePushKey(config: AppConfig): PushKey {
  let key: Buffer;
  if (config.pushKeyFile !== null && config.pushKeyFile.length > 0) {
    key = parseKeyMaterial(readFileSync(config.pushKeyFile, 'utf8'), 'PUSH_KEY_FILE');
  } else if (config.pushKey !== null && config.pushKey.length > 0) {
    key = parseKeyMaterial(config.pushKey, 'PUSH_KEY');
  } else if (config.provider === 'memory') {
    key = randomBytes(32);
  } else {
    throw new Error(
      'PUSH_KEY_FILE or PUSH_KEY is required when PROVIDER is not "memory" (Web Push keys are encrypted at rest)',
    );
  }
  if (key.length !== 32) throw new Error('Web Push encryption key must be 32 bytes');
  return atRestKey(key);
}

/**
 * AES-256-GCM envelope: 12-byte IV || 16-byte auth tag || ciphertext, with the
 * key id as additional authenticated data (unchanged since M4; the generic
 * helper lives in at-rest-crypto.ts).
 */
export function encryptPushValue(plaintext: string, key: Buffer, keyId: string): Buffer {
  return encryptAtRest(plaintext, key, keyId);
}
