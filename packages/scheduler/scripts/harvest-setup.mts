/**
 * Harvests the inputs of the reference test suite (blueprint 15 §5.3).
 *
 * Loaded as a vitest setup file by `harvest.vitest.config.mts`: it wraps
 * `generate` so that every `(input, options)` the scheduler's own tests pass
 * to it is appended to the file named by `ORACLE_HARVEST_OUT`, one JSON
 * document per line. Those tests hold the scenarios the reference was fixed
 * against (staged replan expansion, gap-fitted splits, history exemption,
 * auto-split), which seeded random inputs reach rarely or never; the
 * exporter turns them into oracle cases (`--corpus`).
 *
 * The wrapped function returns the reference's result unchanged.
 *
 * This file is tooling: it is not imported by the package and is not a test.
 */
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, vi } from 'vitest';
import type * as GenerateModule from '../src/generate.js';
import { canonicalJson } from '../src/hash.js';
import { survivesJson } from './oracle-lib.mjs';

/**
 * Property tests call `generate` thousands of times; keep the first inputs
 * of each test. The limit is per test, not per file, so that the later tests
 * of a file — the seeded replan corpora among them — are recorded too.
 */
const MAX_PER_TEST = 200;

const out = process.env['ORACLE_HARVEST_OUT'];
const seen = new Set<string>();
const perTest = new Map<string, number>();

function record(input: unknown, options: unknown): void {
  if (out === undefined) return;
  const test = expect.getState().currentTestName ?? '';
  const recorded = perTest.get(test) ?? 0;
  if (recorded >= MAX_PER_TEST) return;
  // NaN, Infinity and holes would be rewritten by JSON: such inputs probe the
  // reference itself and cannot be handed to the port unchanged.
  if (!survivesJson(input) || !survivesJson(options ?? null)) return;
  let line: string;
  try {
    const key = canonicalJson({ input, options: options ?? null });
    if (seen.has(key)) return;
    seen.add(key);
    perTest.set(test, recorded + 1);
    line = JSON.stringify({
      file: basename(expect.getState().testPath ?? 'unknown'),
      input,
      options: options ?? null,
    });
  } catch {
    // Not serialisable: not an input the port can be given either.
    return;
  }
  appendFileSync(out, `${line}\n`);
}

vi.mock('../src/generate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GenerateModule>();
  const generate: typeof actual.generate = (input, options) => {
    record(input, options);
    return actual.generate(input, options);
  };
  return { ...actual, generate };
});
