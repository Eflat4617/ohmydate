import { EXPLANATION_CODES, type Plan, type ReplanProposal, type Violation } from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import { sql } from 'kysely';
import {
  candidateExplanationJson,
  explanationItemsJson,
  parseCandidateExplanation,
  parseExplanationItems,
} from '../src/adapters/explanation-json.js';
import { toContractViolations } from '../src/application/plan-service.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import {
  M5_HORIZON,
  approveProposal,
  approvedPlan,
  listProposals,
  putM5Availability,
  requestReplan,
  seedPlanTask,
} from './support/m5-fixtures.js';

/**
 * FU-62: the API passes coded explanations and violation codes through, and
 * rows persisted before FU-62 still serialize (with `explanationItems: []`).
 */

const START = '2026-11-11T08:00:00Z' as Instant;
const TASK = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const CODES = new Set<string>(EXPLANATION_CODES);

const LINES = ['Policy balanced v1.0.0: Spread work evenly across days.', 'All hard constraints H1-H8 satisfied.'];
const ITEMS = [
  { code: 'policy_summary', params: { policy: 'balanced', policyVersion: '1.0.0' } },
  { code: 'constraints_satisfied', params: {} },
] as const;

function expectAligned(container: { explanation: readonly string[]; explanationItems?: readonly unknown[] }): void {
  expect(container.explanationItems).toBeDefined();
  expect(container.explanationItems).toHaveLength(container.explanation.length);
  expect(container.explanation.length).toBeGreaterThan(0);
  for (const item of container.explanationItems ?? []) {
    expect(CODES.has((item as { code: string }).code)).toBe(true);
  }
}

describe('explanation persistence helpers (FU-62)', () => {
  it('round-trips lines and items through the candidate explanation column', () => {
    const stored = candidateExplanationJson(LINES, [...ITEMS]);
    // The column keeps its pre-FU-62 shape: English lines first, then one object.
    expect(stored.slice(0, LINES.length)).toEqual(LINES);
    expect(stored.filter((entry) => typeof entry === 'string')).toEqual(LINES);
    expect(parseCandidateExplanation(JSON.parse(JSON.stringify(stored)))).toEqual({
      explanation: LINES,
      explanationItems: ITEMS,
      diversityNoteItems: [],
    });
  });

  it('serializes legacy rows (lines only) with no items', () => {
    expect(parseCandidateExplanation(LINES)).toEqual({ explanation: LINES, explanationItems: [], diversityNoteItems: [] });
    expect(parseCandidateExplanation([])).toEqual({ explanation: [], explanationItems: [], diversityNoteItems: [] });
    expect(parseCandidateExplanation(null)).toEqual({ explanation: [], explanationItems: [], diversityNoteItems: [] });
    expect(candidateExplanationJson(LINES, [])).toEqual(LINES);
    expect(parseExplanationItems(undefined, 2)).toEqual([]);
  });

  it('drops all items when any stored item is unknown, malformed or unpaired (negative)', () => {
    const unknown = [...LINES, { items: [ITEMS[0], { code: 'free_text', params: {} }] }];
    expect(parseCandidateExplanation(unknown).explanationItems).toEqual([]);
    const titled = [...LINES, { items: [ITEMS[0], { code: 'h7_deficit', params: { title: '보고서 초안' } }] }];
    expect(parseCandidateExplanation(titled).explanationItems).toEqual([]);
    const nested = [...LINES, { items: [ITEMS[0], { code: 'h7_deficit', params: { taskId: { id: TASK } } }] }];
    expect(parseCandidateExplanation(nested).explanationItems).toEqual([]);
    const short = [...LINES, { items: [ITEMS[0]] }];
    expect(parseCandidateExplanation(short)).toEqual({ explanation: LINES, explanationItems: [], diversityNoteItems: [] });
    const twoObjects = [...LINES, { items: [...ITEMS] }, { items: [...ITEMS] }];
    expect(parseCandidateExplanation(twoObjects).explanationItems).toEqual([]);
    expect(parseExplanationItems([{ code: 'h7_deficit', params: { shortMin: Number.NaN } }], 1)).toEqual([]);
    // Lines are never lost, even when the coded part is unusable.
    expect(parseCandidateExplanation(unknown).explanation).toEqual(LINES);
  });

  it('copies items into a plain jsonb payload', () => {
    const copy = explanationItemsJson([...ITEMS]);
    expect(copy).toEqual(ITEMS);
    expect(copy[0]).not.toBe(ITEMS[0]);
  });

  it('maps scheduler findings to contract violations with message code and params', () => {
    const [violation] = toContractViolations([
      {
        code: 'H7',
        message: `Task "${TASK}" is short by 30 minutes (deficit).`,
        messageCode: 'h7_deficit',
        params: { taskId: TASK, shortMin: 30 },
        taskId: TASK,
      },
    ]);
    expect(violation).toEqual({
      code: 'H7',
      taskId: TASK,
      message: `Task "${TASK}" is short by 30 minutes (deficit).`,
      messageCode: 'h7_deficit',
      params: { taskId: TASK, shortMin: 30 },
    } satisfies Violation);
  });
});

