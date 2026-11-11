/**
 * Privacy filter (05 §12) and untrusted-document wrapper (05 §9).
 *
 * Redaction runs on an NFKC-normalised copy with default-ignorable characters removed and
 * an index map back to the original. Patterns therefore catch fullwidth digits/`@`, soft
 * hyphens and zero-width separators while masking the original spans. Digit-adjacency
 * lookarounds are evaluated against the original characters, so a superscript/circled
 * footnote marker or a stripped format character still terminates a number. The report
 * contains only kinds and counts, never the matched values.
 *
 * Scanner architecture (ADR-019):
 * - Every pattern independently explores every candidate start. After an accepted match
 *   the next attempt starts at `start + 1` in normalised coordinates, so a match can never
 *   skip a later valid start that overlaps it (the cause of the FU-38 recall regressions).
 * - Every pattern has a bounded maximum match length (`Pattern.maxLength`), and every
 *   unbounded quantifier is capped, so a scan is O(n * L_max) in the input length.
 * - Accepted spans are unioned in original coordinates; overlapping spans get the highest
 *   priority kind (RRN > phone > email > API key). A capped API-key body is extended to the
 *   end of its `[A-Za-z0-9_-]` run here, via a precomputed run-end array (ADR-019 (5)).
 *   Superscript/subscript suffix extension is deliberately not applied: FU-32 pins attached
 *   markers as visible (see the precision note below).
 * - ADR-019 (6): a whitespace-class run (space, tab, newline, U+3000, NBSP and other `Zs`)
 *   normalises to one separator unit, so *whitespace* run length never limits recall.
 *   Non-whitespace separator runs (`-`, `.`, ...) stay capped at `MAX_SEPARATOR`; runs
 *   longer than that are out of scope (ADR-019 (11)) and pinned as known limitations.
 * - A token glued directly to an accepted token (no separator) is discovered by an
 *   adjacency pass from the accepted end. ADR-019 (7): the continuation counts as a right
 *   boundary only when it resolves itself and is a different kind, so long benign digit
 *   runs are not carved into RRN/phone chunks.
 *
 * Precision tradeoffs (05 §12 best effort):
 * - A number written entirely in super/subscript digits is treated as a real number. When
 *   a trailing circled marker is required to complete its shape it is masked with the
 *   number (`⁰¹⁰-¹²³⁴-⁵⁶⁷⑧`); an attached super/subscript suffix that the shape does not
 *   need stays visible (`900101-1234567²`).
 * - A mixed super/subscript + real-digit token is masked when the whole normalised token
 *   validates as a phone/RRN shape. If a real-digit start exists in the same aligned run,
 *   the aligned start wins so a leading marker stays visible (`⁰9001011234567`).
 * - Email obfuscation, IDN/spaced addresses, opaque tokens, names, addresses and account
 *   numbers are outside these guarantees.
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

/** ADR-019 overlap label priority: lower wins. */
const KIND_PRIORITY: Readonly<Record<RedactionKind, number>> = {
  rrn: 0,
  phone: 1,
  email: 2,
  api_key: 3,
};

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const ORIGINAL_DIGIT = /^\p{Nd}$/u;

const DIGIT = '[0-9０-９]';

/**
 * Separator runs are bounded so `L_max` is a real constant: an unbounded `*` would let a
 * rejected attempt scan a multi-megabyte run for every candidate start (FU-24R-2 HIGH).
 * Only whitespace-class runs are folded during normalisation (ADR-019 (6)); non-whitespace
 * runs (`-`, `.`, ...) longer than this cap are out of scope per ADR-019 (11).
 */
const MAX_SEPARATOR = 32;
const SEPARATOR = `[.\\s\\-_/\\u2010-\\u2015\\u2212\\u00B7]{0,${MAX_SEPARATOR}}`;
const REQUIRED_SEPARATOR = `[.\\s\\-_/\\u2010-\\u2015\\u2212\\u00B7]{1,${MAX_SEPARATOR}}`;
const DOMAIN_LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';

/**
 * ADR-019 (6): a whitespace-class run (space, tab, newline, U+3000, NBSP, other `Zs`)
 * normalises to one separator unit, so separator length does not cap recall.
 */
const MULTI_WHITESPACE = /\s\s/u;
const WHITESPACE = /^\s$/u;

/** Hard input-size guard for future LLM call sites (not applied by `redact` itself). */
export const MAX_REDACT_INPUT = 1024 * 1024;

/**
 * Reject an over-large redaction input before scanning. No caller uses this yet; GB-1
 * call sites should check it so a hostile note cannot force a multi-megabyte scan.
 */
export function assertRedactInputSize(text: string): void {
  if (text.length > MAX_REDACT_INPUT) {
    throw new RangeError(
      `redaction input length ${text.length} exceeds MAX_REDACT_INPUT (${MAX_REDACT_INPUT})`,
    );
  }
}

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
  /** Anchored full-match variant used to validate a shorter end. */
  readonly exact?: RegExp;
  /**
   * Upper bound on the number of normalised code units this pattern can match (`L_max`).
   * Documented per pattern; the scanner never reads more than this from a start.
   */
  readonly maxLength: number;
  /**
   * ADR-019 (5): a capped word-body pattern is accepted at `L_max` when the original
   * `[A-Za-z0-9_-]` run continues; the union stage extends the span to the run end.
   * The extension only applies when the raw match reached `maxLength`, so a shorter token
   * that merely fails the trailing word boundary stays rejected.
   */
  readonly extendWordRun?: boolean;
  /** Minimum number of digit glyphs a phone match must contain (precision guard). */
  readonly minDigits?: number;
}

