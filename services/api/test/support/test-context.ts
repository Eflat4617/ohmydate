import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createConfig, type AppConfig } from '../../src/config.js';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import type { Id } from '@ohmydate/domain';
import type { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { migrate } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/types.js';

const { Client, Pool } = pg;

export const databaseUrl = process.env['DATABASE_URL'];
export const hasDatabase = typeof databaseUrl === 'string' && databaseUrl.length > 0;

export interface TestContext {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly schema: string;
  readonly clock: FakeClock;
  readonly ids: ReturnType<typeof createSeededIdGenerator>;
  readonly repos: ReturnType<typeof createInMemoryRepositories>;
  seedUser(input: {
    email: string;
    password: string;
    timeZone?: string;
    locale?: string;
  }): Promise<Id>;
  close(): Promise<void>;
}

function requireDatabaseUrl(): string {
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is not set');
  }
  return databaseUrl;
}

export function makeSchemaName(): string {
  return `t_${randomBytes(8).toString('hex')}`;
}

export async function createSchema(schema: string): Promise<void> {
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await client.end();
  }
}

export async function dropSchema(schema: string): Promise<void> {
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

export interface TestContextOptions {
  readonly config?: Partial<AppConfig>;
  readonly logger?: boolean;
}

export async function createTestContext(
  options: TestContextOptions = {},
): Promise<TestContext> {
  const schema = makeSchemaName();
  await createSchema(schema);
  await migrate({ databaseUrl: requireDatabaseUrl(), schema });

  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }).withSchema(
    schema,
  ) as Kysely<Database>;

  const clock = new FakeClock();
  const ids = createSeededIdGenerator(Math.floor(Math.random() * 1_000_000), clock);
  const repos = createInMemoryRepositories({ clock, ids });
  const config = createConfig({
    cookieSecure: false,
    logLevel: 'silent',
    loginRateLimit: { limit: 1_000, windowMs: 60_000 },
    ...options.config,
  });

  const app = await buildApp({
    config,
    repos,
    clock,
    ids,
    db,
    logger: options.logger ?? false,
  });
  await app.ready();

  return {
    app,
    db,
    schema,
    clock,
    ids,
    repos,
    async seedUser(input) {
      const id = ids.next();
      const passwordHash = await hash(input.password);
      await db
        .insertInto('user')
        .values({
          id,
          email: input.email.trim().toLowerCase(),
          password_hash: passwordHash,
          ...(input.timeZone === undefined ? {} : { time_zone: input.timeZone }),
          ...(input.locale === undefined ? {} : { locale: input.locale }),
        })
        .execute();
      return id;
    },
    async close() {
      await app.close();
      await db.destroy();
      await dropSchema(schema);
    },
  };
}

export interface TestSession {
  readonly sid: string;
  readonly csrf: string;
  readonly cookie: string;
  readonly setCookies: readonly string[];
}

export async function login(
  ctx: TestContext,
  email: string,
  password: string,
): Promise<TestSession> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  if (response.statusCode !== 204) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  return sessionFromResponse(response.headers['set-cookie']);
}

export function sessionFromResponse(
  setCookieHeader: string | string[] | undefined,
): TestSession {
  const setCookies =
    setCookieHeader === undefined
      ? []
      : Array.isArray(setCookieHeader)
        ? setCookieHeader
        : [setCookieHeader];
  const cookies = new Map<string, string>();
  for (const cookie of setCookies) {
    const pair = cookie.split(';', 1)[0];
    if (pair === undefined) continue;
    const index = pair.indexOf('=');
    if (index < 0) continue;
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const sid = cookies.get('sid');
  const csrf = cookies.get('csrf');
  if (sid === undefined || csrf === undefined) {
    throw new Error(`session cookies missing: ${setCookies.join(' | ')}`);
  }
  return {
    sid,
    csrf,
    cookie: `sid=${sid}; csrf=${csrf}`,
    setCookies,
  };
}

export function authHeaders(
  session: TestSession,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
    ...extra,
  };
}

export function newIdempotencyKey(): string {
  return randomUUID();
}
