import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at-rest envelope shared by Web Push key material (09 §6) and the
 * Google refresh token (CAL-03, ADR-024): 12-byte IV || 16-byte auth tag ||
 * ciphertext. The additional authenticated data binds an envelope to its
 * context (push: the key id; Google: owner id + key id), so a row copied to
 * another owner or decrypted under another key fails authentication. Never log
 * a key, a plaintext or an envelope.
 */
export interface AtRestKey {
  readonly key: Buffer;
  readonly keyId: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 32-byte key from hex (64 chars), base64 (32 bytes) or raw 32-byte text. */
export function parseKeyMaterial(raw: string, source: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) throw new Error(`${source} is empty`);
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  const base64 = Buffer.from(value, 'base64');
  if (base64.length === 32) return base64;
  const utf8 = Buffer.from(value, 'utf8');
  if (utf8.length === 32) return utf8;
  throw new Error(`${source} must decode to a 32-byte AES-256 key`);
}

/** Non-secret key identifier: first 16 hex chars of SHA-256(key). */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function atRestKey(key: Buffer): AtRestKey {
  if (key.length !== 32) throw new Error('at-rest encryption key must be 32 bytes');
  return { key, keyId: keyIdOf(key) };
}

export function encryptAtRest(plaintext: string, key: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws (without echoing the envelope) when the tag, key or AAD do not match. */
export function decryptAtRest(envelope: Buffer, key: Buffer, aad: string): string {
  if (envelope.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('at-rest envelope is too short');
  }
  const iv = envelope.subarray(0, IV_BYTES);
  const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('at-rest envelope failed authentication');
  }
}
