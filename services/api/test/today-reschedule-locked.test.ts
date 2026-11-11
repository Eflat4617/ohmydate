import type { TodayProposal } from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import { seedActivePlan, seedAvailability, seedM4Task } from './support/m4-fixtures.js';

/**
 * FU-63 (M5-02R2 LOW): `POST /today:reschedule` must refuse a locked block —
 * alone or mixed with unlocked ones — with 422 validation_failed and must not
 * persist a proposal (today-service reschedule guard). The unlocked-only
 * request is the control that the guard is about the lock, not the request.
 */

const DAY = '2026-11-12';

describe.skipIf(!hasDatabase)('today:reschedule with locked blocks (FU-63)', () => {
  let ctx: TestContext;
  let alice: TestSession;
  let ownerId: Id;
  let unlockedId: Id;
  let lockedId: Id;

  beforeEach(async () => {
    ctx = await createTestContext();
    ownerId = await ctx.seedUser({ email: 'fu63@example.com', password: 'correct-horse' });
    ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
    alice = await login(ctx, 'fu63@example.com', 'correct-horse');
    await seedAvailability(ctx, ownerId);
    const seeded = await seedM4Task(ctx, ownerId, {
      title: 'Locked reschedule',
      dueAt: '2026-11-14T18:00:00Z',
      p50Min: 120,
      p90Min: 120,
    });
    const plan = await seedActivePlan(ctx, ownerId, seeded.task.id, {
      horizonStart: '2026-11-12T00:00:00Z',
      horizonEnd: '2026-11-15T00:00:00Z',
      blockStart: '2026-11-12T10:00:00Z',
      blockEnd: '2026-11-12T11:00:00Z',
    });
    unlockedId = plan.blockId;
    lockedId = ctx.ids.next();
    await ctx.db
      .insertInto('schedule_block')
      .values({
        id: lockedId,
        owner_id: ownerId,
        plan_version_id: plan.planVersionId,
        task_id: seeded.task.id,
        start_at: new Date('2026-11-12T13:00:00Z'),
        end_at: new Date('2026-11-12T14:00:00Z'),
        locked: true,
        status: 'planned',
      })
      .execute();
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function reschedule(blockIds: readonly Id[], key = newIdempotencyKey()) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:reschedule',
      headers: authHeaders(alice, { 'if-match': 'W/"3"', 'idempotency-key': key }),
      payload: { date: DAY, blockIds },
    });
  }

  async function proposalCount(): Promise<number> {
    const row = await ctx.db
      .selectFrom('today_proposal')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async function lockedRow() {
    return ctx.db
      .selectFrom('schedule_block')
      .select(['locked', 'status', 'start_at', 'end_at', 'version'])
      .where('id', '=', lockedId)
      .executeTakeFirstOrThrow();
  }

  function expectLockedValidation(response: Awaited<ReturnType<typeof reschedule>>): void {
    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json() as { code: string; errors?: { path: string; message: string }[] };
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors).toContainEqual({ path: '/blockIds', message: 'a locked block cannot be changed' });
  }

  test('a locked block alone is validation_failed and writes no proposal', async () => {
    const before = await lockedRow();
    const response = await reschedule([lockedId]);
    expectLockedValidation(response);
    expect(await proposalCount()).toBe(0);
    expect(await lockedRow()).toEqual(before);
  });

  test('a mixed locked/unlocked selection is validation_failed and writes no proposal', async () => {
    const response = await reschedule([unlockedId, lockedId]);
    expectLockedValidation(response);
    expect(await proposalCount()).toBe(0);
    const reversed = await reschedule([lockedId, unlockedId]);
    expectLockedValidation(reversed);
    expect(await proposalCount()).toBe(0);
    expect((await lockedRow()).locked).toBe(true);
  });

  test('the 422 is a stored domain result: the same key replays it without writing (08 §1)', async () => {
    const key = newIdempotencyKey();
    expectLockedValidation(await reschedule([unlockedId, lockedId], key));
    const replay = await reschedule([unlockedId, lockedId], key);
    expectLockedValidation(replay);
    expect(await proposalCount()).toBe(0);
  });

  test('control: the unlocked block alone still gets a proposal (negative for the guard)', async () => {
    const response = await reschedule([unlockedId]);
    expect(response.statusCode).toBe(201);
    const proposal = response.json() as TodayProposal;
    expect(proposal.kind).toBe('reschedule');
    expect(proposal.blocks.map((block) => block.blockId)).toEqual([unlockedId]);
    expect(proposal.blocks.some((block) => block.blockId === lockedId)).toBe(false);
    expect(await proposalCount()).toBe(1);
  });
});
