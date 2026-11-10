import { redact } from '../src/index.js';
import { redactWithSpans, type RedactionSpan } from '../src/privacy.js';
import type { RedactionKind } from '../src/privacy.js';
import { redactWithSpans as snapshotRedactWithSpans } from './fixtures/privacy-fu32-snapshot.js';
import { oracleCoverage } from './fixtures/privacy-oracle.js';

/**
 * FU-38c GB-1 gate.
 *
 * 1. INDEPENDENT oracle: every supported shape's core glyphs must be found by a separate
 *    per-start brute-force matcher and masked by the scanner.
 * 2. No per-glyph recall regressions against the frozen FU-32 implementation snapshot.
 * 3. Seeded, deterministic corpus: single tokens of every kind/style, same-kind 2/3-token
 *    runs, cross-kind adjacency in both orders, and glued/space/ZWSP/ZWNJ/U+00AD joiners.
 */

interface CoreRange {
  readonly start: number;
  readonly end: number;
}

interface Case {
  readonly name: string;
  readonly text: string;
  readonly core: readonly CoreRange[];
}

function coverageFromSpans(length: number, spans: readonly RedactionSpan[]): Uint8Array {
  const coverage = new Uint8Array(length);
  for (const span of spans) {
    for (let index = span.start; index < span.end; index += 1) coverage[index] = 1;
  }
  return coverage;
}

function requiredDigit(char: string): boolean {
  return /[0-9０-９⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(char);
}

/** Every core glyph required to be masked must be covered by a scanner span. */
function uncoveredText(text: string, spans: readonly RedactionSpan[]): string[] {
  const coverage = coverageFromSpans(text.length, spans);
  const leaked: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (requiredDigit(char) && coverage[index] === 0) leaked.push(`${index}:${char}`);
  }
  return leaked;
}

