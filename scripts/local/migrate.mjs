#!/usr/bin/env node
// Apply pending planner migrations to the resolved local target. Prints only
// applied filenames (never the database URL or password).
import {
  createContext,
  databaseUrl,
  fail,
  isEntryPoint,
  log,
  parseFlags,
} from './common.mjs';
import { appliedMigrationFiles, ensureMigrations } from './stack.mjs';

export async function migrateLocal(options = {}) {
  const env = options.env ?? process.env;
  const context = options.context ?? createContext(env);
  const apply = options.ensureMigrations ?? ensureMigrations;
  const output = await apply(databaseUrl(context));
  const applied = appliedMigrationFiles(typeof output === 'string' ? output : '');
  if (applied.length > 0) {
    log(`플래너 마이그레이션 적용: ${applied.join(', ')}`);
  } else {
    log('적용할 플래너 마이그레이션이 없습니다.');
  }
  return applied;
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.has('help')) {
    console.log(
      'usage: node scripts/local/migrate.mjs\n' +
        'env: OHMYDATE_LOCAL_DATABASE_URL, OHMYDATE_LOCAL_SECRETS_DIR',
    );
    return;
  }
  await migrateLocal();
}

if (isEntryPoint(import.meta.url)) {
  await main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
