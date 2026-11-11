/**
 * Notes (ContextDocument) domain rules (04 §3, 07 §7, M6-01).
 *
 * Notes are planner-owned Markdown knowledge. They are never synced to the
 * task provider; the only bridge is a one-time "promote the task description
 * to a note" copy. Everything here is pure: no I/O, no clock, no Node APIs.
 */

import type { Id, Instant, Version } from '../brand.js';
import type { ValidationIssue } from '../errors.js';

export const LINK_TARGET_KINDS = ['goal', 'project', 'task'] as const;
export type LinkTargetKind = (typeof LINK_TARGET_KINDS)[number];

/** 04 §1: P1 = personal schedule data, P2 = note bodies/attachments (default). */
export const NOTE_SENSITIVITIES = ['P1', 'P2'] as const;
export type NoteSensitivity = (typeof NOTE_SENSITIVITIES)[number];

export const NOTE_SOURCES = ['manual', 'task_description'] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

/** Title limit in Unicode code points. */
export const MAX_NOTE_TITLE_LENGTH = 200;
/**
 * Body limit in Unicode code points. 65 536 code points are at most 262 144
 * UTF-8 bytes, which is the database CHECK (`octet_length(body_md)`), so the
 * contract limit always fits the column constraint.
 */
export const MAX_NOTE_BODY_LENGTH = 65_536;
export const MAX_NOTE_BODY_BYTES = 262_144;
/** Upper bound on links per note; keeps context assembly bounded. */
export const MAX_LINKS_PER_NOTE = 50;

export interface DocumentLink {
  readonly id: Id;
  readonly documentId: Id;
  readonly targetKind: LinkTargetKind;
  readonly targetId: Id;
  readonly createdAt: Instant;
}

export interface ContextDocument {
  readonly id: Id;
  readonly ownerId: Id;
  readonly title: string;
  /** Raw Markdown exactly as stored; never rendered to HTML by the API. */
  readonly bodyMd: string;
  readonly sensitivity: NoteSensitivity;
  /** Explicit per-note opt-in for LLM context (default false, 05 §12). */
  readonly llmAllowed: boolean;
  readonly source: NoteSource;
  readonly sourceTaskId?: Id;
  readonly links: readonly DocumentLink[];
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly deletedAt?: Instant;
}

export function isLinkTargetKind(value: unknown): value is LinkTargetKind {
  return typeof value === 'string' && (LINK_TARGET_KINDS as readonly string[]).includes(value);
}

function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // A high surrogate followed by a low surrogate is one code point.
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    length += 1;
  }
  return length;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * PostgreSQL `text` cannot store U+0000; reject it as a validation error
 * instead of letting the driver fail with a 500.
 */
const NUL = '\u0000';

/**
 * Validate the user-editable note fields. `undefined` fields are not checked
 * (PATCH semantics); the caller decides which fields are required.
 */
export function validateNoteContent(input: {
  readonly title?: string;
  readonly bodyMd?: string;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length === 0) {
      issues.push({ path: '/title', message: 'title must not be blank' });
    } else if (codePointLength(input.title) > MAX_NOTE_TITLE_LENGTH) {
      issues.push({
        path: '/title',
        message: `title must be at most ${MAX_NOTE_TITLE_LENGTH} characters`,
      });
    }
    if (input.title.includes(NUL)) {
      issues.push({ path: '/title', message: 'title must not contain NUL characters' });
    }
  }
  if (input.bodyMd !== undefined) {
    if (codePointLength(input.bodyMd) > MAX_NOTE_BODY_LENGTH) {
      issues.push({
        path: '/bodyMd',
        message: `bodyMd must be at most ${MAX_NOTE_BODY_LENGTH} characters`,
      });
    } else if (utf8Length(input.bodyMd) > MAX_NOTE_BODY_BYTES) {
      issues.push({
        path: '/bodyMd',
        message: `bodyMd must be at most ${MAX_NOTE_BODY_BYTES} UTF-8 bytes`,
      });
    }
    if (input.bodyMd.includes(NUL)) {
      issues.push({ path: '/bodyMd', message: 'bodyMd must not contain NUL characters' });
    }
  }
  return issues;
}

/** Truncate to at most `max` code points without splitting a surrogate pair. */
export function truncateCodePoints(value: string, max: number): string {
  if (max <= 0) return '';
  let count = 0;
  let end = 0;
  for (const char of value) {
    if (count === max) return value.slice(0, end);
    count += 1;
    end += char.length;
  }
  return value;
}

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Elements whose content is never user-visible text. */
const DROP_CONTENT_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript']);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

interface TagToken {
  readonly name: string;
  readonly closing: boolean;
  readonly end: number;
}

/** Parse `<name ...>` / `</name>` starting at `start`; null when it is not a tag. */
function readTag(html: string, start: number): TagToken | null {
  let index = start + 1;
  let closing = false;
  if (html[index] === '/') {
    closing = true;
    index += 1;
  }
  const nameStart = index;
  while (index < html.length && /[A-Za-z0-9]/.test(html[index] as string)) index += 1;
  if (index === nameStart) return null;
  const name = html.slice(nameStart, index).toLowerCase();
  // Skip attributes, honouring quoted values so a quoted ">" does not end the tag.
  let quote: string | null = null;
  while (index < html.length) {
    const char = html[index] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return { name, closing, end: index + 1 };
    }
    index += 1;
  }
  // Unterminated tag: drop the rest (never emit a partial tag).
  return { name, closing, end: html.length };
}

/**
 * 07 §7 "promote task description to note": convert the provider description
 * (Vikunja stores editor HTML) into plain Markdown text once.
 *
 * Guarantees: the result contains no `<` at all (any literal `<` left after
 * tag removal or entity decoding is re-escaped as `&lt;`), so the API never
 * returns HTML from a promoted note; Markdown renderers still display `&lt;`
 * as `<`. Script/style content is dropped; comments and processing
 * instructions are removed; block elements become line breaks and list items
 * become `- ` bullets.
 */
export function taskDescriptionToMarkdown(description: string): string {
  const out: string[] = [];
  let index = 0;
  let dropUntil: string | null = null;
  const html = description.replace(/\r\n?/g, '\n');
  while (index < html.length) {
    const char = html[index] as string;
    if (char !== '<') {
      if (dropUntil === null) out.push(char);
      index += 1;
      continue;
    }
    if (html.startsWith('<!--', index)) {
      const close = html.indexOf('-->', index + 4);
      index = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html[index + 1] === '!' || html[index + 1] === '?') {
      const close = html.indexOf('>', index + 2);
      index = close < 0 ? html.length : close + 1;
      continue;
    }
    const tag = readTag(html, index);
    if (tag === null) {
      if (dropUntil === null) out.push('&lt;');
      index += 1;
      continue;
    }
    index = tag.end;
    if (dropUntil !== null) {
      if (tag.closing && tag.name === dropUntil) dropUntil = null;
      continue;
    }
    if (!tag.closing && DROP_CONTENT_TAGS.has(tag.name)) {
      dropUntil = tag.name;
      continue;
    }
    if (/^h[1-6]$/.test(tag.name)) {
      out.push(tag.closing ? '\n\n' : `\n\n${'#'.repeat(Number(tag.name[1]))} `);
      continue;
    }
    if (tag.name === 'li') {
      // The next item (or the closing list tag) supplies the line break.
      if (!tag.closing) out.push('\n- ');
      continue;
    }
    if (BLOCK_TAGS.has(tag.name)) out.push('\n');
  }
  const decoded = decodeEntities(out.join('')).replace(/</g, '&lt;');
  return decoded
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
