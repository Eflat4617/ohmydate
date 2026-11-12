import { sql } from 'kysely';
import type { Id, Instant } from '@ohmydate/domain';
import type { Plan } from '@ohmydate/contracts';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import { M5_HORIZON, putM5Availability, seedPlanTask } from './support/m5-fixtures.js';

const START = '2026-11-11T08:00:00Z' as Instant;

describe.skipIf(!hasDatabase)('plan diversity note codes (FU-68)', () => {
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
    const email = `fu68-${label}-${counter}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    await putM5Availability(ctx, session);
    return { ownerId, session };
  }

  async function createPlan(session: TestSession, taskId: string): Promise<Plan> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { scope: { taskIds: [taskId] }, horizon: M5_HORIZON },
    });
    expect(created.statusCode).toBe(201);
    return created.json() as Plan;
  }

  async function getPlan(session: TestSession, planId: string): Promise<Plan> {
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/plans/${planId}`,
      headers: authHeaders(session),
    });
    expect(read.statusCode).toBe(200);
    return read.json() as Plan;
  }

  test('persists the coded note on the first candidate and returns it on read', async () => {
    const { ownerId, session } = await newOwner('create');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Diversity' });
    const plan = await createPlan(session, task.id);
    expect(plan.candidates.length).toBeGreaterThan(0);
    const first = plan.candidates[0];
    expect(first?.diversityNote).toBeDefined();
    expect(first?.diversityNoteItems?.length).toBeGreaterThan(0);
    for (const item of first?.diversityNoteItems ?? []) {
      expect(['diversity_dropped', 'diversity_distinct', 'replan_bound_exceeded']).toContain(item.code);
      for (const value of Object.values(item.params)) expect(typeof value).toBe('number');
    }
    expect(plan.candidates.slice(1).every((candidate) => candidate.diversityNote === undefined)).toBe(true);

    const read = await getPlan(session, plan.id);
    expect(read.candidates[0]?.diversityNote).toBe(first?.diversityNote);
    expect(read.candidates[0]?.diversityNoteItems).toEqual(first?.diversityNoteItems);
  });

  test('a note persisted before FU-68 keeps the English text and has no items', async () => {
    const { ownerId, session } = await newOwner('legacy');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Legacy diversity' });
    const plan = await createPlan(session, task.id);
    const candidate = plan.candidates[0]!;
    // Remove only the coded envelope, as a pre-FU-68 writer would have stored it.
    const legacyLines = JSON.stringify(candidate.explanation);
    await ctx.db
      .updateTable('plan_candidate')
      .set({ explanation: sql<never>`${legacyLines}::jsonb` })
      .where('id', '=', candidate.id)
      .execute();

    const read = await getPlan(session, plan.id);
    expect(read.candidates[0]?.diversityNote).toBe(candidate.diversityNote);
    expect(read.candidates[0]?.diversityNoteItems).toBeUndefined();
  });
});
