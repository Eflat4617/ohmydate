import type { components } from '../api/schema';
import { formatNumber } from './format';
import { t } from './index';

/**
 * Korean text for the scheduler's coded diversity notes (FU-68). The server
 * keeps the English `diversityNote` for logs and legacy rows; the screen
 * renders `diversityNoteItems` instead. A missing, unknown or ill-typed item
 * yields `null`, so the caller falls back to `diversityNoteText` (and finally
 * to the original English text).
 */

export type DiversityNoteItem = components['schemas']['DiversityNoteItem'];
export type DiversityNoteCode = DiversityNoteItem['code'];
type Params = DiversityNoteItem['params'];

class ParamReader {
  valid = true;

  constructor(private readonly params: Params) {}

  count(key: string): string {
    const value = this.params[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.valid = false;
      return '0';
    }
    return formatNumber(value);
  }
}

type Renderer = (read: ParamReader) => string;

const RENDERERS: { readonly [C in DiversityNoteCode]: Renderer } = {
  diversity_dropped: (r) =>
    t('plan.diversity.dropped', {
      kept: r.count('kept'),
      total: r.count('total'),
      dropped: r.count('dropped'),
    }),
  diversity_distinct: (r) => t('plan.diversity.distinct', { total: r.count('total') }),
  replan_bound_exceeded: (r) =>
    t('explain.replan_bound_exceeded', {
      changed: r.count('changedBlocks'),
      bound: r.count('bound'),
      affected: r.count('affectedExistingBlocks'),
    }),
};

/** Every code this build renders (for catalog-completeness tests). */
export const RENDERED_DIVERSITY_NOTE_CODES: readonly DiversityNoteCode[] = Object.keys(
  RENDERERS,
) as DiversityNoteCode[];

/**
 * Join coded note sentences with a space. Returns `null` when there is nothing
 * coded (legacy row) or when any item is unknown/malformed.
 */
export function diversityNoteItemsText(
  items: readonly DiversityNoteItem[] | undefined,
): string | null {
  if (items === undefined || items.length === 0) return null;
  const parts: string[] = [];
  for (const item of items) {
    if (!Object.prototype.hasOwnProperty.call(RENDERERS, item.code)) return null;
    const reader = new ParamReader(item.params);
    const text = RENDERERS[item.code](reader);
    if (!reader.valid) return null;
    parts.push(text);
  }
  return parts.join(' ');
}
