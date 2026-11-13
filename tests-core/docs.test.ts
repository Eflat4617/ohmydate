/**
 * Keeps the plan honest: the route matrix and the data model map of
 * `docs/blueprint/15-DESKTOP-RUST-CORE.md` must cover the contract and the
 * PostgreSQL migrations completely, and agree with what the core serves.
 * No core process is needed for this file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contractRoutes } from './support/contract.js';
import { droppedOperations, portedRoutes } from './support/routes.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const plan = readFileSync(`${repoRoot}docs/blueprint/15-DESKTOP-RUST-CORE.md`, 'utf8');

/** Table rows between `<!-- name:start -->` and `<!-- name:end -->`, split into cells. */
function tableRows(name: string): string[][] {
  const start = plan.indexOf(`<!-- ${name}:start -->`);
  const end = plan.indexOf(`<!-- ${name}:end -->`);
  if (start < 0 || end < start) throw new Error(`section ${name} is missing from the plan`);
  return plan
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function unquote(cell: string | undefined): string {
  return (cell ?? '').replace(/`/g, '');
}

describe('route parity matrix (15 §2.2)', () => {
  const rows = tableRows('route-matrix').map((cells) => ({
    operationId: unquote(cells[0]),
    route: unquote(cells[1]),
    verdict: cells[2] ?? '',
    stage: cells[3] ?? '',
  }));

  test('lists every contract operation exactly once, with its method and path', () => {
    const listed = rows.map((row) => row.operationId).sort();
    expect(listed).toEqual(contractRoutes.map((route) => route.operationId).sort());
    for (const route of contractRoutes) {
      const row = rows.find((entry) => entry.operationId === route.operationId);
      expect(row?.route).toBe(`${route.method.toUpperCase()} ${route.path}`);
    }
  });

  test('uses the three verdicts and names a stage for everything that is kept', () => {
    for (const row of rows) {
      expect(['유지', '유지(차이)', '제외'], row.operationId).toContain(row.verdict);
      if (row.verdict === '제외') expect(row.stage).toBe('—');
      else expect(row.stage, row.operationId).toMatch(/^RC-\d+$/);
    }
    expect(() => tableRows('no-such-section')).toThrow();
  });

  test('agrees with the core: dropped operations are 제외, ported ones are stage RC-00 or later', () => {
    const dropped = rows.filter((row) => row.verdict === '제외').map((row) => row.operationId);
    expect(dropped.sort()).toEqual([...droppedOperations].sort());
    for (const entry of portedRoutes) {
      const row = rows.find((candidate) => candidate.operationId === entry.operationId);
      expect(row?.verdict, entry.operationId).not.toBe('제외');
    }
    // Everything the plan assigns to RC-00 is served today.
    const firstStage = rows.filter((row) => row.stage === 'RC-00').map((row) => row.operationId);
    const served = portedRoutes.map((entry) => entry.operationId);
    expect(firstStage.filter((id) => !served.includes(id))).toEqual([]);
  });
});

/** Tables and columns created by `services/api/migrations/NNNN_*.sql`. */
function migrationColumns(): Map<string, string[]> {
  const directory = `${repoRoot}services/api/migrations`;
  const tables = new Map<string, string[]>();
  const files = readdirSync(directory)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file) && !file.endsWith('.down.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(`${directory}/${file}`, 'utf8').replace(/--.*$/gm, '');
    for (const match of sql.matchAll(/CREATE TABLE "?(\w+)"? \(([\s\S]*?)\n\);/g)) {
      const columns: string[] = [];
      for (const line of (match[2] ?? '').split('\n')) {
        const column =
          /^\s{2}"?([a-z_0-9]+)"?\s+(?:uuid|text|integer|boolean|timestamptz|jsonb|date|real|numeric|bytea|tsvector)/.exec(
            line,
          );
        if (column?.[1] !== undefined) columns.push(column[1]);
      }
      tables.set(match[1] ?? '', columns);
    }
    for (const match of sql.matchAll(/ALTER TABLE (\w+)\s+((?:ADD COLUMN [^;]+))/g)) {
      const columns = tables.get(match[1] ?? '');
      for (const added of (match[2] ?? '').matchAll(/ADD COLUMN (\w+)/g)) {
        if (added[1] !== undefined) columns?.push(added[1]);
      }
    }
  }
  return tables;
}

describe('data model map (15 §3.3)', () => {
  const rows = tableRows('data-model').map((cells) => ({
    table: unquote(cells[0]),
    verdict: cells[2] ?? '',
    sqlite: unquote(cells[3]),
    columns: cells[5] ?? '',
  }));
  const migrated = migrationColumns();

  test('the migration parser sees the whole schema', () => {
    expect(migrated.size).toBe(53);
    expect([...migrated.values()].flat().length).toBe(555);
    expect(migrated.get('task')).toContain('provider_etag');
    expect(migrated.get('commitment_event')).toContain('external_etag');
  });

  test('lists every PostgreSQL table exactly once with a verdict', () => {
    expect(rows.map((row) => row.table).sort()).toEqual([...migrated.keys()].sort());
    for (const row of rows) {
      expect(['유지', '변형', '제외'], row.table).toContain(row.verdict);
      if (row.verdict === '제외') expect(row.sqlite, row.table).toBe('—');
      else expect(row.sqlite, row.table).toMatch(/^[a-z_]+$/);
    }
  });

  test('accounts for every column of every table', () => {
    for (const [table, columns] of migrated) {
      const row = rows.find((entry) => entry.table === table);
      const mentioned = [...(row?.columns ?? '').matchAll(/`([a-z_0-9]+)`/g)].map((match) => match[1]);
      for (const column of columns) {
        expect(mentioned, `${table}.${column} is not in the data model map`).toContain(column);
      }
    }
  });

  test('drops every column of a dropped table and owner_id everywhere', () => {
    for (const row of rows) {
      const kept = row.columns
        .split(' ')
        .filter((token) => token.startsWith('`'))
        .map((token) => unquote(token.split('→')[0]));
      if (row.verdict === '제외') expect(kept, row.table).toEqual([]);
      expect(kept, row.table).not.toContain('owner_id');
    }
  });
});