/** Deterministic PRNG (same generator family as the existing seeded fuzz). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SUPER = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SUB = '₀₁₂₃₄₅₆₇₈₉';
const MATH_BASE = 0x1d7ce;

type DigitStyle = 'ascii' | 'fullwidth' | 'math' | 'super' | 'sub' | 'mixed';
const DIGIT_STYLES: readonly DigitStyle[] = [
  'ascii',
  'fullwidth',
  'math',
  'super',
  'sub',
  'mixed',
];

function styledDigit(char: string, style: DigitStyle, next: () => number): string {
  if (char < '0' || char > '9') return char;
  const digit = char.charCodeAt(0) - 0x30;
  const chosen =
    style === 'mixed'
      ? (['ascii', 'fullwidth', 'math', 'super', 'sub'] as const)[
          Math.floor(next() * 5)
        ]
      : style;
  switch (chosen) {
    case 'fullwidth':
      return String.fromCharCode(0xff10 + digit);
    case 'math':
      return String.fromCodePoint(MATH_BASE + digit);
    case 'super':
      return SUPER[digit] as string;
    case 'sub':
      return SUB[digit] as string;
    default:
      return char;
  }
}

interface TokenSpec {
  readonly kind: RedactionKind;
  readonly prefix: string;
  readonly groups: readonly string[];
  readonly literal?: string;
}

const NUMERIC_TOKENS: readonly TokenSpec[] = [
  { kind: 'rrn', prefix: '', groups: ['900101', '1234567'] },
  { kind: 'rrn', prefix: '', groups: ['870304', '2345678'] },
  { kind: 'phone', prefix: '', groups: ['010', '1234', '5678'] },
  { kind: 'phone', prefix: '', groups: ['02', '123', '4567'] },
  { kind: 'phone', prefix: '', groups: ['070', '1234', '5678'] },
  { kind: 'phone', prefix: '+82', groups: ['10', '1234', '5678'] },
  { kind: 'phone', prefix: '+1', groups: ['415', '555', '2671'] },
  { kind: 'phone', prefix: '(02)', groups: ['123', '4567'] },
];

const LITERAL_TOKENS: readonly TokenSpec[] = [
  { kind: 'email', prefix: '', groups: [], literal: 'jane.doe+plan@example.co.kr' },
  { kind: 'email', prefix: '', groups: [], literal: 'a@b.co' },
  { kind: 'api_key', prefix: '', groups: [], literal: 'sk-proj-abcdefgh12345678' },
  { kind: 'api_key', prefix: '', groups: [], literal: 'AKIAIOSFODNN7EXAMPLE' },
  { kind: 'api_key', prefix: '', groups: [], literal: 'ghp_abcdefghijklmnopqrstuvwx' },
  { kind: 'api_key', prefix: '', groups: [], literal: 'glpat-abcdefghij1234567890' },
];

interface Built {
  readonly text: string;
  readonly core: readonly CoreRange[];
}

function buildToken(
  spec: TokenSpec,
  style: DigitStyle,
  internalSeparator: string,
  next: () => number,
): Built {
  let text = '';
  const core: CoreRange[] = [];
  const append = (source: string, styled: boolean): void => {
    for (const char of source) {
      const rendered = styled ? styledDigit(char, style, next) : char;
      const start = text.length;
      text += rendered;
      if (requiredDigit(char)) core.push({ start, end: text.length });
    }
  };

  if (spec.literal !== undefined) {
    // Literal tokens: every non-separator glyph is core (letters included).
    for (const char of spec.literal) {
      const start = text.length;
      text += char;
      if (!/[\s.+-]/.test(char)) core.push({ start, end: text.length });
    }
    return { text, core };
  }

  append(spec.prefix, false);
  spec.groups.forEach((group, index) => {
    if (index > 0) append(internalSeparator, false);
    append(group, true);
  });
  return { text, core };
}

function joinTokens(parts: readonly Built[], separator: string): Built {
  let text = '';
  const core: CoreRange[] = [];
  parts.forEach((part, index) => {
    if (index > 0) text += separator;
    const offset = text.length;
    text += part.text;
    for (const range of part.core) {
      core.push({ start: range.start + offset, end: range.end + offset });
    }
  });
  return { text, core };
}

const JOIN_SEPARATORS = ['', ' ', '\u200B', '\u200C', '\u00AD'] as const;

const RRN_SPEC = NUMERIC_TOKENS[0] as TokenSpec;
const MOBILE_SPEC = NUMERIC_TOKENS[2] as TokenSpec;
const EMAIL_SPEC = LITERAL_TOKENS[0] as TokenSpec;
const API_KEY_SPEC = LITERAL_TOKENS[2] as TokenSpec;

function buildCases(): Case[] {
  const cases: Case[] = [];
  let counter = 0;
  const next = (): number => {
    counter += 1;
    return mulberry32(0x38c0000 + counter)();
  };

  // Single tokens of every kind/style.
  for (const spec of NUMERIC_TOKENS) {
    for (const style of DIGIT_STYLES) {
      for (const separator of ['-', '\u200B', ''] as const) {
        const built = buildToken(spec, style, separator, next);
        cases.push({ name: `single ${spec.kind} ${style} sep=${JSON.stringify(separator)}`, ...built });
      }
    }
  }
  for (const spec of LITERAL_TOKENS) {
    const built = buildToken(spec, 'ascii', '-', next);
    cases.push({ name: `single ${spec.literal}`, ...built });
  }

  // Same-kind 2- and 3-token runs.
  for (const spec of NUMERIC_TOKENS) {
    for (const separator of JOIN_SEPARATORS) {
      for (const style of ['ascii', 'super', 'sub', 'mixed'] as const) {
        const rate = mulberry32(0x51 + cases.length);
        const first = buildToken(spec, style, '-', rate);
        const second = buildToken(spec, style, '-', rate);
        const built = joinTokens([first, second], separator);
        cases.push({ name: `pair ${spec.kind} ${style} join=${JSON.stringify(separator)}`, ...built });
      }
    }
  }
  for (const separator of JOIN_SEPARATORS) {
    const parts = [
      buildToken(RRN_SPEC, 'super', '-', next),
      buildToken(MOBILE_SPEC, 'ascii', '-', next),
      buildToken(RRN_SPEC, 'super', '-', next),
    ];
    cases.push({ name: `triple rrn/phone/rrn join=${JSON.stringify(separator)}`, ...joinTokens(parts, separator) });
    const phoneRuns = [
      buildToken(MOBILE_SPEC, 'sub', '-', next),
      buildToken(MOBILE_SPEC, 'sub', '-', next),
      buildToken(MOBILE_SPEC, 'sub', '-', next),
    ];
    cases.push({ name: `triple phone join=${JSON.stringify(separator)}`, ...joinTokens(phoneRuns, separator) });
  }

  // Cross-kind adjacency in both orders, plus three-token permutations.
  const rrn = (style: DigitStyle): Built => buildToken(RRN_SPEC, style, '-', next);
  const phone = (style: DigitStyle): Built => buildToken(MOBILE_SPEC, style, '-', next);
  const email = (): Built => buildToken(EMAIL_SPEC, 'ascii', '-', next);
  const apiKey = (): Built => buildToken(API_KEY_SPEC, 'ascii', '-', next);
  for (const separator of JOIN_SEPARATORS) {
    const orders: readonly [string, () => Built, () => Built][] = [
      ['rrn+phone', () => rrn('super'), () => phone('super')],
      ['phone+rrn', () => phone('super'), () => rrn('super')],
      ['phone+email', () => phone('ascii'), email],
      ['email+phone', email, () => phone('ascii')],
      ['phone+api', () => phone('ascii'), apiKey],
      ['api+phone', apiKey, () => phone('ascii')],
    ];
    for (const [label, left, right] of orders) {
      const built = joinTokens([left(), right()], separator);
      cases.push({ name: `${label} join=${JSON.stringify(separator)}`, ...built });
    }
    const permutations: readonly [string, Built[]][] = [
      ['rrn+phone+email', [rrn('super'), phone('super'), email()]],
      ['phone+rrn+api', [phone('super'), rrn('super'), apiKey()]],
      ['api+phone+rrn', [apiKey(), phone('super'), rrn('super')]],
    ];
    for (const [label, parts] of permutations) {
      cases.push({ name: `${label} join=${JSON.stringify(separator)}`, ...joinTokens(parts, separator) });
    }
  }

  return cases;
}

const CASES = buildCases();

test('gate corpus is non-trivial and deterministic', () => {
  expect(CASES.length).toBeGreaterThan(200);
  expect(buildCases().map((entry) => entry.text)).toEqual(CASES.map((entry) => entry.text));
});

test('scanner masks every core glyph the independent oracle finds', () => {
  const failures: string[] = [];
  for (const entry of CASES) {
    const result = redactWithSpans(entry.text);
    const coverage = coverageFromSpans(entry.text.length, result.spans);
    const oracle = oracleCoverage(entry.text);
    const leaked = uncoveredText(entry.text, result.spans);
    if (leaked.length > 0 || result.report.length === 0) {
      failures.push(
        `${entry.name} text=${JSON.stringify(entry.text)} out=${JSON.stringify(result.text)} leaked=${leaked.join(',')}`,
      );
      continue;
    }
    for (const range of entry.core) {
      for (let index = range.start; index < range.end; index += 1) {
        if (requiredDigit(entry.text[index] as string) && oracle[index] !== 1) {
          failures.push(
            `${entry.name} oracle missed core glyph ${index}:${JSON.stringify(entry.text[index])} text=${JSON.stringify(entry.text)}`,
          );
          break;
        }
      }
    }
    for (let index = 0; index < entry.text.length; index += 1) {
      if (oracle[index] === 1 && coverage[index] === 0 && requiredDigit(entry.text[index] as string)) {
        failures.push(
          `${entry.name} scanner missed oracle glyph ${index}:${JSON.stringify(entry.text[index])} text=${JSON.stringify(entry.text)}`,
        );
        break;
      }
    }
    if (failures.length > 10) break;
  }
  expect(failures).toEqual([]);
});

test('no per-glyph recall regressions against the frozen FU-32 snapshot', () => {
  const failures: string[] = [];
  for (const entry of CASES) {
    const current = coverageFromSpans(entry.text.length, redactWithSpans(entry.text).spans);
    const snapshot = coverageFromSpans(
      entry.text.length,
      snapshotRedactWithSpans(entry.text).spans,
    );
    for (let index = 0; index < entry.text.length; index += 1) {
      if (snapshot[index] === 1 && current[index] === 0) {
        failures.push(
          `${entry.name} regressed glyph ${index}:${JSON.stringify(entry.text[index])} text=${JSON.stringify(entry.text)}`,
        );
        break;
      }
    }
    if (failures.length > 10) break;
  }
  expect(failures).toEqual([]);
});

/**
 * FU-38R-1 / FU-38R2 HIGH reproductions and the FU-32R/FU-38 LOW examples. Every digit
 * glyph (ASCII, fullwidth, super/subscript) must be covered; circled markers may stay.
 */
