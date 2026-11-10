import {
  POLICY_NAMES,
  MAX_HORIZON_DAYS,
  type AvailabilityKind as SchedulerAvailabilityKind,
  type PlanMetrics as SchedulerPlanMetrics,
  type PolicyName as SchedulerPolicyName,
  type RiskLevel as SchedulerRiskLevel,
  type ViolationCode as SchedulerViolationCode,
} from '@ohmydate/scheduler';
import {
  ApprovePlanRequestSchema,
  AvailabilityPutSchema,
  AvailabilitySchema,
  CommitmentCreateSchema,
  CommitmentListQuerySchema,
  CommitmentSchema,
  MAX_HORIZON_DAYS as CONTRACT_HORIZON_DAYS,
  PLAN_POLICIES,
  PlanCandidateSchema,
  PlanCreateSchema,
  PlanMetricsSchema,
  PlanSchema,
  PreviewEditRequestSchema,
  PreviewEditResponseSchema,
  type AvailabilityKindName,
  type PlanMetricsDto,
  type PlanPolicyName,
  type RiskLevelName,
  type ViolationCode,
} from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const OTHER_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type _MetricsParity = Assert<Equal<PlanMetricsDto, SchedulerPlanMetrics>>;
export type _PolicyParity = Assert<Equal<PlanPolicyName, SchedulerPolicyName>>;
export type _AvailabilityKindParity = Assert<Equal<AvailabilityKindName, SchedulerAvailabilityKind>>;
export type _RiskParity = Assert<Equal<RiskLevelName, SchedulerRiskLevel>>;
export type _ViolationParity = Assert<
  Equal<ViolationCode, Exclude<SchedulerViolationCode, 'H0_horizon' | 'H0_unknown_task'>>
>;

test('planning enums and horizon bound stay in lockstep with the scheduler', () => {
  expect([...PLAN_POLICIES]).toEqual([...POLICY_NAMES]);
  expect(CONTRACT_HORIZON_DAYS).toBe(MAX_HORIZON_DAYS);
  expect(MAX_HORIZON_DAYS).toBe(366);
});

test('plan create accepts a goal scope and up to three distinct policies', () => {
  const validate = compile(PlanCreateSchema);
  const goalPlan = {
    scope: { goalId: ID },
    policies: ['front_loaded', 'balanced', 'focus_blocked'],
    horizon: { start: '2026-11-11T00:00:00Z', end: '2026-11-25T00:00:00Z' },
  };
  expect(validate(goalPlan)).toBe(true);
  expect(validate({ ...goalPlan, policies: undefined })).toBe(true);
  expect(validate({ ...goalPlan, scope: { taskIds: [ID, OTHER_ID] } })).toBe(true);
  expect(validate({ ...goalPlan, scope: { goalId: ID, taskIds: [ID] } })).toBe(false);
  expect(validate({ ...goalPlan, scope: { taskIds: [] } })).toBe(false);
  expect(validate({ ...goalPlan, scope: { goalId: ID, extra: true } })).toBe(false);
  expect(validate({ ...goalPlan, policies: [] })).toBe(false);
  expect(validate({ ...goalPlan, policies: ['balanced', 'balanced'] })).toBe(false);
  expect(validate({ ...goalPlan, policies: ['balanced', 'balanced', 'balanced', 'balanced'] })).toBe(
    false,
  );
  expect(validate({ ...goalPlan, policies: ['aggressive'] })).toBe(false);
  expect(validate({ ...goalPlan, extra: true })).toBe(false);
});

test('plan create caps task scopes at 100 task ids', () => {
  const validate = compile(PlanCreateSchema);
  const taskIds = Array.from({ length: 101 }, () => ID);
  const plan = {
    scope: { taskIds },
    horizon: { start: '2026-11-11T00:00:00Z', end: '2026-11-25T00:00:00Z' },
  };
  expect(validate(plan)).toBe(false);
  expect(validate({ ...plan, scope: { taskIds: taskIds.slice(0, 100) } })).toBe(true);
});

