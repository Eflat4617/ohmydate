/**
 * The schema verdict comparison (blueprint 15 §11 R13, §2.4).
 *
 * The contract's JSON schemas are checked by two validators: Ajv in the
 * TypeScript API, the `jsonschema` crate in the Rust core. Where they
 * disagree, the same request is accepted by one core and refused by the
 * other. This test builds samples for every request schema of the contract
 * (`support/samples.ts`), asks both, and lists every sample with two
 * verdicts.
 *
 * - The reference: `compile` of `packages/contracts/test/ajv.ts` — Ajv as the
 *   contract package configures it — on the TypeBox schemas of the routes.
 * - The core: the `schema-verdict` binary, which calls what the dispatcher
 *   calls (`core/crates/server/src/verdict.rs`).
 *
 * A difference is either fixed in the core or decided and listed in
 * `support/schema-differences.ts` and the plan's §2.4. The test fails on a
 * difference that is not listed and on a listed one that is gone. A
 * difference seen only in operations the desktop core does not serve needs
 * no decision (the core answers 404 before it validates) and is reported
 * only. The full report is written to `core/target/schema-diff/report.md`.
 *
 * `corepack pnpm run core:schema-diff` builds the binary and runs this file.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteDefinition } from '@ohmydate/contracts';
import { compile } from '../packages/contracts/test/ajv.js';
import { contractRoutes } from './support/contract.js';
import { droppedOperations } from './support/routes.js';
import {
  FORMAT_NAMES,
  KNOWN_KEYWORDS,
  PATTERN_SOURCES,
  keywordsOf,
  samplesOf,
  type Sample,
  type Schema,
} from './support/samples.js';
import { knownDifferences } from './support/schema-differences.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const binary = join(repoRoot, 'core/target/debug/schema-verdict');
const reportDirectory = join(repoRoot, 'core/target/schema-diff');

/** TypeBox schemas carry symbols and `$id`s; a comparison needs plain JSON. */
function plain(schema: unknown): Schema {
  return JSON.parse(JSON.stringify(schema, (key, value: unknown) => (key === '$id' ? undefined : value))) as Schema;
}

interface Part {
  readonly operationId: string;
  /** `body`, `query`, `params` or `header:<name>` — the names `schema-verdict` reads. */
  readonly part: string;
  readonly schema: Schema;
  readonly dropped: boolean;
}

/** True for a control character, or half of a surrogate pair on its own. */
function isUnprintable(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff);
}

/** Header values arrive as text with the blanks around them already removed. */
function headerSample(_kind: string, text: string): boolean {
  if (!text.startsWith('"')) return false;
  const value = JSON.parse(text) as string;
  return value === value.trim() && ![...value].some(isUnprintable);
}

function partsOf(route: RouteDefinition): Part[] {
  const dropped = droppedOperations.includes(route.operationId);
  const parts: Part[] = [];
  const add = (part: string, schema: unknown): void => {
    if (schema !== undefined) parts.push({ operationId: route.operationId, part, schema: plain(schema), dropped });
  };
  add('body', route.body);
  add('query', route.query);
  add('params', route.params);
  const headers = route.headers === undefined ? undefined : plain(route.headers);
  for (const [name, schema] of Object.entries(headers?.properties ?? {})) {
    add(`header:${name.toLowerCase()}`, schema);
  }
  return parts;
}

interface Judged extends Sample {
  readonly operationId: string;
  readonly part: string;
  readonly dropped: boolean;
  /** `valid`, `invalid`, or `unreadable` when `JSON.parse` refuses the text. */
  readonly reference: string;
  /** `valid`, `invalid`, `unreadable`, or `no-rule`. */
  readonly core: string;
}

const accepts = (verdict: string): boolean => verdict === 'valid' || verdict === 'no-rule';

