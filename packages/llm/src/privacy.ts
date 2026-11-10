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
  /**
   * `\b` evaluated on the normalised copy joins tokens that the original text kept apart
   * with a zero-width/format character. These flags apply the original-character word
   * boundary instead (same semantics as `\b`, but a stripped format character is non-word).
   */
  readonly wordBoundary?: DigitBoundary;
  /** Replaces `(?<![\w+])` so an original-character format char still starts a number. */
  readonly notWordPlusBefore?: boolean;
  /**
   * Compiled once with the sticky `y` flag. Retried from the same start when only the
   * trailing digit check fails, so a greedy variable group count can backtrack.
   */
  readonly shorterEnd?: RegExp;
  /**
   * Word-boundary patterns scan for candidate starts with this prefix-only regex, then run
   * the sticky `regex` body only after the original-character start check passes. Without
   * it, `start + 1` retries would greedily rescan a long rejected body per occurrence.
   */
  readonly prefix?: RegExp;
  /** Sticky backtracking variant used when a bounded word token ends mid-run. */
  readonly shorterWordEnd?: RegExp;
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
const ASCII_CHAR = /\p{ASCII}/u;
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

function isDigitCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= FULLWIDTH_DIGIT_FIRST && code <= FULLWIDTH_DIGIT_LAST)
  );
}

function isOriginalDigitChar(char: OriginalChar | undefined): boolean {
  if (char === undefined || char.stripped) return false;
  if (char.value.length !== 1) return false;
  return isDigitCode(char.value.charCodeAt(0));
}

/** True when the normalised match starts on a digit code unit. */
function startsOnDigit(map: IndexMap, start: number): boolean {
  return isDigitCode(map.normalized.charCodeAt(start));
}

/** True when that digit comes from an original digit, not a folded footnote marker. */
function startsOnOriginalDigit(map: IndexMap, start: number): boolean {
  if (map.ascii) return isDigitCode(map.normalized.charCodeAt(start));
  const current = sourceAt(map, start);
  return isOriginalDigitChar(current === undefined ? undefined : map.chars[current]);
}

function normalizeWithMap(text: string): IndexMap {
  if (!NON_ASCII.test(text)) {
    return { normalized: text, ascii: true, source: EMPTY_NUMBERS, chars: EMPTY_CHARS };
  }

  const chars: OriginalChar[] = [];
  const source: number[] = [];
  // Long separator runs repeat one code point; fold and test it once per call.
  const folded = new Map<string, { readonly stripped: boolean; readonly expanded: string }>();
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

    let entry = folded.get(char);
    if (entry === undefined) {
      entry = { stripped: IGNORABLE.test(char), expanded: char.normalize('NFKC') };
      folded.set(char, entry);
    }

    if (entry.stripped) {
      chars.push({ start, end: offset, value: char, stripped: true });
      continue;
    }

    chars.push({ start, end: offset, value: char, stripped: false });
    normalized += entry.expanded;
    for (let unit = 0; unit < entry.expanded.length; unit += 1) source.push(current);
  }

  return { normalized, ascii: false, source, chars };
}

/**
 * Normalisation folds compatibility characters to ASCII (fullwidth digits, circled numbers,
 * fullwidth `@`/`+`). If no character can produce an ASCII unit, concatenating them cannot
 * either, so no pattern can match and the whole normalisation map can be skipped.
 */
