import { redact } from '../src/index.js';
import {
  MAX_REDACT_INPUT,
  assertRedactInputSize,
  redactWithSpans,
  type RedactionSpan,
} from '../src/privacy.js';
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

/** Realistic and over-cap API-key bodies (FU-38cR-1 HIGH). */
const LONG_SK_PROJECT = `sk-proj-${'Ab3'.repeat(52)}`;
const LONG_GITHUB_PAT = `github_pat_${'a'.repeat(93)}`;
const LONG_GHP = `ghp_${'a'.repeat(93)}`;
const LONG_XOX = `xoxb-${'a'.repeat(93)}`;
const LONG_GLPAT = `glpat-${'a'.repeat(93)}`;
const OVER_CAP_SK = `sk-${'b'.repeat(300)}`;
const OVER_CAP_GHP = `ghp_${'b'.repeat(300)}`;
const OVER_CAP_XOX = `xoxb-${'b'.repeat(300)}`;
const OVER_CAP_GLPAT = `glpat-${'b'.repeat(300)}`;
const OVER_CAP_GITHUB = `github_pat_${'b'.repeat(300)}`;

const KEY_TOKENS: readonly TokenSpec[] = [
  { kind: 'api_key', prefix: '', groups: [], literal: LONG_SK_PROJECT },
  { kind: 'api_key', prefix: '', groups: [], literal: LONG_GITHUB_PAT },
  { kind: 'api_key', prefix: '', groups: [], literal: LONG_GHP },
  { kind: 'api_key', prefix: '', groups: [], literal: LONG_XOX },
  { kind: 'api_key', prefix: '', groups: [], literal: LONG_GLPAT },
  { kind: 'api_key', prefix: '', groups: [], literal: OVER_CAP_SK },
  { kind: 'api_key', prefix: '', groups: [], literal: OVER_CAP_GHP },
  { kind: 'api_key', prefix: '', groups: [], literal: OVER_CAP_XOX },
  { kind: 'api_key', prefix: '', groups: [], literal: OVER_CAP_GLPAT },
  { kind: 'api_key', prefix: '', groups: [], literal: OVER_CAP_GITHUB },
];

const KEY_JOIN_SEPARATORS = ['', ' ', '\u200B', '\u200C', '\u00AD', '\u2060', '\uFEFF'] as const;

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

/**
 * ADR-019 (10): same-kind glued numeric windows and 3+ glued chains are out of scope
 * (FU-32 leaks them too). The corpus still generates them; these named cases are the only
 * no-regression exemptions, and each is pinned with its exact current output in
 * privacy.test.ts.
 */
const ADR_OUT_OF_SCOPE_CASES: ReadonlySet<string> = new Set([
  'pair rrn ascii join=""',
  'pair rrn super join=""',
  'pair rrn sub join=""',
  'pair rrn mixed join=""',
  'pair phone ascii join=""',
  'pair phone super join=""',
  'pair phone sub join=""',
  'pair phone mixed join=""',
  'triple rrn/phone/rrn join=""',
  'triple phone join=""',
]);

/**
 * Oracle must-mask exceptions are kept separate from the no-regression exemptions. The
 * glued `ghp_` pair is a pre-existing FU-32 limitation (both implementations leave it
 * unmasked), so it is not ADR-authorized and is *not* exempted from the A/B comparison.
 */
const ORACLE_MUST_MASK_EXCEPTIONS: ReadonlySet<string> = new Set([
  ...ADR_OUT_OF_SCOPE_CASES,
  'key pair ghp_aaaaaaaa join=""',
]);

function isOutOfScopeCase(name: string): boolean {
  return ADR_OUT_OF_SCOPE_CASES.has(name);
}

