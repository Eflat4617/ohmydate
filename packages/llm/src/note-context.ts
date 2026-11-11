/**
 * Note-grounded LLM context (M6-01; 05 §9 injection defense, §10 memory, §12 privacy).
 *
 * Pipeline per call, all deterministic and free of I/O:
 *
 * 1. Eligibility (defense in depth on top of the store query): only documents of the
 *    requesting owner, not deleted, with `llmAllowed === true`.
 * 2. ADR-019 redaction over the WHOLE title and body before splitting, so a value that
 *    spans a paragraph break is still masked exactly as the scanner sees it.
 * 3. Sections: fence-aware paragraphs, each carrying its nearest heading.
 * 4. Sanitising: HTML comments (invisible when rendered) are dropped, default-ignorable code points (zero-width, bidi controls, Unicode tag
 *    characters used for "ASCII smuggling") are removed, other control characters become
 *    spaces, and a second redaction pass runs over the sanitised text.
 * 5. Ranking: term overlap with the request text (never sent), ties broken by document
 *    order and section index. A section with no overlap is only eligible as the lead
 *    (first) section of its document. Selection is greedy under a UTF-8 byte budget.
 * 6. Fencing: every selected section becomes its own
 *    `<untrusted_document id="<docId>" section="<n>" hash="<sectionHash>">` block. The
 *    content is XML-escaped (`&`, `<`, `>` and their NFKC look-alikes) and the fence name
 *    itself is neutralised, so document text can never open or close a block.
 *
 * The builder returns ids, hashes and counts for `note_ai_usage` and the agent run's
 * redaction report; the bodies only ever exist inside the returned `blocks`.
 */

import { createHash } from 'node:crypto';
import { assertRedactInputSize, redact, type RedactionCount, type RedactionKind } from './privacy.js';

export interface NoteContextDocument {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly llmAllowed: boolean;
  readonly version: number;
  readonly updatedAt: string;
  readonly deletedAt?: string | null;
}

export interface NoteContextLimits {
  /** Total UTF-8 bytes of selected block contents (pre-escape). */
  readonly byteBudget: number;
  /** Per-section cap; longer sections are truncated at a code-point boundary. */
  readonly maxSectionBytes: number;
  readonly maxSections: number;
  /** Documents considered, in the caller's order. */
  readonly maxDocuments: number;
}

export const DEFAULT_NOTE_CONTEXT_LIMITS: NoteContextLimits = Object.freeze({
  byteBudget: 6_144,
  maxSectionBytes: 1_536,
  maxSections: 12,
  maxDocuments: 10,
});

export const NOTE_CONTEXT_BUILDER_VERSION = 'note-context@1';

export type NoteExclusionReason =
  | 'other_owner'
  | 'not_llm_allowed'
  | 'deleted'
  | 'document_limit'
  | 'no_selected_section';

export interface NoteContextRequest {
  readonly ownerId: string;
  /** Request text used only for ranking (intake title/description...). Never sent. */
  readonly query: string;
  readonly documents: readonly NoteContextDocument[];
  readonly limits?: Partial<NoteContextLimits>;
}

export interface NoteContextSection {
  readonly docId: string;
  readonly index: number;
  readonly sectionHash: string;
  readonly bytes: number;
  readonly score: number;
}

export interface NoteContextDocumentUsage {
  readonly docId: string;
  readonly version: number;
  /** sha256 hex of the stored `bodyMd` at send time (detects later edits). */
  readonly bodyHash: string;
  readonly updatedAt: string;
  readonly sectionHashes: readonly string[];
  readonly sentBytes: number;
}

export interface NoteContextResult {
  readonly version: typeof NOTE_CONTEXT_BUILDER_VERSION;
  /** Fenced blocks in document/section order; the only place note text appears. */
  readonly blocks: readonly string[];
  readonly sections: readonly NoteContextSection[];
  readonly documents: readonly NoteContextDocumentUsage[];
  readonly excluded: readonly { readonly docId: string; readonly reason: NoteExclusionReason }[];
  /** Kinds and counts only (05 §12); never the matched values. */
  readonly redactionReport: Readonly<Partial<Record<RedactionKind, number>>>;
  readonly totalBytes: number;
}

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 16 hex chars (64 bits): unique within one prompt and easy for a model to copy. */
export function sectionHashOf(content: string): string {
  return sha256Hex(content).slice(0, 16);
}

