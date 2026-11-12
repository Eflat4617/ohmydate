import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiversityNoteItem, GenerateResult, ScheduleInput } from '../src/index.js';
import { DIVERSITY_NOTE_CODES, generate } from '../src/index.js';
import {
  MAX_DIVERSITY_NOTE_LENGTH,
  appendBoundDiversityLines,
} from '../src/generate.js';

/**
 * FU-68: every English `diversityNote` sentence has a closed coded item, and
 * the two forms say the same thing. The oracle is typed against the closed
 * code map, so a new code without an English template is a typecheck error.
 */
function expectedText(item: DiversityNoteItem): string {
  switch (item.code) {
    case 'diversity_dropped':
      return `${item.params.kept} distinct plan(s) from ${item.params.total} policy candidate(s); ${item.params.dropped} candidate(s) dropped as too similar (distance < 0.15).`;
    case 'diversity_distinct':
      // Kept candidates equal the input candidates in this branch.
      return `${item.params.total} distinct plans from ${item.params.total} policy candidates (pairwise distance >= 0.15).`;
    case 'replan_bound_exceeded':
      return `Replan change bound exceeded: ${item.params.changedBlocks} changed block(s) > ${item.params.bound} (2 × ${item.params.affectedExistingBlocks} affected existing block(s) + 2). Unaffected blocks were preserved; this candidate is the best available.`;
  }
}

const CODES = new Set<string>(DIVERSITY_NOTE_CODES);

function expectCodedDiversityNote(result: GenerateResult): void {
  const note = result.diversityNote;
  if (note === undefined) {
    expect(result.diversityNoteItems).toBeUndefined();
    return;
  }
  const items = result.diversityNoteItems;
  expect(items, note).toBeDefined();
  if (items === undefined) return;
  expect(items.length).toBeGreaterThan(0);
  const rendered = items.map((item, index) => {
    expect(CODES.has(item.code), `unknown diversity code ${item.code}`).toBe(true);
    for (const [key, value] of Object.entries(item.params)) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(item.code, `item ${String(index)}`).toBeDefined();
    return expectedText(item);
  });
  expect(rendered.join(' ')).toBe(note);
}

const DAY_RULES = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
  weekday,
  startLocal: '09:00',
  endLocal: '17:00',
  kind: 'work' as const,
}));

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'UTC',
    horizon: { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' },
    tasks: [
      {
        id: 'A',
        dueAt: '2026-11-11T17:00:00Z',
        estimate: { p50Min: 60, p90Min: 60 },
        splittable: true,
        minSessionMin: 30,
        maxSessionMin: 120,
        priority: 1,
        dependsOn: [],
      },
    ],
    availability: DAY_RULES,
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 7,
    ...overrides,
  };
}

function goldenInputs(): ScheduleInput[] {
  const directory = fileURLToPath(new URL('./golden', import.meta.url));
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
        input: ScheduleInput;
      };
      return fixture.input;
    });
}

const REPLAN_BOUND_INPUT = input({
  availability: ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
    weekday,
    startLocal: '00:00',
    endLocal: '24:00',
    kind: 'work' as const,
  })),
  tasks: [
    {
      id: 'A',
      estimate: { p50Min: 150, p90Min: 150 },
      splittable: true,
      minSessionMin: 30,
      maxSessionMin: 30,
      priority: 1,
      dependsOn: [],
    },
  ],
  existingBlocks: [
    { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T02:00:00Z' },
  ],
});

const MULTI_REPLAN_INPUT = input({
  horizon: { start: '2026-11-09T00:00:00Z', end: '2026-11-23T00:00:00Z' },
  availability: ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
    weekday,
    startLocal: '00:00',
    endLocal: '24:00',
    kind: 'work' as const,
  })),
  tasks: Array.from({ length: 5 }, (_, index) => ({
    id: `T${index}`,
    estimate: { p50Min: 150 + 30 * index, p90Min: 150 + 30 * index },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 30,
    priority: 1,
    dependsOn: [],
  })),
  existingBlocks: Array.from({ length: 5 }, (_, index) => ({
    taskId: `T${index}`,
    start: `2026-11-09T0${index}:00:00Z`,
    end: `2026-11-09T0${index}:30:00Z`,
  })),
});

