import {
  replanningRoutes,
  type PlanVersionDto,
  type ReplanProposal,
  type RouteDefinition,
  type ScheduleBlockPage,
} from '@ohmydate/contracts';
import type { InjectOptions } from 'fastify';
import type { Id, Instant } from '@ohmydate/domain';
import { API_PREFIX } from '../src/app.js';
import { ReplanDetectionJob } from '../src/application/replan-detection-job.js';
import { policyWindow } from '../src/application/replan-service.js';
import { PgReplanStore } from '../src/adapters/pg-replan-store.js';
import { createPgSessionLeaderLock } from '../src/adapters/vikunja/reconciler.js';
import {
  authHeaders,
  createTestContext,
  databaseUrl,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import {
  approveProposal,
  approvedPlan,
  availabilityVersion,
  listProposals,
  minutesOf,
  putM5Availability,
  rejectProposal,
  replanServiceFor,
  requestReplan,
  seedPlanTask,
} from './support/m5-fixtures.js';

const START = '2026-11-11T08:00:00Z' as Instant;

function overlaps(
  a: { startAt: string; endAt: string },
  b: { startAt: string; endAt: string },
): boolean {
  return Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(a.endAt) > Date.parse(b.startAt);
}

function keys(blocks: readonly { taskId: string; startAt: string; endAt: string }[]): string[] {
  return blocks
    .map((block) => `${block.taskId}|${Date.parse(block.startAt)}|${Date.parse(block.endAt)}`)
    .sort();
}

describe.skipIf(!hasDatabase)('replan proposals API (M5-02)', () => {
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
    const email = `m5-${label}-${counter}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    await putM5Availability(ctx, session);
    return { ownerId, session };
  }

  async function activeBlocks(session: TestSession) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/schedule-blocks?from=2026-11-10T00:00:00Z&to=2026-11-15T00:00:00Z&limit=100',
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as ScheduleBlockPage).items;
  }

  async function setCurrentEstimate(ownerId: Id, taskId: Id, p50Min: number, p90Min: number) {
    await ctx.db
      .updateTable('estimate')
      .set({ p50_min: p50Min, p90_min: p90Min })
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', taskId)
      .where('is_current', '=', true)
      .execute();
  }

  test('G04: a commitment inserted into the approved plan moves only the hit task; approval keeps history', async () => {
    const { ownerId, session } = await newOwner('g04');
    const tasks = [
      await seedPlanTask(ctx, ownerId, { title: 'A' }),
      await seedPlanTask(ctx, ownerId, { title: 'B' }),
      await seedPlanTask(ctx, ownerId, { title: 'C' }),
    ];
    const { version } = await approvedPlan(ctx, session, tasks.map((task) => task.id));
    const ordered = [...version.blocks].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    expect(ordered.length).toBeGreaterThanOrEqual(3);
    const history = ordered[0];
    const target = ordered[ordered.length - 1];
    if (history === undefined || target === undefined) throw new Error('blocks missing');
    ctx.clock.set(history.endAt as Instant);

    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Dentist', startAt: target.startAt, endAt: target.endAt, timeZone: 'UTC' },
    });
    expect(commitment.statusCode).toBe(201);

    const service = replanServiceFor(ctx);
    expect(await service.runDetection(ctx.clock.now())).toBe(1);
    // Dedupe: the same reason stays a single pending proposal.
    expect(await service.runDetection(ctx.clock.now())).toBe(0);

    const pending = await listProposals(ctx, session, 'pending');
    expect(pending).toHaveLength(1);
    const proposal = pending[0] as ReplanProposal;
    expect(proposal.trigger).toMatchObject({
      kind: 'commitment_conflict',
      reason: 'commitment_overlap',
      affectedTaskIds: [target.taskId],
    });
    expect(proposal.availabilityVersion).toBe(await availabilityVersion(ctx, session));
    const nowMs = Date.parse(ctx.clock.now());
    const untouched = version.blocks.filter(
      (block) => block.taskId !== target.taskId && Date.parse(block.startAt) >= nowMs,
    );
    // Unaffected future blocks are preserved exactly (06 §7).
    expect(keys(proposal.candidate.blocks.filter((block) => block.taskId !== target.taskId))).toEqual(
      keys(untouched),
    );
    expect(
      proposal.candidate.blocks
        .filter((block) => block.taskId === target.taskId)
        .some((block) => overlaps(block, target)),
    ).toBe(false);
    expect(minutesOf(proposal.candidate.blocks, target.taskId)).toBe(60);
    expect(proposal.candidate.changedBlocks).toBeGreaterThan(0);
    expect(proposal.candidate.changedBlocks).toBeLessThanOrEqual(proposal.candidate.bound);
    expect(proposal.candidate.flags).not.toContain('infeasible');

    const notifications = await ctx.db
      .selectFrom('notification')
      .select(['kind', 'dedupe_key'])
      .where('owner_id', '=', ownerId)
      .where('kind', '=', 'replan_proposal')
      .execute();
    expect(notifications).toEqual([{ kind: 'replan_proposal', dedupe_key: `replan_proposal:${proposal.id}` }]);

    const key = newIdempotencyKey();
    const approved = await approveProposal(ctx, session, proposal, { key });
    expect(approved.statusCode).toBe(201);
    const planVersion = approved.json() as PlanVersionDto;
    expect(planVersion).toMatchObject({ createdBy: 'replan', reason: 'replan:commitment_overlap' });
    expect(keys(planVersion.blocks)).toEqual(keys(proposal.candidate.blocks));

    const replay = await approveProposal(ctx, session, proposal, { key });
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as PlanVersionDto).id).toBe(planVersion.id);

    const live = await activeBlocks(session);
    // History is untouched: the past block keeps its id and status.
    expect(live.find((block) => block.id === history.id)).toMatchObject({ status: 'planned' });
    expect(live.some((block) => block.id === target.id)).toBe(false);
    expect(live.filter((block) => overlaps(block, target))).toEqual([]);

    const again = await approveProposal(ctx, session, proposal);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'proposal_state_conflict' });
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/replan-proposals/${proposal.id}`,
      headers: authHeaders(session),
    });
    expect(read.json()).toMatchObject({ state: 'approved' });
  });

  test('approve concurrency: two approvals give exactly one 201; availability change gives 412', async () => {
    const { ownerId, session } = await newOwner('race');
    const a = await seedPlanTask(ctx, ownerId, { title: 'A' });
    const b = await seedPlanTask(ctx, ownerId, { title: 'B' });
    const { plan } = await approvedPlan(ctx, session, [a.id, b.id]);
    const requested = await requestReplan(ctx, session, { planId: plan.id, affectedTaskIds: [a.id] });
    expect(requested.statusCode).toBe(201);
    const proposal = requested.json() as ReplanProposal;
    expect(proposal).toMatchObject({ state: 'pending', trigger: { kind: 'user_request', reason: 'user_request' } });

    const responses = await Promise.all([
      approveProposal(ctx, session, proposal),
      approveProposal(ctx, session, proposal),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toMatchObject({
      code: 'proposal_state_conflict',
    });

    const second = await requestReplan(ctx, session, { planId: plan.id });
    expect(second.statusCode).toBe(201);
    const stale = second.json() as ReplanProposal;
    const missing = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/replan-proposals/${stale.id}:approve`,
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {},
    });
    expect(missing.statusCode).toBe(428);
    const entityTag = await approveProposal(ctx, session, stale, { ifMatch: 'W/"1"' });
    expect(entityTag.statusCode).toBe(400);

    const bumped = await putM5Availability(ctx, session);
    const oldTag = await approveProposal(ctx, session, stale);
    expect(oldTag.statusCode).toBe(412);
    expect(oldTag.json()).toMatchObject({ code: 'availability_changed' });
    // Even with the fresh tag the proposal was computed on the old snapshot.
    const newTag = await approveProposal(ctx, session, stale, {
      ifMatch: `W/"availability:${bumped}"`,
    });
    expect(newTag.statusCode).toBe(412);
    expect(newTag.json()).toMatchObject({ code: 'availability_changed' });
  });

  test('reject suppresses the reason for 24 h; the daily cap returns 409 replan_suppressed with Retry-After', async () => {
    const { ownerId, session } = await newOwner('reject');
    const a = await seedPlanTask(ctx, ownerId, { title: 'A' });
    const { plan } = await approvedPlan(ctx, session, [a.id]);
    const first = await requestReplan(ctx, session, { planId: plan.id });
    expect(first.statusCode).toBe(201);
    const proposal = first.json() as ReplanProposal;

    const stale = await rejectProposal(ctx, session, proposal, { ifMatch: 'W/"9"' });
    expect(stale.statusCode).toBe(412);
    const rejected = await rejectProposal(ctx, session, proposal, { reason: 'not now, private text' });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ state: 'rejected', version: 2 });
    expect(rejected.body).not.toContain('private text');
    const twice = await rejectProposal(ctx, session, { id: proposal.id, version: 2 });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ code: 'proposal_state_conflict' });

    const suppressed = await requestReplan(ctx, session, { planId: plan.id });
    expect(suppressed.statusCode).toBe(409);
    expect(suppressed.json()).toMatchObject({ code: 'replan_suppressed' });
    expect(Number(suppressed.headers['retry-after'])).toBe(24 * 60 * 60);

    const other = await requestReplan(ctx, session, { planId: plan.id, reason: 'dependency_change' });
    expect(other.statusCode).toBe(201);
    // Two proposals today (the rejected one counts): the cap is reached.
    const capped = await requestReplan(ctx, session, { planId: plan.id, reason: 'deadline_slack_negative' });
    expect(capped.statusCode).toBe(409);
    expect(capped.json()).toMatchObject({ code: 'replan_suppressed' });
    // Until the next local (UTC) midnight: 08:00 -> 16 h.
    expect(Number(capped.headers['retry-after'])).toBe(16 * 60 * 60);

    ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
    const tomorrow = await requestReplan(ctx, session, { planId: plan.id, reason: 'deadline_slack_negative' });
    expect(tomorrow.statusCode).toBe(201);
    // 24 h after the rejection the reason is allowed again (this is the 2nd today).
    ctx.clock.set('2026-11-12T08:00:01Z' as Instant);
    const unsuppressed = await requestReplan(ctx, session, { planId: plan.id });
    expect(unsuppressed.statusCode).toBe(201);
  });

  test('a repeated user request supersedes its pending predecessor; unknown scope ids are 422', async () => {
    const { ownerId, session } = await newOwner('supersede');
    const a = await seedPlanTask(ctx, ownerId, { title: 'A' });
    const { plan } = await approvedPlan(ctx, session, [a.id]);
    const first = (await requestReplan(ctx, session, { planId: plan.id })).json() as ReplanProposal;
    const second = await requestReplan(ctx, session, { planId: plan.id });
    expect(second.statusCode).toBe(201);
    const all = await listProposals(ctx, session);
    expect(all.find((entry) => entry.id === first.id)?.state).toBe('superseded');
    expect((await listProposals(ctx, session, 'pending')).map((entry) => entry.id)).toEqual([
      (second.json() as ReplanProposal).id,
    ]);
    const invalid = await requestReplan(ctx, session, {
      planId: plan.id,
      affectedTaskIds: [ctx.ids.next()],
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'validation_failed' });
    const unknownPlan = await requestReplan(ctx, session, { planId: ctx.ids.next() });
    expect(unknownPlan.statusCode).toBe(404);
  });

  test('detection: two concurrent leaders create one proposal; rejection suppresses; base version change expires', async () => {
    const { ownerId, session } = await newOwner('detect');
    const due = await seedPlanTask(ctx, ownerId, {
      title: 'Due today',
      dueAt: '2026-11-11T17:00:00Z',
    });
    const other = await seedPlanTask(ctx, ownerId, { title: 'Other' });
    const { plan } = await approvedPlan(ctx, session, [due.id, other.id]);
    // G09: a 200% underestimate -> P90 remaining 120 > 60 planned -> slack < 0.
    await setCurrentEstimate(ownerId, due.id, 120, 120);

    const leaderKey = 7_000_000 + Math.floor(Math.random() * 1_000_000);
    const jobs = [0, 1].map(
      () =>
        new ReplanDetectionJob({
          runner: replanServiceFor(ctx),
          clock: ctx.clock,
          intervalMs: 60_000,
          leaderLock: createPgSessionLeaderLock({
            connectionString: databaseUrl as string,
            key: leaderKey,
          }),
        }),
    );
    const services = [replanServiceFor(ctx), replanServiceFor(ctx)];
    await Promise.all([
      jobs[0]?.runOnce(),
      jobs[1]?.runOnce(),
      services[0]?.runDetection(ctx.clock.now()),
      services[1]?.runDetection(ctx.clock.now()),
    ]);
    const pending = await listProposals(ctx, session, 'pending');
    expect(pending).toHaveLength(1);
    const proposal = pending[0] as ReplanProposal;
    expect(proposal.trigger).toMatchObject({
      kind: 'deadline_risk',
      reason: 'deadline_slack_negative',
      affectedTaskIds: [due.id],
    });
    expect(minutesOf(proposal.candidate.blocks, due.id)).toBe(120);

    const rejected = await rejectProposal(ctx, session, proposal);
    expect(rejected.statusCode).toBe(200);
    expect(await replanServiceFor(ctx).runDetection(ctx.clock.now())).toBe(0);
    expect(await listProposals(ctx, session, 'pending')).toEqual([]);

    // A different trigger is still allowed and then expires when the base
    // plan version changes underneath it.
    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Overlap',
        startAt: '2026-11-11T00:00:00Z',
        endAt: '2026-11-14T00:00:00Z',
        timeZone: 'UTC',
      },
    });
    expect(commitment.statusCode).toBe(201);
    expect(await replanServiceFor(ctx).runDetection(ctx.clock.now())).toBe(1);
    const conflict = (await listProposals(ctx, session, 'pending'))[0] as ReplanProposal;
    expect(conflict.trigger.kind).toBe('commitment_conflict');
    expect(conflict.candidate.flags).toContain('infeasible');

    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/commitments/${(commitment.json() as { id: string }).id}`,
      headers: authHeaders(session, { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() }),
    });
    // Re-approve the original candidate (a new version of the SAME plan); the
    // estimate goes back to the candidate's 60 minutes so H7 holds.
    await setCurrentEstimate(ownerId, due.id, 60, 60);
    const candidate = plan.candidates[0];
    if (candidate === undefined) throw new Error('candidate missing');
    const reapproved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${await availabilityVersion(ctx, session)}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(reapproved.statusCode).toBe(201);
    const after = await listProposals(ctx, session);
    expect(after.find((entry) => entry.id === conflict.id)?.state).toBe('expired');
    const late = await approveProposal(ctx, session, conflict, {
      ifMatch: `W/"availability:${await availabilityVersion(ctx, session)}"`,
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'proposal_state_conflict' });
  });

  test('detection honours the 2/day cap: three triggers create two proposals', async () => {
    const { ownerId, session } = await newOwner('caps');
    const risky = await seedPlanTask(ctx, ownerId, { title: 'Risky', dueAt: '2026-11-11T17:00:00Z' });
    const hit = await seedPlanTask(ctx, ownerId, { title: 'Hit' });
    const over = await seedPlanTask(ctx, ownerId, { title: 'Over', estimate: { p50Min: 120, p90Min: 120 } });
    const { version } = await approvedPlan(ctx, session, [risky.id, hit.id, over.id]);
    const hitBlock = version.blocks.find((block) => block.taskId === hit.id);
    if (hitBlock === undefined) throw new Error('hit block missing');
    await setCurrentEstimate(ownerId, risky.id, 120, 120);
    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Call', startAt: hitBlock.startAt, endAt: hitBlock.endAt, timeZone: 'UTC' },
    });
    expect(commitment.statusCode).toBe(201);
    await setCurrentEstimate(ownerId, over.id, 60, 60);

    expect(await replanServiceFor(ctx).runDetection(ctx.clock.now())).toBe(2);
    const all = await listProposals(ctx, session);
    expect(all.map((entry) => entry.trigger.kind).sort()).toEqual([
      'commitment_conflict',
      'deadline_risk',
    ]);
    // Capped: nothing else today, even after rejecting both.
    for (const entry of all) {
      expect((await rejectProposal(ctx, session, entry)).statusCode).toBe(200);
    }
    expect(await replanServiceFor(ctx).runDetection(ctx.clock.now())).toBe(0);
  });

  test('G08: an over-estimate proposes freed time without reassigning it; early completion is capped at 1/day', async () => {
    const { ownerId, session } = await newOwner('g08');
    const over = await seedPlanTask(ctx, ownerId, { title: 'Over', estimate: { p50Min: 120, p90Min: 120 } });
    const keep = await seedPlanTask(ctx, ownerId, { title: 'Keep' });
    const second = await seedPlanTask(ctx, ownerId, { title: 'Second', estimate: { p50Min: 120, p90Min: 120 } });
    const { version } = await approvedPlan(ctx, session, [over.id, keep.id, second.id]);
    // 50% over-estimate: remaining shrinks from 120 to 60 minutes.
    await setCurrentEstimate(ownerId, over.id, 60, 60);

    expect(await replanServiceFor(ctx).runDetection(ctx.clock.now())).toBe(1);
    const early = (await listProposals(ctx, session, 'pending'))[0] as ReplanProposal;
    expect(early.trigger).toMatchObject({
      kind: 'early_completion',
      reason: 'early_completion_capacity',
      affectedTaskIds: [over.id],
    });
    expect(minutesOf(early.candidate.blocks, over.id)).toBe(60);
    // Freed time is not reassigned: every other task keeps its exact blocks.
    expect(keys(early.candidate.blocks.filter((block) => block.taskId !== over.id))).toEqual(
      keys(version.blocks.filter((block) => block.taskId !== over.id)),
    );
    expect((await approveProposal(ctx, session, early)).statusCode).toBe(201);

    // A second over-estimate the same day: early completion is capped at one
    // per day even though the 2/day total is not reached.
    await setCurrentEstimate(ownerId, second.id, 60, 60);
    expect(await replanServiceFor(ctx).runDetection(ctx.clock.now())).toBe(0);
    expect(await listProposals(ctx, session, 'pending')).toEqual([]);
    // ... and it is the early-completion cap that blocks it, not a missing trigger.
    const store = new PgReplanStore({ db: ctx.db, clock: ctx.clock, ids: ctx.ids });
    expect(
      await store.checkPolicy(
        ownerId,
        { kind: 'early_completion', reason: 'early_completion_capacity' },
        policyWindow(ctx.clock.now(), 'UTC'),
        'detected',
      ),
    ).toMatchObject({ kind: 'early_completion_cap' });
    expect(
      await store.checkPolicy(
        ownerId,
        { kind: 'deadline_risk', reason: 'deadline_slack_negative' },
        policyWindow(ctx.clock.now(), 'UTC'),
        'detected',
      ),
    ).toBeNull();
  });

  test('owner isolation: another owner sees 404 for every proposal operation', async () => {
    const alice = await newOwner('iso-a');
    const bob = await newOwner('iso-b');
    const task = await seedPlanTask(ctx, alice.ownerId);
    const { plan } = await approvedPlan(ctx, alice.session, [task.id]);
    const proposal = (await requestReplan(ctx, alice.session, { planId: plan.id })).json() as ReplanProposal;

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/replan-proposals/${proposal.id}`,
      headers: authHeaders(bob.session),
    });
    expect(get.statusCode).toBe(404);
    expect((await approveProposal(ctx, bob.session, proposal)).statusCode).toBe(404);
    expect((await rejectProposal(ctx, bob.session, proposal)).statusCode).toBe(404);
    expect((await requestReplan(ctx, bob.session, { planId: plan.id })).statusCode).toBe(404);
    expect(await listProposals(ctx, bob.session)).toEqual([]);
    expect((await listProposals(ctx, alice.session)).map((entry) => entry.id)).toEqual([proposal.id]);
  });

  test('route walk: every replanning route returns only declared statuses', async () => {
    const { session } = await newOwner('walk');
    const id = ctx.ids.next();
    const declared = (route: RouteDefinition, status: number) =>
      Object.keys(route.responses).map(Number).includes(status);
    const required = (route: RouteDefinition) =>
      (route.headers as { required?: readonly string[] } | undefined)?.required ?? [];
    for (const route of replanningRoutes) {
      const headers = authHeaders(session);
      if (required(route).includes('If-Match')) {
        headers['if-match'] =
          route.operationId === 'approveReplanProposal' ? 'W/"availability:1"' : 'W/"1"';
      }
      if (required(route).includes('Idempotency-Key')) {
        headers['idempotency-key'] = newIdempotencyKey();
      }
      const options: InjectOptions = {
        method: route.method.toUpperCase() as NonNullable<InjectOptions['method']>,
        // The contract path is the wire URL; toFastifyPath's `::` is only the
        // router escape for a literal action suffix.
        url: `${API_PREFIX}${route.path.replace('{id}', id)}`,
        headers,
      };
      if (route.body !== undefined) options.payload = {};
      const response = await ctx.app.inject(options);
      expect({
        route: route.operationId,
        status: response.statusCode,
        declared: declared(route, response.statusCode),
      }).toEqual({ route: route.operationId, status: response.statusCode, declared: true });
      if (response.statusCode >= 400) {
        expect(response.headers['content-type']).toContain('application/problem+json');
      }
    }
  });
});
