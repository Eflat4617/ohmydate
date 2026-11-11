// Spawned compiled fixture for FU-42c requirement 2.
//
// It wires the production shutdown controller at boot, before listening, and
// exposes one handler that ignores the abort signal. Shutdown must therefore
// time out the cleanup budget, log the unsettled operation, destroy the
// database only afterwards, and exit 1.
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { buildApp } from '../../dist/app.js';
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
const drainMs = Number(process.env['TEST_DRAIN_MS'] ?? '300');
const cleanupMs = Number(process.env['TEST_CLEANUP_MS'] ?? '600');
const deadlineMs = Number(process.env['TEST_DEADLINE_MS'] ?? '5000');

const clock = { now: () => new Date().toISOString() };
const ids = { next: () => randomUUID() };
const pool = createDatabasePool(databaseUrl);
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

const unused = () => {
  throw new Error('never-settling-app: repositories are not used');
};
const repos = {
  projects: { getInbox: unused, list: unused, create: unused, get: unused, update: unused },
  tasks: { list: unused, create: unused, get: unused, update: unused, complete: unused, delete: unused },
};

const app = await buildApp({
  config: createConfig({ provider: 'memory', cookieSecure: false, logLevel: 'silent' }),
  repos,
  clock,
  ids,
  db,
  logger: { level: 'error' },
});

app.get('/never', async () => {
  process.stdout.write('HANDLER_STARTED\n');
  // Deliberately ignores the application abort signal.
  return new Promise(() => undefined);
});

let sequence = 0;
const trace = (event) => {
  sequence += 1;
  process.stdout.write(`SEQ:${sequence}:${event}\n`);
};

const shutdown = createShutdownController({
  logger: {
    info: () => undefined,
    error: (details, message) => app.log.error(details, message),
  },
  close: createApplicationClose(app, drainMs, cleanupMs, trace),
  destroy: async () => {
    await db.destroy();
    process.stdout.write('DB_DESTROYED\n');
  },
  exit: (code) => process.exit(code),
  deadlineMs,
  trace,
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}

await app.listen({ host, port });
process.stdout.write('never-app ready\n');
