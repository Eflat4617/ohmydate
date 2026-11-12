import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Login-session secrets (08 §1 auth, 09 §6). The session id (`sid` cookie) and
 * the CSRF token (`csrf` cookie, echoed in `X-CSRF-Token`) are 32 random bytes
 * in base64url. Servers keep only their SHA-256 digests (FU-92): the raw
 * values exist in the browser's cookies and in the login response, nowhere
 * else.
 */
const SECRET_BYTES = 32;

/** base64url of 32 bytes without padding is always 43 characters. */
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function createSessionSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function createCsrfToken(): string {
  return createSessionSecret();
}

/**
 * True when `value` has the shape of a secret this server issues. Stores use
 * it to reject tampered or foreign cookie values before any lookup; it is not
 * a credential check.
 */
export function isSessionSecretShape(value: string): boolean {
  return SESSION_SECRET_PATTERN.test(value);
}

/** Lowercase hex SHA-256 (64 characters) of a session id or CSRF token. */
export function hashSessionSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two stored digests. Both sides are hex SHA-256,
 * so equal-length buffers are compared with `timingSafeEqual`; a malformed
 * digest never matches.
 */
export function sessionHashesEqual(left: string, right: string): boolean {
  if (!SHA256_HEX_PATTERN.test(left) || !SHA256_HEX_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Constant-time check that a presented secret (e.g. the `X-CSRF-Token`
 * header) hashes to `expectedHash`. Missing or empty values never match.
 */
export function sessionSecretMatches(
  value: string | undefined,
  expectedHash: string,
): boolean {
  if (value === undefined || value.length === 0) return false;
  return sessionHashesEqual(hashSessionSecret(value), expectedHash);
}
