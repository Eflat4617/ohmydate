import { HttpResponse, http } from 'msw';
import type {
  Commitment,
  EstimationProfileItem,
  EstimationReset,
  Notification,
  PlanBlock,
  PlanVersion,
  ReplanCandidate,
  ReplanProposal,
  ReplanReasonCode,
  ReplanRequest,
  ScheduleBlock,
  TodayBlock,
} from '../api/client';
import type { ProblemCode } from '../api/errors';
import {
  REPORT_TEMPLATE_ID,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_TWO_ID,
  USER_ID,
  createUuidV7,
  type MockDb,
} from './db';
import {
  etag,
  json,
  parseBody,
  parseIdempotency,
  problem,
  remember,
  rememberDomainResult,
  type IdempotencyToken,
} from './handlers';
import { emptyEstimationProfile, recomputeProfile } from './replan-seed';

/**
 * M5-03 MSW handlers for replanning (08 §2.6) and "내 패턴" (08 §2.10) plus
 * the synthetic scenario the screens, tests and screenshots use. Semantics
 * follow services/api: approval pins `If-Match: W/"availability:<n>"` (412
 * availability_changed), a non-pending proposal is 409
 * proposal_state_conflict, rejection pins the proposal version and suppresses
 * the reason for 24 h, and a suppressed or over-cap request is a stored
 * 409 replan_suppressed with `Retry-After` seconds.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const REPLAN_DAILY_CAP = 2;

export const MOCK_PLAN_ID = '01900000-0000-7000-8000-0000000000e1';
/** Plan version the Today mock attributes its blocks to (see daily.ts). */
export const MOCK_PLAN_VERSION_ID = '01900000-0000-7000-8000-0000000000d1';
export const REPLAN_PENDING_ID = '01900000-0000-7000-8000-0000000002a1';
export const REPLAN_APPROVED_ID = '01900000-0000-7000-8000-0000000002a2';
export const REPLAN_REJECTED_ID = '01900000-0000-7000-8000-0000000002a3';
export const REPLAN_EXPIRED_ID = '01900000-0000-7000-8000-0000000002a4';
export const REPLAN_NOTIFICATION_ID = '01900000-0000-7000-8000-0000000002c1';
export const LOCKED_BLOCK_ID = '01900000-0000-7000-8000-0000000002b1';
export const LATER_BLOCK_ID = '01900000-0000-7000-8000-0000000002b2';
export const DINNER_COMMITMENT_ID = '01900000-0000-7000-8000-0000000002d1';

/** Where the pending proposal moves the overlapped block (Mon 11:00–11:40 KST). */
export const MOVED_START = '2026-11-16T02:00:00.000Z';
export const MOVED_END = '2026-11-16T02:40:00.000Z';

function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'Authentication is required');
}

function numericIfMatch(request: Request): { version: number } | Response {
  const header = request.headers.get('If-Match');
  if (header === null) return problem(428, 'version_conflict', 'If-Match header is required');
  const match = /^W\/"(\d+)"$/.exec(header);
  if (match === null) return problem(400, 'validation_failed', 'If-Match must look like W/"<version>"');
  return { version: Number(match[1]) };
}

function availabilityIfMatch(request: Request): { version: number } | Response {
  const header = request.headers.get('If-Match');
  if (header === null) return problem(428, 'version_conflict', 'If-Match header is required');
  const match = /^W\/"availability:(\d+)"$/.exec(header);
  if (match === null) {
    return problem(400, 'validation_failed', 'If-Match must look like W/"availability:<version>"');
  }
  return { version: Number(match[1]) };
}

function storedProblem(
  db: MockDb,
  token: IdempotencyToken,
  status: number,
  code: ProblemCode,
  detail: string,
  headers: Record<string, string>,
): Response {
  const body = { type: 'about:blank', title: 'Request failed', status, code, detail };
  const all = { 'Content-Type': 'application/problem+json', ...headers };
  remember(db, token, status, body, all);
  return HttpResponse.json(body, { status, headers: all });
}

function idFrom(request: Request, pattern: RegExp): string {
  const match = pattern.exec(new URL(request.url).pathname);
  return match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
}

function localDate(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(instant),
  );
}