test('metrics mirror the scheduler shape and keep fractional loads', () => {
  const validate = compile(PlanMetricsSchema);
  const metrics = {
    totalFocusMin: 300,
    minSlackMin: 1440,
    maxDailyLoadMin: 150,
    avgDailyLoadMin: 142.5,
    contextSwitches: 3,
    changedBlocks: 0,
    deficitMin: 0,
    capacityDeficitMin: 30,
    p90CoverageRatio: 0.9,
  };
  expect(validate(metrics)).toBe(true);
  expect(validate({ ...metrics, minSlackMin: 0.5 })).toBe(true);
  expect(validate({ ...metrics, minSlackMin: -60 })).toBe(true);
  expect(validate({ ...metrics, minSlackMin: Number.POSITIVE_INFINITY })).toBe(false);
  expect(validate({ ...metrics, extra: true })).toBe(false);
  expect(validate({ ...metrics, totalFocusMin: -1 })).toBe(false);
  expect(validate({ ...metrics, avgDailyLoadMin: 'many' })).toBe(false);
});

test('plan candidates enforce bounded counts and required explanation fields', () => {
  const validate = compile(PlanCandidateSchema);
  const candidate = {
    id: ID,
    policy: 'balanced',
    blocks: [{ taskId: ID, startAt: '2026-11-12T09:00:00Z', endAt: '2026-11-12T10:00:00Z' }],
    metrics: {
      totalFocusMin: 60,
      minSlackMin: 100,
      maxDailyLoadMin: 60,
      avgDailyLoadMin: 60,
      contextSwitches: 0,
      changedBlocks: 0,
      deficitMin: 0,
      capacityDeficitMin: 0,
      p90CoverageRatio: 1,
    },
    feasible: true,
    deficitMin: 0,
    capacityDeficitMin: 0,
    explanation: ['Balanced daily load'],
    generatorVersion: 'scheduler@0.1.0',
    inputHash: 'sha256:abc',
  };
  expect(validate(candidate)).toBe(true);
  expect(validate({ ...candidate, diversityNote: 'Only one distinct plan' })).toBe(true);
  expect(validate({ ...candidate, extra: true })).toBe(false);
  expect(validate({ ...candidate, policy: 'cheapest' })).toBe(false);
  expect(validate({ ...candidate, blocks: [{ taskId: ID, startAt: 'x', endAt: 'y' }] })).toBe(false);
});

test('plan response carries scope, availability version and candidates', () => {
  const validate = compile(PlanSchema);
  const plan = {
    id: ID,
    ownerId: OTHER_ID,
    scope: { taskIds: [ID] },
    status: 'draft',
    availabilityVersion: 4,
    horizon: { start: '2026-11-11T00:00:00Z', end: '2026-11-25T00:00:00Z' },
    timeZone: 'UTC',
    candidates: [],
    version: 1,
    createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
  };
  expect(validate(plan)).toBe(true);
  expect(validate({ ...plan, status: 'archived' })).toBe(false);
  expect(validate({ ...plan, availabilityVersion: 0 })).toBe(false);
  expect(validate({ ...plan, extra: true })).toBe(false);
});

test('preview edit reports H1-H8 violations and approve accepts edited blocks', () => {
  const validatePreview = compile(PreviewEditResponseSchema);
  expect(
    validatePreview({
      feasible: false,
      violations: [{ code: 'H1', taskId: ID, message: 'overlaps a commitment' }],
      deficitMin: 30,
    }),
  ).toBe(true);
  expect(
    validatePreview({ feasible: true, violations: [], deficitMin: 0 }),
  ).toBe(true);
  expect(
    validatePreview({ feasible: false, violations: [{ code: 'H0_horizon', message: 'internal' }], deficitMin: 0 }),
  ).toBe(false);

  const validateRequest = compile(PreviewEditRequestSchema);
  expect(
    validateRequest({
      blocks: [{ taskId: ID, startAt: '2026-11-12T09:00:00Z', endAt: '2026-11-12T10:00:00Z' }],
    }),
  ).toBe(true);
  expect(validateRequest({ blocks: [], extra: true })).toBe(false);

  const validateApprove = compile(ApprovePlanRequestSchema);
  expect(validateApprove({})).toBe(true);
  expect(
    validateApprove({
      editedBlocks: [{ taskId: ID, startAt: '2026-11-12T09:00:00Z', endAt: '2026-11-12T10:00:00Z' }],
    }),
  ).toBe(true);
  expect(validateApprove({ editedBlocks: 'none' })).toBe(false);
});

