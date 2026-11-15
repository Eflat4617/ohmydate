import openapi from '../../../packages/contracts/openapi.json';
import {
  RENDERED_DIVERSITY_NOTE_CODES,
  diversityNoteItemsText,
  type DiversityNoteCode,
  type DiversityNoteItem,
} from '../src/i18n/diversity';

const HANGUL = /[가-힣]/;

/** One realistic params object per contract code (exhaustive by type). */
const SAMPLES: { readonly [C in DiversityNoteCode]: DiversityNoteItem['params'] } = {
  diversity_dropped: { kept: 2, total: 3, dropped: 1 },
  diversity_distinct: { total: 3 },
  replan_bound_exceeded: { changedBlocks: 6, bound: 4, affectedExistingBlocks: 1 },
};

function contractCodes(): DiversityNoteCode[] {
  const schema = (openapi as unknown as {
    components: { schemas: { DiversityNoteItem: { properties: { code: { anyOf: { const: string }[] } } } } };
  }).components.schemas.DiversityNoteItem;
  return schema.properties.code.anyOf.map((entry) => entry.const as DiversityNoteCode);
}

function item(code: DiversityNoteCode): DiversityNoteItem {
  return { code, params: SAMPLES[code] };
}

describe('diversity note code catalog (FU-68)', () => {
  it('has a Korean renderer for exactly the contract enum', () => {
    const codes = contractCodes();
    expect(codes.length).toBeGreaterThan(0);
    expect([...RENDERED_DIVERSITY_NOTE_CODES].sort()).toEqual([...codes].sort());
    expect(Object.keys(SAMPLES).sort()).toEqual([...codes].sort());
  });

  it('renders every code as Korean and joins sentences with a space', () => {
    for (const code of RENDERED_DIVERSITY_NOTE_CODES) {
      const text = diversityNoteItemsText([item(code)]);
      expect(text, code).not.toBeNull();
      expect(HANGUL.test(text ?? ''), `${code} → ${text}`).toBe(true);
      expect(text, code).not.toMatch(/[{}]/);
    }
    expect(
      diversityNoteItemsText([item('diversity_distinct'), item('replan_bound_exceeded')]),
    ).toBe(
      '일정안 3개가 모두 서로 충분히 달라요. 바뀐 블록이 6개로, 변경 상한 4개(영향받은 기존 블록 1개 × 2 + 2)를 넘어요. 영향받지 않은 블록은 그대로 두었고, 이 안이 그중 가장 나아요.',
    );
  });

  it('falls back (null) for legacy or malformed items (negative)', () => {
    expect(diversityNoteItemsText(undefined)).toBeNull();
    expect(diversityNoteItemsText([])).toBeNull();
    expect(
      diversityNoteItemsText([{ code: 'free_text', params: {} } as unknown as DiversityNoteItem]),
    ).toBeNull();
    expect(
      diversityNoteItemsText([{ code: 'diversity_distinct', params: { total: '3' } } as unknown as DiversityNoteItem]),
    ).toBeNull();
  });
});
