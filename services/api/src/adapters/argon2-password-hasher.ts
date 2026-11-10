import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/ports.js';

/**
 * ADR-011: planner-local passwords use argon2id. `@node-rs/argon2` is MIT and
 * ships prebuilt binaries, avoiding a native build toolchain in dev/CI.
 */
export class Argon2PasswordHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
