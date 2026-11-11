import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { E2EState } from './state';

/**
 * Direct access to the throwaway E2E schema for fixture steps that have no
 * public API (M5 has no "lock block" endpoint yet). Only used to arrange
 * preconditions; every assertion still goes through the planner API or UI.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(repoRoot, 'services/api/package.json'));
const pg = require('pg') as {
  Client: new (options: { connectionString: string }) => {
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
    end(): Promise<void>;
  };
};

function scopedUrl(state: E2EState): string {
  const url = new URL(state.baseDatabaseUrl);
  if (!/^[a-z_][a-z0-9_]*$/.test(state.databaseSchema)) throw new Error('invalid E2E schema');
  url.searchParams.set('options', `-csearch_path=${state.databaseSchema}`);
  return url.toString();
}

/** Mark one approved schedule block as locked (the user pinned it). */
export async function lockScheduleBlock(state: E2EState, blockId: string): Promise<void> {
  const client = new pg.Client({ connectionString: scopedUrl(state) });
  await client.connect();
  try {
    const result = await client.query(
      'UPDATE schedule_block SET locked = true WHERE id = $1 AND locked = false',
      [blockId],
    );
    if (result.rowCount !== 1) throw new Error(`schedule block ${blockId} could not be locked`);
  } finally {
    await client.end();
  }
}