const REPROS = [
  '⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷',
  '⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷\u200B⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷',
  '⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷\u200C⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷',
  '⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷\u00AD⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷',
  '⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷ ⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷',
  '⁰¹⁰¹²³⁴⁵⁶⁷⁸\u200B900101-1234567',
  '⁰¹⁰¹²³⁴⁵⁶⁷⁸\u200C900101-1234567',
  '⁰¹⁰¹²³⁴⁵⁶⁷⁸\u00AD900101-1234567',
  '⁰¹⁰¹²³⁴⁵⁶⁷⁸900101-1234567',
  '⁴³⁶⁰¹⁰⁸⁷⁵³⁷⁵⁸\u200B019-1463-3169',
  '₁₂₄₀₅₂₅₇₄₄₇₃₃\u00AD031-7225-9762',
  '⁰³¹⁶⁷⁵⁷⁴⁹¹①',
  '⁰²¹²³⁴⁵⁶⁷①',
  '⁰¹⁰-¹²³⁴-⁵⁶⁷⑧',
  '0318403770⑳',
  '(02)6193273⑳',
] as const;

test.each(REPROS)('FU-38 repro masks every digit glyph: %s', (input) => {
  const result = redactWithSpans(input);
  expect(uncoveredText(input, result.spans)).toEqual([]);
  expect(result.report.length).toBeGreaterThan(0);
});

