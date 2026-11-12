import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import {
  createUuidV7Generator,
  isIanaTimeZone,
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
  return (
    'usage: create-user <email> [--time-zone <IANA>] [--locale <locale>] ' +
    '(password read from stdin)'
  );
}

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

export interface CreateUserArgs {
  readonly email: string;
  readonly timeZone?: string;
  readonly locale?: string;
}

function optionValue(argv: readonly string[], index: number, name: string): [string, number] {
  const inline = argv[index];
  const separator = inline?.indexOf('=') ?? -1;
  if (separator > 2) {
    const value = inline?.slice(separator + 1) ?? '';
    if (value.length === 0) throw new Error(`${name} requires a value`);
    return [value, index];
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return [next, index + 1];
}

export function parseCreateUserArgs(argv: readonly string[]): CreateUserArgs {
  let email: string | undefined;
  let timeZone: string | undefined;
  let locale: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--time-zone' || arg.startsWith('--time-zone=')) {
      const [value, consumed] = optionValue(argv, index, '--time-zone');
      timeZone = value;
      index = consumed;
    } else if (arg === '--locale' || arg.startsWith('--locale=')) {
      const [value, consumed] = optionValue(argv, index, '--locale');
      locale = value;
      index = consumed;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (email === undefined) {
      email = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (email === undefined || email.trim() === '') throw new Error(usage());
  if (timeZone !== undefined && !isIanaTimeZone(timeZone)) {
    throw new Error(`invalid IANA time zone: ${timeZone}`);
  }
  if (
    locale !== undefined &&
    (locale.length < 2 || locale.length > 35 || !LOCALE_PATTERN.test(locale))
  ) {
    throw new Error(`invalid locale: ${locale}`);
  }
  return {
    email,
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
  };
}

async function main(): Promise<void> {
  const args = parseCreateUserArgs(process.argv.slice(2));
  const email = args.email;

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
      ...(args.timeZone === undefined ? {} : { timeZone: args.timeZone }),
      ...(args.locale === undefined ? {} : { locale: args.locale }),
    });
    console.log(`created user ${created.email} (${created.id})`);
  } finally {
    await db.destroy();
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Importing this module in a test must never read stdin or open the database. */
export function isCreateUserEntrypoint(
  entry: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (entry === undefined) return false;
  const modulePath = realpathOrNull(fileURLToPath(moduleUrl));
  if (modulePath === null) return false;
  for (const candidate of [entry, `${entry}.js`]) {
    const resolved = realpathOrNull(candidate);
    if (resolved !== null && resolved === modulePath) return true;
  }
  return false;
}

if (isCreateUserEntrypoint()) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
