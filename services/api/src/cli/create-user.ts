import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import {
  createUuidV7Generator,
  type Clock,
  type Instant,
} from '@ohmydate/domain';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { normalizeEmail, PgUserRepository } from '../adapters/pg-user-repository.js';
import { UserService } from '../application/user-service.js';
import type { Database } from '../db/types.js';

const { Pool } = pg;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function usage(): string {
  return 'usage: create-user <email> (password read from stdin)';
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (email === undefined || email.trim() === '') {
    throw new Error(usage());
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required');
  }

  const password = (await readStdin()).replace(/\r?\n$/, '');
  if (password.length === 0) {
    throw new Error('password must be provided on stdin');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  try {
    const clock: Clock = {
      now: () => new Date().toISOString() as Instant,
    };
    const ids = createUuidV7Generator({ clock, rand: (length) => randomBytes(length) });
    const users = new PgUserRepository(db, clock);
    const service = new UserService(users);
    const created = await service.create({
      id: ids.next(),
      email: normalizeEmail(email),
      passwordHash: await hash(password),
    });
    console.log(`created user ${created.email} (${created.id})`);
  } finally {
    await db.destroy();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