function couldContainMatch(text: string): boolean {
  if (!NON_ASCII.test(text)) return true;
  const folded = new Map<string, boolean>();
  for (const char of text) {
    if (char.length === 1 && char.charCodeAt(0) < 0x80) return true;
    let producesAscii = folded.get(char);
    if (producesAscii === undefined) {
      producesAscii = ASCII_CHAR.test(char.normalize('NFKC'));
      folded.set(char, producesAscii);
    }
    if (producesAscii) return true;
  }
  return false;
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

/** ASCII word characters, matching JavaScript `\b` semantics. */
function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

function isOriginalWordChar(char: OriginalChar | undefined): boolean {
  if (char === undefined || char.stripped) return false;
  if (char.value.length !== 1) return false;
  const code = char.value.charCodeAt(0);
  if (isAsciiWordCode(code)) return true;
  // Fullwidth ASCII variants are word characters too; NFKC folds them to ASCII before the
  // regexes run, so treating the original glyph as non-word would split the token.
  return (
    (code >= 0xff10 && code <= 0xff19) ||
    (code >= 0xff21 && code <= 0xff3a) ||
    code === 0xff3f ||
    (code >= 0xff41 && code <= 0xff5a)
  );
}

/**
 * `\b` on the original characters. Format characters are stripped from the normalised
 * copy, so `\b` there sees two word characters glued together; here the stripped char is
 * a non-word boundary, exactly as it was in the input.
 */
function wordBoundaryBefore(map: IndexMap, start: number): boolean {
  if (map.ascii) {
    const before =
      start > 0 && start <= map.normalized.length
        ? isAsciiWordCode(map.normalized.charCodeAt(start - 1))
        : false;
    const here =
      start >= 0 && start < map.normalized.length
        ? isAsciiWordCode(map.normalized.charCodeAt(start))
        : false;
    return before !== here;
  }
  const current = sourceAt(map, start);
  if (current === undefined) {
    if (map.chars.length === 0) return false;
    return isOriginalWordChar(map.chars[start <= 0 ? 0 : map.chars.length - 1]);
  }
  if (start > 0 && sourceAt(map, start - 1) === current) return false;
  return (
    isOriginalWordChar(map.chars[current - 1]) !== isOriginalWordChar(map.chars[current])
  );
}

function wordBoundaryAfter(map: IndexMap, end: number): boolean {
  if (map.ascii) {
    const here =
      end > 0 && end <= map.normalized.length
        ? isAsciiWordCode(map.normalized.charCodeAt(end - 1))
        : false;
    const next =
      end >= 0 && end < map.normalized.length
        ? isAsciiWordCode(map.normalized.charCodeAt(end))
        : false;
    return here !== next;
  }
  if (end <= 0) {
    return map.chars.length === 0 ? false : isOriginalWordChar(map.chars[0]);
  }
  const current = sourceAt(map, end - 1);
  if (current === undefined) {
    return map.chars.length === 0 ? false : isOriginalWordChar(map.chars[map.chars.length - 1]);
  }
  if (end < sourceLength(map) && sourceAt(map, end) === current) return false;
  return isOriginalWordChar(map.chars[current]) !== isOriginalWordChar(map.chars[current + 1]);
}

/** `(?<![\w+])` on the original characters. */
function notWordPlusBefore(map: IndexMap, start: number): boolean {
  if (map.ascii) {
    if (start <= 0) return true;
    const code = map.normalized.charCodeAt(start - 1);
    return !(isAsciiWordCode(code) || code === 0x2b);
  }
  const current = sourceAt(map, start);
  if (current === undefined) return true;
  if (start > 0 && sourceAt(map, start - 1) === current) return false;
  const previous = map.chars[current - 1];
  if (previous === undefined) return true;
  // A fullwidth plus is the same '+' for this rule, so the whole token still masks.
  if (previous.value === '+' || previous.value === '＋') return false;
  if (previous.stripped) {
    // `+<format char>82 ...`: the stripped char must not let a lower-priority 82-prefix
    // pattern claim an inner span before the full +cc span.
    let index = current - 1;
    while (index >= 0 && map.chars[index]?.stripped === true) index -= 1;
    const before = map.chars[index];
    if (before !== undefined && (before.value === '+' || before.value === '＋')) return false;
    return true;
  }
  return !isOriginalWordChar(previous);
}

const CC_PHONE_SOURCE = `\\+${DIGIT}{1,3}(?:${SEPARATOR}(?:\\(\\s?${DIGIT}{1,5}\\s?\\)|${DIGIT}{2,4})){2,4}`;
const CC_PHONE_EXACT = new RegExp(`^(?:${CC_PHONE_SOURCE})$`, 'u');

// Order matters: redact wider/more specific tokens first so a lower-priority pattern never
// claims part of an already-masked span. Matching runs on the normalised copy.
// Word boundaries and `(?<![\w+])` are deliberately kept out of the regexes: on the
// normalised copy they would join tokens separated only by a stripped format character,
// so they are re-evaluated against the original characters after each match.
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
  {
    kind: 'api_key',
    prefix: /(?:AKIA|ASIA)/g,
    regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/y,
    wordBoundary: 'both',
  },
  {
    kind: 'api_key',
    prefix: /(?:gh[pousr]_|github_pat_)/g,
    regex: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/y,
    wordBoundary: 'both',
  },
  {
    kind: 'api_key',
    prefix: /(?:sk|tk|pk)[-_]/g,
    regex: /(?:sk|tk|pk)[-_][A-Za-z0-9_-]{8,}/y,
    wordBoundary: 'both',
  },
  {
    kind: 'api_key',
    prefix: /xox[baprs]-/g,
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/y,
    wordBoundary: 'both',
  },
  {
    kind: 'api_key',
    prefix: /AIza/g,
    regex: /AIza[0-9A-Za-z_-]{30,40}/y,
    wordBoundary: 'both',
    shorterWordEnd: /AIza[0-9A-Za-z_-]{30,40}(?![A-Za-z0-9_])/y,
  },
  {
    kind: 'api_key',
    prefix: /glpat-/g,
    regex: /glpat-[A-Za-z0-9_-]{20,}/y,
    wordBoundary: 'both',
  },
  {
    kind: 'api_key',
    prefix: /(?:Bearer|bearer)\s+/g,
    regex:
      /(?:Bearer|bearer)\s+[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}/y,
    wordBoundary: 'both',
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
      `\\+${DIGIT}{1,3}${SEPARATOR}\\(0\\)${SEPARATOR}${DIGIT}{1,2}${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`,
      'gu',
    ),
    digitBoundary: 'end',
    notWordPlusBefore: true,
  },
  {
    kind: 'phone',
    // Parenthesised country code: (+82) 10-1234-5678.
    regex: new RegExp(
      `\\(\\+${DIGIT}{1,3}\\)${SEPARATOR}${DIGIT}{1,2}${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`,
      'gu',
    ),
    digitBoundary: 'end',
    notWordPlusBefore: true,
  },
  {
    kind: 'phone',
    // International dialling prefixes: 0082-10-..., 001-82-10-..., 82-10-....
    regex: new RegExp(
      `(?:00(?:82|[1-9]${DIGIT}{0,2}${SEPARATOR}82)|82)${SEPARATOR}(?:\\(0\\)${SEPARATOR})?0?${DIGIT}{1,2}${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`,
      'gu',
    ),
    digitBoundary: 'both',
    notWordPlusBefore: true,
  },
  {
    kind: 'phone',
    // +<cc> followed by 2-4 groups; a group may be parenthesised (area/trunk).
    regex: new RegExp(CC_PHONE_SOURCE, 'gu'),
    digitBoundary: 'end',
    notWordPlusBefore: true,
    shorterEnd: new RegExp(`${CC_PHONE_SOURCE}(?![0-9０-９])`, 'yu'),
  },
  // Glued E.164 without separators: +821012345678, +14155552671.
  {
    kind: 'phone',
    regex: new RegExp(`\\+${DIGIT}{8,15}`, 'gu'),
    digitBoundary: 'end',
    notWordPlusBefore: true,
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

/**
 * A word-boundary match may greedily end on a non-word separator (`sk-key-`); JavaScript
 * `\b` would backtrack it. Trim only trailing non-word original characters to reach the
 * same boundary, never dropping part of the token itself.
 */
function trimmedWordEnd(map: IndexMap, start: number, rawEnd: number): number | undefined {
  let end = rawEnd;
  while (end > start) {
    if (wordBoundaryAfter(map, end)) return end;
    if (map.ascii) {
      if (isAsciiWordCode(map.normalized.charCodeAt(end - 1))) return undefined;
    } else {
      const current = sourceAt(map, end - 1);
      if (current === undefined) return undefined;
      if (isOriginalWordChar(map.chars[current])) return undefined;
    }
    end -= 1;
  }
  return undefined;
}

/** A shorter +cc end must satisfy the original-character digit boundary. */
function shorterEndAfter(
  map: IndexMap,
  pattern: Pattern,
  start: number,
  rawEnd: number,
): number | undefined {
  const shorter = pattern.shorterEnd;
  if (shorter === undefined) return undefined;
  // Sticky fast path: contiguous digits can be split across groups, yielding a match
  // longer than the rejected greedy one. Sticky exec scans only at `start`.
  shorter.lastIndex = start;
  const candidate = shorter.exec(map.normalized);
  if (candidate !== null) {
    const end = start + candidate[0].length;
    if (end > rawEnd) {
      const last = sourceAt(map, end - 1);
      const splits =
        last !== undefined && end < sourceLength(map) && sourceAt(map, end) === last;
      if (
        !splits &&
        boundaryAfter(map, end) &&
        CC_PHONE_EXACT.test(map.normalized.slice(start, end))
      ) {
        return end;
      }
    }
  }
  // Walk the rejected span's ends longest-first. A normalised lookahead cannot see an
  // original-char digit boundary (e.g. ⑳ or a stripped ZWSP), so each candidate end is
  // tested with the original-character rule and the exact pattern.
  for (let end = rawEnd; end > start; end -= 1) {
    // A CC match can only end on a digit or a closing paren. Separator runs can be
    // arbitrarily long, so testing every position there is O(L^2) (FU-24R-2 HIGH).
    const last = map.normalized.charCodeAt(end - 1);
    if (!(isDigitCode(last) || last === 0x29)) continue;
    if (!boundaryAfter(map, end)) continue;
    if (CC_PHONE_EXACT.test(map.normalized.slice(start, end))) return end;
  }
  return undefined;
}

function startAllowed(map: IndexMap, pattern: Pattern, start: number): boolean {
  const { digitBoundary, wordBoundary, notWordPlusBefore: needsNotWordPlus } = pattern;
  if ((digitBoundary === 'start' || digitBoundary === 'both') && !boundaryBefore(map, start)) {
    return false;
  }
  // A digit pattern must not begin on a footnote marker that only folds to a digit
  // (⁰/①/㉑); that start would let its end land on a stripped char before a real digit.
  if (
    (digitBoundary === 'start' || digitBoundary === 'both') &&
    startsOnDigit(map, start) &&
    !startsOnOriginalDigit(map, start)
  ) {
    return false;
  }
  if (needsNotWordPlus === true && !notWordPlusBefore(map, start)) return false;
  if (
    (wordBoundary === 'start' || wordBoundary === 'both') &&
    !wordBoundaryBefore(map, start)
  ) {
    return false;
  }
  return true;
}

/** Resolve a raw regex match to an accepted end, applying the original-character rules. */
function resolveEnd(
  map: IndexMap,
  pattern: Pattern,
  start: number,
  rawEnd: number,
): number | undefined {
  const { digitBoundary, wordBoundary } = pattern;
  if (!startAllowed(map, pattern, start)) return undefined;

  let end = rawEnd;
  if (wordBoundary === 'end' || wordBoundary === 'both') {
    let trimmed = trimmedWordEnd(map, start, end);
    if (trimmed === undefined) {
      const fallback = pattern.shorterWordEnd;
      if (fallback !== undefined) {
        fallback.lastIndex = start;
        const match = fallback.exec(map.normalized);
        if (match !== null && match.index === start) {
          const candidate = start + match[0].length;
          const last = sourceAt(map, candidate - 1);
          const splits =
            last !== undefined &&
            candidate < sourceLength(map) &&
            sourceAt(map, candidate) === last;
          if (candidate > start && !splits && wordBoundaryAfter(map, candidate)) {
            trimmed = candidate;
          }
        }
      }
    }
    if (trimmed === undefined) return undefined;
    end = trimmed;
  }
  if ((digitBoundary === 'end' || digitBoundary === 'both') && !boundaryAfter(map, end)) {
    const candidate = shorterEndAfter(map, pattern, start, rawEnd);
    if (candidate !== undefined) return candidate;
    return undefined;
  }
  return end;
}

export interface RedactionWithSpansResult extends RedactionResult {
  readonly spans: readonly RedactionSpan[];
}

/**
 * Record a matched span. A fully-contained lower-priority span adds nothing; a partial
 * overlap is kept so `mergeSpans` takes the union instead of dropping the wider match
 * (e.g. a 82-prefix inner match inside a full +cc span).
 */
function addSpan(
  map: IndexMap,
  covered: Uint8Array,
  spans: RedactionSpan[],
  start: number,
  end: number,
  kind: RedactionKind,
): void {
  let allCovered = true;
  for (let index = start; index < end; index += 1) {
    if (covered[index] === 0) {
      allCovered = false;
      break;
    }
  }
  if (allCovered) return;
  for (let index = start; index < end; index += 1) covered[index] = 1;
  const first = sourceAt(map, start);
  const last = sourceAt(map, end - 1);
  if (first !== undefined && last !== undefined) {
    spans.push({ start: charStart(map, first), end: charEnd(map, last), kind });
  }
}

/**
 * Redact and also return the merged original-character spans. The spans are used by the
 * fuzz test to prove every character of a token was covered, not just the whole token.
 */
export function redactWithSpans(text: string): RedactionWithSpansResult {
  if (!couldContainMatch(text)) {
    return { text, report: [], spans: [] };
  }
  const map = normalizeWithMap(text);
  const covered = new Uint8Array(map.normalized.length);
  const spans: RedactionSpan[] = [];

  for (const patternDef of PATTERNS) {
    const { kind, regex } = patternDef;
    if (patternDef.prefix !== undefined) {
      // Word-boundary patterns: scan only candidate prefix starts, so a rejected start
      // never runs the greedy body (the quadratic cause of the FU-24R HIGH).
      const prefix = new RegExp(patternDef.prefix.source, patternDef.prefix.flags);
      const body = new RegExp(regex.source, regex.flags);
      let candidate = prefix.exec(map.normalized);
      while (candidate !== null) {
        const start = candidate.index;
        if (!startAllowed(map, patternDef, start)) {
          prefix.lastIndex = start + 1;
          candidate = prefix.exec(map.normalized);
          continue;
        }
        body.lastIndex = start;
        const raw = body.exec(map.normalized);
        if (raw === null) {
          prefix.lastIndex = start + 1;
          candidate = prefix.exec(map.normalized);
          continue;
        }
        const rawEnd = start + raw[0].length;
        const end = rawEnd === start ? undefined : resolveEnd(map, patternDef, start, rawEnd);
        if (end === undefined) {
          prefix.lastIndex = start + 1;
          candidate = prefix.exec(map.normalized);
          continue;
        }
        addSpan(map, covered, spans, start, end, kind);
        // Resume at the accepted end so a shorter word fallback never skips the next token.
        prefix.lastIndex = Math.max(end, start + 1);
        candidate = prefix.exec(map.normalized);
      }
      continue;
    }

    const pattern = new RegExp(regex.source, regex.flags);
    let match = pattern.exec(map.normalized);
    while (match !== null) {
      const start = match.index;
      const rawEnd = start + match[0].length;
      if (rawEnd === start) {
        pattern.lastIndex += 1;
        match = pattern.exec(map.normalized);
        continue;
      }
      const end = resolveEnd(map, patternDef, start, rawEnd);
      if (end === undefined) {
        // Retry one code unit later, not at the rejected span's end: a longer rejected
        // match can start inside a shorter valid one (the class (a) recall regression).
        pattern.lastIndex = start + 1;
        match = pattern.exec(map.normalized);
        continue;
      }
      addSpan(map, covered, spans, start, end, kind);
      // Continue after whichever match was accepted so the fallback never rescans its tail.
      pattern.lastIndex = Math.max(rawEnd, end);
      match = pattern.exec(map.normalized);
    }
  }

  const merged = mergeSpans(spans);
  const counts = new Map<RedactionKind, number>();
  for (const span of merged) {
    counts.set(span.kind, (counts.get(span.kind) ?? 0) + 1);
  }

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

  return { text: parts.join(''), report, spans: merged };
}

export function redact(text: string): RedactionResult {
  const { text: output, report } = redactWithSpans(text);
  return { text: output, report };
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