describe.skipIf(!hasDatabase)('coded explanations over HTTP (FU-62)', () => {
  let ctx: TestContext;
  let counter = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  async function newOwner(label: string): Promise<{ ownerId: Id; session: TestSession }> {
    counter += 1;
    const email = `fu62-${label}-${counter}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    await putM5Availability(ctx, session);
    return { ownerId, session };
  }

  async function getPlan(session: TestSession, planId: string): Promise<Plan> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/plans/${planId}`,
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Plan;
  }

  test('plan create and read return explanationItems paired with every explanation line', async () => {
    const { ownerId, session } = await newOwner('plan');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Coded A' });
    // An unsatisfiable second task forces an infeasible candidate with violation lines.
    const tight = await seedPlanTask(ctx, ownerId, {
      title: 'Coded B',
      estimate: { p50Min: 1_200, p90Min: 1_200 },
      dueAt: '2026-11-11T12:00:00Z',
    });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { scope: { taskIds: [task.id, tight.id] }, horizon: M5_HORIZON },
    });
    expect(created.statusCode).toBe(201);
    const plan = created.json() as Plan;
    expect(plan.candidates.length).toBeGreaterThan(0);
    for (const candidate of plan.candidates) expectAligned(candidate);
    const infeasible = plan.candidates.find((candidate) => !candidate.feasible);
    expect(infeasible).toBeDefined();
    const codes = new Set((infeasible?.explanationItems ?? []).map((item) => item.code));
    expect(codes.has('infeasible_summary')).toBe(true);
    expect([...codes].some((code) => code.startsWith('h'))).toBe(true);
    // Params carry IDs and numbers, never titles.
    expect(JSON.stringify(infeasible?.explanationItems)).not.toContain('Coded');

    const read = await getPlan(session, plan.id);
    expect(read.candidates.map((candidate) => candidate.explanationItems)).toEqual(
      plan.candidates.map((candidate) => candidate.explanationItems),
    );
    expect(read.candidates.map((candidate) => candidate.explanation)).toEqual(
      plan.candidates.map((candidate) => candidate.explanation),
    );
  });

  test('a candidate row persisted before FU-62 serializes with explanationItems: []', async () => {
    const { ownerId, session } = await newOwner('legacy');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Legacy A' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { scope: { taskIds: [task.id] }, policies: ['balanced'], horizon: M5_HORIZON },
    });
    expect(created.statusCode).toBe(201);
    const plan = created.json() as Plan;
    const candidate = plan.candidates[0];
    expect(candidate).toBeDefined();
    // Rewrite the row exactly as a pre-FU-62 writer stored it: English lines only.
    const legacyLines = JSON.stringify(candidate?.explanation ?? []);
    await ctx.db
      .updateTable('plan_candidate')
      .set({ explanation: sql<never>`${legacyLines}::jsonb` })
      .where('id', '=', candidate?.id ?? '')
      .execute();
    const read = await getPlan(session, plan.id);
    expect(read.candidates[0]?.explanation).toEqual(candidate?.explanation);
    expect(read.candidates[0]?.explanationItems).toEqual([]);
  });

  test('preview-edit violations and approve 422 constraint_violation carry message codes', async () => {
    const { ownerId, session } = await newOwner('violations');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Overlap A' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { scope: { taskIds: [task.id] }, policies: ['balanced'], horizon: M5_HORIZON },
    });
    const plan = created.json() as Plan;
    const candidate = plan.candidates[0];
    const overlapping = [
      { taskId: task.id, startAt: '2026-11-11T09:00:00Z', endAt: '2026-11-11T10:00:00Z' },
      { taskId: task.id, startAt: '2026-11-11T09:30:00Z', endAt: '2026-11-11T10:30:00Z' },
    ];

    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:preview-edit`,
      headers: authHeaders(session, {
        'if-match': `W/"${plan.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { blocks: overlapping },
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json() as { feasible: boolean; violations: Violation[] };
    expect(previewBody.feasible).toBe(false);
    expect(previewBody.violations.length).toBeGreaterThan(0);
    for (const violation of previewBody.violations) {
      expect(violation.messageCode).toBeDefined();
      expect(violation.messageCode?.startsWith(violation.code.toLowerCase())).toBe(true);
      expect(violation.params).toBeDefined();
    }
    const overlap = previewBody.violations.find((violation) => violation.messageCode === 'h1_same_task_overlap');
    expect(overlap?.params).toEqual({ taskId: task.id });

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${plan.availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { editedBlocks: overlapping },
    });
    expect(approve.statusCode).toBe(422);
    const problem = approve.json() as { code: string; violations: Violation[] };
    expect(problem.code).toBe('constraint_violation');
    expect(problem.violations.map((violation) => violation.messageCode)).toEqual(
      previewBody.violations.map((violation) => violation.messageCode),
    );
    expect(problem.violations.find((violation) => violation.messageCode === 'h7_overallocated')?.params).toEqual({
      taskId: task.id,
      excessMin: 60,
    });
  });

  test('replan proposals carry coded explanations; legacy payloads serialize with []', async () => {
    const { ownerId, session } = await newOwner('replan');
    const a = await seedPlanTask(ctx, ownerId, { title: 'Replan A' });
    const { plan } = await approvedPlan(ctx, session, [a.id]);
    const requested = await requestReplan(ctx, session, { planId: plan.id, affectedTaskIds: [a.id] });
    expect(requested.statusCode).toBe(201);
    const proposal = requested.json() as ReplanProposal;
    expectAligned(proposal.candidate);
    const [listed] = await listProposals(ctx, session, 'pending');
    expect(listed?.candidate.explanationItems).toEqual(proposal.candidate.explanationItems);

    // Approving overlapping edits reports coded findings in the 422 problem.
    const rejected = await approveProposal(ctx, session, proposal, {
      body: {
        editedBlocks: [
          { taskId: a.id, startAt: '2026-11-12T09:00:00Z', endAt: '2026-11-12T10:00:00Z' },
          { taskId: a.id, startAt: '2026-11-12T09:30:00Z', endAt: '2026-11-12T10:30:00Z' },
        ],
      },
    });
    expect(rejected.statusCode).toBe(422);
    const problem = rejected.json() as { code: string; violations: Violation[] };
    expect(problem.code).toBe('constraint_violation');
    expect(problem.violations.some((violation) => violation.messageCode === 'h1_same_task_overlap')).toBe(true);
    for (const violation of problem.violations) expect(violation.messageCode).toBeDefined();

    // A proposal written before FU-62 has no explanationItems in its payload.
    await ctx.db
      .updateTable('replan_proposal')
      .set({ payload: sql<never>`payload #- '{candidate,explanationItems}'` })
      .where('id', '=', proposal.id)
      .execute();
    const [legacy] = await listProposals(ctx, session, 'pending');
    expect(legacy?.id).toBe(proposal.id);
    expect(legacy?.candidate.explanation).toEqual(proposal.candidate.explanation);
    expect(legacy?.candidate.explanationItems).toEqual([]);
  });
});
