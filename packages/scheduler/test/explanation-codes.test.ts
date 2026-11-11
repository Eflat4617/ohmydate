import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import type {
  Block,
  ExplanationCode,
  ExplanationItem,
  ExplanationParamMap,
  InputIssue,
  PlanCandidate,
  ScheduleInput,
  Task,
  Violation,
} from '../src/index.js';
import {
  EXPLANATION_CODES,
  INPUT_ISSUE_MESSAGE_CODES,
  POLICIES,
  VIOLATION_MESSAGE_CODES,
  generate,
  validate,
  validateInput,
} from '../src/index.js';

/**
 * FU-62: every explanation line and every validator / input message has a
 * closed code whose params reproduce it. The oracle below is typed against the
 * code map, so adding a code without describing its English template here is
 * a typecheck error; the reachability test then proves each code is emitted.
 */

type Oracle = { [C in ExplanationCode]: (params: ExplanationParamMap[C]) => string | RegExp };

const ANY_QUOTED = '"[^"]*"';

const ORACLE: Oracle = {
  policy_summary: ({ policy, policyVersion }) =>
    `Policy ${policy} v${policyVersion}: ${POLICIES[policy].summary}`,
  placement_summary: (p) =>
    `Placed ${p.placedMin} of ${p.requiredMin} required minutes in ${p.blockCount} movable block(s), retaining ${p.retainedCount} existing block(s).`,
  constraints_satisfied: () => 'All hard constraints H1-H8 satisfied.',
  infeasible_summary: ({ violationCount }) =>
    new RegExp(`^Infeasible with ${violationCount} hard violation\\(s\\): H[0-9A-Za-z_]+(, H[0-9A-Za-z_]+)*\\.$`),
  heuristic_insufficient_available_time: () => 'Heuristic reason: insufficient_available_time.',
  heuristic_no_contiguous_window: () => 'Heuristic reason: no_contiguous_window.',
  heuristic_estimate_not_grid_aligned: () => 'Heuristic reason: estimate_not_grid_aligned.',
  heuristic_estimate_below_grid: () => 'Heuristic reason: estimate_below_grid.',
  heuristic_session_bounds_infeasible: () => 'Heuristic reason: session_bounds_infeasible.',
  unplaced_minutes: ({ deficitMin }) => `Unplaced minutes (H7 shortfall): ${deficitMin} min.`,
  capacity_deficit: ({ capacityDeficitMin }) => `Capacity deficit: ${capacityDeficitMin} min.`,
  replan_bound_exceeded: (p) =>
    `Replan change bound exceeded: ${p.changedBlocks} changed block(s) > ${p.bound} (2 × ${p.affectedExistingBlocks} affected existing block(s) + 2). Unaffected blocks were preserved; this candidate is the best available.`,
  input_rejected: ({ issueCount }) =>
    new RegExp(`^Input rejected before generation: [a-z_]+(, [a-z_]+){${issueCount - 1}}\\.$`),

  input_invalid_time_zone: () => /^Invalid IANA time zone: .*$/,
  input_invalid_horizon_instant: () => 'Horizon contains an invalid instant.',
  input_horizon_not_increasing: () => 'Horizon end must be after horizon start.',
  input_horizon_too_long: ({ maxDays }) =>
    `Horizon spans more than ${maxDays} days, the maximum supported length.`,
  input_invalid_now: () => 'now is not a valid instant.',
  input_duplicate_task: ({ taskId }) => `Task id "${taskId}" is duplicated.`,
  input_invalid_estimate: ({ taskId, maxMin }) =>
    `Task "${taskId}" has an estimate that is not a whole number of minutes between 0 and ${maxMin}.`,
  input_invalid_buffer: ({ taskId, maxMin }) =>
    `Task "${taskId}" has a bufferBeforeDueMin that is not a whole number of minutes between 0 and ${maxMin}.`,
  input_invalid_session_minutes: ({ taskId, maxMin }) =>
    `Task "${taskId}" has a session bound that is not a whole number of minutes between 0 and ${maxMin}.`,
  input_invalid_session_bounds: ({ taskId }) => `Task "${taskId}" has invalid session bounds.`,
  input_invalid_task_window_instant: ({ taskId }) =>
    `Task "${taskId}" contains an invalid window instant.`,
  input_task_window_empty: ({ taskId }) =>
    `Task "${taskId}" has earliestStartAt at or after its due window.`,
  input_invalid_preference: ({ field, maxMin }) =>
    `prefs.${field} must be a whole number of minutes between 0 and ${maxMin}.`,
  input_unknown_dependency: ({ taskId, dependencyId }) =>
    `Task "${taskId}" depends on unknown task "${dependencyId}".`,
  input_dependency_cycle: () => 'Task dependencies contain a cycle.',
  input_invalid_weekday: () => /^Availability weekday .+ is outside 1-7\.$/,
  input_invalid_availability_window: () => /^Availability window .*-.* is invalid\.$/,
  input_invalid_exception_date: () => new RegExp(`^Exception date ${ANY_QUOTED} is invalid\\.$`),
  input_exception_partial_window: () =>
    new RegExp(`^Exception on ${ANY_QUOTED} must have both start and end or neither\\.$`),
  input_invalid_exception_window: () => new RegExp(`^Exception window on ${ANY_QUOTED} is invalid\\.$`),
  input_commitment_invalid_instant: () => 'commitment has an invalid instant.',
  input_commitment_end_before_start: () => 'commitment ends before it starts.',
  input_commitment_too_long: ({ maxDays }) =>
    `Commitment spans more than ${maxDays} days, the maximum supported length.`,
  input_unknown_block_task: ({ taskId }) => `Block references unknown task "${taskId}".`,
  input_invalid_block_instant: ({ taskId }) => `Block for task "${taskId}" has an invalid instant.`,
  input_block_sub_millisecond: ({ taskId }) =>
    `Block for task "${taskId}" has sub-millisecond precision.`,
  input_block_off_grid: ({ taskId }) => `Block for task "${taskId}" is not on the 5-minute grid.`,
  input_block_end_before_start: ({ taskId }) => `Block for task "${taskId}" ends before it starts.`,
  input_block_too_long: ({ taskId, maxDays }) =>
    `Block for task "${taskId}" spans more than ${maxDays} days, the maximum supported length.`,

  h0_unknown_task: ({ taskId }) => `Block references unknown task "${taskId}".`,
  h0_outside_horizon: ({ taskId }) => `Block for task "${taskId}" is outside the planning horizon.`,
  h1_same_task_overlap: ({ taskId }) => `Blocks for task "${taskId}" overlap.`,
  h1_tasks_overlap: ({ taskId, otherTaskId }) =>
    `Blocks for tasks "${taskId}" and "${otherTaskId}" overlap.`,
  h1_commitment_overlap: ({ taskId }) => `Block for task "${taskId}" overlaps a commitment.`,
  h2_outside_availability: ({ taskId }) => `Block for task "${taskId}" is outside availability.`,
  h3_dependency_order: ({ taskId, dependencyId }) =>
    `Task "${taskId}" starts before dependency "${dependencyId}" finishes.`,
  h4_before_earliest_start: ({ taskId }) => `Task "${taskId}" starts before earliestStartAt.`,
  h4_inside_due_buffer: ({ taskId }) => `Task "${taskId}" ends inside its pre-due buffer.`,
  h4_after_due: ({ taskId }) => `Task "${taskId}" ends after its due time.`,
  h5_unsplittable_no_remaining: ({ taskId }) =>
    `Non-splittable task "${taskId}" has no remaining minutes and must not have a block.`,
  h5_unsplittable_required_out_of_bounds: (p) =>
    `Non-splittable task "${p.taskId}" requires ${p.requiredMin} minutes, outside [${p.minSessionMin}, ${p.maxSessionMin}].`,
  h5_unsplittable_single_block: ({ taskId, requiredMin }) =>
    `Non-splittable task "${taskId}" must be one block covering ${requiredMin} minutes.`,
  h5_session_out_of_bounds: (p) =>
    `Task "${p.taskId}" has a ${p.durationMin}-minute session outside [${p.minSessionMin}, ${p.maxSessionMin}].`,
  h6_daily_focus_exceeded: (p) =>
    `Daily focus on ${p.date} is ${p.totalMin} minutes, above ${p.maxDailyFocusMin}.`,
  h6_break_missing: (p) =>
    `Continuous focus starting on ${p.date} exceeds ${p.breakAfterMin} minutes without a ${p.breakMin}-minute break.`,
  h7_deficit: ({ taskId, shortMin }) => `Task "${taskId}" is short by ${shortMin} minutes (deficit).`,
  h7_overallocated: ({ taskId, excessMin }) =>
    `Task "${taskId}" is overallocated by ${excessMin} minutes.`,
  h8_invalid_time_zone: () => /^Invalid IANA time zone: .*$/,
  h8_invalid_horizon: () => 'Horizon contains an invalid instant.',
  h8_invalid_instant: ({ taskId }) => `Block for task "${taskId}" has an invalid instant.`,
  h8_sub_millisecond: ({ taskId }) => `Block for task "${taskId}" has sub-millisecond precision.`,
  h8_off_grid: ({ taskId }) => `Block for task "${taskId}" is not aligned to the 5-minute grid.`,
  h8_end_before_start: ({ taskId }) => `Block for task "${taskId}" ends before it starts.`,
};