interface OriginalChar {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly stripped: boolean;
}

interface IndexMap {
  readonly normalized: string;
  /** True only when the normalised text is byte-for-byte the original string. */
  readonly ascii: boolean;
  /**
   * ASCII text that only needed whitespace-run folding. Keeps a compact original-string
   * reference and a normalised-index -> original-index table instead of building one
   * object per character, which keeps 1 MiB of ASCII prose fast.
   */
  readonly compact?: boolean;
  readonly original?: string;
  /** Normalised code-unit index -> original char index. Built lazily for `compact`. */
  source: ArrayLike<number>;
  /** Original char index -> first normalised code-unit index (or -1 when stripped). */
  readonly firstNorm: ArrayLike<number>;
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
  return ORIGINAL_DIGIT.test(char.value);
}

/**
 * Superscript (⁰¹²³⁴⁵⁶⁷⁸⁹) and subscript (₀₁₂₃₄₅₆₇₈₉) digits are `No`, not `Nd`, so
 * they still act as footnote markers by default. A number written entirely in these
 * digits is a real number though: the decision (FU-32, FU-38R-1) is to mask it when every
 * `Nd` digit in the matched token is absent, while circled markers (`No`) may be consumed.
 */
function isSuperSubDigit(value: string): boolean {
  if (value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return (
    code === 0x2070 ||
    code === 0x00b9 ||
    code === 0x00b2 ||
    code === 0x00b3 ||
    (code >= 0x2074 && code <= 0x2079) ||
    (code >= 0x2080 && code <= 0x2089)
  );
}

function startsOnSuperSubDigit(map: IndexMap, start: number): boolean {
  if (map.ascii || map.compact === true) return false;
  const current = sourceAt(map, start);
  const char = current === undefined ? undefined : map.chars[current];
  return char !== undefined && !char.stripped && isSuperSubDigit(char.value);
}

/** True when the normalised match starts on a digit code unit. */
function startsOnDigit(map: IndexMap, start: number): boolean {
  return isDigitCode(map.normalized.charCodeAt(start));
}

/** True when that digit comes from an original digit, not a folded footnote marker. */
function startsOnOriginalDigit(map: IndexMap, start: number): boolean {
  if (map.ascii || map.compact === true) {
    return isDigitCode(map.normalized.charCodeAt(start));
  }
  const current = sourceAt(map, start);
  return isOriginalDigitChar(current === undefined ? undefined : map.chars[current]);
}

/**
 * First normalised position in the digit run at `start` that comes from a real `Nd` digit,
 * limited to `limit` (the current match end, so the probe is bounded by `L_max`). A
 * super/subscript glyph before it is indistinguishable from a footnote marker, so probing
 * the real-digit start decides whether shifting the window recovers more.
 */
function firstOriginalDigitInRun(
  map: IndexMap,
  start: number,
  limit: number,
): number | undefined {
  if (map.ascii || map.compact === true) return start;
  const stop = Math.min(limit, sourceLength(map));
  let index = start;
  while (index < stop && isDigitCode(map.normalized.charCodeAt(index))) {
    if (startsOnOriginalDigit(map, index)) return index;
    index += 1;
  }
  return undefined;
}

/**
 * Fast path for ASCII text whose only normalisation is whitespace folding (ADR-019 (6)).
 * It avoids per-character objects: the normalised string is built natively and only a
 * `Uint32Array` map back to original offsets is materialised. `firstNorm` stays empty and
 * `toNormalized` binary-searches `source` for the rare adjacency lookup.
 */
function normalizeAsciiFolded(text: string): IndexMap {
  return {
    normalized: text.replace(/\s+/g, ' '),
    ascii: false,
    compact: true,
    original: text,
    source: EMPTY_NUMBERS,
    firstNorm: EMPTY_NUMBERS,
    chars: EMPTY_CHARS,
  };
}

/**
 * Build the compact original-offset table on first use. Plain prose with no secrets never
 * needs it, so the 1 MiB ASCII path only pays for the native whitespace fold.
 */
function compactSource(map: IndexMap): ArrayLike<number> {
  if (map.source !== EMPTY_NUMBERS) return map.source;
  const original = map.original as string;
  const source = new Uint32Array(map.normalized.length);
  const ws = /\s+/g;
  let previous = 0;
  let unit = 0;
  let match = ws.exec(original);
  while (match !== null) {
    const identity = match.index - previous;
    for (let step = 0; step < identity; step += 1) source[unit + step] = previous + step;
    unit += identity;
    source[unit] = match.index;
    unit += 1;
    previous = match.index + match[0].length;
    match = ws.exec(original);
  }
  const tail = map.normalized.length - unit;
  for (let step = 0; step < tail; step += 1) source[unit + step] = previous + step;
  map.source = source;
  return source;
}

function normalizeWithMap(text: string): IndexMap {
  if (!NON_ASCII.test(text)) {
    if (!MULTI_WHITESPACE.test(text)) {
      return {
        normalized: text,
        ascii: true,
        source: EMPTY_NUMBERS,
        firstNorm: EMPTY_NUMBERS,
        chars: EMPTY_CHARS,
      };
    }
    return normalizeAsciiFolded(text);
  }

  const chars: OriginalChar[] = [];
  const source: number[] = [];
  const firstNorm: number[] = [];
  // Long separator runs repeat one code point; fold and test it once per call.
  const folded = new Map<string, string>();
  let normalized = '';
  let offset = 0;
  let index = 0;
  let inWhitespaceRun = false;

  for (const char of text) {
    const start = offset;
    offset += char.length;
    const current = index;
    index += 1;

    // Ignorable first: U+FEFF is both whitespace and default-ignorable; stripping keeps
    // FU-32 semantics. A stripped char inside a whitespace run leaves the run open so
    // `' \u200B '` still folds to one separator unit.
    if (IGNORABLE.test(char)) {
      chars.push({ start, end: offset, value: char, stripped: true });
      firstNorm.push(-1);
      continue;
    }

    if (WHITESPACE.test(char)) {
      if (inWhitespaceRun) {
        chars.push({ start, end: offset, value: char, stripped: true });
        firstNorm.push(-1);
        continue;
      }
      inWhitespaceRun = true;
      chars.push({ start, end: offset, value: char, stripped: false });
      firstNorm.push(normalized.length);
      normalized += ' ';
      source.push(current);
      continue;
    }
    inWhitespaceRun = false;

    if (isAscii(char)) {
      chars.push({ start, end: offset, value: char, stripped: false });
      source.push(current);
      firstNorm.push(normalized.length);
      normalized += char;
      continue;
    }

    let expanded = folded.get(char);
    if (expanded === undefined) {
      expanded = char.normalize('NFKC');
      folded.set(char, expanded);
    }

    chars.push({ start, end: offset, value: char, stripped: false });
    firstNorm.push(normalized.length);
    normalized += expanded;
    for (let unit = 0; unit < expanded.length; unit += 1) source.push(current);
  }

  return { normalized, ascii: false, source, firstNorm, chars };
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
  if (map.ascii) {
    return index >= 0 && index < map.normalized.length ? index : undefined;
  }
  if (map.compact === true) return compactSource(map)[index];
  return map.source[index];
}

function sourceLength(map: IndexMap): number {
  return map.ascii || map.compact === true ? map.normalized.length : map.source.length;
}

/**
 * Next candidate start after a normalised position. Advances one code point, not one code
 * unit: a `u`-flag regex whose `lastIndex` sits inside a surrogate pair backs up to the
 * pair start, so `start + 1` would return the same match forever.
 */
function nextStart(map: IndexMap, index: number): number {
  const code = map.normalized.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = map.normalized.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return index + 2;
  }
  return index + 1;
}

