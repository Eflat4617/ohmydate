import { HttpResponse, http } from 'msw';
import type {
  Notification,
  PlanVersion,
  PushSubscription,
  SessionCreate,
  ScheduleBlock,
  SessionReviewRequest,
  TodayProposal,
  WorkSession,
  Export,
} from '../api/client';
import type { ProblemCode } from '../api/errors';
import { layoutClock } from '../layout/clock';
import { createUuidV7, todayScheduleBlock, type MockDb } from './db';
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

const TWO_MINUTES_MS = 2 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'Authentication is required');
}

function parseAvailabilityIfMatch(request: Request): { version: number } | Response {
  const header = request.headers.get('If-Match');
  if (header === null) {
    return problem(428, 'version_conflict', 'If-Match header is required');
  }
  const match = /^W\/"availability:(\d+)"$/.exec(header);
  if (match === null) {
    return problem(400, 'validation_failed', 'If-Match must look like W/"availability:<version>"');
  }
  return { version: Number(match[1]) };
}

function parseNumericIfMatch(request: Request): { version: number } | Response {
  const header = request.headers.get('If-Match');
  if (header === null) {
    return problem(428, 'version_conflict', 'If-Match header is required');
  }
  const match = /^W\/"(\d+)"$/.exec(header);
  if (match === null) {
    return problem(400, 'validation_failed', 'If-Match must look like W/"<version>"');
  }
  return { version: Number(match[1]) };
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function clampInstant(value: string, minMs: number, maxMs: number): string | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
	return new Date(Math.min(maxMs, Math.max(minMs, parsed))).toISOString();
}

function sessionProblem(token: IdempotencyToken, db: MockDb, code: ProblemCode, detail: string): Response {
  return rememberDomainResult(db, token, code === 'session_state_conflict' ? 409 : 409, code, detail, 'Session state conflict');
}

function accumulateFocused(db: MockDb, session: WorkSession, clientMs: number): number {
  const clock = db.sessionClocks.get(session.id);
  if (clock === undefined || clock.activeSince === null) return session.focusedSec;
  return session.focusedSec + Math.max(0, Math.floor((clientMs - clock.activeSince) / 1000));
}

function accumulatePaused(db: MockDb, session: WorkSession, clientMs: number): number {
  const clock = db.sessionClocks.get(session.id);
  if (clock === undefined || clock.pausedSince === null) return session.pausedSec;
  return session.pausedSec + Math.max(0, Math.floor((clientMs - clock.pausedSince) / 1000));
}

function seedNotificationState(db: MockDb): Notification[] {
  return [...db.notifications.values()].sort((left, right) =>
    right.scheduledAt.localeCompare(left.scheduledAt),
  );
}

