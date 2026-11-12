import {
  DIVERSITY_NOTE_CODES,
  EXPLANATION_CODES,
  EXPLANATION_PARAM_TOKEN_PATTERN,
  type DiversityNoteItem,
  type ExplanationItem,
  type ExplanationParams,
} from '@ohmydate/contracts';

/**
 * Persistence helpers for coded explanations (FU-62).
 *
 * Rows written before FU-62 hold only the English lines; they parse to
 * `explanationItems: []` so clients fall back to the original text. Coded
 * items are all-or-nothing: if any stored item is unknown or malformed, or the
 * item count differs from the line count, no items are returned, because a
 * partial list could not be paired with `explanation[i]` any more.
 */

const CODES: ReadonlySet<string> = new Set(EXPLANATION_CODES);
const DIVERSITY_CODES: ReadonlySet<string> = new Set(DIVERSITY_NOTE_CODES);
const PARAM_KEY = /^[a-z][A-Za-z0-9]{0,39}$/;
const PARAM_TOKEN = new RegExp(EXPLANATION_PARAM_TOKEN_PATTERN);
const MAX_PARAMS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseParams(value: unknown): ExplanationParams | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAMS) return null;
  const params: ExplanationParams = {};
  for (const [key, entry] of entries) {
    if (!PARAM_KEY.test(key)) return null;
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      params[key] = entry;
    } else if (typeof entry === 'string' && PARAM_TOKEN.test(entry)) {
      params[key] = entry;
    } else {
      return null;
    }
  }
  return params;
}

function parseItem(value: unknown): ExplanationItem | null {
  if (!isRecord(value)) return null;
  const code = value['code'];
  if (typeof code !== 'string' || !CODES.has(code)) return null;
  const params = parseParams(value['params']);
  if (params === null) return null;
  return { code: code as ExplanationItem['code'], params };
}

/** Validated coded items paired with `lineCount` English lines, or `[]`. */
export function parseExplanationItems(value: unknown, lineCount: number): ExplanationItem[] {
  if (!Array.isArray(value) || value.length !== lineCount) return [];
  const items: ExplanationItem[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (item === null) return [];
    items.push(item);
  }
  return items;
}

function parseDiversityItem(value: unknown): DiversityNoteItem | null {
  if (!isRecord(value)) return null;
  const code = value['code'];
  if (typeof code !== 'string' || !DIVERSITY_CODES.has(code)) return null;
  const params = parseParams(value['params']);
  if (params === null) return null;
  return { code: code as DiversityNoteItem['code'], params };
}

/** Validated diversity-note items, or `[]` when absent/legacy/all-or-nothing fails. */
export function parseDiversityNoteItems(value: unknown): DiversityNoteItem[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const items: DiversityNoteItem[] = [];
  for (const entry of value) {
    const item = parseDiversityItem(entry);
    if (item === null) return [];
    items.push(item);
  }
  return items;
}

/** JSON copy of coded items for a jsonb payload. */
export function explanationItemsJson(items: readonly ExplanationItem[]): unknown[] {
  return items.map((item) => ({ code: item.code, params: { ...item.params } }));
}

export function diversityNoteItemsJson(items: readonly DiversityNoteItem[]): unknown[] {
  return items.map((item) => ({ code: item.code, params: { ...item.params } }));
}

/**
 * `plan_candidate.explanation` keeps its pre-FU-62 shape (an array of English
 * lines, which is what older readers filter for) and appends one trailing
 * `{ items: [...] }` object with the coded form. Rolling back to a reader that
 * predates FU-62 therefore keeps every line.
 */
export function candidateExplanationJson(
  explanation: readonly string[],
  items: readonly ExplanationItem[],
  diversityNoteItems: readonly DiversityNoteItem[] = [],
): unknown[] {
  if (items.length === 0 && diversityNoteItems.length === 0) return [...explanation];
  const coded: Record<string, unknown> = {};
  if (items.length > 0) coded['items'] = explanationItemsJson(items);
  if (diversityNoteItems.length > 0) {
    coded['diversityNoteItems'] = diversityNoteItemsJson(diversityNoteItems);
  }
  return [...explanation, coded];
}

export function parseCandidateExplanation(value: unknown): {
  explanation: string[];
  explanationItems: ExplanationItem[];
  diversityNoteItems: DiversityNoteItem[];
} {
  if (!Array.isArray(value)) {
    return { explanation: [], explanationItems: [], diversityNoteItems: [] };
  }
  const explanation = value.filter((entry): entry is string => typeof entry === 'string');
  // Keep accepting the pre-FU-68 single-key object and any future object that
  // carries only diversity items.
  const coded = value.filter(isRecord);
  const envelope = coded.length === 1 ? coded[0] : undefined;
  return {
    explanation,
    explanationItems: parseExplanationItems(envelope?.['items'], explanation.length),
    diversityNoteItems: parseDiversityNoteItems(envelope?.['diversityNoteItems']),
  };
}
