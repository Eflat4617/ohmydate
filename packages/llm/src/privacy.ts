/**
 * Privacy filter (05 §12) and untrusted-document wrapper (05 §9).
 *
 * `redact` never returns or reports the original secret values: the report contains only
 * the kind and a count. Masking happens before any text is sent to a provider or logged.
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

interface Pattern {
  readonly kind: RedactionKind;
  readonly regex: RegExp;
}

// Order matters: redact the widest/most specific tokens first so a later pattern never
// re-matches part of a mask. The email rule is bounded ({1,64} local part, bounded labels)
// to avoid quadratic backtracking on long non-matching input. RRN must run before phones.
// Separators intentionally include dot, ASCII whitespace/hyphen and the Unicode dash range
// (figure dash, hyphen, non-breaking hyphen, en dash, em dash) used in pasted documents.
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'email',
    regex:
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?){1,4}(?![A-Za-z0-9-])/g,
  },
  { kind: 'api_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'api_key', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'api_key', regex: /\b(?:sk|tk|pk)[-_][A-Za-z0-9_-]{8,}\b/g },
  { kind: 'rrn', regex: /\b\d{6}[- ]?[1-8]\d{6}\b/g },
  {
    kind: 'phone',
    // +<cc> followed by 2-4 groups with optional separators and an optional "(0)" trunk
    // prefix, e.g. "+82 10-1234-5678", "+82-10-...", "+82 (0)10-...", "+1 415 555 2671".
    regex:
      /(?<![\w+])\+\d{1,3}(?:[.\s\-\u2010-\u2015]{0,2}(?:\(\s?0\s?\)|0)?[.\s\-\u2010-\u2015]{0,2}\d{2,4}){2,4}(?!\d)/g,
  },
  // Glued E.164 without separators: +821012345678, +14155552671.
  { kind: 'phone', regex: /(?<![\w+])\+\d{8,15}(?!\d)/g },
  // Parenthesised Korean area code: (02) 123-4567, (031) 123-4567.
  {
    kind: 'phone',
    regex:
      /\(\s?0(?:2|[3-6][1-5])\s?\)[.\s\-\u2010-\u2015]?\d{3,4}[.\s\-\u2010-\u2015]?\d{4}(?!\d)/g,
  },
  // Korean mobile plus 070 VoIP and 080 toll-free ranges.
  {
    kind: 'phone',
    regex:
      /(?<!\d)(?:01[016789]|070|080)[.\s\-\u2010-\u2015]?\d{3,4}[.\s\-\u2010-\u2015]?\d{4}(?!\d)/g,
  },
  // 050x VoIP ranges (050, 0505, ...).
  {
    kind: 'phone',
    regex:
      /(?<!\d)050\d?[.\s\-\u2010-\u2015]?\d{3,4}[.\s\-\u2010-\u2015]?\d{4}(?!\d)/g,
  },
  // Korean landline: 02, 031-065.
  {
    kind: 'phone',
    regex:
      /(?<!\d)0(?:2|[3-6][1-5])[.\s\-\u2010-\u2015]?\d{3,4}[.\s\-\u2010-\u2015]?\d{4}(?!\d)/g,
  },
];

export function redact(text: string): RedactionResult {
  const counts = new Map<RedactionKind, number>();
  let output = text;

  for (const { kind, regex } of PATTERNS) {
    const pattern = new RegExp(regex.source, regex.flags);
    output = output.replace(pattern, () => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return MASKS[kind];
    });
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
