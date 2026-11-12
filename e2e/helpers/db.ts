import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { E2EState } from './state';

/**
 * Direct access to the throwaway E2E schema for fixture steps that have no
 * public API. Only used to read or arrange what no endpoint exposes; every
 * assertion on behaviour still goes through the planner API or UI. (Block
 * locks go through `POST /schedule-blocks/{id}:lock` since FU-71.)
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(repoRoot, 'services/api/package.json'));
const pg = require('pg') as {
  Client: new (options: { connectionString: string }) => {
    connect(): Promise<void>;
    query(
      text: string,
      values?: unknown[],
    ): Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  };
};

function scopedUrl(state: E2EState): string {
  const url = new URL(state.baseDatabaseUrl);
  if (!/^[a-z_][a-z0-9_]*$/.test(state.databaseSchema)) throw new Error('invalid E2E schema');
  url.searchParams.set('options', `-csearch_path=${state.databaseSchema}`);
  return url.toString();
}

/** FU-76: statuses of an owner's AI runs for one purpose (oldest first). */
export async function agentRunStatuses(
  state: E2EState,
  ownerId: string,
  purpose: string,
): Promise<string[]> {
  const client = new pg.Client({ connectionString: scopedUrl(state) });
  await client.connect();
  try {
    const result = await client.query(
      'SELECT status FROM agent_run WHERE owner_id = $1 AND purpose = $2 ORDER BY created_at, id',
      [ownerId, purpose],
    );
    return result.rows.map((row) => String(row['status']));
  } finally {
    await client.end();
  }
}
