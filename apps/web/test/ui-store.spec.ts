import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../src/stores/ui';

describe('conflict suppression counter', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('stays suppressed until every owning dialog has closed', () => {
    const ui = useUiStore();
    expect(ui.conflictOpen).toBe(false);

    ui.openConflict();
    ui.openConflict();
    expect(ui.conflictOpen).toBe(true);

    ui.closeConflict();
    expect(ui.conflictOpen).toBe(true);

    ui.closeConflict();
    expect(ui.conflictOpen).toBe(false);

    ui.closeConflict();
    expect(ui.conflictOpen).toBe(false);
  });
});
