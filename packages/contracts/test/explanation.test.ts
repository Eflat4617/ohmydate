import {
  EXPLANATION_CODES as SCHEDULER_EXPLANATION_CODES,
  INPUT_ISSUE_MESSAGE_CODES as SCHEDULER_INPUT_CODES,
  VIOLATION_MESSAGE_CODES as SCHEDULER_VIOLATION_CODES,
  generate,
  validate as validatePlan,
  type ScheduleInput,
} from '@ohmydate/scheduler';
import {
  API_VIOLATION_MESSAGE_CODES,
  EXPLANATION_CODES,
  ExplanationItemSchema,
  GENERATOR_EXPLANATION_CODES,
  INPUT_ISSUE_MESSAGE_CODES,
  PlanCandidateSchema,
  ProblemSchema,
  ReplanCandidateSchema,
  VIOLATION_MESSAGE_CODES,
  ViolationSchema,
  schemaRegistry,
  type PlanCandidateDto,
} from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from './ajv.js';

const TASK_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const OTHER_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c57';
const CANDIDATE_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56';

const INPUT: ScheduleInput = {
  now: '2026-11-09T00:00:00Z',
  timeZone: 'Asia/Seoul',
  horizon: { start: '2026-11-09T00:00:00Z', end: '2026-11-11T00:00:00Z' },
  tasks: [
    {
      id: TASK_ID,
      dueAt: '2026-11-10T08:00:00Z',
      estimate: { p50Min: 600, p90Min: 600 },
      splittable: true,
      minSessionMin: 30,
      maxSessionMin: 90,
      priority: 1,
      dependsOn: [],
    },
    {
      id: OTHER_ID,
      estimate: { p50Min: 60, p90Min: 60 },
      splittable: true,
      minSessionMin: 30,
      maxSessionMin: 60,
      priority: 2,
      dependsOn: [TASK_ID],
    },
  ],
  availability: [
    { weekday: 1, startLocal: '09:00', endLocal: '12:00', kind: 'work' },
    { weekday: 2, startLocal: '09:00', endLocal: '12:00', kind: 'focus' },
  ],
  exceptions: [],
  commitments: [{ start: '2026-11-09T01:00:00Z', end: '2026-11-09T01:30:00Z' }],
  lockedBlocks: [],
  prefs: {
    maxDailyFocusMin: 120,
    breakAfterMin: 60,
    breakMin: 15,
    riskLevel: 'p50',
    dayStartLocal: '08:00',
    dayEndLocal: '22:00',
  },
  seed: 3,
};

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('explanation code contract (FU-62)', () => {
  it('mirrors the scheduler code lists exactly, plus the API-only violation code', () => {
    expect(sorted(INPUT_ISSUE_MESSAGE_CODES)).toEqual(sorted(SCHEDULER_INPUT_CODES));
    expect(sorted(VIOLATION_MESSAGE_CODES)).toEqual(
      sorted([...SCHEDULER_VIOLATION_CODES, ...API_VIOLATION_MESSAGE_CODES]),
    );
    expect(sorted(EXPLANATION_CODES)).toEqual(
      sorted([...SCHEDULER_EXPLANATION_CODES, ...API_VIOLATION_MESSAGE_CODES]),
    );
    expect(sorted(GENERATOR_EXPLANATION_CODES)).toEqual(
      sorted(
        SCHEDULER_EXPLANATION_CODES.filter(
          (code) => !code.startsWith('input_') && !/^h[0-8]_/.test(code),
        ).concat(['input_rejected']),
      ),
    );
    expect(new Set(EXPLANATION_CODES).size).toBe(EXPLANATION_CODES.length);
    for (const code of API_VIOLATION_MESSAGE_CODES) {
      expect((SCHEDULER_EXPLANATION_CODES as readonly string[]).includes(code)).toBe(false);
    }
  });

  it('registers ExplanationItem as an OpenAPI component', () => {
    expect(schemaRegistry.ExplanationItem).toBe(ExplanationItemSchema);
  });

  it('accepts numbers and opaque tokens as params and rejects free text (negative)', () => {
    const check = compile(ExplanationItemSchema);
    expect(check({ code: 'h7_deficit', params: { taskId: TASK_ID, shortMin: 30 } })).toBe(true);
    expect(
      check({
        code: 'h1_commitment_overlap',
        params: { taskId: TASK_ID, startAt: '2026-11-09T09:00:00Z', endAt: '2026-11-09T10:00:00Z' },
      }),
    ).toBe(true);
    expect(check({ code: 'constraints_satisfied', params: {} })).toBe(true);
    expect(check({ code: 'policy_summary', params: { policy: 'front_loaded', policyVersion: '1.0.0' } })).toBe(true);

    expect(check({ code: 'free_text', params: {} })).toBe(false);
    expect(check({ code: 'h7_deficit' })).toBe(false);
    expect(check({ code: 'h7_deficit', params: { taskId: '보고서 작성' } })).toBe(false);
    expect(check({ code: 'h7_deficit', params: { title: 'Quarterly report draft' } })).toBe(false);
    expect(check({ code: 'h7_deficit', params: { taskId: { nested: true } } })).toBe(false);
    expect(check({ code: 'h7_deficit', params: { 'task id': TASK_ID } })).toBe(false);
    expect(check({ code: 'h7_deficit', params: { taskId: '' } })).toBe(false);
    expect(check({ code: 'h7_deficit', params: {}, text: 'extra' })).toBe(false);
  });

  it('serializes real scheduler candidates with their coded items', () => {
    const check = compile(PlanCandidateSchema);
    const { candidates } = generate(INPUT);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((candidate) => !candidate.feasible)).toBe(true);
    for (const candidate of candidates) {
      const dto: PlanCandidateDto = {
        id: CANDIDATE_ID,
        policy: candidate.policy,
        blocks: candidate.blocks.map((block) => ({
          taskId: block.taskId,
          startAt: block.start,
          endAt: block.end,
        })),
        metrics: candidate.metrics,
        feasible: candidate.feasible,
        deficitMin: candidate.deficitMin,
        capacityDeficitMin: candidate.capacityDeficitMin,
        explanation: candidate.explanation,
        explanationItems: candidate.explanationItems,
        generatorVersion: candidate.generatorVersion,
        inputHash: candidate.inputHash,
      };
      expect({ policy: candidate.policy, valid: check(dto), errors: check.errors ?? null }).toEqual({
        policy: candidate.policy,
        valid: true,
        errors: null,
      });
      expect(dto.explanationItems).toHaveLength(dto.explanation.length);
    }
  });

  it('keeps legacy candidates and replan candidates without items valid', () => {
    const candidate = compile(PlanCandidateSchema);
    const legacy = {
      id: CANDIDATE_ID,
      policy: 'balanced',
      blocks: [],
      metrics: {
        totalFocusMin: 0,
        minSlackMin: 0,
        maxDailyLoadMin: 0,
        avgDailyLoadMin: 0,
        contextSwitches: 0,
        changedBlocks: 0,
        deficitMin: 0,
        capacityDeficitMin: 0,
        p90CoverageRatio: 1,
      },
      feasible: true,
      deficitMin: 0,
      capacityDeficitMin: 0,
      explanation: ['Policy balanced v1.0.0: Spread work evenly across days.'],
      generatorVersion: 'm3-02.6',
      inputHash: 'abc',
    };
    expect(candidate(legacy)).toBe(true);
    expect(candidate({ ...legacy, explanationItems: [] })).toBe(true);
    expect(candidate({ ...legacy, explanationItems: [{ code: 'unknown_code', params: {} }] })).toBe(false);

    const replan = compile(ReplanCandidateSchema);
    const replanLegacy = {
      blocks: [],
      metrics: legacy.metrics,
      changedBlocks: 0,
      bound: 2,
      flags: [],
      explanation: ['All hard constraints H1-H8 satisfied.'],
    };
    expect(replan(replanLegacy)).toBe(true);
    expect(
      replan({ ...replanLegacy, explanationItems: [{ code: 'constraints_satisfied', params: {} }] }),
    ).toBe(true);
    expect(replan({ ...replanLegacy, explanationItems: [{ code: 'H1', params: {} }] })).toBe(false);
  });

  it('carries validator message codes on violations and in constraint_violation problems', () => {
    const violation = compile(ViolationSchema);
    const problem = compile(ProblemSchema);
    const findings = validatePlan(
      INPUT,
      [
        { taskId: TASK_ID, start: '2026-11-09T01:00:00Z', end: '2026-11-09T02:00:00Z' },
        { taskId: OTHER_ID, start: '2026-11-09T01:30:00Z', end: '2026-11-09T02:00:00Z' },
      ],
      { riskLevel: 'p50' },
    );
    expect(findings.length).toBeGreaterThan(2);
    const wire = findings
      .filter((finding) => !finding.code.startsWith('H0_'))
      .map((finding) => ({
        code: finding.code,
        ...(finding.taskId === undefined ? {} : { taskId: finding.taskId }),
        message: finding.message,
        messageCode: finding.messageCode,
        params: finding.params,
      }));
    for (const entry of wire) {
      expect({ entry: entry.messageCode, valid: violation(entry) }).toEqual({ entry: entry.messageCode, valid: true });
    }
    expect(
      problem({
        type: 'about:blank',
        title: 'Constraint violation',
        status: 422,
        code: 'constraint_violation',
        violations: wire,
      }),
    ).toBe(true);
    // Legacy and API-only findings.
    expect(violation({ code: 'H1', message: 'blocks overlap' })).toBe(true);
    expect(
      violation({ code: 'H1', message: 'overlap', messageCode: 'h1_active_block_overlap', params: {} }),
    ).toBe(true);
    expect(violation({ code: 'H1', message: 'x', messageCode: 'policy_summary', params: {} })).toBe(false);
    expect(violation({ code: 'H1', message: 'x', messageCode: 'h1_unknown', params: {} })).toBe(false);
  });
});

describe('06 §6.1 code tables (FU-62)', () => {
  const spec = readFileSync(
    fileURLToPath(new URL('../../../docs/blueprint/06-SCHEDULER-SPEC.md', import.meta.url)),
    'utf8',
  );
  const start = spec.indexOf('### 6.1 ');
  const end = spec.indexOf('\n## ', start);
  const section = spec.slice(start, end === -1 ? undefined : end);
  const rows = [...section.matchAll(/^\| `([a-z0-9_]+)` \|(.*)$/gm)];

  it('lists every contract code exactly once', () => {
    expect(start).toBeGreaterThan(-1);
    const documented = rows.map((row) => row[1] ?? '');
    expect(new Set(documented).size).toBe(documented.length);
    expect(sorted(documented)).toEqual(sorted(EXPLANATION_CODES));
  });

  it('labels each violation code with its H-kind', () => {
    for (const code of VIOLATION_MESSAGE_CODES) {
      const row = rows.find((entry) => entry[1] === code);
      const kind = row?.[2]?.split('|')[0]?.trim() ?? '';
      expect(kind.toLowerCase().startsWith(code.slice(0, 2)), `${code} → ${kind}`).toBe(true);
    }
  });
});