function expectedText(item: ExplanationItem): string | RegExp {
  const render = ORACLE[item.code] as (params: ExplanationItem['params']) => string | RegExp;
  return render(item.params);
}

function expectMatches(text: string, expected: string | RegExp, context: string): void {
  if (typeof expected === 'string') {
    expect(text, context).toBe(expected);
  } else {
    expect(text, context).toMatch(expected);
  }
}

/** Opaque token: IDs, UTC instants, civil dates, enum values. No spaces or quotes. */
const TOKEN = /^[A-Za-z0-9_.:+-]{1,100}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXPLANATION_CODE_SET = new Set<string>(EXPLANATION_CODES);

function expectSafeParams(item: ExplanationItem): void {
  for (const [key, value] of Object.entries(item.params)) {
    const where = `${item.code}.${key}`;
    expect(key, where).toMatch(/^[a-z][A-Za-z0-9]*$/);
    if (typeof value === 'number') {
      expect(Number.isFinite(value), where).toBe(true);
      continue;
    }
    expect(typeof value, where).toBe('string');
    expect(value, where).toMatch(TOKEN);
    if (key.endsWith('At')) expect(value, where).toMatch(UTC_INSTANT);
    if (key === 'date') expect(value, where).toMatch(CIVIL_DATE);
  }
}

