// Spawned production-default HTTP fixture for FU-37R findings 2 and 3.
//
// It loads the compiled dist app, uses the same pool/shutdown helpers as
// dist/main.js, and serves an authenticated GET /api/v1/projects through a
// deliberately slow repository. That makes a >10 s valid handler observable
// over a real socket without inventing production routes.
import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { Kysely, PostgresDialect } from 'kysely';
import { buildApp } from '../../dist/app.js';
import { UserService } from '../../dist/application/user-service.js';
import { PgUserRepository } from '../../dist/adapters/pg-user-repository.js';
import { createConfig } from '../../dist/config.js';
import {
  createApplicationClose,
  createDatabasePool,
  createShutdownController,
} from '../../dist/main.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required');
}
const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? '0');
const delayMs = Number(process.env['SLOW_HANDLER_MS'] ?? '11000');
const email = process.env['TEST_EMAIL'] ?? 'slow-handler@example.com';
const password = process.env['TEST_PASSWORD'] ?? 'slow-handler-password';

const clock = { now: () => new Date().toISOString() };
const ids = { next: () => randomUUID() };
const pool = createDatabasePool(databaseUrl);
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

function project(ownerId) {
  const now = clock.now();
  return {
    id: randomUUID(),
    ownerId,
    title: 'Inbox',
    kind: 'inbox',
    archived: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const projects = {
  async getInbox(ownerId) {
    return project(ownerId);
  },
  async list() {
    await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
    return { items: [], nextCursor: null };
  },
  async create() {
    throw new Error('slow-app: create is not used');
  },
  async get() {
    return null;
  },
  async update() {
    throw new Error('slow-app: update is not used');
  },
};
const tasks = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error('slow-app: tasks are not used');
      };
    },
  },
);

const app = await buildApp({
  config: createConfig({ provider: 'memory', cookieSecure: false, logLevel: 'silent' }),
  repos: { projects, tasks },
  clock,
  ids,
  db,
  logger: false,
});

const users = new PgUserRepository(db, clock);
await new UserService(users).create({
  id: randomUUID(),
  email,
  passwordHash: await hash(password),
});

const shutdown = createShutdownController({
  logger: { info: () => undefined, error: () => undefined },
  close: createApplicationClose(app),
  destroy: () => db.destroy(),
  exit: (code) => process.exit(code),
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}

await app.listen({ host, port });
process.stdout.write('slow-app ready\n');