export function bodyHashOf(bodyMd: string): string {
  return sha256Hex(bodyMd);
}

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
// An unterminated comment hides the rest of the document when rendered, so drop it too.
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// C0/C1 controls except tab and newline; U+2028/2029 are normalised to newlines first.
// Matching control characters is the point of this pattern.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Remove invisible characters an attacker can use to hide or smuggle instructions
 * (zero-width joiners/spaces, bidi overrides, U+E0000 tag characters, variation
 * selectors) and normalise line breaks. Visible text is unchanged.
 */
export function sanitizeUntrustedText(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(DEFAULT_IGNORABLE, '')
    .replace(CONTROL, ' ');
}

const FENCE_NAME = /untrusted[\s_\-.]*document/giu;

/**
 * XML-escape untrusted content. `<`/`>` and their NFKC look-alikes (fullwidth and small
 * forms) are escaped, `&` is escaped first so pre-escaped text stays distinguishable, and
 * the fence element name is neutralised so even escaped text cannot imitate a fence.
 */
export function escapeUntrustedContent(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/[<\uFF1C\uFE64]/g, '&lt;')
    .replace(/[>\uFF1E\uFE65]/g, '&gt;')
    .replace(FENCE_NAME, 'quoted-fence-text');
}

const ATTRIBUTE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

function attribute(value: string, name: string): string {
  if (!ATTRIBUTE_VALUE.test(value)) {
    throw new Error(`untrusted document ${name} must match ${ATTRIBUTE_VALUE.source}`);
  }
  return value;
}

/** Build one fenced note block. Attribute values are restricted to a safe charset. */
export function buildNoteBlock(input: {
  readonly docId: string;
  readonly index: number;
  readonly sectionHash: string;
  readonly content: string;
}): string {
  const id = attribute(input.docId, 'id');
  const hash = attribute(input.sectionHash, 'hash');
  const section = attribute(String(input.index), 'section');
  return `<untrusted_document id="${id}" section="${section}" hash="${hash}">\n${escapeUntrustedContent(
    input.content,
  )}\n</untrusted_document>`;
}