/** The FU-62 invariant for one candidate: one valid coded item per English line. */
function expectCodedExplanation(candidate: PlanCandidate): void {
  expect(candidate.explanationItems).toHaveLength(candidate.explanation.length);
  candidate.explanation.forEach((line, index) => {
    const item = candidate.explanationItems[index];
    expect(item, `line ${index}: ${line}`).toBeDefined();
    if (item === undefined) return;
    expect(EXPLANATION_CODE_SET.has(item.code), item.code).toBe(true);
    expectSafeParams(item);
    const expected = expectedText(item);
    if (item.code.startsWith('input_') && item.code !== 'input_rejected') {
      // Input issue lines are `<issue code>: <message>`.
      const match = /^([a-z_]+): (.*)$/s.exec(line);
      expect(match, line).not.toBeNull();
      expectMatches(match?.[2] ?? '', expected, `${item.code} ← ${line}`);
    } else {
      expectMatches(line, expected, `${item.code} ← ${line}`);
    }
  });
}

function hKind(violation: Violation): string {
  return violation.code.split('_')[0]?.toLowerCase() ?? '';
}

function expectCodedViolation(violation: Violation): void {
  expect((VIOLATION_MESSAGE_CODES as readonly string[]).includes(violation.messageCode)).toBe(true);
  // The message code family is the H-kind: h1_* codes only on H1 findings.
  expect(violation.messageCode.startsWith(`${hKind(violation)}_`), violation.messageCode).toBe(true);
  const item = { code: violation.messageCode, params: violation.params } as ExplanationItem;
  expectSafeParams(item);
  expectMatches(violation.message, expectedText(item), violation.messageCode);
}

function expectCodedIssue(issue: InputIssue): void {
  expect((INPUT_ISSUE_MESSAGE_CODES as readonly string[]).includes(issue.messageCode)).toBe(true);
  const item = { code: issue.messageCode, params: issue.params } as ExplanationItem;
  expectSafeParams(item);
  expectMatches(issue.message, expectedText(item), issue.messageCode);
}

