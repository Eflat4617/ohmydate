/**
 * Privacy filter (05 §12) and untrusted-document wrapper (05 §9).
 *
 * Redaction runs on an NFKC-normalised copy with zero-width/format characters removed and
 * an index map back to the original. Patterns therefore catch fullwidth digits/`@`, soft
 * hyphens and zero-width separators while masking the original spans. The report contains
 * only kinds and counts, never the matched values.
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

const FORMAT_CHARS: ReadonlySet<string> = new Set([
  '\u00AD', // soft hyphen
  '\u200B', // zero width space
  '\u200C', // zero width non-joiner
  '\u200D', // zero width joiner
  '\u2060', // word joiner
  '\uFEFF', // zero width no-break space / BOM
]);

const DIGIT = '[0-9０-９]';
const SEPARATOR = '[.\\s\\-_/\\u2010-\\u2015]*';
const DOMAIN_LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';

interface Pattern {
  readonly kind: RedactionKind;
  readonly regex: RegExp;
}

interface IndexMap {
  readonly normalized: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

function normalizeWithMap(text: string): IndexMap {
  const starts: number[] = [];
  const ends: number[] = [];
  let normalized = '';
  let offset = 0;

  for (const char of text) {
    const start = offset;
    offset += char.length;
    if (FORMAT_CHARS.has(char)) continue;
    const expanded = char.normalize('NFKC');
    for (let index = 0; index < expanded.length; index += 1) {
      starts.push(start);
      ends.push(offset);
    }
    normalized += expanded;
  }

  return { normalized, starts, ends };
}

// Order matters: redact wider/more specific tokens first so a lower-priority pattern never
// claims part of an already-masked span. Matching runs on the normalised copy.
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'email',
    // Unicode local parts, long local parts and up to 9 domain labels are masked whole.
    regex: new RegExp(
      `[^\\s@<>()\\[\\],;:'"]{1,320}@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL}){1,8}`,
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
      /\bBearer\s+[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\b/g,
  },
  {
    kind: 'rrn',
    // Korean RRN shares the phone separator class (dot, slash, Unicode dash, spaced dash).
    regex: new RegExp(`(?<!${DIGIT})${DIGIT}{6}${SEPARATOR}[1-8]${DIGIT}{6}(?!${DIGIT})`, 'gu'),
  },
  {
    kind: 'phone',
    // +<cc> followed by 2-4 groups; a group may be parenthesised (area/trunk).
    regex: new RegExp(
      `(?<![\\w+])\\+${DIGIT}{1,3}(?:${SEPARATOR}(?:\\(\\s?${DIGIT}{1,5}\\s?\\)|${DIGIT}{2,4})){2,4}(?!${DIGIT})`,
      'gu',
    ),
  },
  // Glued E.164 without separators: +821012345678, +14155552671.
  { kind: 'phone', regex: new RegExp(`(?<![\\w+])\\+${DIGIT}{8,15}(?!${DIGIT})`, 'gu') },
  {
    kind: 'phone',
    // Parenthesised KR prefix: (02), (031), (010), (070), (0505).
    regex: new RegExp(
      `\\(\\s?0(?:1[016789]|2|[3-6][1-5]|50${DIGIT}?|70|80)\\s?\\)${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}(?!${DIGIT})`,
      'gu',
    ),
  },
  // Korean mobile plus 070 VoIP and 080 toll-free ranges.
  {
    kind: 'phone',
    regex: new RegExp(
      `(?<!${DIGIT})(?:01[016789]|070|080)${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}(?!${DIGIT})`,
      'gu',
    ),
  },
  // 050x VoIP ranges (050, 0505, ...).
  {
    kind: 'phone',
    regex: new RegExp(
      `(?<!${DIGIT})050${DIGIT}?${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}(?!${DIGIT})`,
      'gu',
    ),
  },
  // Korean landline: 02, 031-065.
  {
    kind: 'phone',
    regex: new RegExp(
      `(?<!${DIGIT})0(?:2|[3-6][1-5])${SEPARATOR}${DIGIT}{3,4}${SEPARATOR}${DIGIT}{4}(?!${DIGIT})`,
      'gu',
    ),
  },
];

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: RedactionKind;
}

export function redact(text: string): RedactionResult {
  const { normalized, starts, ends } = normalizeWithMap(text);
  const covered = new Uint8Array(normalized.length);
  const spans: Span[] = [];

  for (const { kind, regex } of PATTERNS) {
    const pattern = new RegExp(regex.source, regex.flags);
    let match = pattern.exec(normalized);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      let free = end > start;
      for (let index = start; index < end; index += 1) {
        if (covered[index] === 1) {
          free = false;
          break;
        }
      }
      if (free) {
        for (let index = start; index < end; index += 1) covered[index] = 1;
        const originalStart = starts[start];
        const originalEnd = ends[end - 1];
        if (originalStart !== undefined && originalEnd !== undefined) {
          spans.push({ start: originalStart, end: originalEnd, kind });
        }
      }
      match = pattern.exec(normalized);
    }
  }

  const counts = new Map<RedactionKind, number>();
  let output = text;
  spans.sort((left, right) => right.start - left.start || right.end - left.end);
  let acceptedStart = text.length + 1;
  for (const span of spans) {
    if (span.end > acceptedStart) continue;
    acceptedStart = span.start;
    counts.set(span.kind, (counts.get(span.kind) ?? 0) + 1);
    output = output.slice(0, span.start) + MASKS[span.kind] + output.slice(span.end);
  }

  const report: RedactionCount[] = [];
  for (const kind of REPORT_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0) report.push({ kind, count });
  }

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