function charStart(map: IndexMap, index: number): number {
  if (map.ascii) return index;
  if (map.compact === true) return compactSource(map)[index] ?? index;
  return map.chars[index]?.start ?? index;
}

function charEnd(map: IndexMap, index: number): number {
  if (map.ascii) return index + 1;
  if (map.compact === true) return (compactSource(map)[index] ?? index) + 1;
  return map.chars[index]?.end ?? index + 1;
}

/** Original coordinate -> normalised position of the char that starts there. */
function toNormalized(map: IndexMap, originalStart: number): number | undefined {
  if (map.ascii) return originalStart;
  if (map.compact === true) {
    // `source` is strictly increasing, so an exact original offset can be found by binary
    // search. Whitespace characters folded away have no normalised position.
    const source = compactSource(map);
    let low = 0;
    let high = source.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const position = source[middle] as number;
      if (position < originalStart) {
        low = middle + 1;
      } else if (position > originalStart) {
        high = middle - 1;
      } else {
        return middle;
      }
    }
    return undefined;
  }
  let low = 0;
  let high = map.chars.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const char = map.chars[middle] as OriginalChar;
    if (char.start < originalStart) {
      low = middle + 1;
    } else if (char.start > originalStart) {
      high = middle - 1;
    } else {
      const position = map.firstNorm[middle];
      return position !== undefined && position >= 0 ? position : undefined;
    }
  }
  return undefined;
}