function isOracleMustMaskException(name: string): boolean {
  return ORACLE_MUST_MASK_EXCEPTIONS.has(name);
}

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

  // Same-kind 2- and 3-token runs, including fully glued ones (ADR-019 (10)).
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

  // Same-kind API-key runs with realistic and over-cap bodies, joined by stripped
  // characters (ZWSP/ZWNJ/SHY/WJ/BOM) as well as space/glued.
  for (const spec of KEY_TOKENS) {
    cases.push({ name: `single key ${spec.literal?.slice(0, 16)}`, ...buildToken(spec, 'ascii', '-', next) });
  }
  for (const separator of KEY_JOIN_SEPARATORS) {
    for (const spec of KEY_TOKENS) {
      const first = buildToken(spec, 'ascii', '-', next);
      const second = buildToken(spec, 'ascii', '-', next);
      cases.push({
        name: `key pair ${spec.literal?.slice(0, 12)} join=${JSON.stringify(separator)}`,
        ...joinTokens([first, second], separator),
      });
    }
    const triple = [
      buildToken(KEY_TOKENS[1] as TokenSpec, 'ascii', '-', next),
      buildToken(KEY_TOKENS[1] as TokenSpec, 'ascii', '-', next),
      buildToken(KEY_TOKENS[1] as TokenSpec, 'ascii', '-', next),
    ];
    cases.push({
      name: `key triple github_pat join=${JSON.stringify(separator)}`,
      ...joinTokens(triple, separator),
    });
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
    if (isOracleMustMaskException(entry.name)) continue;
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
        if (oracle[index] !== 1) {
          failures.push(
            `${entry.name} oracle missed core glyph ${index}:${JSON.stringify(entry.text[index])} text=${JSON.stringify(entry.text)}`,
          );
          break;
        }
        if (coverage[index] !== 1) {
          failures.push(
            `${entry.name} scanner missed core glyph ${index}:${JSON.stringify(entry.text[index])} text=${JSON.stringify(entry.text)}`,
          );
          break;
        }
      }
    }
    if (failures.length > 10) break;
  }
  expect(failures).toEqual([]);
});

