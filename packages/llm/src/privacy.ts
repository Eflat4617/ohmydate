/**
 * Privacy filter (05 §12) and untrusted-document wrapper (05 §9).
 *
 * Redaction runs on an NFKC-normalised copy with default-ignorable characters removed and
 * an index map back to the original. Patterns therefore catch fullwidth digits/`@`, soft
 * hyphens and zero-width separators while masking the original spans. Digit-adjacency
 * lookarounds are evaluated against the original characters, so a superscript/circled
 * footnote marker or a stripped format character still terminates a number. The report
 * contains only kinds and counts, never the matched values.
 */

export type RedactionKind = 'email' | 'phone' | 'rrn' | 'api_key';

export interface RedactionCount {
  readonly kind: RedactionKind;
  readonly count: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly report: readonly RedactionCount[];
}

const MASKS: Readonly<Record<RedactionKind, string>> = {
  email: '[REDACTED_EMAIL]',
  phone: '[REDACTED_PHONE]',
  rrn: '[REDACTED_RRN]',
  api_key: '[REDACTED_API_KEY]',
};

const REPORT_ORDER: readonly RedactionKind[] = ['email', 'phone', 'rrn', 'api_key'];

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

const DIGIT = '[0-9０-９]';
const SEPARATOR = '[.\\s\\-_/\\u2010-\\u2015\\u2212\\u00B7]*';
const DOMAIN_LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';

type DigitBoundary = 'start' | 'end' | 'both';

interface Pattern {
  readonly kind: RedactionKind;
  readonly regex: RegExp;
  readonly digitBoundary?: DigitBoundary;
}

interface OriginalChar {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly stripped: boolean;
}

interface IndexMap {
  readonly normalized: string;
  readonly ascii: boolean;
  /** Normalised code-unit index -> index in `chars`. */
  readonly source: readonly number[];
  readonly chars: readonly OriginalChar[];
}

const FULLWIDTH_DIGIT_FIRST = 0xff10;
const FULLWIDTH_DIGIT_LAST = 0xff19;
const NON_ASCII = /[^\p{ASCII}]/u;
const EMPTY_NUMBERS: readonly number[] = [];
const EMPTY_CHARS: readonly OriginalChar[] = [];

function isAscii(char: string): boolean {
  return char.length === 1 && char.charCodeAt(0) < 0x80;
}

/**
 * A character is a digit boundary unless it is itself an ASCII or fullwidth digit.
 * Evaluating against the original char (not the NFKC copy) means a superscript/circled
 * number or a stripped format character terminates a number even though it folds to a
 * digit, while a fullwidth digit keeps its digit semantics.
 */
function isBoundaryChar(char: OriginalChar | undefined): boolean {
  if (char === undefined || char.stripped) return true;
  if (char.value.length !== 1) return true;
  const code = char.value.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return false;
  if (code >= FULLWIDTH_DIGIT_FIRST && code <= FULLWIDTH_DIGIT_LAST) return false;
  return true;
}

function normalizeWithMap(text: string): IndexMap {
  if (!NON_ASCII.test(text)) {
    return { normalized: text, ascii: true, source: EMPTY_NUMBERS, chars: EMPTY_CHARS };
  }

  const chars: OriginalChar[] = [];
  const source: number[] = [];
  let normalized = '';
  let offset = 0;
  let index = 0;

  for (const char of text) {
    const start = offset;
    offset += char.length;
    const current = index;
    index += 1;

    if (isAscii(char)) {
      chars.push({ start, end: offset, value: char, stripped: false });
      source.push(current);
      normalized += char;
      continue;
    }

    if (IGNORABLE.test(char)) {
      chars.push({ start, end: offset, value: char, stripped: true });
      continue;
    }

    chars.push({ start, end: offset, value: char, stripped: false });
    const expanded = char.normalize('NFKC');
    normalized += expanded;
    for (let unit = 0; unit < expanded.length; unit += 1) source.push(current);
  }

  return { normalized, ascii: false, source, chars };
}

function sourceAt(map: IndexMap, index: number): number | undefined {
  return map.ascii ? (index >= 0 && index < map.normalized.length ? index : undefined) : map.source[index];
}

function sourceLength(map: IndexMap): number {
  return map.ascii ? map.normalized.length : map.source.length;
}

function charStart(map: IndexMap, index: number): number {
  return map.ascii ? index : (map.chars[index]?.start ?? index);
}