function charBoundary(map: IndexMap, index: number): boolean {
  if (map.ascii || map.compact === true) {
    const original = map.compact === true ? (map.original as string) : map.normalized;
    if (index < 0 || index >= original.length) return true;
    const code = original.charCodeAt(index);
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
  if (map.compact === true) {
    const original = map.original as string;
    const hereIndex = sourceAt(map, start);
    if (hereIndex === undefined) return false;
    const before =
      hereIndex > 0 ? isAsciiWordCode(original.charCodeAt(hereIndex - 1)) : false;
    const here =
      hereIndex < original.length ? isAsciiWordCode(original.charCodeAt(hereIndex)) : false;
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
  if (map.compact === true) {
    const original = map.original as string;
    const endIndex = sourceAt(map, end - 1);
    if (endIndex === undefined) return false;
    const here = isAsciiWordCode(original.charCodeAt(endIndex));
    const next =
      endIndex + 1 < original.length
        ? isAsciiWordCode(original.charCodeAt(endIndex + 1))
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
  if (map.compact === true) {
    const original = map.original as string;
    const current = sourceAt(map, start);
    if (current === undefined) return true;
    if (current <= 0) return true;
    const code = original.charCodeAt(current - 1);
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

/**
 * FU-32's international pattern, kept byte-for-byte (ADR-019 (9)). Its groups are joined
 * by optionally-empty separators, so glued and stripped-joined groups still match.
 */
const CC_PHONE_SOURCE = `\\+${DIGIT}{1,3}(?:${SEPARATOR}(?:\\(\\s?${DIGIT}{1,5}\\s?\\)|${DIGIT}{2,4})){2,4}`;
const CC_PHONE_EXACT = new RegExp(`^(?:${CC_PHONE_SOURCE})$`, 'u');
/**
 * Separate 1-digit-area international form (+82-2-…, +81 3-…, +33 1 …). ADR-019 (9): a
 * recall-widening change adds a pattern instead of editing FU-32's. The country code needs
 * at least two digits and every group after the area needs a separator, which keeps short
 * arithmetic-like `+1 2 …` runs out; `minDigits` is a second guard.
 */
const SINGLE_AREA_PHONE_SOURCE = `\\+${DIGIT}{2,3}${REQUIRED_SEPARATOR}${DIGIT}(?:${REQUIRED_SEPARATOR}(?:\\(\\s?${DIGIT}{1,5}\\s?\\)|${DIGIT}{2,4})){1,4}`;
const SINGLE_AREA_PHONE_EXACT = new RegExp(`^(?:${SINGLE_AREA_PHONE_SOURCE})$`, 'u');
const INTL_82_PHONE_SOURCE = `(?:00(?:82|[1-9]${DIGIT}{0,2}${SEPARATOR}82)|82)${SEPARATOR}(?:\\(0\\)${SEPARATOR})?0?${DIGIT}{1,2}${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`;
const KR_PAREN_PREFIX_SOURCE = `\\(\\s?0(?:1[016789]|2|[3-6][1-5]|50${DIGIT}?|70|80)\\s?\\)${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`;
const KR_MOBILE_SOURCE = `(?:01[016789]|070|080)${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`;
const KR_050_SOURCE = `050${DIGIT}?${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`;
const KR_LANDLINE_SOURCE = `0(?:2|[3-6][1-5])${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}`;
const RRN_SOURCE = `${DIGIT}{6}${SEPARATOR}[1-8]${DIGIT}{6}`;

function exactSource(source: string): RegExp {
  return new RegExp(`^(?:${source})$`, 'u');
}

/**
 * `maxLength` is the documented per-pattern `L_max` in normalised code units. Unbounded
 * payload quantifiers (API-key bodies, Bearer segments) are capped at 256/2048 so the bound
 * is a constant; separators are capped at `MAX_SEPARATOR`.
 */
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'email',
    // 320 local + '@' + 8 labels of at most 63 + 8 dots.
    maxLength: 840,
    regex: new RegExp(
      `(?<![^\\s@<>()\\[\\],;:'"])[^\\s@<>()\\[\\],;:'"]{1,320}@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL}){1,8}`,
      'gu',
    ),
  },
  {
    kind: 'api_key',
    maxLength: 20,
    prefix: /(?:AKIA|ASIA)/g,
    regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/y,
    wordBoundary: 'both',
  },
  {
    kind: 'api_key',
    // `ghp_` + 256 body characters (the `gh*` alternative's cap).
    maxLength: 260,
    prefix: /gh[pousr]_/g,
    regex: /gh[pousr]_[A-Za-z0-9]{20,256}/y,
    wordBoundary: 'both',
    extendWordRun: true,
  },
  {
    kind: 'api_key',
    // `github_pat_` + 256 body characters.
    maxLength: 267,
    prefix: /github_pat_/g,
    regex: /github_pat_[A-Za-z0-9_]{20,256}/y,
    wordBoundary: 'both',
    extendWordRun: true,
  },
  {
    kind: 'api_key',
    maxLength: 259,
    prefix: /(?:sk|tk|pk)[-_]/g,
    regex: /(?:sk|tk|pk)[-_][A-Za-z0-9_-]{8,256}/y,
    wordBoundary: 'both',
    extendWordRun: true,
  },
  {
    kind: 'api_key',
    // `xox?-` (5 characters) + 256 body characters.
    maxLength: 261,
    prefix: /xox[baprs]-/g,
    regex: /xox[baprs]-[A-Za-z0-9-]{10,256}/y,
    wordBoundary: 'both',
    extendWordRun: true,
  },
  {
    kind: 'api_key',
    maxLength: 43,
    prefix: /AIza/g,
    regex: /AIza[0-9A-Za-z_-]{30,40}/y,
    wordBoundary: 'both',
    shorterWordEnd: /AIza[0-9A-Za-z_-]{30,40}(?![A-Za-z0-9_])/y,
  },
  {
    kind: 'api_key',
    // `glpat-` (6 characters) + 256 body characters.
    maxLength: 262,
    prefix: /glpat-/g,
    regex: /glpat-[A-Za-z0-9_-]{20,256}/y,
    wordBoundary: 'both',
    extendWordRun: true,
  },
  {
    kind: 'api_key',
    maxLength: 6200,
    prefix: /(?:Bearer|bearer)\s{1,32}/g,
    regex:
      /(?:Bearer|bearer)\s{1,32}[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}/y,
    wordBoundary: 'both',
  },
  {
    kind: 'rrn',
    // Korean RRN shares the phone separator class (dot, slash, Unicode dash, spaced dash).
    maxLength: 45,
    regex: new RegExp(RRN_SOURCE, 'gu'),
    digitBoundary: 'both',
    exact: exactSource(RRN_SOURCE),
  },
  {
    kind: 'phone',
    // +82-(0)2-123-4567.
    maxLength: 120,
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
    maxLength: 120,
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
    maxLength: 150,
    regex: new RegExp(INTL_82_PHONE_SOURCE, 'gu'),
    digitBoundary: 'both',
    notWordPlusBefore: true,
    exact: exactSource(INTL_82_PHONE_SOURCE),
  },
  {
    kind: 'phone',
    // FU-32 +<cc> followed by 2-4 groups; groups may be glued or stripped-joined.
    maxLength: 167,
    regex: new RegExp(CC_PHONE_SOURCE, 'gu'),
    digitBoundary: 'end',
    notWordPlusBefore: true,
    shorterEnd: new RegExp(`${CC_PHONE_SOURCE}(?![0-9０-９])`, 'yu'),
    exact: CC_PHONE_EXACT,
  },
  {
    kind: 'phone',
    // Separate 1-digit-area form (+82-2-..., +81 3-..., +33 1 ...); ADR-019 (9)-(10).
    maxLength: 200,
    regex: new RegExp(SINGLE_AREA_PHONE_SOURCE, 'gu'),
    digitBoundary: 'end',
    notWordPlusBefore: true,
    shorterEnd: new RegExp(`${SINGLE_AREA_PHONE_SOURCE}(?![0-9０-９])`, 'yu'),
    exact: SINGLE_AREA_PHONE_EXACT,
    minDigits: 8,
  },
  // Glued E.164 without separators: +821012345678, +14155552671.
  {
    kind: 'phone',
    maxLength: 16,
    regex: new RegExp(`\\+${DIGIT}{8,15}`, 'gu'),
    digitBoundary: 'end',
    notWordPlusBefore: true,
  },
  {
    kind: 'phone',
    // Parenthesised KR prefix: (02), (031), (010), (070), (0505).
    maxLength: 120,
    regex: new RegExp(KR_PAREN_PREFIX_SOURCE, 'gu'),
    digitBoundary: 'end',
    exact: exactSource(KR_PAREN_PREFIX_SOURCE),
  },
  // Korean mobile plus 070 VoIP and 080 toll-free ranges.
  {
    kind: 'phone',
    maxLength: 85,
    regex: new RegExp(KR_MOBILE_SOURCE, 'gu'),
    digitBoundary: 'both',
    exact: exactSource(KR_MOBILE_SOURCE),
  },
  // 050x VoIP ranges (050, 0505, ...).
  {
    kind: 'phone',
    maxLength: 85,
    regex: new RegExp(KR_050_SOURCE, 'gu'),
    digitBoundary: 'both',
    exact: exactSource(KR_050_SOURCE),
  },
  // Korean landline: 02, 031-065.
  {
    kind: 'phone',
    maxLength: 85,
    regex: new RegExp(KR_LANDLINE_SOURCE, 'gu'),
    digitBoundary: 'both',
    exact: exactSource(KR_LANDLINE_SOURCE),
  },
];

/**
 * Digit patterns used to decide whether a rejected right boundary is actually a glued
 * second token (`900101123456701012345678`). Raw sticky shapes only: no boundary checks,
 * because the continuation token's left boundary is the accepted token's end.
 */
const DIGIT_PROBES: readonly { readonly pattern: Pattern; readonly probe: RegExp }[] =
  PATTERNS.filter((pattern) => pattern.digitBoundary !== undefined).map((pattern) => ({
    pattern,
    probe: new RegExp(pattern.regex.source, 'yu'),
  }));

/**
 * ADR-019 (7): a glued continuation is a valid right boundary only when it is itself
 * accepted by a normal resolve (no further right-boundary relaxation) and it is a
 * different kind. Same-kind digit windows inside one long run are inherently ambiguous, so
 * they never justify cutting a benign digit run into RRN/phone chunks.
 */
function acceptsGluedContinuation(
  map: IndexMap,
  currentKind: RedactionKind,
  start: number,
): boolean {
  if (start <= 0 || start >= sourceLength(map)) return false;
  if (!isDigitCode(map.normalized.charCodeAt(start))) return false;
  for (const { pattern, probe } of DIGIT_PROBES) {
    if (pattern.kind === currentKind) continue;
    probe.lastIndex = start;
    const match = probe.exec(map.normalized);
    if (match === null || match.index !== start || match[0].length === 0) continue;
    const rawEnd = start + match[0].length;
    const end = resolveEnd(map, pattern, start, rawEnd, true, undefined, false);
    if (end !== undefined) return true;
  }
  return false;
}

export interface RedactionSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: RedactionKind;
}

interface MutableSpan {
  start: number;
  end: number;
  kind: RedactionKind;
}

/** Merge overlapping spans into their union, keeping the first span's mask kind. */
export function mergeSpans(spans: readonly RedactionSpan[]): RedactionSpan[] {
  const sorted = [...spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: MutableSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ start: span.start, end: span.end, kind: span.kind });
  }
  return merged;
}