export function createDailyHandlers(db: MockDb) {
  return [
    http.get(/\/api\/v1\/today(\?.*)?$/, ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const current = `W/"today-${db.todayRevision}-${db.today.version}"`;
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(db.today, 200, { ETag: current });
    }),

    http.post(/\/api\/v1\/today:accept$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseNumericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      if (ifMatch.version !== db.today.version) {
        return rememberDomainResult(
          db,
          token,
          412,
          'version_conflict',
          `Today is at version ${db.today.version}; the request used ${ifMatch.version}`,
        );
      }
      const body = parseBody<{ date?: unknown; blockIds?: unknown }>(raw);
      if (body === undefined || typeof body.date !== 'string') {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'date is required');
      }
      if (body.blockIds !== undefined) {
        if (!Array.isArray(body.blockIds) || body.blockIds.length < 1) {
          return rememberDomainResult(db, token, 422, 'validation_failed', 'blockIds must be a non-empty array');
        }
        const known = new Set(db.today.blocks.map((block) => block.id));
        if (body.blockIds.some((id) => typeof id !== 'string' || !known.has(id))) {
          return rememberDomainResult(db, token, 422, 'validation_failed', 'blockIds contains an unknown block');
        }
      }
      db.today = { ...db.today, version: db.today.version + 1 };
      db.todayRevision += 1;
      const current = etag(db.today.version);
      remember(db, token, 200, db.today, { ETag: current });
      return json(db.today, 200, { ETag: current });
    }),

    http.post(/\/api\/v1\/today:shrink$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseNumericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      if (ifMatch.version !== db.today.version) {
        return rememberDomainResult(
          db,
          token,
          412,
          'version_conflict',
          `Today is at version ${db.today.version}; the request used ${ifMatch.version}`,
        );
      }
      const body = parseBody<{ date?: unknown; blockId?: unknown; targetMin?: unknown }>(raw);
      if (
        body === undefined ||
        typeof body.date !== 'string' ||
        typeof body.blockId !== 'string' ||
        typeof body.targetMin !== 'number' ||
        !Number.isInteger(body.targetMin) ||
        body.targetMin < 1
      ) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'date, blockId and targetMin are required');
      }
      const block = db.today.blocks.find((item) => item.id === body.blockId);
      if (block === undefined) {
        return rememberDomainResult(db, token, 404, 'not_found', 'Block not found');
      }
      const proposal = buildProposal(db, 'shrink', body.date, [
        {
          blockId: block.id,
          taskId: block.taskId,
          startAt: block.startAt,
          endAt: addMinutes(block.startAt, body.targetMin),
        },
      ]);
      const current = etag(proposal.version);
      remember(db, token, 201, proposal, { ETag: current });
      return json(proposal, 201, { ETag: current });
    }),

    http.post(/\/api\/v1\/today:reschedule$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseNumericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      if (ifMatch.version !== db.today.version) {
        return rememberDomainResult(
          db,
          token,
          412,
          'version_conflict',
          `Today is at version ${db.today.version}; the request used ${ifMatch.version}`,
        );
      }
      const body = parseBody<{ date?: unknown; blockIds?: unknown; toDate?: unknown }>(raw);
      if (body === undefined || typeof body.date !== 'string' || !Array.isArray(body.blockIds) || body.blockIds.length < 1) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'date and blockIds are required');
      }
      const ids = body.blockIds.filter((value): value is string => typeof value === 'string');
      if (ids.length !== body.blockIds.length) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'blockIds must contain ids');
      }
      const selected = db.today.blocks.filter((block) => ids.includes(block.id));
      if (selected.length !== ids.length) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'blockIds contains an unknown block');
      }
      const proposal = buildProposal(
        db,
        'reschedule',
        body.date,
        selected.map((block) => ({
          blockId: block.id,
          taskId: block.taskId,
          startAt: addMinutes(block.startAt, 30),
          endAt: addMinutes(block.endAt, 30),
        })),
      );
      const current = etag(proposal.version);
      remember(db, token, 201, proposal, { ETag: current });
      return json(proposal, 201, { ETag: current });
    }),

    http.post(/\/api\/v1\/today\/proposals\/([^/]+):approve$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/today\/proposals\/([^/]+):approve$/.exec(new URL(request.url).pathname);
      const proposalId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseAvailabilityIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const stored = db.proposals.get(proposalId);
      if (stored === undefined) {
        return rememberDomainResult(db, token, 404, 'not_found', 'Proposal not found');
      }
      if (ifMatch.version !== stored.availabilityVersion) {
        return rememberDomainResult(
          db,
          token,
          412,
          'availability_changed',
          `Availability is at version ${stored.availabilityVersion}; the request used ${ifMatch.version}`,
        );
      }
      if (stored.planVersion === undefined) {
        const byBlock = new Map(stored.proposal.blocks.map((block) => [block.blockId, block]));
        db.today = {
          ...db.today,
          version: db.today.version + 1,
          slackMin:
            db.today.slackMin +
            stored.proposal.blocks.reduce((sum, next) => {
              const before = db.today.blocks.find((block) => block.id === next.blockId);
              if (before === undefined) return sum;
              const beforeMin = Math.round((Date.parse(before.endAt) - Date.parse(before.startAt)) / 60_000);
              const afterMin = Math.round((Date.parse(next.endAt) - Date.parse(next.startAt)) / 60_000);
              return sum + Math.max(0, beforeMin - afterMin);
            }, 0),
          blocks: db.today.blocks.map((block) => {
            const replacement = byBlock.get(block.id);
            if (replacement === undefined) return block;
            return { ...block, startAt: replacement.startAt, endAt: replacement.endAt };
          }),
        };
        db.todayRevision += 1;
        const planVersionId = createUuidV7();
        const planVersion: PlanVersion = {
          id: planVersionId,
          planId: '01900000-0000-7000-8000-0000000000d1',
          seq: 1,
          createdBy: 'user',
          availabilityVersion: stored.availabilityVersion,
          version: 1,
          createdAt: new Date().toISOString(),
          blocks: db.today.blocks.map((block) => ({
            id: createUuidV7(),
            planVersionId,
            taskId: block.taskId,
            startAt: block.startAt,
            endAt: block.endAt,
            locked: false,
            status: block.status,
            version: 1,
          })),
        };
        stored.applied = true;
        stored.planVersion = planVersion;
      }
      const current = etag(stored.planVersion.version);
      remember(db, token, 201, stored.planVersion, { ETag: current });
      return json(stored.planVersion, 201, { ETag: current });
    }),

    http.get(/\/api\/v1\/sessions(\?.*)?$/, ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const state = url.searchParams.get('state');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      let items = [...db.sessions.values()];
      if (state !== null) items = items.filter((item) => item.state === state);
      items.sort((left, right) => right.id.localeCompare(left.id));
      const page = items.slice(0, Number.isFinite(limit) ? limit : 20);
      const current = `W/"sessions-${db.sessions.size}-${state ?? 'all'}"`;
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json({ items: page, nextCursor: null }, 200, { ETag: current });
    }),

    http.get(/\/api\/v1\/sessions\/([^/:]+)$/, ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/sessions\/([^/:]+)$/.exec(new URL(request.url).pathname);
      const sessionId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const session = db.sessions.get(sessionId);
      if (session === undefined) return problem(404, 'not_found', 'Session not found');
      const current = etag(session.version);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(session, 200, { ETag: current });
    }),

    http.get(/\/api\/v1\/schedule-blocks(\?.*)?$/, ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const fromMs = Date.parse(url.searchParams.get('from') ?? '');
      const toMs = Date.parse(url.searchParams.get('to') ?? '');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
        return problem(422, 'validation_failed', 'from and to must define a positive range');
      }
      const planVersionId = '01900000-0000-7000-8000-0000000000d1';
      const items: ScheduleBlock[] = [
        ...db.today.blocks.map((block) => todayScheduleBlock(db, block, planVersionId)),
        ...db.extraScheduleBlocks,
      ]
        .filter((block) => Date.parse(block.startAt) < toMs && Date.parse(block.endAt) > fromMs)
        .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
        .slice(0, Number.isFinite(limit) ? limit : 50);
      const current = `W/"schedule-blocks-${db.todayRevision}-${items.length}"`;
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json({ items, nextCursor: null }, 200, { ETag: current });
    }),

    // FU-71: POST /schedule-blocks/{id}:lock|:unlock (pg-planning-store setBlockLock).
    http.post(/\/api\/v1\/schedule-blocks\/([^/:]+):(lock|unlock)$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const match = /\/schedule-blocks\/([^/:]+):(lock|unlock)$/.exec(new URL(request.url).pathname);
      const blockId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const locked = match?.[2] === 'lock';
      const todayBlock = db.today.blocks.find((block) => block.id === blockId);
      const extraIndex = db.extraScheduleBlocks.findIndex((block) => block.id === blockId);
      const current =
        todayBlock !== undefined
          ? todayScheduleBlock(db, todayBlock, '01900000-0000-7000-8000-0000000000d1')
          : db.extraScheduleBlocks[extraIndex];
      if (current === undefined) return problem(404, 'not_found', 'Schedule block not found');
      const ifMatch = parseNumericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      // 412 is not stored (08 §1): the retry with the fresh version may reuse the key.
      if (ifMatch.version !== current.version) {
        return problem(412, 'version_conflict', `The block is at version ${current.version}`);
      }
      if (current.status !== 'planned' || Date.parse(current.startAt) < layoutClock().now()) {
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'Only a planned block that has not started can change', 'State conflict');
      }
      let saved: ScheduleBlock = current;
      if (current.locked !== locked) {
        saved = { ...current, locked, version: current.version + 1 };
        if (todayBlock !== undefined) {
          db.todayBlockLocks.set(blockId, { locked, version: saved.version });
        } else {
          db.extraScheduleBlocks = db.extraScheduleBlocks.map((block, index) => (index === extraIndex ? saved : block));
        }
        // The plan revision covers lock state (Today.version follows it).
        db.today = { ...db.today, version: db.today.version + 1 };
        db.todayRevision += 1;
      }
      const tag = etag(saved.version);
      remember(db, token, 200, saved, { ETag: tag });
      return json(saved, 200, { ETag: tag });
    }),

    http.post(/\/api\/v1\/sessions$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<SessionCreate>(raw);
      if (
        body === undefined ||
        typeof body.taskId !== 'string' ||
        typeof body.clientStartedAt !== 'string' ||
        typeof body.clientId !== 'string'
      ) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'taskId, clientStartedAt and clientId are required');
      }
      const task = db.tasks.get(body.taskId);
      if (task === undefined || task.deletedAt !== undefined) {
        return rememberDomainResult(db, token, 404, 'not_found', 'Task not found');
      }
      if (db.activeSessionId !== null) {
        const active = db.sessions.get(db.activeSessionId);
        if (active !== undefined && (active.state === 'active' || active.state === 'paused')) {
          return rememberDomainResult(db, token, 409, 'active_session_exists', 'An active focus session already exists');
        }
        db.activeSessionId = null;
      }
      const now = Date.now();
      const startedAt = clampInstant(body.clientStartedAt, now - ONE_DAY_MS, now + TWO_MINUTES_MS);
      if (startedAt === null) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'clientStartedAt is not a valid instant');
      }
      const session: WorkSession = {
        id: createUuidV7(),
        taskId: body.taskId,
        ...(body.blockId === undefined ? {} : { blockId: body.blockId }),
        state: 'active',
        startedAt,
        focusedSec: 0,
        pausedSec: 0,
        clientId: body.clientId,
        version: 1,
      };
      db.sessions.set(session.id, session);
      db.sessionClocks.set(session.id, { activeSince: Date.parse(startedAt), pausedSince: null });
      db.activeSessionId = session.id;
      const current = etag(session.version);
      remember(db, token, 201, session, { ETag: current });
      return json(session, 201, { ETag: current });
    }),

    http.post(/\/api\/v1\/sessions\/([^/]+):(pause|resume|complete)$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/sessions\/([^/]+):(pause|resume|complete)$/.exec(new URL(request.url).pathname);
      const sessionId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const event = match?.[2];
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseNumericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const session = db.sessions.get(sessionId);
      if (session === undefined) {
        return rememberDomainResult(db, token, 404, 'not_found', 'Session not found');
      }
      if (session.version !== ifMatch.version) {
        return rememberDomainResult(
          db,
          token,
          412,
          'version_conflict',
          `Session is at version ${session.version}; the request used ${ifMatch.version}`,
        );
      }
      const body = parseBody<{ clientAt?: unknown }>(raw);
      if (body === undefined || typeof body.clientAt !== 'string') {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'clientAt is required');
      }
      const now = Date.now();
      const clientAt = clampInstant(body.clientAt, Date.parse(session.startedAt), now + TWO_MINUTES_MS);
      if (clientAt === null) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'clientAt is not a valid instant');
      }
      const clientMs = Date.parse(clientAt);
      const clock = db.sessionClocks.get(session.id) ?? { activeSince: null, pausedSince: null };
      let updated: WorkSession;
      if (event === 'pause') {
        if (session.state !== 'active') {
          return sessionProblem(token, db, 'session_state_conflict', 'Only an active session can be paused');
        }
        updated = {
          ...session,
          state: 'paused',
          focusedSec: accumulateFocused(db, session, clientMs),
          version: session.version + 1,
        };
        db.sessionClocks.set(session.id, { activeSince: null, pausedSince: clientMs });
      } else if (event === 'resume') {
        if (session.state !== 'paused') {
          return sessionProblem(token, db, 'session_state_conflict', 'Only a paused session can be resumed');
        }
        updated = {
          ...session,
          state: 'active',
          pausedSec: accumulatePaused(db, session, clientMs),
          version: session.version + 1,
        };
        db.sessionClocks.set(session.id, { activeSince: clientMs, pausedSince: null });
      } else {
        if (session.state !== 'active' && session.state !== 'paused') {
          return sessionProblem(token, db, 'session_state_conflict', 'Session is already completed');
        }
        updated = {
          ...session,
          state: 'completed',
          endedAt: clientAt,
          focusedSec: accumulateFocused(db, session, clientMs),
          pausedSec: accumulatePaused(db, session, clientMs),
          version: session.version + 1,
        };
        db.sessionClocks.set(session.id, { activeSince: null, pausedSince: null });
        if (db.activeSessionId === session.id) db.activeSessionId = null;
      }
      void clock;
      db.sessions.set(updated.id, updated);
      const current = etag(updated.version);
      remember(db, token, 200, updated, { ETag: current });
      return json(updated, 200, { ETag: current });
    }),

    http.post('*/api/v1/sessions/:id/review', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseNumericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const session = db.sessions.get(String(params.id));
      if (session === undefined) {
        return rememberDomainResult(db, token, 404, 'not_found', 'Session not found');
      }
      if (session.version !== ifMatch.version) {
        return rememberDomainResult(
          db,
          token,
          412,
          'version_conflict',
          `Session is at version ${session.version}; the request used ${ifMatch.version}`,
        );
      }
      if (session.state !== 'completed') {
        return rememberDomainResult(db, token, 409, 'session_state_conflict', 'Review requires a completed session');
      }
      const body = parseBody<SessionReviewRequest>(raw);
      if (
        body === undefined ||
        typeof body.outcome !== 'string' ||
        !Array.isArray(body.reasonChips) ||
        (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000))
      ) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'Invalid review body');
      }
      if (!['done', 'partial', 'blocked'].includes(body.outcome)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'Unknown session outcome');
      }
      const task = db.tasks.get(session.taskId);
      const estimatedP50 = task?.session?.minMinutes ?? 25;
      const actualFocusMin = Math.max(1, Math.ceil(session.focusedSec / 60));
      const maxMinutes = task?.session?.maxMinutes ?? 90;
      const quality =
        body.outcome === 'blocked'
          ? 'excluded'
          : actualFocusMin > maxMinutes * 2
            ? 'outlier'
            : 'ok';
      const feedback = {
        taskId: session.taskId,
        estimatedP50,
        actualFocusMin,
        quality,
      };
      remember(db, token, 201, feedback);
      return json(feedback, 201);
    }),

    http.get(/\/api\/v1\/notifications(\?.*)?$/, ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const state = url.searchParams.get('state');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      let items = seedNotificationState(db);
      if (state !== null) items = items.filter((item) => item.state === state);
      items = items.slice(0, Number.isFinite(limit) ? limit : 50);
      const current = `W/"notifications-${items.length}-${items[0]?.version ?? 0}"`;
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json({ items, nextCursor: null }, 200, { ETag: current });
    }),

    http.post(/\/api\/v1\/notifications\/([^/]+):dismiss$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/notifications\/([^/]+):dismiss$/.exec(new URL(request.url).pathname);
      const notificationId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseNumericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const notification = db.notifications.get(notificationId);
      if (notification === undefined) {
        return rememberDomainResult(db, token, 404, 'not_found', 'Notification not found');
      }
      if (notification.version !== ifMatch.version) {
        return rememberDomainResult(
          db,
          token,
          412,
          'version_conflict',
          `Notification is at version ${notification.version}; the request used ${ifMatch.version}`,
        );
      }
      const updated: Notification = {
        ...notification,
        state: 'dismissed',
        version: notification.version + 1,
        ...(notification.sentAt === undefined ? { sentAt: notification.scheduledAt } : {}),
      };
      db.notifications.set(updated.id, updated);
      const current = etag(updated.version);
      remember(db, token, 200, updated, { ETag: current });
      return json(updated, 200, { ETag: current });
    }),

    http.post(/\/api\/v1\/push-subscriptions$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<{ endpoint?: unknown; keys?: unknown; deviceLabel?: unknown }>(raw);
      if (
        body === undefined ||
        typeof body.endpoint !== 'string' ||
        !body.endpoint.startsWith('https://') ||
        body.keys === null ||
        typeof body.keys !== 'object'
      ) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'endpoint and keys are required');
      }
      const keys = body.keys as { p256dh?: unknown; auth?: unknown };
      if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'Subscription keys are required');
      }
      const subscription: PushSubscription = {
        id: createUuidV7(),
        endpoint: body.endpoint,
        ...(typeof body.deviceLabel === 'string' ? { deviceLabel: body.deviceLabel } : {}),
        createdAt: new Date().toISOString(),
        version: 1,
      };
      db.pushSubscriptions.set(subscription.id, subscription);
      const current = etag(subscription.version);
      remember(db, token, 201, subscription, { ETag: current });
      return json(subscription, 201, { ETag: current });
    }),

    http.post(/\/api\/v1\/exports$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const exportJob: Export = {
        id: createUuidV7(),
        state: 'queued',
        createdAt: new Date().toISOString(),
      };
      db.exports.set(exportJob.id, exportJob);
      remember(db, token, 202, { exportId: exportJob.id });
      return json({ exportId: exportJob.id }, 202);
    }),

    http.get(/\/api\/v1\/exports\/([^/]+)$/, ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/exports\/([^/]+)$/.exec(new URL(request.url).pathname);
      const exportId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const exportJob = db.exports.get(exportId);
      if (exportJob === undefined) return problem(404, 'not_found', 'Export not found');
      const current = `W/"export-${exportJob.id}-${exportJob.state}"`;
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(exportJob, 200, { ETag: current });
    }),

    http.delete(/\/api\/v1\/push-subscriptions\/([^/]+)$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/push-subscriptions\/([^/]+)$/.exec(new URL(request.url).pathname);
      const subscriptionId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      await request.text();
      const ifMatch = parseNumericIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const subscription = db.pushSubscriptions.get(subscriptionId);
      if (subscription === undefined) return problem(404, 'not_found', 'Push subscription not found');
      if (subscription.version !== ifMatch.version) {
        return problem(412, 'version_conflict', 'Push subscription version mismatch');
      }
      db.pushSubscriptions.delete(subscriptionId);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

function buildProposal(
  db: MockDb,
  kind: TodayProposal['kind'],
  date: string,
  blocks: TodayProposal['blocks'],
): TodayProposal {
  const proposal: TodayProposal = {
    id: createUuidV7(),
    kind,
    date,
    timeZone: db.today.timeZone,
    blocks,
    version: 1,
    createdAt: new Date().toISOString(),
    availabilityVersion: db.today.version + 100,
    basePlanVersionId: '01900000-0000-7000-8000-0000000000d1',
  };
  db.proposals.set(proposal.id, {
    proposal,
    availabilityVersion: proposal.availabilityVersion,
    applied: false,
  });
  return proposal;
}