describe('diversity note codes (FU-68)', () => {
  it('publishes a duplicate-free closed code list', () => {
    expect(new Set(DIVERSITY_NOTE_CODES).size).toBe(DIVERSITY_NOTE_CODES.length);
    expect([...DIVERSITY_NOTE_CODES].sort()).toEqual([
      'diversity_distinct',
      'diversity_dropped',
      'replan_bound_exceeded',
    ]);
  });

  it('codes every diversity note the generator emits, including the replan-bound sentence', () => {
    const seen = new Set<string>();
    const results = [
      ...goldenInputs().map((fixture) => generate(fixture)),
      generate(input()),
      generate(REPLAN_BOUND_INPUT),
      generate(MULTI_REPLAN_INPUT),
    ];
    for (const result of results) {
      expectCodedDiversityNote(result);
      expect((result.diversityNote ?? '').length).toBeLessThanOrEqual(MAX_DIVERSITY_NOTE_LENGTH);
      for (const item of result.diversityNoteItems ?? []) seen.add(item.code);
    }
    expect(seen.has('diversity_dropped') || seen.has('diversity_distinct')).toBe(true);
    expect(seen.has('replan_bound_exceeded')).toBe(true);
  }, 30_000);

  it('reaches each of the three codes on its own fixture', () => {
    // A history with no replan bounds produces the plain diversity sentence.
    const dropped = generate(input());
    expect(dropped.diversityNoteItems?.map((item) => item.code)).toEqual(['diversity_dropped']);
    expectCodedDiversityNote(dropped);

    // A multi-task replan keeps three genuinely distinct policy plans.
    const distinct = generate(MULTI_REPLAN_INPUT);
    expect(distinct.diversityNoteItems?.map((item) => item.code)).toEqual([
      'diversity_distinct',
      'replan_bound_exceeded',
    ]);
    expect(distinct.diversityNote).toMatch(/^3 distinct plans from 3 policy candidates/);
    expectCodedDiversityNote(distinct);

    // A single policy can produce a note that is only the bound sentence.
    const bounded = generate(REPLAN_BOUND_INPUT, { policies: ['balanced'] });
    expect(bounded.diversityNoteItems?.map((item) => item.code)).toEqual(['replan_bound_exceeded']);
    expect(bounded.diversityNote).toMatch(/^Replan change bound exceeded:/);
    expectCodedDiversityNote(bounded);
  }, 30_000);

  it('caps a joined note at 500 characters and drops text with its item', () => {
    const baseNote = '3 distinct plans from 3 policy candidates (pairwise distance >= 0.15).';
    const boundText = (changedBlocks: number) =>
      `Replan change bound exceeded: ${changedBlocks} changed block(s) > 6 (2 × 2 affected existing block(s) + 2). Unaffected blocks were preserved; this candidate is the best available.`;
    const boundItem = (changedBlocks: number): DiversityNoteItem => ({
      code: 'replan_bound_exceeded',
      params: { changedBlocks, bound: 6, affectedExistingBlocks: 2 },
    });
    const boundLines = new Map<string, DiversityNoteItem>([
      [boundText(31), boundItem(31)],
      [boundText(33), boundItem(33)],
      [boundText(35), boundItem(35)],
    ]);

    const composed = appendBoundDiversityLines(baseNote, [], boundLines);
    expect(composed.note).toBeDefined();
    expect(composed.note!.length).toBeLessThanOrEqual(MAX_DIVERSITY_NOTE_LENGTH);
    // At least one of the three sentences had to be dropped to fit.
    expect(composed.items.length).toBeLessThan(3);
    expect(composed.items.length).toBeGreaterThan(0);
    // Every surviving sentence still has its item, in order.
    const sentences = composed.note!
      .slice(baseNote.length + 1)
      .split(/(?=Replan change bound exceeded: )/);
    expect(composed.note!.startsWith(baseNote)).toBe(true);
    expect(sentences).toHaveLength(composed.items.length);
    sentences.forEach((sentence, index) => {
      const item = composed.items[index]!;
      if (item.code !== 'replan_bound_exceeded') throw new Error(`unexpected code ${item.code}`);
      expect(sentence.trim()).toBe(boundText(item.params.changedBlocks));
    });

    // A bound line without a coded item keeps its English text (legacy fallback).
    const legacy = appendBoundDiversityLines(
      'base note',
      [],
      new Map([[boundText(31), undefined]]),
    );
    expect(legacy.note).toBe(`base note ${boundText(31)}`);
    expect(legacy.items).toEqual([]);
  });

  it('detects a missing or mislabelled item (negative)', () => {
    const result = generate(REPLAN_BOUND_INPUT);
    const items = result.diversityNoteItems ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(() =>
      expectCodedDiversityNote({ ...result, diversityNoteItems: items.slice(1) }),
    ).toThrow();
    expect(() =>
      expectCodedDiversityNote({
        ...result,
        diversityNoteItems: items.map((item) => item.code === 'replan_bound_exceeded'
          ? { code: 'diversity_distinct', params: { total: 0 } }
          : item),
      }),
    ).toThrow();
  });

  it('makes unknown codes impossible by type (negative)', () => {
    // @ts-expect-error — a code outside the closed diversity enum is not valid.
    const unknown: DiversityNoteItem = { code: 'free_text', params: {} };
    // @ts-expect-error — a task title is not a diversity-note parameter.
    const titled: DiversityNoteItem = { code: 'diversity_dropped', params: { kept: 1, total: 2, dropped: 1, title: '보고서' } };
    expect(CODES.has(unknown.code)).toBe(false);
    expect(titled.code).toBe('diversity_dropped');
  });
});