function sortedProposals(db: MockDb): ReplanProposal[] {
  return [...db.replanProposals.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Current approved blocks the way `GET /schedule-blocks` reports them. */
export function mockScheduleBlocks(db: MockDb): ScheduleBlock[] {
  return [
    ...db.today.blocks.map((block) => ({
      id: block.id,
      planVersionId: MOCK_PLAN_VERSION_ID,
      taskId: block.taskId,
      startAt: block.startAt,
      endAt: block.endAt,
      locked: false,
      status: block.status,
      version: 1,
    })),
    ...db.extraScheduleBlocks,
  ];
}

function planTaskIds(db: MockDb, proposal: ReplanProposal): Set<string> {
  return new Set([
    ...proposal.candidate.blocks.map((block) => block.taskId),
    ...proposal.trigger.affectedTaskIds,
    ...mockScheduleBlocks(db)
      .filter((block) => block.planVersionId === proposal.basePlanVersionId)
      .map((block) => block.taskId),
  ]);
}

/** Supersede the plan's unlocked future blocks and insert the candidate (pg-replan-store approve). */
function applyCandidate(db: MockDb, proposal: ReplanProposal): PlanVersion {
  const since = Date.parse(proposal.createdAt);
  const tasks = planTaskIds(db, proposal);
  const keep = (block: { taskId: string; startAt: string; locked?: boolean }) =>
    !tasks.has(block.taskId) || block.locked === true || Date.parse(block.startAt) < since;
  const versionId = createUuidV7();
  const todayBlocks: TodayBlock[] = db.today.blocks.filter((block) => keep({ ...block, locked: false }));
  const extra: ScheduleBlock[] = db.extraScheduleBlocks.filter((block) => keep(block));
  const inserted: ScheduleBlock[] = [];
  for (const block of proposal.candidate.blocks) {
    const row: ScheduleBlock = {
      id: createUuidV7(),
      planVersionId: versionId,
      taskId: block.taskId,
      startAt: block.startAt,
      endAt: block.endAt,
      locked: false,
      status: 'planned',
      version: 1,
    };
    inserted.push(row);
    if (localDate(block.startAt, db.today.timeZone) === db.today.date) {
      todayBlocks.push({
        id: row.id,
        taskId: row.taskId,
        title: db.tasks.get(row.taskId)?.title ?? row.taskId,
        startAt: row.startAt,
        endAt: row.endAt,
        status: 'planned',
      });
    } else {
      extra.push(row);
    }
  }
  todayBlocks.sort((left, right) => left.startAt.localeCompare(right.startAt));
  db.today = { ...db.today, version: db.today.version + 1, blocks: todayBlocks.slice(0, 3) };
  db.todayRevision += 1;
  db.extraScheduleBlocks = extra;
  return {
    id: versionId,
    planId: MOCK_PLAN_ID,
    seq: 2,
    reason: `replan:${proposal.trigger.reason}`,
    createdBy: 'replan',
    availabilityVersion: db.availabilityVersion,
    blocks: inserted,
    version: 1,
    createdAt: new Date().toISOString(),
  };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A user-requested candidate: keep everything and push the latest unlocked block back an hour. */
function requestedCandidate(db: MockDb, since: number): ReplanCandidate {
  const future = mockScheduleBlocks(db)
    .filter((block) => !block.locked && block.status !== 'done' && Date.parse(block.startAt) >= since)
    .sort((left, right) => left.startAt.localeCompare(right.startAt));
  const blocks: PlanBlock[] = future.map((block) => ({ taskId: block.taskId, startAt: block.startAt, endAt: block.endAt }));
  const last = blocks.at(-1);
  if (last !== undefined) {
    blocks[blocks.length - 1] = {
      taskId: last.taskId,
      startAt: new Date(Date.parse(last.startAt) + 60 * 60_000).toISOString(),
      endAt: new Date(Date.parse(last.endAt) + 60 * 60_000).toISOString(),
    };
  }
  const total = blocks.reduce((sum, block) => sum + (Date.parse(block.endAt) - Date.parse(block.startAt)) / 60_000, 0);
  return {
    blocks,
    metrics: {
      totalFocusMin: total,
      minSlackMin: 1_440,
      maxDailyLoadMin: Math.min(total, 300),
      avgDailyLoadMin: total / 3,
      contextSwitches: Math.max(0, blocks.length - 1),
      changedBlocks: last === undefined ? 0 : 2,
      deficitMin: 0,
      capacityDeficitMin: 0,
      p90CoverageRatio: 1,
    },
    changedBlocks: last === undefined ? 0 : 2,
    bound: 2 * blocks.length + 2,
    flags: [],
    explanation: ['User-requested replan over every open task of the plan.', 'Kept every other block in place.'],
  };
}

function proposalDto(
  id: string,
  state: ReplanProposal['state'],
  trigger: ReplanProposal['trigger'],
  candidate: ReplanCandidate,
  availabilityVersion: number,
  createdAt: string,
  version = 1,
): ReplanProposal {
  return {
    id,
    state,
    trigger,
    basePlanVersionId: MOCK_PLAN_VERSION_ID,
    availabilityVersion,
    candidate,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + DAY_MS).toISOString(),
    version,
  };
}

export interface ReplanScenarioOptions {
  /** Add approved / rejected / expired history entries (list screen). */
  readonly history?: boolean;
}

/**
 * Synthetic M5-03 scenario on the 2026-11-14 (Asia/Seoul) mock day: a new
 * dinner commitment overlaps the second Today block, so a pending
 * commitment_conflict proposal moves only that block to Monday. Task one also
 * owns a locked block on Monday that the proposal leaves alone.
 */
export function seedReplanScenario(db: MockDb, options: ReplanScenarioOptions = {}): ReplanProposal {
  const createdAt = '2026-11-14T09:30:00.000Z';
  const one = db.tasks.get(TODAY_TASK_ONE_ID);
  const two = db.tasks.get(TODAY_TASK_TWO_ID);
  if (one !== undefined) db.tasks.set(one.id, { ...one, dueAt: '2026-11-18T09:00:00.000Z' });
  if (two !== undefined) db.tasks.set(two.id, { ...two, dueAt: '2026-11-17T09:00:00.000Z' });
  db.taskRevision += 1;
  db.extraScheduleBlocks = [
    ...db.extraScheduleBlocks,
    {
      id: LOCKED_BLOCK_ID,
      planVersionId: MOCK_PLAN_VERSION_ID,
      taskId: TODAY_TASK_ONE_ID,
      startAt: '2026-11-16T00:00:00.000Z',
      endAt: '2026-11-16T01:00:00.000Z',
      locked: true,
      status: 'planned',
      version: 1,
    },
    {
      id: LATER_BLOCK_ID,
      planVersionId: MOCK_PLAN_VERSION_ID,
      taskId: TODAY_TASK_TWO_ID,
      startAt: '2026-11-17T01:00:00.000Z',
      endAt: '2026-11-17T01:45:00.000Z',
      locked: false,
      status: 'planned',
      version: 1,
    },
  ];
  const dinner: Commitment = {
    id: DINNER_COMMITMENT_ID,
    ownerId: USER_ID,
    title: '저녁 약속',
    startAt: '2026-11-14T11:50:00.000Z',
    endAt: '2026-11-14T13:00:00.000Z',
    timeZone: 'Asia/Seoul',
    source: 'manual',
    version: 1,
    createdAt: '2026-11-14T09:20:00.000Z',
    updatedAt: '2026-11-14T09:20:00.000Z',
  };
  db.commitments.set(dinner.id, dinner);
  db.availabilityVersion += 1;
  db.availability = { ...db.availability, version: db.availabilityVersion };

  const first = db.today.blocks[0];
  const blocks: PlanBlock[] = [
    ...(first === undefined ? [] : [{ taskId: first.taskId, startAt: first.startAt, endAt: first.endAt }]),
    { taskId: TODAY_TASK_TWO_ID, startAt: MOVED_START, endAt: MOVED_END },
    { taskId: TODAY_TASK_TWO_ID, startAt: '2026-11-17T01:00:00.000Z', endAt: '2026-11-17T01:45:00.000Z' },
  ];
  const pending = proposalDto(
    REPLAN_PENDING_ID,
    'pending',
    {
      kind: 'commitment_conflict',
      reason: 'commitment_overlap',
      detectedAt: createdAt,
      affectedTaskIds: [TODAY_TASK_TWO_ID],
    },
    {
      blocks,
      metrics: {
        totalFocusMin: 175,
        minSlackMin: 1_440 + 22 * 60 + 15,
        maxDailyLoadMin: 90,
        avgDailyLoadMin: 58.3,
        contextSwitches: 2,
        changedBlocks: 2,
        deficitMin: 0,
        capacityDeficitMin: 0,
        p90CoverageRatio: 1,
      },
      changedBlocks: 2,
      bound: 4,
      flags: [],
      explanation: [
        'Replan scope: 1 affected task(s) after a commitment overlap.',
        'Changed 2 block(s) within the bound of 4; 2 existing block(s) kept in place.',
      ],
    },
    db.availabilityVersion,
    createdAt,
  );
  db.replanProposals.set(pending.id, pending);

  const notification: Notification = {
    id: REPLAN_NOTIFICATION_ID,
    kind: 'replan_proposal',
    dedupeKey: `replan_proposal:${pending.id}`,
    scheduledAt: createdAt,
    sentAt: createdAt,
    channel: 'in_app',
    state: 'sent',
    version: 1,
  };
  db.notifications.set(notification.id, notification);

  if (options.history === true) {
    const quiet = requestedCandidate(db, Date.parse('2026-11-13T00:00:00.000Z'));
    db.replanProposals.set(
      REPLAN_APPROVED_ID,
      proposalDto(
        REPLAN_APPROVED_ID,
        'approved',
        { kind: 'user_request', reason: 'user_request', detectedAt: '2026-11-13T08:00:00.000Z', affectedTaskIds: [TODAY_TASK_ONE_ID] },
        quiet,
        1,
        '2026-11-13T08:00:00.000Z',
        2,
      ),
    );
    db.replanProposals.set(
      REPLAN_REJECTED_ID,
      proposalDto(
        REPLAN_REJECTED_ID,
        'rejected',
        {
          kind: 'deadline_risk',
          reason: 'deadline_slack_negative',
          detectedAt: '2026-11-12T07:00:00.000Z',
          affectedTaskIds: [TODAY_TASK_TWO_ID],
        },
        { ...quiet, flags: ['capacity_deficit'] },
        1,
        '2026-11-12T07:00:00.000Z',
        2,
      ),
    );
    db.replanProposals.set(
      REPLAN_EXPIRED_ID,
      proposalDto(
        REPLAN_EXPIRED_ID,
        'expired',
        {
          kind: 'early_completion',
          reason: 'early_completion_capacity',
          detectedAt: '2026-11-11T06:00:00.000Z',
          affectedTaskIds: [TODAY_TASK_ONE_ID],
        },
        quiet,
        1,
        '2026-11-11T06:00:00.000Z',
        2,
      ),
    );
  }
  return pending;
}

/** Cold start: no feedback yet. */
export function seedColdEstimation(db: MockDb): void {
  db.estimation = emptyEstimationProfile();
}

export function createReplanHandlers(db: MockDb) {
  return [
    http.get(/\/api\/v1\/replan-proposals(\?.*)?$/, ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const state = url.searchParams.get('state');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      let items = sortedProposals(db);
      if (state !== null) items = items.filter((item) => item.state === state);
      items = items.slice(0, Number.isFinite(limit) ? limit : 20);
      return json({ items, nextCursor: null });
    }),

    http.get(/\/api\/v1\/replan-proposals\/([^/:]+)$/, ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const proposal = db.replanProposals.get(idFrom(request, /\/api\/v1\/replan-proposals\/([^/:]+)$/));
      if (proposal === undefined) return problem(404, 'not_found', 'Replan proposal not found');
      return json(proposal, 200, { ETag: etag(proposal.version) });
    }),

    http.post(/\/api\/v1\/replan-proposals\/([^/]+):approve$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const id = idFrom(request, /\/api\/v1\/replan-proposals\/([^/]+):approve$/);
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = availabilityIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const proposal = db.replanProposals.get(id);
      if (proposal === undefined) return rememberDomainResult(db, token, 404, 'not_found', 'Replan proposal not found');
      if (ifMatch.version !== db.availabilityVersion) {
        // 412 is never stored (08 §1): a retry with a fresh precondition may succeed.
        return problem(
          412,
          'availability_changed',
          `Availability is at version ${db.availabilityVersion}; the request used ${ifMatch.version}`,
        );
      }
      if (proposal.state !== 'pending') {
        return rememberDomainResult(db, token, 409, 'proposal_state_conflict', `Proposal is ${proposal.state}`);
      }
      const version = applyCandidate(db, proposal);
      db.replanProposals.set(id, { ...proposal, state: 'approved', version: proposal.version + 1 });
      for (const other of db.replanProposals.values()) {
        if (other.id !== id && other.state === 'pending' && other.basePlanVersionId === proposal.basePlanVersionId) {
          db.replanProposals.set(other.id, { ...other, state: 'expired', version: other.version + 1 });
        }
      }
      remember(db, token, 201, version, { ETag: etag(version.version) });
      return json(version, 201, { ETag: etag(version.version) });
    }),

    http.post(/\/api\/v1\/replan-proposals\/([^/]+):reject$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const id = idFrom(request, /\/api\/v1\/replan-proposals\/([^/]+):reject$/);
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = numericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const proposal = db.replanProposals.get(id);
      if (proposal === undefined) return rememberDomainResult(db, token, 404, 'not_found', 'Replan proposal not found');
      if (proposal.version !== ifMatch.version) {
        return problem(412, 'version_conflict', `Proposal is at version ${proposal.version}`);
      }
      if (proposal.state !== 'pending') {
        return rememberDomainResult(db, token, 409, 'proposal_state_conflict', `Proposal is ${proposal.state}`);
      }
      const body = parseBody<{ reason?: unknown }>(raw) ?? {};
      if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'reason must be at most 500 characters');
      }
      const rejected: ReplanProposal = { ...proposal, state: 'rejected', version: proposal.version + 1 };
      db.replanProposals.set(id, rejected);
      db.replanSuppressions.set(proposal.trigger.reason, Date.now() + DAY_MS);
      remember(db, token, 200, rejected, { ETag: etag(rejected.version) });
      return json(rejected, 200, { ETag: etag(rejected.version) });
    }),

    http.post(/\/api\/v1\/replan-proposals:request$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<ReplanRequest>(raw);
      if (body === undefined || typeof body.planId !== 'string') {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'planId is required');
      }
      if (body.planId !== MOCK_PLAN_ID && !db.plans.has(body.planId)) {
        return rememberDomainResult(db, token, 404, 'not_found', 'Plan not found');
      }
      const reason: ReplanReasonCode = body.reason ?? 'user_request';
      const now = Date.now();
      const until = db.replanSuppressions.get(reason);
      if (until !== undefined && until > now) {
        return storedProblem(db, token, 409, 'replan_suppressed', 'The same reason is suppressed after a rejection', {
          'Retry-After': String((until - now) / 1000),
        });
      }
      const today = utcDay(now);
      const createdToday = [...db.replanProposals.values()].filter((item) => utcDay(Date.parse(item.createdAt)) === today);
      if (createdToday.length >= REPLAN_DAILY_CAP) {
        const dayEnd = Date.parse(`${today}T00:00:00.000Z`) + DAY_MS;
        return storedProblem(db, token, 409, 'replan_suppressed', 'Daily replan cap reached', {
          'Retry-After': String((dayEnd - now) / 1000),
        });
      }
      for (const other of db.replanProposals.values()) {
        if (other.state === 'pending' && other.trigger.reason === reason) {
          db.replanProposals.set(other.id, { ...other, state: 'superseded', version: other.version + 1 });
        }
      }
      const createdAt = new Date(now).toISOString();
      const candidate = requestedCandidate(db, now);
      const proposal = proposalDto(
        createUuidV7(),
        'pending',
        {
          kind: 'user_request',
          reason,
          detectedAt: createdAt,
          affectedTaskIds: body.affectedTaskIds ?? [...new Set(candidate.blocks.map((block) => block.taskId))].sort(),
        },
        candidate,
        db.availabilityVersion,
        createdAt,
      );
      db.replanProposals.set(proposal.id, proposal);
      remember(db, token, 201, proposal, { ETag: etag(proposal.version) });
      return json(proposal, 201, { ETag: etag(proposal.version) });
    }),

    http.get(/\/api\/v1\/estimation\/profile$/, () => {
      if (!db.authenticated) return unauthenticated();
      return json(db.estimation);
    }),

    http.patch(/\/api\/v1\/estimation\/feedback\/([^/]+)$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const id = idFrom(request, /\/api\/v1\/estimation\/feedback\/([^/]+)$/);
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = numericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const current = db.estimation.items.find((entry) => entry.feedbackId === id);
      if (current === undefined) return rememberDomainResult(db, token, 404, 'not_found', 'Feedback not found');
      if (current.version !== ifMatch.version) {
        return problem(412, 'version_conflict', `Feedback is at version ${current.version}`);
      }
      const body = parseBody<{ excluded?: unknown }>(raw);
      if (body === undefined || typeof body.excluded !== 'boolean') {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'excluded must be a boolean');
      }
      const updated: EstimationProfileItem = { ...current, excluded: body.excluded, version: current.version + 1 };
      db.estimation = recomputeProfile({
        ...db.estimation,
        items: db.estimation.items.map((entry) => (entry.feedbackId === id ? updated : entry)),
      });
      remember(db, token, 200, updated, { ETag: etag(updated.version) });
      return json(updated, 200, { ETag: etag(updated.version) });
    }),

    http.post(/\/api\/v1\/estimation:reset$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<EstimationReset>(raw);
      if (body === undefined || (body.scope !== 'all' && body.scope !== 'template')) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'scope must be template or all');
      }
      if (body.scope === 'template') {
        if (body.templateId === undefined || (body.templateId !== REPORT_TEMPLATE_ID && !db.templates.has(body.templateId))) {
          return rememberDomainResult(db, token, 422, 'validation_failed', 'templateId is required for scope template');
        }
      }
      const items =
        body.scope === 'all' ? [] : db.estimation.items.filter((entry) => entry.templateId !== body.templateId);
      db.estimation = recomputeProfile({ ...db.estimation, items });
      remember(db, token, 200, db.estimation);
      return json(db.estimation);
    }),
  ];
}