test('no per-glyph recall regressions against the frozen FU-32 snapshot', () => {
  const failures: string[] = [];
  for (const entry of CASES) {
    if (isOutOfScopeCase(entry.name)) continue;
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

type AbCategory = 'single' | 'mixdigit' | 'same2' | 'same3' | 'pairs' | 'perms';

/**
 * Reduced seeded reproduction of the reviewer's 216k A/B classes: single, per-digit mixed
 * styles, same-kind 2/3-token runs, and cross-kind pairs/permutations. Glued same-kind and
 * 3+ glued cases are generated but excluded from the assertion (ADR-019 (10)).
 */
function generatedAbCorpus(): readonly Case[] {
  const random = mulberry32(0x38d0a1b);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)] as T;
  const cases: Case[] = [];
  const add = (category: AbCategory, name: string, built: Built): void => {
    cases.push({ name: `216k ${category} ${name}`, ...built });
  };
  const separator = (): string => pick(['-', '', '\u200B', '.'] as const);
  const style = (): DigitStyle => pick(DIGIT_STYLES);
  const spec = (): TokenSpec => pick(NUMERIC_TOKENS);

  for (let index = 0; index < 500; index += 1) {
    add('single', `${index}`, buildToken(spec(), style(), separator(), random));
  }
  for (let index = 0; index < 500; index += 1) {
    add('mixdigit', `${index}`, buildToken(spec(), 'mixed', separator(), random));
  }
  for (const [category, tokens] of [
    ['same2', 2],
    ['same3', 3],
  ] as const) {
    for (let index = 0; index < 400; index += 1) {
      const chosen = spec();
      const chosenStyle = style();
      const join = pick(JOIN_SEPARATORS);
      const parts = Array.from({ length: tokens }, () =>
        buildToken(chosen, chosenStyle, '-', random),
      );
      add(category, `${index} join=${JSON.stringify(join)}`, joinTokens(parts, join));
    }
  }
  for (let index = 0; index < 400; index += 1) {
    const join = pick(JOIN_SEPARATORS);
    const first = buildToken(pick([RRN_SPEC, MOBILE_SPEC]), style(), '-', random);
    const second = buildToken(pick([EMAIL_SPEC, API_KEY_SPEC]), 'ascii', '-', random);
    add('pairs', `${index} join=${JSON.stringify(join)}`, joinTokens([first, second], join));
  }
  for (let index = 0; index < 400; index += 1) {
    const join = pick(JOIN_SEPARATORS);
    const parts = [
      buildToken(RRN_SPEC, 'super', '-', random),
      buildToken(MOBILE_SPEC, style(), '-', random),
      buildToken(API_KEY_SPEC, 'ascii', '-', random),
    ];
    add('perms', `${index} join=${JSON.stringify(join)}`, joinTokens(parts, join));
  }
  return cases;
}

/** Only ADR-019 (10) same-kind glued numeric windows are exempt; permutations stay in. */
function isOutOfScopeGenerated(name: string): boolean {
  return (
    (name.startsWith('216k same2 ') || name.startsWith('216k same3 ')) &&
    name.endsWith('join=""')
  );
}

test('seeded 216k-style A/B classes have zero per-glyph regressions vs FU-32', () => {
  const corpus = generatedAbCorpus();
  expect(corpus.length).toBeGreaterThan(2_000);
  const failures: string[] = [];
  for (const entry of corpus) {
    if (isOutOfScopeGenerated(entry.name)) continue;
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
  '301017393922089022553716133087249092',
  'order 0101234567890123456789012',
  '3.14159265358979323846264338',
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

/** No letter/digit glyph of a key run may survive (HIGH key-cap regression). */
function leakedWordGlyphs(text: string, spans: readonly RedactionSpan[]): string[] {
  const coverage = coverageFromSpans(text.length, spans);
  const leaked: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (/[A-Za-z0-9_]/.test(char) && coverage[index] === 0) leaked.push(`${index}:${char}`);
  }
  return leaked;
}

const STRIPPED_JOINERS = ['\u200B', '\u200C', '\u00AD', '\u2060', '\uFEFF'] as const;

test.each(STRIPPED_JOINERS)(
  'realistic sk-proj key joined by %j to another key masks both',
  (joiner) => {
    const input = `${LONG_SK_PROJECT}${joiner}${LONG_SK_PROJECT}`;
    const result = redactWithSpans(input);
    expect(leakedWordGlyphs(input, result.spans)).toEqual([]);
    expect(result.text).not.toContain('sk-proj-');
  },
);

test.each(STRIPPED_JOINERS)(
  'realistic sk-proj key joined by %j to a 120-char word masks the key',
  (joiner) => {
    const word = 'w'.repeat(120);
    const input = `${LONG_SK_PROJECT}${joiner}${word}`;
    const result = redactWithSpans(input);
    expect(result.report.length).toBeGreaterThan(0);
    expect(result.text).not.toContain('sk-proj-');
    expect(result.text).not.toContain('Ab3Ab3');
  },
);

test.each(STRIPPED_JOINERS)(
  'three 93-char github_pat keys joined by %j mask fully',
  (joiner) => {
    const input = `${LONG_GITHUB_PAT}${joiner}${LONG_GITHUB_PAT}${joiner}${LONG_GITHUB_PAT}`;
    const result = redactWithSpans(input);
    expect(leakedWordGlyphs(input, result.spans)).toEqual([]);
    expect(result.text).not.toContain('github_pat_');
  },
);

test.each([
  `sk-${'b'.repeat(257)}`,
  `ghp_${'b'.repeat(257)}`,
  `xoxb-${'b'.repeat(257)}`,
  `glpat-${'b'.repeat(257)}`,
  `sk-${'b'.repeat(600)}`,
  `ghp_${'b'.repeat(600)}`,
  `xoxb-${'b'.repeat(600)}`,
  `glpat-${'b'.repeat(600)}`,
])('over-cap key body is masked, not rejected: %s', (input) => {
  const result = redactWithSpans(input);
  expect(leakedWordGlyphs(input, result.spans)).toEqual([]);
  expect(result.report).toEqual([{ kind: 'api_key', count: 1 }]);
});

/** Reviewer separator repros: whitespace-class runs fold to one separator unit. */
const SEPARATOR_REPROS = [
  `tel 010${' '.repeat(33)}1234-5678`,
  `900101${' '.repeat(40)}-1234567`,
  `주민번호: 900101-\n${' '.repeat(40)}1234567`,
  `010${'\u3000'.repeat(33)}1234\u30005678`,
  `Bearer${' '.repeat(33)}eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`,
] as const;

test.each(SEPARATOR_REPROS)('long whitespace separator run still masks: %j', (input) => {
  const result = redactWithSpans(input);
  const leaked = uncoveredText(input, result.spans);
  expect(leaked).toEqual([]);
  expect(result.report.length).toBeGreaterThan(0);
});

test('random whitespace runs of length 1..80 never lose masking', () => {
  const random = mulberry32(0x5e9a);
  const whitespace = [' ', '\t', '\n', '\u3000', '\u00A0', '\u2003', '\u202F'] as const;
  const failures: string[] = [];
  for (let run = 1; run <= 80; run += 1) {
    for (const space of whitespace) {
      const chars = Array.from({ length: run }, () => space).join('');
      const phone = `tel 010${chars}1234-5678`;
      const rrn = `900101${chars}-1234567`;
      for (const input of [phone, rrn]) {
        const result = redactWithSpans(input);
        if (result.report.length === 0 || uncoveredText(input, result.spans).length > 0) {
          failures.push(`${run}:${JSON.stringify(space)} ${JSON.stringify(input)}`);
        }
      }
    }
    const randomRun = Array.from(
      { length: run },
      () => whitespace[Math.floor(random() * whitespace.length)] as string,
    ).join('');
    const input = `tel 010${randomRun}1234-5678`;
    const result = redactWithSpans(input);
    if (result.report.length === 0 || uncoveredText(input, result.spans).length > 0) {
      failures.push(`random:${run}`);
    }
  }
  expect(failures).toEqual([]);
});

/** GB-1: Seoul/single-digit-area international phone formats. */
const SINGLE_DIGIT_AREA_PHONES = [
  '+82-2-1234-5678',
  '+82 2 1234 5678',
  '+82-2-123-4567',
  '+81 3-1234-5678',
  '+33 1 23 45 67 89',
] as const;

test.each(SINGLE_DIGIT_AREA_PHONES)(
  'international phone with a 1-digit area masks: %s',
  (input) => {
    const result = redact(input);
    expect(result.text).toBe('[REDACTED_PHONE]');
    expect(result.report).toEqual([{ kind: 'phone', count: 1 }]);
  },
);

/**
 * FU-38cR2 HIGH: FU-32 kept its optional-separator `+cc` groups; every string below was
 * masked by FU-32 and leaked by the area-first rewrite. The corpus also includes a
 * separator after `cc` with glued/stripped-joined groups, and the FU-32 A/B comparison.
 */
const CC_REGRESSION_CORPUS = [
  '+82 1012345678',
  '+82-1012345678',
  '+82 10 12345678',
  '+82-10-12345678',
  '+82 31-12345678',
  '+82-3112345678',
  '+1 4155552671',
  '+1 415-5552671',
  '+44 2071838750',
  '+44 20 71838750',
  '+49 30 12345678',
  '+81-90-12345678',
  '+86 13812345678',
  '+33 612345678',
  '+61 412345678',
  '+65 91234567',
  '+852 91234567',
  'tel +82 1012345678.',
  '전화: +82-1012345678',
  '+82-2\u00AD9007\u00AD2208',
  '+82 2\u200B1386\u200B3726',
  '+82-31\u200B020\u200B6052',
  '+82 10\u200C1234..5678',
  '+82 10\u20601234..5678',
  '+82-10-1234\u200B5678',
] as const;

test.each(CC_REGRESSION_CORPUS)(
  '+cc glued/stripped-joined groups keep FU-32 recall and mask every digit: %s',
  (input) => {
    const result = redactWithSpans(input);
    expect(uncoveredText(input, result.spans)).toEqual([]);
    expect(result.report.length).toBeGreaterThan(0);
    const snapshot = coverageFromSpans(
      input.length,
      snapshotRedactWithSpans(input).spans,
    );
    const current = coverageFromSpans(input.length, result.spans);
    for (let index = 0; index < input.length; index += 1) {
      if (snapshot[index] === 1) expect(current[index]).toBe(1);
    }
  },
);

/** FU-38cR2 LOW: the 1-digit-area pattern must not over-mask short `+` numerics. */
const SHORT_PLUS_NUMERICS = [
  '+1 2 2026',
  '+1 2 2026-11-11',
  '+1 2-12-2026',
  '+5 1 23 45',
  '+1 2 34 56',
  '+1 2 3456',
  '+12 3 4567',
  '+44 1 234',
  '+9 9 99 99',
] as const;

test.each(SHORT_PLUS_NUMERICS)('short + numeric stays unmasked: %s', (input) => {
  expect(redact(input)).toEqual({ text: input, report: [] });
});

/**
 * FU-38dR-1 HIGH: the compact ASCII whitespace-fold map must convert a span from
 * normalised to original coordinates exactly once. These assertions pin the exact
 * original span (not just "something masked") for every token kind after folded
 * whitespace, with trailing prose to expose any displacement.
 */
const WHITESPACE_TOKEN_CASES: readonly { readonly kind: RedactionKind; readonly token: string }[] =
  [
    { kind: 'phone', token: '010-1234-5678' },
    { kind: 'phone', token: '+82 10-1234-5678' },
    { kind: 'rrn', token: '900101-1234567' },
    { kind: 'email', token: 'jane.doe+plan@example.co.kr' },
    { kind: 'api_key', token: 'sk-proj-abcdefgh12345678' },
    { kind: 'api_key', token: 'tk_live_abcdefgh12345678' },
    { kind: 'api_key', token: 'pk_live_abcdefgh12345678' },
    { kind: 'api_key', token: 'ghp_abcdefghijklmnopqrstuvwx' },
    { kind: 'api_key', token: 'github_pat_abcdefghijklmnopqrstuvwx' },
    { kind: 'api_key', token: 'glpat-abcdefghij1234567890' },
    { kind: 'api_key', token: 'AKIAIOSFODNN7EXAMPLE' },
    { kind: 'api_key', token: 'xoxb-1234567890-abcdefghij' },
    { kind: 'api_key', token: 'AIzaSyA1234567890abcdefghijklmnopqrstuvw' },
    {
      kind: 'api_key',
      token: 'Bearer eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    },
  ];

const WHITESPACE_CONTEXTS = [
  { name: 'LF paragraph', prefix: 'x\n\n', suffix: ' trailing prose' },
  { name: 'CRLF paragraph', prefix: 'x\r\n\r\n', suffix: ' trailing prose' },
  { name: 'spaces and tabs', prefix: 'x \t \t ', suffix: '\t trailing prose' },
  {
    name: 'long spaces',
    prefix: `x${' '.repeat(40)}`,
    suffix: ` following prose ${' following prose '.repeat(4)}`,
  },
  {
    name: 'long mixed whitespace',
    prefix: `x${' \t\n'.repeat(15)}`,
    suffix: ` following prose ${' following prose '.repeat(4)}`,
  },
] as const;

test.each(WHITESPACE_CONTEXTS)(
  'folded whitespace keeps exact original spans and full coverage ($name)',
  ({ prefix, suffix }) => {
    const failures: string[] = [];
    for (const { kind, token } of WHITESPACE_TOKEN_CASES) {
      const text = `${prefix}${token}${suffix}`;
      const expectedStart = prefix.length;
      const expectedEnd = expectedStart + token.length;
      const result = redactWithSpans(text);
      const exact =
        result.spans.length === 1 &&
        result.spans[0]?.start === expectedStart &&
        result.spans[0]?.end === expectedEnd &&
        result.spans[0]?.kind === kind;
      if (!exact) {
        failures.push(
          `${kind} ${JSON.stringify(token)} spans=${JSON.stringify(result.spans)} expected=[${expectedStart},${expectedEnd}) out=${JSON.stringify(result.text)}`,
        );
        continue;
      }
      const coverage = coverageFromSpans(text.length, result.spans);
      for (let index = expectedStart; index < expectedEnd; index += 1) {
        if (/\s/.test(text[index] as string)) continue;
        if (coverage[index] !== 1) {
          failures.push(
            `${kind} ${JSON.stringify(token)} missed glyph ${index}:${JSON.stringify(text[index])}`,
          );
          break;
        }
      }
    }
    expect(failures).toEqual([]);
  },
);

/** Folding inside a token and between multiple tokens keeps each original span exact. */
const MULTI_FOLDED_CASES = [
  {
    name: 'folded phone groups',
    text: 'intro\n\n010 \t 1234   5678 trailing prose',
    tokens: [{ kind: 'phone', value: '010 \t 1234   5678' }],
  },
  {
    name: 'folded RRN groups after CRLF',
    text: 'x\r\n\r\n900101 \t 1234567 trailing prose',
    tokens: [{ kind: 'rrn', value: '900101 \t 1234567' }],
  },
  {
    name: 'two numeric tokens with folded whitespace between',
    text: 'x\n\n010-1234-5678 \t\n  900101-1234567 trailing prose',
    tokens: [
      { kind: 'phone', value: '010-1234-5678' },
      { kind: 'rrn', value: '900101-1234567' },
    ],
  },
  {
    name: 'email and phone after separate paragraphs',
    text: 'x\n\na\n\njane.doe@example.com\n\n010-1234-5678 trailing prose',
    tokens: [
      { kind: 'email', value: 'jane.doe@example.com' },
      { kind: 'phone', value: '010-1234-5678' },
    ],
  },
  {
    name: 'key and phone with long folded whitespace before both',
    text: `x${' '.repeat(30)}sk-proj-abcdefgh12345678 \t\t 010-1234-5678 trailing prose`,
    tokens: [
      { kind: 'api_key', value: 'sk-proj-abcdefgh12345678' },
      { kind: 'phone', value: '010-1234-5678' },
    ],
  },
] as const;

test.each(MULTI_FOLDED_CASES)(
  'folded whitespace inside/between tokens maps spans exactly ($name)',
  ({ text, tokens }) => {
    const expected: { start: number; end: number; kind: string }[] = [];
    let cursor = 0;
    for (const token of tokens) {
      const start = text.indexOf(token.value, cursor);
      expect(start).toBeGreaterThanOrEqual(0);
      expected.push({ start, end: start + token.value.length, kind: token.kind });
      cursor = start + token.value.length;
    }
    const result = redactWithSpans(text);
    expect(result.spans.map(({ start, end, kind }) => ({ start, end, kind }))).toEqual(expected);
  },
);

/**
 * Seeded whitespace-context A/B: folded whitespace before, inside and after tokens,
 * including ASCII paragraph breaks (compact path) and U+3000/NBSP/EM-space (generic map).
 */
function seededWhitespaceCorpus(): readonly { readonly name: string; readonly text: string }[] {
  const random = mulberry32(0x128acf21);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)] as T;
  const int = (min: number, max: number): number =>
    min + Math.floor(random() * (max - min + 1));
  const whitespace = [' ', '  ', '   ', '\t', '\t ', '\n', '\r\n', '\n\n', ' \t ', '\u3000', '\u00A0', '\u2003'] as const;
  const numeric = [
    ['010', '1234', '5678'],
    ['02', '123', '4567'],
    ['+82', '10', '1234', '5678'],
    ['900101', '1234567'],
    ['870304', '2345678'],
  ] as const;
  const literals = WHITESPACE_TOKEN_CASES.map((entry) => entry.token);
  const cases: { name: string; text: string }[] = [];
  for (let index = 0; index < 2_400; index += 1) {
    const lead = random() < 0.5 ? 'x' : '';
    const before = Array.from({ length: int(0, 4) }, () => pick(whitespace)).join('');
    const after = `${Array.from({ length: int(1, 3) }, () => pick(whitespace)).join('')} trailing prose `;
    let body: string;
    if (random() < 0.5) {
      const groups = pick(numeric);
      const separator = pick(['-', ' ', '\t', '  ', '\n', '\r\n']);
      body = groups.join(separator);
    } else {
      body = pick(literals);
    }
    if (random() < 0.25) {
      const groups = pick(numeric);
      const separator = pick(['-', ' ', '\t']);
      body = `${body}${pick(whitespace)}${pick(whitespace)}${groups.join(separator)}`;
    }
    cases.push({ name: `ws ${index}`, text: `${lead}${before}${body}${after}` });
  }
  return cases;
}

test('seeded whitespace-context A/B has zero per-glyph regressions vs FU-32', () => {
  const corpus = seededWhitespaceCorpus();
  expect(corpus).toHaveLength(2_400);
  const failures: string[] = [];
  for (const entry of corpus) {
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

test('MAX_REDACT_INPUT guard documents and enforces the input cap', () => {
  expect(MAX_REDACT_INPUT).toBe(1024 * 1024);
  expect(() => assertRedactInputSize('x'.repeat(MAX_REDACT_INPUT))).not.toThrow();
  expect(() => assertRedactInputSize('x'.repeat(MAX_REDACT_INPUT + 1))).toThrow(
    /MAX_REDACT_INPUT/,
  );
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
  { label: 'uniform super run', unit: '⁵' },
  { label: 'uniform sub run', unit: '₅' },
  { label: 'alternating super/ASCII', unit: '⁰1⁰1²²³³⁴⁴⁵⁵⁶⁶⁷⁷⁸⁸⁹⁹' },
  { label: 'long ZWSP chain in RRN', unit: '900101\u200B\u200B\u200B\u200B\u200B1234567 ' },
  { label: 'separator run over old cap', unit: `tel 010${' '.repeat(40)}1234-5678 ` },
  { label: 'ideographic separator over old cap', unit: `010${'\u3000'.repeat(40)}1234\u30005678 ` },
  { label: 'many +cc retries', unit: '+1 12 34 56 78999 ' },
  { label: 'prefix-dense sk words', unit: 'sk-abcdefgh ' },
  { label: 'Bearer near-misses', unit: 'Bearer abcdefghij ' },
  { label: 'glued ASCII phone chain', unit: '01012345678 ' },
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
        let best = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const started = performance.now();
          redact(text);
          best = Math.min(best, performance.now() - started);
        }
        timings.push(best);
      }
      for (let index = 1; index < timings.length; index += 1) {
        const previous = timings[index - 1] as number;
        const current = timings[index] as number;
        const ratio = current / Math.max(previous, 0.5);
        if (ratio > 3.0) {
          failures.push(
            `${shape.label} at ${sizes[index]} grew ${ratio.toFixed(2)}x (${previous.toFixed(1)}ms -> ${current.toFixed(1)}ms)`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  },
  // Heavy mode scans 2+4+8 MiB per shape; 405 s was observed under load, so scale the
  // timeout with the heavy size set instead of leaving almost no margin.
  HEAVY_ENABLED ? 1_200_000 : 60_000,
);

/**
 * FU-38cR2 LOW: plain ASCII prose with multi-character whitespace runs must not fall off
 * the ASCII fast path. The lazy compact map means no per-character objects are built when
 * there is nothing to redact, keeping this within 3x of FU-32.
 */
perfTest(
  '1 MiB ASCII prose with paragraphs stays within 3x of FU-32',
  () => {
    const unit = `${'The quick brown fox jumps over the lazy dog. '.repeat(40)}\n\n`;
    const prose = repeatToSize(unit, 1024 * 1024);
    redact(prose.slice(0, 2_000));
    snapshotRedactWithSpans(prose.slice(0, 2_000));
    const measure = (run: () => unknown): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = performance.now();
        run();
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const current = measure(() => redact(prose));
    const base = measure(() => snapshotRedactWithSpans(prose));
    expect(current).toBeLessThanOrEqual(Math.max(base * 3, 20));
  },
  60_000,
);
