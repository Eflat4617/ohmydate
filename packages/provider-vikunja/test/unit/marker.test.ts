import { isUuidV7, type Id } from '@ohmydate/domain';
import { appendMarker, extractMarker, stripMarker } from '../../src/marker.js';

const ID = '0190a000-0000-7000-8000-000000000001' as Id;

describe('orphan recovery marker', () => {
  test('appends the planner UUID to an existing description', () => {
    const marked = appendMarker('Plan the week', ID);
    expect(marked).toBe('Plan the week\n\n<!-- ohmydate:' + ID + ' -->');
    expect(stripMarker(marked)).toBe('Plan the week');
  });

  test('stores only the marker when there is no description', () => {
    const marked = appendMarker(undefined, ID);
    expect(marked).toBe('<!-- ohmydate:' + ID + ' -->');
    expect(stripMarker(marked)).toBeUndefined();
  });

  test('round-trips descriptions containing marker-like text', () => {
    const description = 'Literal <!-- not a marker --> text';
    expect(stripMarker(appendMarker(description, ID))).toBe(description);
  });

  test('extracts the marker for orphan reconciliation', () => {
    const marker = extractMarker(appendMarker('desc', ID));
    expect(marker).toBe(ID);
    expect(isUuidV7(marker)).toBe(true);
    expect(extractMarker('no marker here')).toBeNull();
    expect(extractMarker('<!-- ohmydate:not-a-uuid -->')).toBeNull();
  });
});