export interface NoteSection {
  readonly index: number;
  readonly heading: string | null;
  readonly text: string;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t#]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split Markdown into paragraph sections. Blank lines separate paragraphs except inside
 * fenced code blocks; an ATX heading closes the current paragraph and becomes the heading
 * of the following ones. A heading without a paragraph is its own section.
 */
export function splitNoteSections(bodyMd: string): NoteSection[] {
  const lines = bodyMd.replace(/\r\n?/g, '\n').split('\n');
  const sections: NoteSection[] = [];
  let heading: string | null = null;
  let headingUsed = true;
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length === 0) return;
    sections.push({ index: sections.length, heading, text });
    headingUsed = true;
  };
  const flushHeadingOnly = (): void => {
    if (heading !== null && !headingUsed) {
      sections.push({ index: sections.length, heading, text: '' });
    }
  };

  for (const line of lines) {
    if (fence !== null) {
      buffer.push(line);
      const trimmed = line.trim();
      if (trimmed.startsWith(fence) && trimmed.replace(/[`~]/g, '').length === 0) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      fence = (open[1] as string).slice(0, 3);
      buffer.push(line);
      continue;
    }
    const headingMatch = HEADING.exec(line);
    if (headingMatch !== null) {
      flush();
      flushHeadingOnly();
      heading = (headingMatch[2] ?? '').trim();
      headingUsed = false;
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  flushHeadingOnly();
  return sections;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'was',
  'you',
  'your',
  'from',
  'into',
  'have',
  'has',
  'not',
  'but',
]);

const HANGUL = /\p{Script=Hangul}/u;
const HAN = /\p{Script=Han}/u;
const MAX_TERMS = 4_000;

/** Deterministic term set: NFKC, lower-case, letter/digit tokens, Hangul bigrams. */
export function noteTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const tokens = text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (const token of tokens) {
    if (terms.size >= MAX_TERMS) break;
    if (token.length === 0) continue;
    if (token.length < 2 && !HAN.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    terms.add(token);
    if (HANGUL.test(token)) {
      // Korean has no stemmer here: bigrams let "논문을" overlap with "논문".
      const chars = [...token];
      for (let index = 0; index + 1 < chars.length; index += 1) {
        terms.add(`${chars[index] as string}${chars[index + 1] as string}`);
      }
    }
  }
  return terms;
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const term of small) if (large.has(term)) count += 1;
  return count;
}

function truncateBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const marker = '\n[truncated]';
  const limit = Math.max(0, maxBytes - utf8Bytes(marker));
  let used = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (used + size > limit) break;
    used += size;
    end += char.length;
  }
  return `${text.slice(0, end)}${marker}`;
}

function addReport(target: Map<RedactionKind, number>, report: readonly RedactionCount[]): void {
  for (const entry of report) target.set(entry.kind, (target.get(entry.kind) ?? 0) + entry.count);
}

function resolveLimits(partial: Partial<NoteContextLimits> | undefined): NoteContextLimits {
  const merged = { ...DEFAULT_NOTE_CONTEXT_LIMITS, ...(partial ?? {}) };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`note context limit ${name} must be a positive integer`);
    }
  }
  return merged;
}

interface Candidate {
  readonly docOrder: number;
  readonly doc: NoteContextDocument;
  readonly index: number;
  readonly score: number;
  readonly content: string;
  readonly secondPass: readonly RedactionCount[];
}

export function buildNoteContext(request: NoteContextRequest): NoteContextResult {
  const limits = resolveLimits(request.limits);
  const queryTerms = noteTerms(request.query);
  const excluded: { docId: string; reason: NoteExclusionReason }[] = [];
  const eligible: NoteContextDocument[] = [];
  const seen = new Set<string>();

  for (const doc of request.documents) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    if (doc.ownerId !== request.ownerId) {
      excluded.push({ docId: doc.id, reason: 'other_owner' });
    } else if (doc.deletedAt !== undefined && doc.deletedAt !== null) {
      excluded.push({ docId: doc.id, reason: 'deleted' });
    } else if (doc.llmAllowed !== true) {
      excluded.push({ docId: doc.id, reason: 'not_llm_allowed' });
    } else if (eligible.length >= limits.maxDocuments) {
      excluded.push({ docId: doc.id, reason: 'document_limit' });
    } else {
      eligible.push(doc);
    }
  }

  const firstPass = new Map<string, readonly RedactionCount[]>();
  const candidates: Candidate[] = [];
  eligible.forEach((doc, docOrder) => {
    assertRedactInputSize(doc.title);
    assertRedactInputSize(doc.bodyMd);
    const title = redact(doc.title);
    const body = redact(doc.bodyMd);
    firstPass.set(doc.id, [...title.report, ...body.report]);
    const cleanTitle = sanitizeUntrustedText(title.text).replace(/\s+/g, ' ').trim();
    const titleTerms = noteTerms(cleanTitle);
    const titleScore = overlap(titleTerms, queryTerms);
    // HTML comments are invisible in rendered Markdown; never send hidden text.
    const visibleBody = body.text.replace(HTML_COMMENT, '');
    for (const section of splitNoteSections(visibleBody)) {
      const text = sanitizeUntrustedText(
        section.heading === null
          ? section.text
          : section.text.length === 0
            ? `# ${section.heading}`
            : `# ${section.heading}\n${section.text}`,
      ).trim();
      if (text.length === 0) continue;
      const score = overlap(noteTerms(text), queryTerms) * 2 + titleScore;
      if (score === 0 && section.index !== 0) continue;
      const second = redact(text);
      const raw = `title: ${cleanTitle}\n---\n${second.text}`;
      const content = truncateBytes(raw, limits.maxSectionBytes);
      candidates.push({ docOrder, doc, index: section.index, score, content, secondPass: second.report });
    }
  });

  candidates.sort(
    (left, right) =>
      right.score - left.score || left.docOrder - right.docOrder || left.index - right.index,
  );

  const picked: Candidate[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (picked.length >= limits.maxSections) break;
    const bytes = utf8Bytes(candidate.content);
    if (totalBytes + bytes > limits.byteBudget) continue;
    picked.push(candidate);
    totalBytes += bytes;
  }
  picked.sort((left, right) => left.docOrder - right.docOrder || left.index - right.index);

  const report = new Map<RedactionKind, number>();
  const sections: NoteContextSection[] = [];
  const blocks: string[] = [];
  const usage = new Map<string, { doc: NoteContextDocument; hashes: string[]; bytes: number }>();
  for (const candidate of picked) {
    const sectionHash = sectionHashOf(`${candidate.doc.id}\n${candidate.content}`);
    const bytes = utf8Bytes(candidate.content);
    blocks.push(
      buildNoteBlock({
        docId: candidate.doc.id,
        index: candidate.index,
        sectionHash,
        content: candidate.content,
      }),
    );
    sections.push({
      docId: candidate.doc.id,
      index: candidate.index,
      sectionHash,
      bytes,
      score: candidate.score,
    });
    const entry = usage.get(candidate.doc.id) ?? { doc: candidate.doc, hashes: [], bytes: 0 };
    entry.hashes.push(sectionHash);
    entry.bytes += bytes;
    usage.set(candidate.doc.id, entry);
    addReport(report, candidate.secondPass);
  }
  for (const docId of usage.keys()) addReport(report, firstPass.get(docId) ?? []);
  for (const doc of eligible) {
    if (!usage.has(doc.id)) excluded.push({ docId: doc.id, reason: 'no_selected_section' });
  }

  const documents: NoteContextDocumentUsage[] = [...usage.values()].map((entry) => ({
    docId: entry.doc.id,
    version: entry.doc.version,
    bodyHash: bodyHashOf(entry.doc.bodyMd),
    updatedAt: entry.doc.updatedAt,
    sectionHashes: entry.hashes,
    sentBytes: entry.bytes,
  }));

  const redactionReport: Partial<Record<RedactionKind, number>> = {};
  for (const kind of ['email', 'phone', 'rrn', 'api_key'] as const) {
    const count = report.get(kind);
    if (count !== undefined && count > 0) redactionReport[kind] = count;
  }

  return {
    version: NOTE_CONTEXT_BUILDER_VERSION,
    blocks,
    sections,
    documents,
    excluded,
    redactionReport,
    totalBytes,
  };
}