function charEnd(map: IndexMap, index: number): number {
  return map.ascii ? index + 1 : (map.chars[index]?.end ?? index + 1);
}

function charBoundary(map: IndexMap, index: number): boolean {
  if (map.ascii) {
    if (index < 0 || index >= map.normalized.length) return true;
    const code = map.normalized.charCodeAt(index);
    return !(
      (code >= 0x30 && code <= 0x39) ||
      (code >= FULLWIDTH_DIGIT_FIRST && code <= FULLWIDTH_DIGIT_LAST)
    );
  }
  return isBoundaryChar(map.chars[index]);
}

function boundaryBefore(map: IndexMap, start: number): boolean {
  const current = sourceAt(map, start);
  if (current === undefined) return true;
  if (start > 0 && sourceAt(map, start - 1) === current) return false;
  return charBoundary(map, current - 1);
}

function boundaryAfter(map: IndexMap, end: number): boolean {
  const current = sourceAt(map, end - 1);
  if (current === undefined) return true;
  if (end < sourceLength(map) && sourceAt(map, end) === current) return false;
  return charBoundary(map, current + 1);
}

// Order matters: redact wider/more specific tokens first so a lower-priority pattern never
// claims part of an already-masked span. Matching runs on the normalised copy.
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'email',
    // The local-part start is anchored so the engine cannot rescan 320 characters from
    // every position (the quadratic cause of the R3 regression).
    regex: new RegExp(
      `(?<![^\\s@<>()\\[\\],;:'"])[^\\s@<>()\\[\\],;:'"]{1,320}@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL}){1,8}`,
      'gu',
    ),
  },
  { kind: 'api_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'api_key', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'api_key', regex: /\b(?:sk|tk|pk)[-_][A-Za-z0-9_-]{8,}\b/g },
  { kind: 'api_key', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'api_key', regex: /\bAIza[0-9A-Za-z_-]{30,40}\b/g },
  { kind: 'api_key', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  {
    kind: 'api_key',
    regex:
      /\b(?:Bearer|bearer)\s+[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\b/g,
  },
  {
    kind: 'rrn',
    // Korean RRN shares the phone separator class (dot, slash, Unicode dash, spaced dash).
    regex: new RegExp(`${DIGIT}{6}${SEPARATOR}[1-8]${DIGIT}{6}`, 'gu'),
    digitBoundary: 'both',
  },
  {
    kind: 'phone',
    // +82-(0)2-123-4567.
    regex: new RegExp(
      `(?<![\\w+])\\+${DIGIT}{1,3}${SEPARATOR}\\(0\\)${SEPARATOR}${DIGIT}{1,2}${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`,
      'gu',
    ),
    digitBoundary: 'end',
  },
  {
    kind: 'phone',
    // Parenthesised country code: (+82) 10-1234-5678.
    regex: new RegExp(
      `(?<![\\w+])\\(\\+${DIGIT}{1,3}\\)${SEPARATOR}${DIGIT}{1,2}${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`,
      'gu',
    ),
    digitBoundary: 'end',
  },
  {
    kind: 'phone',
    // International dialling prefixes: 0082-10-..., 001-82-10-..., 82-10-....
    regex: new RegExp(
      `(?<![\\w+])(?:00(?:82|[1-9]${DIGIT}{0,2}${SEPARATOR}82)|82)${SEPARATOR}(?:\\(0\\)${SEPARATOR})?0?${DIGIT}{1,2}${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`,
      'gu',
    ),
    digitBoundary: 'both',
  },
  {
    kind: 'phone',
    // +<cc> followed by 2-4 groups; a group may be parenthesised (area/trunk).
    regex: new RegExp(
      `(?<![\\w+])\\+${DIGIT}{1,3}(?:${SEPARATOR}(?:\\(\\s?${DIGIT}{1,5}\\s?\\)|${DIGIT}{2,4})){2,4}`,
      'gu',
    ),
    digitBoundary: 'end',
  },
  // Glued E.164 without separators: +821012345678, +14155552671.
  {
    kind: 'phone',
    regex: new RegExp(`(?<![\\w+])\\+${DIGIT}{8,15}`, 'gu'),
    digitBoundary: 'end',
  },
  {
    kind: 'phone',
    // Parenthesised KR prefix: (02), (031), (010), (070), (0505).
    regex: new RegExp(
      `\\(\\s?0(?:1[016789]|2|[3-6][1-5]|50${DIGIT}?|70|80)\\s?\\)${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`,
      'gu',
    ),
    digitBoundary: 'end',
  },
  // Korean mobile plus 070 VoIP and 080 toll-free ranges.
  {
    kind: 'phone',
    regex: new RegExp(
      `(?:01[016789]|070|080)${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`,
      'gu',
    ),
    digitBoundary: 'both',
  },
  // 050x VoIP ranges (050, 0505, ...).
  {
    kind: 'phone',
    regex: new RegExp(`050${DIGIT}?${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`, 'gu'),
    digitBoundary: 'both',
  },
  // Korean landline: 02, 031-065.
  {
    kind: 'phone',
    regex: new RegExp(`0(?:2|[3-6][1-5])${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`, 'gu'),
    digitBoundary: 'both',
  },
];

export interface RedactionSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: RedactionKind;
}

/** Merge overlapping spans into their union, keeping the first span's mask kind. */
export function mergeSpans(spans: readonly RedactionSpan[]): RedactionSpan[] {
  const sorted = [...spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: RedactionSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      if (span.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: span.end, kind: last.kind };
      }
      continue;
    }
    merged.push(span);
  }
  return merged;
}