/**
 * Union overlapped spans and pick the deterministic kind priority for each component
 * (ADR-019: RRN > phone > email > API key). Adjacent spans stay separate.
 */
function unionSpans(spans: readonly RedactionSpan[]): RedactionSpan[] {
  const sorted = [...spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: MutableSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
      if (KIND_PRIORITY[span.kind] < KIND_PRIORITY[last.kind]) last.kind = span.kind;
      continue;
    }
    merged.push({ start: span.start, end: span.end, kind: span.kind });
  }
  return merged;
}

function originalWordAt(map: IndexMap, index: number | undefined): boolean {
  if (index === undefined) return false;
  if (map.ascii) return isAsciiWordCode(map.normalized.charCodeAt(index));
  if (map.compact === true) {
    return isAsciiWordCode((map.original as string).charCodeAt(index));
  }
  return isOriginalWordChar(map.chars[index]);
}

/**
 * True when a stripped format character sits directly after the matched end. That char is
 * a real original word boundary even though the normalised match continues across it, so
 * `ghp_<key><ZWSP>ghp_<key>` can end the first key before the joiner.
 */
function strippedBoundaryAfter(map: IndexMap, end: number): boolean {
  if (map.ascii || map.compact === true) return false;
  const current = sourceAt(map, end - 1);
  if (current === undefined) return false;
  return map.chars[current + 1]?.stripped === true;
}