test('availability rules, exceptions and preferences use bounded local values', () => {
  const validate = compile(AvailabilityPutSchema);
  const availability = {
    timeZone: 'Asia/Seoul',
    rules: [
      { weekday: 1, startLocal: '09:00', endLocal: '18:00', kind: 'work' },
      { weekday: 2, startLocal: '20:00', endLocal: '24:00', kind: 'focus' },
    ],
    exceptions: [
      { date: '2026-11-15', kind: 'off' },
      { date: '2026-11-16', kind: 'extra', startLocal: '10:00', endLocal: '12:00' },
    ],
    prefs: {
      maxDailyFocusMin: 240,
      breakAfterMin: 50,
      breakMin: 10,
      dayStartLocal: '08:00',
      dayEndLocal: '23:00',
      riskLevel: 'p90',
    },
  };
  expect(validate(availability)).toBe(true);
  expect(validate({ ...availability, timeZone: '+09:00' })).toBe(false);
  expect(
    validate({ ...availability, rules: [{ weekday: 8, startLocal: '09:00', endLocal: '10:00', kind: 'work' }] }),
  ).toBe(false);
  expect(
    validate({ ...availability, rules: [{ weekday: 1, startLocal: '9:00', endLocal: '18:00', kind: 'work' }] }),
  ).toBe(false);
  expect(
    validate({ ...availability, rules: [{ weekday: 1, startLocal: '09:00', endLocal: '18:00', kind: 'rest' }] }),
  ).toBe(false);
  expect(
    validate({ ...availability, prefs: { ...availability.prefs, maxDailyFocusMin: 100_001 } }),
  ).toBe(false);
  expect(validate({ ...availability, extra: true })).toBe(false);

  const validateRead = compile(AvailabilitySchema);
  expect(validateRead({ ...availability, version: 2 })).toBe(true);
  expect(validateRead({ ...availability, version: 0 })).toBe(false);
});

test('commitments bound rrule strings and list occurrences within the period', () => {
  const validateCreate = compile(CommitmentCreateSchema);
  const commitment = {
    title: 'Weekly seminar',
    startAt: '2026-11-12T05:00:00Z',
    endAt: '2026-11-12T07:00:00Z',
    timeZone: 'Asia/Seoul',
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
  };
  expect(validateCreate(commitment)).toBe(true);
  expect(validateCreate({ ...commitment, rrule: undefined })).toBe(true);
  expect(validateCreate({ ...commitment, rrule: 'WEEKLY' })).toBe(false);
  expect(validateCreate({ ...commitment, rrule: `FREQ=${'X'.repeat(600)}` })).toBe(false);
  expect(validateCreate({ ...commitment, source: 'imported' })).toBe(false);
  expect(validateCreate({ ...commitment, extra: true })).toBe(false);

  const validateCommitment = compile(CommitmentSchema);
  expect(
    validateCommitment({
      ...commitment,
      id: ID,
      ownerId: OTHER_ID,
      source: 'manual',
      occurrences: [
        { commitmentId: ID, startAt: '2026-11-12T05:00:00Z', endAt: '2026-11-12T07:00:00Z' },
      ],
      version: 1,
      createdAt: '2026-11-11T00:00:00Z',
      updatedAt: '2026-11-11T00:00:00Z',
    }),
  ).toBe(true);

  const validateQuery = compile(CommitmentListQuerySchema);
  expect(
    validateQuery({ from: '2026-11-11T00:00:00Z', to: '2026-11-25T00:00:00Z' }),
  ).toBe(true);
  expect(validateQuery({ from: '2026-11-11T00:00:00Z' })).toBe(false);
  expect(
    validateQuery({ from: '2026-11-11T00:00:00Z', to: '2026-11-25T00:00:00Z', extra: true }),
  ).toBe(false);
});

test('plan carries the persisted horizon and time zone', () => {
  const validate = compile(PlanSchema);
  const plan = {
    id: ID,
    ownerId: OTHER_ID,
    scope: { taskIds: [ID] },
    status: 'active',
    availabilityVersion: 4,
    currentVersionId: OTHER_ID,
    horizon: { start: '2026-11-11T00:00:00Z', end: '2026-11-25T00:00:00Z' },
    timeZone: 'Asia/Seoul',
    candidates: [],
    version: 2,
    createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
  };
  expect(validate(plan)).toBe(true);
  // Round-trip through JSON keeps the exact requested bounds.
  expect(validate(JSON.parse(JSON.stringify(plan)))).toBe(true);
  expect(validate({ ...plan, horizon: undefined })).toBe(false);
  expect(validate({ ...plan, timeZone: undefined })).toBe(false);
  expect(validate({ ...plan, timeZone: '+09:00' })).toBe(false);
  expect(
    validate({ ...plan, horizon: { start: plan.horizon.end, end: plan.horizon.start } }),
  ).toBe(true);
});
