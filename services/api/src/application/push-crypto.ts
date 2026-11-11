import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';

export interface PushKey {
  readonly key: Buffer;
  readonly keyId: string;
}

function parseKeyMaterial(raw: string, source: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) throw new Error(`${source} is empty`);
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  const base64 = Buffer.from(value, 'base64');
  if (base64.length === 32) return base64;
  const utf8 = Buffer.from(value, 'utf8');
  if (utf8.length === 32) return utf8;
  throw new Error(`${source} must decode to a 32-byte AES-256 key`);
}

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
  } else if (!config.pushKeyRequired) {
    key = randomBytes(32);
  } else {
    throw new Error(
      'PUSH_KEY_FILE or PUSH_KEY is required when PROVIDER is not "memory" (Web Push keys are encrypted at rest)',
    );
  }
  if (key.length !== 32) throw new Error('Web Push encryption key must be 32 bytes');
  return {
    key,
    keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
  };
}

/** AES-256-GCM envelope: 12-byte IV || 16-byte auth tag || ciphertext. */
export function encryptPushValue(plaintext: string, key: Buffer, keyId: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(keyId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}