function overlapsDigitBoundary(
  map: IndexMap,
  start: number,
  end: number,
  boundary: DigitBoundary | undefined,
): boolean {
  if ((boundary === 'start' || boundary === 'both') && !boundaryBefore(map, start)) {
    return false;
  }
  if ((boundary === 'end' || boundary === 'both') && !boundaryAfter(map, end)) {
    return false;
  }
  return true;
}

export function redact(text: string): RedactionResult {
  const map = normalizeWithMap(text);
  const covered = new Uint8Array(map.normalized.length);
  const spans: RedactionSpan[] = [];

  for (const { kind, regex, digitBoundary } of PATTERNS) {
    const pattern = new RegExp(regex.source, regex.flags);
    let match = pattern.exec(map.normalized);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (end === start) {
        pattern.lastIndex += 1;
        match = pattern.exec(map.normalized);
        continue;
      }
      if (!overlapsDigitBoundary(map, start, end, digitBoundary)) {
        match = pattern.exec(map.normalized);
        continue;
      }
      let free = true;
      for (let index = start; index < end; index += 1) {
        if (covered[index] === 1) {
          free = false;
          break;
        }
      }
      if (free) {
        for (let index = start; index < end; index += 1) covered[index] = 1;
        const first = sourceAt(map, start);
        const last = sourceAt(map, end - 1);
        if (first !== undefined && last !== undefined) {
          spans.push({
            start: charStart(map, first),
            end: charEnd(map, last),
            kind,
          });
        }
      }
      match = pattern.exec(map.normalized);
    }
  }

  const counts = new Map<RedactionKind, number>();
  for (const span of spans) {
    counts.set(span.kind, (counts.get(span.kind) ?? 0) + 1);
  }
  const merged = mergeSpans(spans);

  const parts: string[] = [];
  let cursor = 0;
  for (const span of merged) {
    parts.push(text.slice(cursor, span.start), MASKS[span.kind]);
    cursor = span.end;
  }
  parts.push(text.slice(cursor));

  const report: RedactionCount[] = [];
  for (const kind of REPORT_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0) report.push({ kind, count });
  }

  return { text: parts.join(''), report };
}

const DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function sanitizeId(id: string): string {
  if (!DOCUMENT_ID.test(id)) {
    throw new Error(
      'untrusted document id must be 1-128 characters of A-Z a-z 0-9 . _ : - (no quotes or angle brackets)',
    );
  }
  return id;
}

function escapeAngleBrackets(text: string): string {
  // Escaping every "<" makes it impossible for content to form any closing/opening tag,
  // including spaced, dashed, zero-width or case variants of `</untrusted_document>`.
  return text.replace(/</g, '&lt;');
}

/**
 * Wrap external/notes text so the prompt can state that everything inside is data.
 * All "<" characters in the content are escaped, so the only real tags are the wrapper.
 */
export function buildUntrustedBlock(id: string, text: string): string {
  return `<untrusted_document id="${sanitizeId(id)}">\n${escapeAngleBrackets(text)}\n</untrusted_document>`;
}