function judgeAll(): Judged[] {
  const pending: Omit<Judged, 'core'>[] = [];
  for (const route of contractRoutes) {
    for (const part of partsOf(route)) {
      const validate = compile(part.schema);
      const isHeader = part.part.startsWith('header:');
      for (const sample of samplesOf(part.schema, isHeader ? headerSample : undefined)) {
        let reference: string;
        try {
          reference = validate(JSON.parse(sample.text)) ? 'valid' : 'invalid';
        } catch {
          reference = 'unreadable';
        }
        pending.push({
          ...sample,
          // Kinds of header samples carry the header's name: a header is
          // judged by a rule of its own in the core, not by a schema.
          kind: isHeader ? `${part.part}:${sample.kind}` : sample.kind,
          operationId: part.operationId,
          part: part.part,
          dropped: part.dropped,
          reference,
        });
      }
    }
  }

  const input = pending
    .map((sample, id) => JSON.stringify({ id, operation: sample.operationId, part: sample.part, text: sample.text }))
    .join('\n');
  const run = spawnSync(binary, [], { input, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new Error(`schema-verdict exited with ${run.status}: ${run.stderr}`);
  const verdicts = new Map<number, string>();
  for (const line of run.stdout.split('\n')) {
    if (line.length === 0) continue;
    const answer = JSON.parse(line) as { id: number; verdict: string };
    verdicts.set(answer.id, answer.verdict);
  }
  return pending.map((sample, id) => {
    const core = verdicts.get(id);
    if (core === undefined) throw new Error(`schema-verdict gave no verdict for sample ${id}`);
    return { ...sample, core };
  });
}

interface Difference {
  readonly kind: string;
  readonly referenceAccepts: boolean;
  readonly reference: string;
  readonly core: string;
  readonly samples: readonly Judged[];
  /** Seen only in operations the desktop core does not serve. */
  readonly droppedOnly: boolean;
}

function differencesOf(judged: readonly Judged[]): Difference[] {
  const groups = new Map<string, Judged[]>();
  for (const sample of judged) {
    if (sample.kind === 'base' || accepts(sample.reference) === accepts(sample.core)) continue;
    const key = `${sample.kind}\u0000${accepts(sample.reference)}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.values()]
    .map((samples) => {
      const first = samples[0] as Judged;
      return {
        kind: first.kind,
        referenceAccepts: accepts(first.reference),
        reference: first.reference,
        core: first.core,
        samples,
        droppedOnly: samples.every((sample) => sample.dropped),
      };
    })
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

/** Sample text for the report: invisible characters written as escapes. */
/** The listed decision that covers a difference, if any. */
function decisionFor(difference: Difference): (typeof knownDifferences)[number] | undefined {
  return knownDifferences.find(
    (entry) =>
      entry.referenceAccepts === difference.referenceAccepts &&
      (entry.family === true ? difference.kind.startsWith(entry.kind) : entry.kind === difference.kind),
  );
}

function shown(text: string): string {
  const visible = [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const invisible = isUnprintable(character) || code === 0x2028 || code === 0x2029 || code === 0xfeff;
      return invisible ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    })
    .join('');
  return visible.length > 100 ? `${visible.slice(0, 97)}…` : visible;
}

function report(judged: readonly Judged[], differences: readonly Difference[]): string {
  const lines = [
    '# Schema verdict comparison',
    '',
    `Samples: ${judged.length} (base instances ${judged.filter((sample) => sample.kind === 'base').length}).`,
    `Kinds of sample: ${new Set(judged.map((sample) => sample.kind)).size}.`,
    `Samples with two verdicts: ${differences.reduce((sum, difference) => sum + difference.samples.length, 0)}`,
    `in ${differences.length} kinds.`,
    '',
    '| Kind | Reference (Ajv) | Core (jsonschema) | Samples | Places | Decision |',
    '|---|---|---|---|---|---|',
  ];
  for (const difference of differences) {
    const places = new Set(difference.samples.map((sample) => `${sample.operationId} ${sample.part}`));
    const decision = difference.droppedOnly
      ? 'not served (404 before validation)'
      : (decisionFor(difference)?.decision ?? '**undecided**');
    lines.push(
      `| \`${difference.kind}\` | ${difference.reference} | ${difference.core} | ${difference.samples.length} | ` +
        `${places.size} | ${decision} |`,
    );
  }
  // Every kind, also the ones both judge alike: what was compared at all.
  lines.push('', '## Every kind of sample', '', '| Kind | Samples | Reference / core |', '|---|---|---|');
  const kinds = new Map<string, Judged[]>();
  for (const sample of judged) kinds.set(sample.kind, [...(kinds.get(sample.kind) ?? []), sample]);
  for (const [kind, samples] of [...kinds.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const verdicts = new Map<string, number>();
    for (const sample of samples) {
      const pair = `${sample.reference} / ${sample.core}`;
      verdicts.set(pair, (verdicts.get(pair) ?? 0) + 1);
    }
    const pairs = [...verdicts.entries()].map(([pair, count]) => `${pair} × ${count}`).join(', ');
    lines.push(`| \`${kind}\` | ${samples.length} | ${pairs} |`);
  }
  lines.push('', '## Every sample with two verdicts', '');
  for (const difference of differences) {
    lines.push(`### ${difference.kind} — reference ${difference.reference}, core ${difference.core}`, '');
    for (const sample of difference.samples) {
      lines.push(`- ${sample.operationId} ${sample.part} ${sample.pointer}: \`${shown(sample.text)}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const available = existsSync(binary);
const judged = available ? judgeAll() : [];
const differences = differencesOf(judged);
if (available) {
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, 'report.md'), report(judged, differences));
}

describe('schema verdicts: Ajv and the core (15 §11 R13)', () => {
  test('the core side of the tool is built', () => {
    expect(available, `${binary} is missing: run \`corepack pnpm run core:build\``).toBe(true);
  });

  test('the generator knows every keyword, format and pattern the contract uses', () => {
    const keywords = new Set<string>();
    const formats = new Set<string>();
    const patterns = new Set<string>();
    const collect = (schema: unknown): void => {
      if (Array.isArray(schema)) schema.forEach(collect);
      else if (schema !== null && typeof schema === 'object') {
        const record = schema as Record<string, unknown>;
        if (typeof record['format'] === 'string') formats.add(record['format']);
        if (typeof record['pattern'] === 'string') patterns.add(record['pattern']);
        Object.values(record).forEach(collect);
      }
    };
    for (const route of contractRoutes) {
      for (const part of partsOf(route)) {
        keywordsOf(part.schema, keywords);
        collect(part.schema);
      }
    }
    // A keyword the generator does not vary would be compared with nothing.
    expect([...keywords].filter((keyword) => !KNOWN_KEYWORDS.includes(keyword))).toEqual([]);
    expect([...formats].sort()).toEqual([...FORMAT_NAMES].sort());
    expect([...patterns].filter((pattern) => !PATTERN_SOURCES.includes(pattern))).toEqual([]);
  });

  test('every request schema of the contract is sampled, and both validators accept its base instance', () => {
    const bases = judged.filter((sample) => sample.kind === 'base');
    const sampled = (part: string): number => bases.filter((sample) => sample.part === part).length;
    expect(sampled('body')).toBe(contractRoutes.filter((route) => route.body !== undefined).length);
    expect(sampled('query')).toBe(contractRoutes.filter((route) => route.query !== undefined).length);
    expect(sampled('params')).toBe(contractRoutes.filter((route) => route.params !== undefined).length);
    expect([sampled('body'), sampled('query'), sampled('params')]).toEqual([37, 14, 45]);
    for (const base of bases) {
      const where = `${base.operationId} ${base.part}: ${base.text.slice(0, 200)}`;
      expect(base.reference, `the reference refuses the base instance of ${where}`).toBe('valid');
      expect(base.core, `the core refuses the base instance of ${where}`).toBe('valid');
    }
  });

  test('the comparison is not empty: both validators refuse and accept plenty', () => {
    expect(judged.length).toBeGreaterThan(10_000);
    expect(new Set(judged.map((sample) => sample.kind)).size).toBeGreaterThan(400);
    for (const format of FORMAT_NAMES) {
      const ofFormat = judged.filter((sample) => sample.kind.includes(`format:${format}:`));
      expect(ofFormat.filter((sample) => sample.reference === 'valid').length, format).toBeGreaterThan(0);
      expect(ofFormat.filter((sample) => sample.reference === 'invalid').length, format).toBeGreaterThan(0);
      expect(ofFormat.filter((sample) => sample.core === 'invalid').length, format).toBeGreaterThan(0);
    }
    for (const family of ['length:', 'integer:', 'object:closed:unknown-property', 'enum:', 'array:', 'type:']) {
      const ofFamily = judged.filter((sample) => sample.kind.startsWith(family));
      expect(ofFamily.filter((sample) => sample.core === 'invalid').length, family).toBeGreaterThan(0);
      expect(ofFamily.filter((sample) => sample.reference === 'invalid').length, family).toBeGreaterThan(0);
    }
    // The core never has "no rule" where the contract has a schema.
    expect(judged.filter((sample) => sample.core === 'no-rule')).toEqual([]);
  });

  test('every difference is a decided one, and every decided one still occurs', () => {
    const name = (kind: string, referenceAccepts: boolean): string =>
      `${kind} | reference ${referenceAccepts ? 'accepts' : 'refuses'}, core ${referenceAccepts ? 'refuses' : 'accepts'}`;
    // The core answers 404 for a dropped operation before it validates
    // anything, so a difference seen only there cannot be observed.
    const served = differences.filter((difference) => !difference.droppedOnly);
    expect(
      served
        .filter((difference) => decisionFor(difference) === undefined)
        .map((difference) => name(difference.kind, difference.referenceAccepts)),
      'verdict differences without a decision — fix the core, or decide and list them ' +
        '(tests-core/support/schema-differences.ts and 15 §2.4). Report: core/target/schema-diff/report.md',
    ).toEqual([]);
    expect(
      knownDifferences
        .filter((entry) => entry.family !== true)
        .filter((entry) => !served.some((difference) => decisionFor(difference) === entry))
        .map((entry) => name(entry.kind, entry.referenceAccepts)),
      'listed differences that no longer occur — remove them from the list and from 15 §2.4',
    ).toEqual([]);
    const listed = knownDifferences.map((entry) => name(entry.kind, entry.referenceAccepts));
    expect(new Set(listed).size).toBe(listed.length);
  });

  test('time zones: the core accepts every name the reference accepts', () => {
    // S3 decides one direction only. This is the other one, said out loud.
    const zones = judged.filter((sample) => sample.kind.startsWith('format:iana-time-zone:'));
    expect(zones.length).toBeGreaterThan(100);
    expect(
      zones
        .filter((sample) => sample.reference === 'valid' && sample.core !== 'valid')
        .map((sample) => sample.kind),
    ).toEqual([]);
    // Names both know, and names neither takes for a zone.
    const verdictsOf = (kind: string): string[] => [
      ...new Set(zones.filter((sample) => sample.kind === kind).map((sample) => `${sample.reference}/${sample.core}`)),
    ];
    for (const kind of ['canonical', 'utc', 'etc-utc', 'renamed-old-calcutta', 'renamed-old-kiev']) {
      expect(verdictsOf(`format:iana-time-zone:${kind}`), kind).toEqual(['valid/valid']);
    }
    for (const kind of ['lowercase', 'uppercase', 'numeric-offset', 'abbreviation', 'unknown', 'factory', 'localtime', 'traversal', 'empty']) {
      expect(verdictsOf(`format:iana-time-zone:${kind}`), kind).toEqual(['invalid/invalid']);
    }
  });
});
