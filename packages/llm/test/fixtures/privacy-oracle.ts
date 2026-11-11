/**
 * Independent reference oracle for the FU-38c redaction gate. It is intentionally a
 * different, simpler implementation from the production scanner: normalise once, then try
 * every shape anchored at every start (brute force). It applies no digit/word boundary
 * heuristics, so it over-approximates rather than sharing the scanner's logic.
 */

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * Shapes are deliberately written from scratch, not imported from the scanner. Digit
 * classes are ASCII because the oracle runs on the NFKC-normalised copy.
 */
const SHAPES: readonly { readonly kind: string; readonly regex: RegExp }[] = [
  {
    kind: 'email',
    regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/y,
  },
  { kind: 'api_key', regex: /(?:AKIA|ASIA)[A-Z0-9]{16}/y },
  { kind: 'api_key', regex: /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/y },
  { kind: 'api_key', regex: /(?:sk|tk|pk)[-_][A-Za-z0-9_-]{8,}/y },
  { kind: 'api_key', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/y },
  { kind: 'api_key', regex: /glpat-[A-Za-z0-9_-]{20,}/y },
  {
    kind: 'api_key',
    regex: /(?:Bearer|bearer)\s+[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/y,
  },
  { kind: 'rrn', regex: /\d{6}[-. /\s]?[1-8]\d{6}/y },
  {
    kind: 'phone',
    regex: /\+\d{1,3}[\s.-]?\(0\)[\s.-]?\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{4}/y,
  },
  {
    kind: 'phone',
    regex: /\(\+\d{1,3}\)[\s.-]?\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{4}/y,
  },
  {
    kind: 'phone',
    regex: /(?:00(?:82|[1-9]\d{0,2}[\s.-]?82)|82)[\s.-]?(?:\(0\)[\s.-]?)?0?\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{4}/y,
  },
  {
    kind: 'phone',
    regex: /\+\d{1,3}(?:[\s.-]?(?:\(\s?\d{1,5}\s?\)|\d{2,4})){2,4}/y,
  },
  { kind: 'phone', regex: /\+\d{8,15}/y },
  {
    kind: 'phone',
    regex: /\(\s?0(?:1[016789]|2|[3-6][1-5]|50\d?|70|80)\s?\)[\s.-]?\d{3,4}[\s.-]?\d{4}/y,
  },
  {
    kind: 'phone',
    regex: /(?:01[016789]|070|080)[\s.-]?\d{3,4}[\s.-]?\d{4}/y,
  },
  { kind: 'phone', regex: /050\d?[\s.-]?\d{3,4}[\s.-]?\d{4}/y },
  { kind: 'phone', regex: /0(?:2|[3-6][1-5])[\s.-]?\d{3,4}[\s.-]?\d{4}/y },
];

export interface OracleMatch {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
}

interface Normalized {
  readonly text: string;
  readonly starts: number[];
  readonly ends: number[];
}

function normalize(text: string): Normalized {
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const start = offset;
    offset += char.length;
    if (IGNORABLE.test(char)) continue;
    const expanded = char.normalize('NFKC');
    normalized += expanded;
    for (let unit = 0; unit < expanded.length; unit += 1) {
      starts.push(start);
      ends.push(offset);
    }
  }
  return { text: normalized, starts, ends };
}

/** All matches the oracle finds, in original code-unit coordinates. */
export function oracleMatches(text: string): OracleMatch[] {
  const map = normalize(text);
  const matches: OracleMatch[] = [];
  for (let start = 0; start < map.text.length; start += 1) {
    for (const shape of SHAPES) {
      shape.regex.lastIndex = start;
      const match = shape.regex.exec(map.text);
      if (match === null || match.index !== start || match[0].length === 0) continue;
      const endIndex = start + match[0].length - 1;
      const originalStart = map.starts[start];
      const originalEnd = map.ends[endIndex];
      if (originalStart === undefined || originalEnd === undefined) continue;
      matches.push({ kind: shape.kind, start: originalStart, end: originalEnd });
      break;
    }
  }
  return matches;
}

/** Per-code-unit coverage bitset over the original text. */
export function oracleCoverage(text: string): Uint8Array {
  const coverage = new Uint8Array(text.length);
  for (const match of oracleMatches(text)) {
    for (let index = match.start; index < match.end; index += 1) coverage[index] = 1;
  }
  return coverage;
}