test('repro spans map back to original coordinates without splitting glyphs', () => {
  for (const input of REPROS) {
    const result = redactWithSpans(input);
    for (const span of result.spans) {
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeLessThanOrEqual(input.length);
      expect(span.end).toBeGreaterThan(span.start);
      // A span must not start or end inside a surrogate pair or a composed digit glyph.
      const first = input.charCodeAt(span.start);
      if (span.start > 0 && first >= 0xdc00 && first <= 0xdfff) {
        const previous = input.charCodeAt(span.start - 1);
        expect(previous >= 0xd800 && previous <= 0xdbff).toBe(false);
      }
    }
    expect(result.text).not.toContain('⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷⁹⁰⁰¹⁰¹');
  }
});

const PRECISION_NEGATIVES = [
  'E=mc²',
  'x₁…x₁₀',
  '결과¹²³',
  '²⁰²⁶',
  'H₂O',
  '10⁻¹²³⁴',
  'x² + y² = z²',
  'a₁ + a₂ + a₃',
] as const;

test.each(PRECISION_NEGATIVES)(
  'precision negative stays unmasked: %s',
  (input) => {
    expect(redact(input)).toEqual({ text: input, report: [] });
  },
);

/**
 * Attached-suffix tradeoff pinned from FU-38R-1 LOW: a separated shape ends before an
 * attached superscript suffix, while a separator-less all-super run can absorb it because
 * every start is a candidate (ADR-019).
 */
test('attached superscript suffix tradeoff is pinned', () => {
  expect(redact('010-1234-5678²').text).toBe('[REDACTED_PHONE]²');
  expect(redact('900101-1234567²').text).toBe('[REDACTED_RRN]²');
  expect(redact('⁰¹⁰-¹²³⁴-⁵⁶⁷⁸²').text).toBe('[REDACTED_PHONE]²');
  expect(redact('⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷²').text).toBe('[REDACTED_RRN]²');
  expect(redact('⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷²').text).toBe('[REDACTED_RRN]');
});

/**
 * ADR-019 perf gate: linear scaling to 8 MiB for the adversarial shapes from FU-38R2.
 * Heavy sizes only run with PRIVACY_HEAVY=1; the assertion itself needs
 * PRIVACY_PERF_ASSERT=1 so an ordinary `pnpm test` stays fast.
 */
const PERF_ENABLED = process.env.PRIVACY_PERF_ASSERT === '1';
const HEAVY_ENABLED = process.env.PRIVACY_HEAVY === '1';
const perfTest = PERF_ENABLED ? test : test.skip;

function repeatToSize(unit: string, size: number): string {
  const count = Math.ceil(size / unit.length);
  return unit.repeat(count);
}

const PERF_SHAPES: readonly { readonly label: string; readonly unit: string }[] = [
  {
    label: 'overlapping super RRNs',
    unit: '⁸⁵¹²²⁷¹⁴⁸⁶⁹⁹⁷⁹⁰⁰¹⁰¹-¹²³⁴⁵⁶⁷',
  },
  { label: 'alternating super/ASCII', unit: '⁰1⁰1²²³³⁴⁴⁵⁵⁶⁶⁷⁷⁸⁸⁹⁹' },
  { label: 'long ZWSP chain in RRN', unit: '900101\u200B\u200B\u200B\u200B\u200B1234567 ' },
  { label: 'many retries', unit: '+1 12 34 56 78999 ' },
  { label: 'glued mixed RRN+phone', unit: '900101123456701012345678 ' },
];

perfTest(
  'redaction scales linearly on adversarial shapes',
  () => {
    const sizes = HEAVY_ENABLED
      ? [2 * 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024]
      : [256 * 1024, 512 * 1024];
    const failures: string[] = [];
    for (const shape of PERF_SHAPES) {
      const timings: number[] = [];
      for (const size of sizes) {
        const text = repeatToSize(shape.unit, size);
        redact(text.slice(0, 2_000));
        const started = performance.now();
        redact(text);
        const elapsed = performance.now() - started;
        timings.push(elapsed);
      }
      for (let index = 1; index < timings.length; index += 1) {
        const previous = timings[index - 1] as number;
        const current = timings[index] as number;
        const ratio = current / Math.max(previous, 0.5);
        if (ratio > 4.5) {
          failures.push(
            `${shape.label} at ${sizes[index]} grew ${ratio.toFixed(2)}x (${previous.toFixed(1)}ms -> ${current.toFixed(1)}ms)`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  },
  HEAVY_ENABLED ? 600_000 : 60_000,
);