/** Does `[start, end)` still match the pattern body exactly? */
function matchesPatternShape(
  map: IndexMap,
  pattern: Pattern,
  start: number,
  end: number,
): boolean {
  const source = pattern.exact?.source ?? pattern.regex.source;
  return new RegExp(`^(?:${source})$`, 'u').test(map.normalized.slice(start, end));
}

/**
 * A word-boundary match may greedily end on a non-word separator (`sk-key-`); JavaScript
 * `\b` would backtrack it. Trim only trailing non-word original characters to reach the
 * same boundary, never dropping part of the token itself. A match may also run across a
 * stripped format character; in that case the longest earlier end whose immediate next
 * original char is stripped (and whose slice still matches the pattern shape) wins.
 */
function trimmedWordEnd(
  map: IndexMap,
  pattern: Pattern,
  start: number,
  rawEnd: number,
): number | undefined {
  // A raw match that reached `L_max` is extended to the run end by ADR-019 (5); do not
  // split it at an earlier stripped-character boundary.
  const atCap = rawEnd - start >= pattern.maxLength;
  let end = rawEnd;
  let crossedWord = false;
  while (end > start) {
    const boundary = wordBoundaryAfter(map, end);
    if (boundary) {
      if (!crossedWord) return end;
      if (
        !atCap &&
        strippedBoundaryAfter(map, end) &&
        matchesPatternShape(map, pattern, start, end)
      ) {
        return end;
      }
    }
    if (originalWordAt(map, sourceAt(map, end - 1))) {
      crossedWord = true;
      if (atCap) return undefined;
    }
    end -= 1;
  }
  return undefined;
}

function countDigits(normalized: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (isDigitCode(normalized.charCodeAt(index))) count += 1;
  }
  return count;
}

/** `[A-Za-z0-9_-]` in normalised (ASCII) coordinates, for ADR-019 (5) run extension. */
function isWordRunCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2d
  );
}

/** A shorter end must not split a glyph, satisfy the boundary and match exactly. */
function acceptedShorterEnd(
  map: IndexMap,
  pattern: Pattern,
  start: number,
  end: number,
): boolean {
  if (end <= start) return false;
  const last = sourceAt(map, end - 1);
  if (last !== undefined && end < sourceLength(map) && sourceAt(map, end) === last) {
    return false;
  }
  if (!boundaryAfter(map, end)) return false;
  if (
    pattern.minDigits !== undefined &&
    countDigits(map.normalized, start, end) < pattern.minDigits
  ) {
    return false;
  }
  const exact = pattern.exact;
  return exact === undefined || exact.test(map.normalized.slice(start, end));
}

/**
 * Walk the rejected end backwards to the longest end that satisfies the original-character
 * digit boundary. Every digit pattern supplies an anchored `exact` shape, so a greedy
 * variable group that swallowed a marker digit (⑳/㉑/⑧) can be shortened instead of
 * dropping the whole token. The walk is bounded by `L_max`.
 */
function shorterEndAfter(
  map: IndexMap,
  pattern: Pattern,
  start: number,
  rawEnd: number,
): number | undefined {
  const shorter = pattern.shorterEnd;
  if (shorter !== undefined) {
    // Sticky fast path: contiguous digits can be split across groups, yielding a match
    // longer than the rejected greedy one. Sticky exec scans only at `start`.
    shorter.lastIndex = start;
    const candidate = shorter.exec(map.normalized);
    if (candidate !== null && candidate.index === start) {
      const end = start + candidate[0].length;
      if (end > rawEnd && acceptedShorterEnd(map, pattern, start, end)) return end;
    }
  }
  if (pattern.exact === undefined) return undefined;
  for (let end = rawEnd; end > start; end -= 1) {
    // A match can only end on a digit or a closing paren. Separator runs are bounded, but
    // skipping them avoids testing every position (FU-24R-2 HIGH).
    const last = map.normalized.charCodeAt(end - 1);
    if (!(isDigitCode(last) || last === 0x29)) continue;
    if (acceptedShorterEnd(map, pattern, start, end)) return end;
  }
  return undefined;
}

function startAllowed(
  map: IndexMap,
  pattern: Pattern,
  start: number,
  adjacent: boolean,
): boolean {
  const { digitBoundary, wordBoundary, notWordPlusBefore: needsNotWordPlus } = pattern;
  if (
    !adjacent &&
    (digitBoundary === 'start' || digitBoundary === 'both') &&
    !boundaryBefore(map, start)
  ) {
    return false;
  }
  // A digit pattern must not begin on a footnote marker that only folds to a digit
  // (①/⑳/㉑); that start would let its end land on a real digit. Super/subscript digits
  // are the exception: a token made entirely of them is a real number.
  if (
    (digitBoundary === 'start' || digitBoundary === 'both') &&
    startsOnDigit(map, start) &&
    !startsOnOriginalDigit(map, start) &&
    !startsOnSuperSubDigit(map, start)
  ) {
    return false;
  }
  if (!adjacent && needsNotWordPlus === true && !notWordPlusBefore(map, start)) return false;
  if (!adjacent && (wordBoundary === 'start' || wordBoundary === 'both')) {
    return wordBoundaryBefore(map, start);
  }
  return true;
}

