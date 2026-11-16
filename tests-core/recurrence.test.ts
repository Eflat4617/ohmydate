/**
 * Keeps the recurrence oracle honest (blueprint 15 §6.1): the sample that
 * `cargo test` replays against the Rust port must be what the TypeScript
 * reference answers *today*. Without this check a change of the reference —
 * or of the tz database inside Node — would leave the Rust side comparing
 * itself with an old answer. No core process is needed for this file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildPack,
  FORMAT,
  FORMAT_VERSION,
  packText,
  SAMPLE,
  type ExpandRecord,
  type ParseRecord,
} from './support/recurrence-oracle.js';

const samplePath = fileURLToPath(
  new URL('../core/crates/recurrence/tests/oracle/sample.jsonl', import.meta.url),
);

/** Numbers (1-based) of the lines that differ; a missing line differs. */
function differingLines(left: readonly string[], right: readonly string[]): number[] {
  const numbers: number[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) numbers.push(index + 1);
  }
  return numbers;
}

describe('recurrence oracle', () => {
  const committed = readFileSync(samplePath, 'utf8').split('\n');
  const pack = buildPack(SAMPLE);
  const fresh = packText(pack).split('\n');

  test('the committed sample is what the reference answers today', () => {
    const header = JSON.parse(committed[0] ?? '{}') as typeof pack.header;
    expect(header.format).toBe(FORMAT);
    expect(header.formatVersion).toBe(FORMAT_VERSION);
    expect(header.oracle.seed).toBe(SAMPLE.seed);
    expect(header.oracle.count).toBe(SAMPLE.count);
    // The header names the Node and tz database that wrote the file; the
    // records below it must be the same whoever writes them.
    const differing = differingLines(committed.slice(1), fresh.slice(1));
    expect(
      differing.slice(0, 5),
      `${differing.length} record(s) differ from the reference ` +
        `(sample written with tzdata ${header.oracle.tzdata}, this Node has ${pack.header.oracle.tzdata}). ` +
        'Make the sample again with `corepack pnpm run core:rrule-oracle`, then run ' +
        '`cargo test -p ohmydate-recurrence`: a mismatch there is a real difference between the two cores.',
    ).toEqual([]);
  });

  test('the same seed gives the same pack, another seed another one', () => {
    expect(packText(buildPack(SAMPLE))).toBe(packText(pack));
    const other = packText(buildPack({ seed: SAMPLE.seed + 1, count: 20 }));
    expect(other).not.toBe(packText(buildPack({ seed: SAMPLE.seed, count: 20 })));
  });

  test('a changed, missing or added record is noticed', () => {
    expect(differingLines(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(differingLines(['a', 'b'], ['a', 'B'])).toEqual([2]);
    expect(differingLines(['a', 'b'], ['a'])).toEqual([2]);
    expect(differingLines(['a'], ['a', 'b', 'c'])).toEqual([2, 3]);
  });

  test('the sample holds what the port has to prove', () => {
    const parses = pack.records.filter((record): record is ParseRecord => record.t === 'parse');
    const expansions = pack.records.filter(
      (record): record is ExpandRecord => record.t === 'expand',
    );
    expect(parses.length).toBeGreaterThanOrEqual(600);
    expect(parses.filter((record) => record.rule !== undefined).length).toBeGreaterThanOrEqual(50);
    expect(expansions.length).toBeGreaterThanOrEqual(400);
    const sum = (pick: (record: ExpandRecord) => number): number =>
      expansions.reduce((total, record) => total + pick(record), 0);
    // Occurrences on wall times a clock change skipped, and on ones that happened twice.
    expect(sum((record) => record.gaps ?? 0)).toBeGreaterThanOrEqual(50);
    expect(sum((record) => record.overlaps ?? 0)).toBeGreaterThanOrEqual(50);
    // Clock changes in both hemispheres and a zone without any.
    const zones = new Set(expansions.map((record) => record.commitment.timeZone));
    for (const zone of ['America/New_York', 'Australia/Sydney', 'Asia/Seoul', 'UTC']) {
      expect(zones, zone).toContain(zone);
    }
    // Every test of services/api/test/rrule.test.ts that expands something.
    expect(expansions.filter((record) => record.kind === 'test').length).toBe(12);
    // The pack is plain ASCII, one record per line.
    expect(/^[\x20-\x7e\n]*$/u.test(packText(pack))).toBe(true);
  });
});