// --- fixtures -------------------------------------------------------------

const DAY_RULES = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
  weekday,
  startLocal: '09:00',
  endLocal: '17:00',
  kind: 'work' as const,
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'A',
    dueAt: '2026-11-11T17:00:00Z',
    estimate: { p50Min: 60, p90Min: 60 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 1,
    dependsOn: [],
    ...overrides,
  };
}

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'UTC',
    horizon: { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' },
    tasks: [task()],
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

function block(taskId: string, start: string, end: string): Block {
  return { taskId, start: `2026-11-09T${start}`, end: `2026-11-09T${end}` };
}

const ONE_HOUR = [block('A', '09:00:00Z', '10:00:00Z')];

/** Validator scenarios; together they reach every violation message code. */
const VIOLATION_SCENARIOS: ReadonlyArray<readonly [string, ScheduleInput, Block[]]> = [
  ['invalid time zone', input({ timeZone: 'Mars/Base' }), ONE_HOUR],
  ['invalid horizon', input({ horizon: { start: 'not-an-instant', end: '2026-11-12T00:00:00Z' } }), ONE_HOUR],
  ['unknown task', input(), [...ONE_HOUR, block('Z', '11:00:00Z', '12:00:00Z')]],
  ['outside horizon', input(), [{ taskId: 'A', start: '2026-11-13T09:00:00Z', end: '2026-11-13T10:00:00Z' }]],
  ['invalid instant', input(), [{ taskId: 'A', start: 'garbage', end: '2026-11-09T10:00:00Z' }]],
  ['sub-millisecond', input(), [block('A', '09:00:00.000000001Z', '10:00:00Z')]],
  ['off grid', input(), [block('A', '09:03:00Z', '10:03:00Z')]],
  ['ends before start', input(), [block('A', '10:00:00Z', '09:00:00Z')]],
  ['same-task overlap', input(), [block('A', '09:00:00Z', '09:30:00Z'), block('A', '09:15:00Z', '09:45:00Z')]],
  [
    'two-task overlap',
    input({ tasks: [task(), task({ id: 'B' })] }),
    [block('A', '09:00:00Z', '10:00:00Z'), block('B', '09:30:00Z', '10:30:00Z')],
  ],
  [
    'commitment overlap',
    input({ commitments: [{ start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z' }] }),
    ONE_HOUR,
  ],
  ['outside availability', input(), [block('A', '03:00:00Z', '04:00:00Z')]],
  [
    'dependency order',
    input({ tasks: [task(), task({ id: 'B', dependsOn: ['A'] })] }),
    [block('B', '09:00:00Z', '10:00:00Z'), block('A', '10:00:00Z', '11:00:00Z')],
  ],
  ['before earliest start', input({ tasks: [task({ earliestStartAt: '2026-11-10T09:00:00Z' })] }), ONE_HOUR],
  [
    'inside due buffer',
    input({ tasks: [task({ dueAt: '2026-11-09T11:00:00Z', bufferBeforeDueMin: 60 })] }),
    [block('A', '09:30:00Z', '10:30:00Z')],
  ],
  ['after due', input({ tasks: [task({ dueAt: '2026-11-09T09:30:00Z' })] }), ONE_HOUR],
  [
    'non-splittable without remaining minutes',
    input({ tasks: [task({ splittable: false, minSessionMin: 60, maxSessionMin: 60, remainingMin: 0 })] }),
    ONE_HOUR,
  ],
  [
    'non-splittable outside session bounds',
    input({ tasks: [task({ splittable: false, minSessionMin: 90, maxSessionMin: 120 })] }),
    ONE_HOUR,
  ],
  [
    'non-splittable in two blocks',
    input({ tasks: [task({ splittable: false, minSessionMin: 60, maxSessionMin: 60 })] }),
    [block('A', '09:00:00Z', '09:30:00Z'), block('A', '10:00:00Z', '10:30:00Z')],
  ],
  [
    'session too short',
    input(),
    [block('A', '09:00:00Z', '09:15:00Z'), block('A', '10:00:00Z', '10:45:00Z')],
  ],
  ['daily cap', input({ prefs: { ...input().prefs, maxDailyFocusMin: 30 } }), ONE_HOUR],
  ['missing break', input({ prefs: { ...input().prefs, breakAfterMin: 30, breakMin: 15 } }), ONE_HOUR],
  ['deficit', input(), []],
  ['overallocated', input(), [block('A', '09:00:00Z', '10:30:00Z')]],
];

/** Input scenarios; together they reach every input issue message code. */
const INPUT_SCENARIOS: ReadonlyArray<readonly [string, ScheduleInput]> = [
  ['time zone', input({ timeZone: 'Mars/Base' })],
  ['horizon instant', input({ horizon: { start: 'garbage', end: '2026-11-12T00:00:00Z' } })],
  ['horizon order', input({ horizon: { start: '2026-11-12T00:00:00Z', end: '2026-11-12T00:00:00Z' } })],
  ['horizon length', input({ horizon: { start: '2026-01-01T00:00:00Z', end: '2027-03-01T00:00:00Z' } })],
  ['now', input({ now: 'garbage' })],
  ['duplicate task', input({ tasks: [task(), task()] })],
  ['estimate', input({ tasks: [task({ estimate: { p50Min: Number.NaN, p90Min: 60 } })] })],
  ['buffer', input({ tasks: [task({ bufferBeforeDueMin: 1.5 })] })],
  ['session minutes', input({ tasks: [task({ minSessionMin: 1.5 })] })],
  ['session bounds', input({ tasks: [task({ minSessionMin: 60, maxSessionMin: 30 })] })],
  ['window instant', input({ tasks: [task({ dueAt: 'garbage' })] })],
  ['empty window', input({ tasks: [task({ earliestStartAt: '2026-11-11T18:00:00Z' })] })],
  ['preference', input({ prefs: { ...input().prefs, breakMin: -1 } })],
  ['unknown dependency', input({ tasks: [task({ dependsOn: ['Z'] })] })],
  [
    'dependency cycle',
    input({ tasks: [task({ dependsOn: ['B'] }), task({ id: 'B', dependsOn: ['A'] })] }),
  ],
  [
    'weekday',
    input({ availability: [{ weekday: 9 as unknown as 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' }] }),
  ],
  ['availability window', input({ availability: [{ weekday: 1, startLocal: '17:00', endLocal: '09:00', kind: 'work' }] })],
  ['exception date', input({ exceptions: [{ date: '2026-13-40', kind: 'off' }] })],
  ['partial exception', input({ exceptions: [{ date: '2026-11-10', kind: 'off', startLocal: '09:00' }] })],
  [
    'exception window',
    input({ exceptions: [{ date: '2026-11-10', kind: 'off', startLocal: '12:00', endLocal: '10:00' }] }),
  ],
  ['commitment instant', input({ commitments: [{ start: 'garbage', end: '2026-11-09T10:00:00Z' }] })],
  [
    'commitment order',
    input({ commitments: [{ start: '2026-11-09T10:00:00Z', end: '2026-11-09T09:00:00Z' }] }),
  ],
  [
    'commitment length',
    input({
      horizon: { start: '2026-11-12T00:00:00Z', end: '2026-11-09T00:00:00Z' },
      commitments: [{ start: '2026-01-01T00:00:00Z', end: '2027-03-01T00:00:00Z' }],
    }),
  ],
  ['block task', input({ lockedBlocks: [block('Z', '09:00:00Z', '10:00:00Z')] })],
  ['block instant', input({ lockedBlocks: [{ taskId: 'A', start: 'garbage', end: '2026-11-09T10:00:00Z' }] })],
  ['block precision', input({ lockedBlocks: [block('A', '09:00:00.000000001Z', '10:00:00Z')] })],
  ['block grid', input({ existingBlocks: [block('A', '09:03:00Z', '10:03:00Z')] })],
  ['block order', input({ lockedBlocks: [block('A', '10:00:00Z', '09:00:00Z')] })],
  [
    'block length',
    input({ lockedBlocks: [{ taskId: 'A', start: '2026-01-01T00:00:00Z', end: '2027-03-01T00:00:00Z' }] }),
  ],
];

/** Generator scenarios; together they reach every generator explanation code. */
const GENERATOR_SCENARIOS: ReadonlyArray<readonly [string, ScheduleInput]> = [
  ['feasible', input()],
  ['infeasible capacity', input({ tasks: [task({ dueAt: '2026-11-09T09:30:00Z' })] })],
  [
    'no contiguous window',
    input({
      tasks: [task({ estimate: { p50Min: 600, p90Min: 600 }, splittable: false, minSessionMin: 600, maxSessionMin: 600 })],
    }),
  ],
  ['not grid aligned', input({ tasks: [task({ estimate: { p50Min: 62, p90Min: 62 } })] })],
  ['below grid', input({ tasks: [task({ estimate: { p50Min: 3, p90Min: 3 }, minSessionMin: 5 })] })],
  [
    'session bounds',
    input({ tasks: [task({ estimate: { p50Min: 50, p90Min: 50 }, minSessionMin: 30, maxSessionMin: 40 })] }),
  ],
  [
    'replan bound',
    input({
      availability: ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
        weekday,
        startLocal: '00:00',
        endLocal: '24:00',
        kind: 'work' as const,
      })),
      tasks: [task({ estimate: { p50Min: 150, p90Min: 150 }, minSessionMin: 30, maxSessionMin: 30 })],
      existingBlocks: [block('A', '00:00:00Z', '02:00:00Z')],
    }),
  ],
  ['rejected input', input({ timeZone: 'Mars/Base' })],
];

function goldenInputs(): Array<readonly [string, ScheduleInput]> {
  const directory = fileURLToPath(new URL('./golden', import.meta.url));
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
        id: string;
        input: ScheduleInput;
      };
      return [fixture.id, fixture.input] as const;
    });
}

/**
 * `buildChunks()` keeps an `estimate_below_grid` branch for a positive
 * remainder that rounds to zero grid units, but every such remainder is also
 * off-grid and reports `estimate_not_grid_aligned` first. The code stays in
 * the closed enum (the branch exists), and this list pins that it is the only
 * generator code no input reaches.
 */
const DEFENSIVE_GENERATOR_CODES: ReadonlySet<ExplanationCode> = new Set<ExplanationCode>([
  'heuristic_estimate_below_grid',
]);

// --- tests ----------------------------------------------------------------

describe('explanation and violation codes (FU-62)', () => {
  it('publishes closed, duplicate-free code lists with every violation and input code included', () => {
    expect(new Set(EXPLANATION_CODES).size).toBe(EXPLANATION_CODES.length);
    expect(Object.keys(ORACLE).sort()).toEqual([...EXPLANATION_CODES].sort());
    for (const code of [...VIOLATION_MESSAGE_CODES, ...INPUT_ISSUE_MESSAGE_CODES]) {
      expect(EXPLANATION_CODE_SET.has(code), code).toBe(true);
    }
    for (const code of VIOLATION_MESSAGE_CODES) expect(code).toMatch(/^h[0-8]_[a-z_]+$/);
    for (const code of INPUT_ISSUE_MESSAGE_CODES) expect(code).toMatch(/^input_[a-z_]+$/);
  });

  it('codes every validator finding 1:1 with its message template', () => {
    const seen = new Set<string>();
    for (const [name, scenario, blocks] of VIOLATION_SCENARIOS) {
      const violations = validate(scenario, blocks, { riskLevel: scenario.prefs.riskLevel });
      expect(violations.length, name).toBeGreaterThan(0);
      for (const violation of violations) {
        expectCodedViolation(violation);
        seen.add(violation.messageCode);
      }
    }
    // Reachability: every published violation code is produced by some input.
    expect([...seen].sort()).toEqual([...VIOLATION_MESSAGE_CODES].sort());
  });

  it('codes every input issue 1:1 with its message template', () => {
    const seen = new Set<string>();
    for (const [name, scenario] of INPUT_SCENARIOS) {
      const issues = validateInput(scenario);
      expect(issues.length, name).toBeGreaterThan(0);
      for (const issue of issues) {
        expectCodedIssue(issue);
        seen.add(issue.messageCode);
      }
    }
    expect([...seen].sort()).toEqual([...INPUT_ISSUE_MESSAGE_CODES].sort());
  });

  it('emits a coded item for every explanation line the generator writes', () => {
    const seen = new Set<string>();
    for (const [name, scenario] of [...GENERATOR_SCENARIOS, ...INPUT_SCENARIOS]) {
      const result = generate(scenario);
      expect(result.candidates.length, name).toBeGreaterThan(0);
      for (const candidate of result.candidates) {
        expectCodedExplanation(candidate);
        for (const item of candidate.explanationItems) seen.add(item.code);
      }
    }
    for (const [, scenario, blocks] of VIOLATION_SCENARIOS) {
      // Use the scenario blocks as locked work so the generator reports them.
      const locked = { ...scenario, lockedBlocks: [...scenario.lockedBlocks, ...blocks] };
      for (const candidate of generate(locked).candidates) {
        expectCodedExplanation(candidate);
        for (const item of candidate.explanationItems) seen.add(item.code);
      }
    }
    const generatorCodes = EXPLANATION_CODES.filter(
      (code) =>
        !code.startsWith('input_') && !/^h[0-8]_/.test(code) && !DEFENSIVE_GENERATOR_CODES.has(code),
    );
    for (const code of [...generatorCodes, 'input_rejected']) {
      expect(seen.has(code), `generator never emitted ${code}`).toBe(true);
    }
    for (const code of DEFENSIVE_GENERATOR_CODES) {
      expect(EXPLANATION_CODE_SET.has(code), code).toBe(true);
      expect(seen.has(code), `${code} became reachable; drop it from DEFENSIVE_GENERATOR_CODES`).toBe(false);
    }
  });

  it('keeps explanations coded across every golden fixture', () => {
    for (const [id, fixture] of goldenInputs()) {
      const result = generate(fixture);
      expect(result.candidates.length, id).toBeGreaterThan(0);
      for (const candidate of result.candidates) expectCodedExplanation(candidate);
    }
  });

  it('codes every finding for random edited blocks (property)', () => {
    const base = input({ tasks: [task(), task({ id: 'B', dependsOn: ['A'], dueAt: '2026-11-10T12:00:00Z' })] });
    const blockArb = fc.record({
      taskId: fc.constantFrom('A', 'B', 'Z'),
      day: fc.integer({ min: 8, max: 12 }),
      startMin: fc.integer({ min: 0, max: 24 * 60 - 1 }),
      lengthMin: fc.integer({ min: -30, max: 600 }),
    });
    fc.assert(
      fc.property(fc.array(blockArb, { maxLength: 6 }), (specs) => {
        const blocks = specs.map((spec) => {
          const start = Date.UTC(2026, 10, spec.day, 0, spec.startMin);
          return {
            taskId: spec.taskId,
            start: new Date(start).toISOString(),
            end: new Date(start + spec.lengthMin * 60_000).toISOString(),
          };
        });
        for (const violation of validate(base, blocks, { riskLevel: 'p50' })) {
          expectCodedViolation(violation);
        }
      }),
      { numRuns: 300, seed: 6262 },
    );
  });

  it('detects a line without an item (negative)', () => {
    const [candidate] = generate(input()).candidates;
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    const stripped: PlanCandidate = { ...candidate, explanationItems: candidate.explanationItems.slice(1) };
    expect(() => expectCodedExplanation(stripped)).toThrow();
    const mislabelled: PlanCandidate = {
      ...candidate,
      explanationItems: candidate.explanationItems.map((item) =>
        item.code === 'constraints_satisfied' ? { code: 'unplaced_minutes', params: { deficitMin: 0 } } : item,
      ),
    };
    expect(() => expectCodedExplanation(mislabelled)).toThrow();
  });

  it('makes unknown codes and mismatched params impossible by type (negative)', () => {
    // @ts-expect-error — a code outside the closed enum is not an ExplanationItem.
    const unknown: ExplanationItem = { code: 'free_text', params: {} };
    // @ts-expect-error — each code has a fixed parameter shape.
    const wrongParams: ExplanationItem = { code: 'h7_deficit', params: { deficitMin: 10 } };
    // @ts-expect-error — a task title is not a parameter of any code.
    const titled: ExplanationItem = { code: 'h3_dependency_order', params: { taskId: 'A', dependencyId: 'B', title: '보고서' } };
    expect(EXPLANATION_CODE_SET.has(unknown.code)).toBe(false);
    expect(wrongParams.code).toBe('h7_deficit');
    expect(titled.code).toBe('h3_dependency_order');
  });
});