interface ExtensionCandidate {
  readonly start: number;
  readonly end: number;
  readonly kind: RedactionKind;
}

/** Raw sticky match at `start`, used only to probe an aligned real-digit start. */
function probeAt(map: IndexMap, pattern: Pattern, start: number): number | undefined {
  const probe = new RegExp(pattern.regex.source, 'yu');
  probe.lastIndex = start;
  const match = probe.exec(map.normalized);
  if (match === null || match.index !== start || match[0].length === 0) return undefined;
  let end = start + match[0].length;
  if (pattern.wordBoundary === 'end' || pattern.wordBoundary === 'both') {
    const trimmed = trimmedWordEnd(map, pattern, start, end);
    if (trimmed === undefined) return undefined;
    end = trimmed;
  }
  if (
    (pattern.digitBoundary === 'end' || pattern.digitBoundary === 'both') &&
    !boundaryAfter(map, end)
  ) {
    const shorter = shorterEndAfter(map, pattern, start, end);
    if (shorter === undefined) return undefined;
    end = shorter;
  }
  if (
    pattern.minDigits !== undefined &&
    countDigits(map.normalized, start, end) < pattern.minDigits
  ) {
    return undefined;
  }
  return end;
}

/** Resolve a raw regex match to an accepted end, applying the original-character rules. */
function resolveEnd(
  map: IndexMap,
  pattern: Pattern,
  start: number,
  rawEnd: number,
  adjacent: boolean,
  extensions?: ExtensionCandidate[],
  allowContinuation = true,
): number | undefined {
  const { digitBoundary, wordBoundary } = pattern;
  if (!startAllowed(map, pattern, start, adjacent)) return undefined;

  let end = rawEnd;
  if (wordBoundary === 'end' || wordBoundary === 'both') {
    let trimmed = trimmedWordEnd(map, pattern, start, end);
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
    if (trimmed === undefined) {
      // ADR-019 (5): `L_max` is a search bound, not a rejection reason. When the regex
      // body actually reached `maxLength` and stops mid word run, accept it and let the
      // union stage extend to the run end. A shorter match that merely fails `\b` (for
      // example `ghp_` + 30 letters + `_tail`) is still rejected, as in FU-32.
      if (
        pattern.extendWordRun === true &&
        extensions !== undefined &&
        rawEnd < sourceLength(map) &&
        rawEnd - start >= pattern.maxLength &&
        isWordRunCode(map.normalized.charCodeAt(rawEnd))
      ) {
        extensions.push({ start, end: rawEnd, kind: pattern.kind });
        return rawEnd;
      }
      return undefined;
    }
    end = trimmed;
  }
  if ((digitBoundary === 'end' || digitBoundary === 'both') && !boundaryAfter(map, end)) {
    // A glued *accepted* token of another kind immediately after this one is a valid right
    // boundary; the scanner will accept that continuation at the adjacency pass.
    if (allowContinuation && acceptsGluedContinuation(map, pattern.kind, rawEnd)) {
      return rawEnd;
    }
    const candidate = shorterEndAfter(map, pattern, start, rawEnd);
    if (candidate === undefined) return undefined;
    end = candidate;
  }
  if (
    pattern.minDigits !== undefined &&
    countDigits(map.normalized, start, end) < pattern.minDigits
  ) {
    return undefined;
  }
  // A match may start on a super/subscript glyph and mix it with real digits. The regex
  // validates the whole normalised token as a supported shape. When the contiguous digit
  // run behind that start contains a real `Nd` digit whose aligned window covers at least
  // as much, prefer the aligned start so a leading marker stays visible.
  if (
    (digitBoundary === 'start' || digitBoundary === 'both') &&
    startsOnDigit(map, start) &&
    !startsOnOriginalDigit(map, start) &&
    startsOnSuperSubDigit(map, start)
  ) {
    const aligned = firstOriginalDigitInRun(map, start, end);
    if (aligned !== undefined && aligned > start) {
      const alignedEnd = probeAt(map, pattern, aligned);
      if (alignedEnd !== undefined && alignedEnd >= end) return undefined;
    }
  }
  return end;
}

export interface RedactionWithSpansResult extends RedactionResult {
  readonly spans: readonly RedactionSpan[];
}

/** Coalesce a span into the per-pattern list; starts arrive in increasing order. */
function recordSpan(
  map: IndexMap,
  spans: MutableSpan[],
  ends: Set<number>,
  start: number,
  end: number,
  kind: RedactionKind,
): void {
  if (end <= start) return;
  const first = sourceAt(map, start);
  const last = sourceAt(map, end - 1);
  if (first === undefined || last === undefined) return;
  const originalStart = charStart(map, first);
  const originalEnd = charEnd(map, last);
  ends.add(originalEnd);
  const previous = spans[spans.length - 1];
  if (
    previous !== undefined &&
    previous.kind === kind &&
    originalStart >= previous.start &&
    originalStart <= previous.end
  ) {
    if (originalEnd > previous.end) previous.end = originalEnd;
    return;
  }
  spans.push({ start: originalStart, end: originalEnd, kind });
}