/** Index of the references a model may legitimately cite for one call. */
export interface GroundingIndex {
  readonly sectionsByDoc: ReadonlyMap<string, ReadonlySet<string>>;
  readonly taskIds?: ReadonlySet<string>;
}

export function groundingIndexOf(
  context: Pick<NoteContextResult, 'sections'>,
  taskIds: readonly string[] = [],
): GroundingIndex {
  const sectionsByDoc = new Map<string, Set<string>>();
  for (const section of context.sections) {
    const set = sectionsByDoc.get(section.docId) ?? new Set<string>();
    set.add(section.sectionHash);
    sectionsByDoc.set(section.docId, set);
  }
  return { sectionsByDoc, taskIds: new Set(taskIds) };
}

export type HallucinatedRefReason = 'unknown_document' | 'unknown_section' | 'unknown_task';

export interface GroundedRefCandidate {
  readonly docId?: string;
  readonly sectionHash?: string;
  readonly taskId?: string;
}

export interface GroundedRefPartition<T> {
  readonly kept: readonly T[];
  readonly removed: readonly { readonly item: T; readonly reason: HallucinatedRefReason }[];
}

/**
 * 05 §9: every reference in model output must exist in the input set. Unknown document,
 * section (a real document but a hash that was not sent) or task references are removed
 * and reported so the caller can record a `hallucinated_ref` event.
 */
export function partitionGroundedRefs<T extends GroundedRefCandidate>(
  items: readonly T[],
  index: GroundingIndex,
): GroundedRefPartition<T> {
  const kept: T[] = [];
  const removed: { item: T; reason: HallucinatedRefReason }[] = [];
  for (const item of items) {
    if (item.docId !== undefined) {
      const sections = index.sectionsByDoc.get(item.docId);
      if (sections === undefined) {
        removed.push({ item, reason: 'unknown_document' });
        continue;
      }
      if (item.sectionHash === undefined || !sections.has(item.sectionHash)) {
        removed.push({ item, reason: 'unknown_section' });
        continue;
      }
    }
    if (item.taskId !== undefined && index.taskIds?.has(item.taskId) !== true) {
      removed.push({ item, reason: 'unknown_task' });
      continue;
    }
    kept.push(item);
  }
  return { kept, removed };
}

const LINK = /\b(?:https?|ftp|file|data|javascript|vbscript|mailto|wss?):\S*|\bwww\.\S+/giu;

/**
 * Note-grounded output must not carry links from untrusted notes into tasks. There is no
 * execution path for URLs or commands at all (no tools, no fetch); this only stops a
 * planted link from being shown as a planner suggestion.
 */
export function neutralizeLinks(text: string): { readonly text: string; readonly removed: number } {
  let removed = 0;
  const output = text.replace(LINK, () => {
    removed += 1;
    return '[link removed]';
  });
  return { text: output, removed };
}
