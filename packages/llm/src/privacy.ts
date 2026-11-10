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
// re-matches part of a mask. RRN must run before the phone rules.
const PATTERNS: readonly Pattern[] = [
  { kind: 'api_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'api_key', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'api_key', regex: /\b(?:sk|tk|pk)[-_][A-Za-z0-9_-]{8,}\b/g },
  { kind: 'rrn', regex: /\b\d{6}[- ]?[1-8]\d{6}\b/g },
  { kind: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'phone', regex: /(?<!\w)\+\d{8,15}\b/g },
  { kind: 'phone', regex: /\b01[016789][- ]?\d{3,4}[- ]?\d{4}\b/g },
  { kind: 'phone', regex: /\b0(?:2|[3-6][1-5])[- ]?\d{3,4}[- ]?\d{4}\b/g },
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

function escapeClosingTag(text: string): string {
  return text.replace(/<\/untrusted_document/gi, '&lt;/untrusted_document');
}

/**
 * Wrap external/notes text so the prompt can state that everything inside is data.
 * Closing tags inside the content are neutralised to prevent wrapper escape.
 */
export function buildUntrustedBlock(id: string, text: string): string {
  return `<untrusted_document id="${sanitizeId(id)}">\n${escapeClosingTag(text)}\n</untrusted_document>`;
}