/**
 * Find tokens glued directly after an already-accepted token. Their ordinary start
 * boundary is a digit/word character, so only the adjacency context (an accepted span ends
 * exactly here) makes them a valid start. This keeps `1010-1234-5678` untouched while
 * `900101123456701012345678` masks both tokens. The work list is bounded by the number of
 * accepted spans (each original end is queued at most once), and each probe is sticky at
 * one position, so the pass stays linear.
 */
function scanAdjacent(
  map: IndexMap,
  spans: MutableSpan[],
  ends: Set<number>,
  extensions: ExtensionCandidate[],
): void {
  const sticky = new Map<Pattern, RegExp>();
  const queue = [...ends].sort((left, right) => left - right);
  const newEnds = new Set<number>(ends);
  let cursor = 0;
  while (cursor < queue.length) {
    const originalEnd = queue[cursor] as number;
    cursor += 1;
    const start = toNormalized(map, originalEnd);
    if (start === undefined || start >= map.normalized.length) continue;
    for (const pattern of PATTERNS) {
      let probe = sticky.get(pattern);
      if (probe === undefined) {
        probe = new RegExp(pattern.regex.source, 'yu');
        sticky.set(pattern, probe);
      }
      probe.lastIndex = start;
      const match = probe.exec(map.normalized);
      if (match === null || match.index !== start || match[0].length === 0) continue;
      const rawEnd = start + match[0].length;
      const end = resolveEnd(map, pattern, start, rawEnd, true, extensions);
      if (end === undefined) continue;
      recordSpan(map, spans, ends, start, end, pattern.kind);
      const last = spans[spans.length - 1];
      if (last !== undefined && !newEnds.has(last.end)) {
        newEnds.add(last.end);
        queue.push(last.end);
      }
    }
  }
}

/**
 * Redact and also return the merged original-character spans. The spans are used by the
 * gate tests to prove every character of a token was covered, not just the whole token.
 */
export function redactWithSpans(text: string): RedactionWithSpansResult {
  if (!couldContainMatch(text)) {
    return { text, report: [], spans: [] };
  }
  const map = normalizeWithMap(text);
  const spans: MutableSpan[] = [];
  const ends = new Set<number>();
  const extensions: ExtensionCandidate[] = [];

  for (const patternDef of PATTERNS) {
    const { kind, regex } = patternDef;
    if (patternDef.prefix !== undefined) {
      // Word-boundary patterns: scan only candidate prefix starts, so a rejected start
      // never runs the greedy body (the quadratic cause of the FU-24R HIGH).
      const prefix = new RegExp(patternDef.prefix.source, patternDef.prefix.flags);
      const body = new RegExp(regex.source, 'yu');
      let candidate = prefix.exec(map.normalized);
      while (candidate !== null) {
        const start = candidate.index;
        body.lastIndex = start;
        const raw = body.exec(map.normalized);
        if (raw === null || raw.index !== start || raw[0].length === 0) {
          prefix.lastIndex = nextStart(map, start);
          candidate = prefix.exec(map.normalized);
          continue;
        }
        const rawEnd = start + raw[0].length;
        const end = resolveEnd(map, patternDef, start, rawEnd, false, extensions);
        if (end === undefined) {
          prefix.lastIndex = nextStart(map, start);
          candidate = prefix.exec(map.normalized);
          continue;
        }
        recordSpan(map, spans, ends, start, end, kind);
        // ADR-019: continue at the next candidate start, never at the accepted end.
        prefix.lastIndex = nextStart(map, start);
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
        pattern.lastIndex = nextStart(map, start);
        match = pattern.exec(map.normalized);
        continue;
      }
      const end = resolveEnd(map, patternDef, start, rawEnd, false, extensions);
      if (end === undefined) {
        // Retry one code unit later, not at the rejected span's end: a longer rejected
        // match can start inside a shorter valid one (the class (a) recall regression).
        pattern.lastIndex = nextStart(map, start);
        match = pattern.exec(map.normalized);
        continue;
      }
      recordSpan(map, spans, ends, start, end, kind);
      // ADR-019: continue at the next candidate start, never at the accepted end.
      pattern.lastIndex = nextStart(map, start);
      match = pattern.exec(map.normalized);
    }
  }

  scanAdjacent(map, spans, ends, extensions);

  // ADR-019 (5) union stage: extend a capped key body to the end of its `[A-Za-z0-9_-]`
  // run. The run-end array is built once (O(n)) and each lookup is O(1).
  if (extensions.length > 0) {
    const length = map.normalized.length;
    const runEnd = new Int32Array(length + 1);
    runEnd[length] = length;
    for (let index = length - 1; index >= 0; index -= 1) {
      runEnd[index] = isWordRunCode(map.normalized.charCodeAt(index))
        ? (runEnd[index + 1] as number)
        : index;
    }
    for (const candidate of extensions) {
      const extended = runEnd[candidate.end] as number;
      recordSpan(map, spans, ends, candidate.start, Math.max(extended, candidate.end), candidate.kind);
    }
  }

  // All span extensions (super/subscript runs) belong here, after acceptance. FU-32 pins
  // an attached super/subscript suffix as visible (`900101-1234567²`), so none is applied;
  // the start-at-every-position scan already covers the digits of multi-token runs.
  const merged = unionSpans(spans);
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
