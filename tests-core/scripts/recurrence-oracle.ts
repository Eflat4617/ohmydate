/**
 * Writes a recurrence oracle pack (see `../support/recurrence-oracle.ts`).
 *
 *   corepack pnpm run core:rrule-oracle                      # the committed sample
 *   corepack pnpm run core:rrule-oracle -- --count 20000 --seed 7 --name diff --out core/target/recurrence-oracle
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack, packText, SAMPLE } from '../support/recurrence-oracle.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function integer(name: string, fallback: number): number {
  const text = option(name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return value;
}

const count = integer('count', SAMPLE.count);
const seed = integer('seed', SAMPLE.seed);
const directory = resolve(repoRoot, option('out') ?? 'core/crates/recurrence/tests/oracle');
const name = option('name') ?? 'sample';

const pack = buildPack({ seed, count });
mkdirSync(directory, { recursive: true });
const file = resolve(directory, `${name}.jsonl`);
const text = packText(pack);
writeFileSync(file, text);

const kinds = new Map<string, number>();
for (const record of pack.records) kinds.set(record.t, (kinds.get(record.t) ?? 0) + 1);
process.stdout.write(
  `${file}: ${pack.records.length} records (${[...kinds].map(([kind, total]) => `${kind} ${total}`).join(', ')}), ` +
    `${Math.round(text.length / 1024)} KiB, seed ${seed}, tzdata ${pack.header.oracle.tzdata}\n`,
);
