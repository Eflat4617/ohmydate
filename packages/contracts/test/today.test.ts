import {
  EstimationFeedbackSchema,
  ExportSchema,
  NotificationQuerySchema,
  NotificationSchema,
  ProblemCodeSchema,
  PushSubscriptionCreateSchema,
  SessionCreateSchema,
  SessionEventRequestSchema,
  SessionReviewRequestSchema,
  TodayProposalSchema,
  TodaySchema,
  WorkSessionSchema,
} from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const OTHER_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56';
const BLOCK_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c57';
const INSTANT = '2026-11-11T09:00:00+09:00';

const block = {
  id: BLOCK_ID,
  taskId: ID,
  title: '관련 논문 5편 요약',
  startAt: INSTANT,
  endAt: '2026-11-11T10:30:00+09:00',
  status: 'planned',
};

const today = {
  date: '2026-11-11',
  timeZone: 'Asia/Seoul',
  blocks: [block],
  slackMin: 200,
  risk: { level: 'low', reasons: [] },
  version: 3,
};

test('Today accepts two to three blocks, signed slack and a risk summary', () => {
  const validate = compile(TodaySchema);
  expect(validate(today)).toBe(true);
  expect(validate({ ...today, blocks: [] })).toBe(true);
  expect(validate({ ...today, slackMin: -45 })).toBe(true);
  expect(validate({ ...today, risk: { level: 'high', reasons: ['slack_negative'] } })).toBe(true);
  expect(validate({ ...today, blocks: [block, block, block] })).toBe(true);
  expect(validate({ ...today, blocks: [block, block, block, block] })).toBe(false);
  expect(validate({ ...today, slackMin: '200' })).toBe(false);
  expect(validate({ ...today, risk: { level: 'critical', reasons: [] } })).toBe(false);
  expect(validate({ ...today, risk: { level: 'low', reasons: [1] } })).toBe(false);
  expect(validate({ ...today, version: 0 })).toBe(false);
  expect(validate({ ...today, extra: true })).toBe(false);
  expect(validate({ ...today, blocks: [{ ...block, extra: true }] })).toBe(false);
});

test('WorkSession is a versioned active/paused/completed/abandoned record', () => {
  const validate = compile(WorkSessionSchema);
  const session = {
    id: ID,
    taskId: OTHER_ID,
    blockId: BLOCK_ID,
    state: 'active',
    startedAt: INSTANT,
    focusedSec: 0,
    pausedSec: 0,
    clientId: 'web-0193',
    version: 1,
  };
  expect(validate(session)).toBe(true);
  for (const state of ['paused', 'completed', 'abandoned']) {
    expect(validate({ ...session, state })).toBe(true);
  }
  expect(validate({ ...session, state: 'running' })).toBe(false);
  expect(validate({ ...session, focusedSec: -1 })).toBe(false);
  expect(validate({ ...session, pausedSec: -1 })).toBe(false);
  expect(validate({ ...session, clientId: '' })).toBe(false);
  expect(validate({ ...session, version: 0 })).toBe(false);
  expect(validate({ ...session, extra: true })).toBe(false);
});

test('SessionCreate requires a client start time and client id', () => {
  const validate = compile(SessionCreateSchema);
  const create = { taskId: ID, blockId: BLOCK_ID, clientStartedAt: INSTANT, clientId: 'web' };
  expect(validate(create)).toBe(true);
  expect(validate({ taskId: ID, clientStartedAt: INSTANT, clientId: 'web' })).toBe(true);
  expect(validate({ ...create, clientStartedAt: undefined })).toBe(false);
  expect(validate({ ...create, clientId: '' })).toBe(false);
  expect(validate({ ...create, extra: true })).toBe(false);
});

test('session events only carry a client timestamp for offline replay', () => {
  const validate = compile(SessionEventRequestSchema);
  expect(validate({ clientAt: INSTANT })).toBe(true);
  expect(validate({})).toBe(false);
  expect(validate({ clientAt: 'yesterday' })).toBe(false);
  expect(validate({ clientAt: INSTANT, extra: true })).toBe(false);
});

test('session review accepts bounded notes and the fixed reason chip enum', () => {
  const validate = compile(SessionReviewRequestSchema);
  const review = { outcome: 'partial', reasonChips: ['interrupted', 'task_larger'] };
  expect(validate(review)).toBe(true);
  expect(validate({ ...review, outcome: 'done' })).toBe(true);
  expect(validate({ ...review, outcome: 'blocked' })).toBe(true);
  expect(validate({ ...review, outcome: 'not_done' })).toBe(false);
  expect(validate({ ...review, reasonChips: ['traffic'] })).toBe(false);
  expect(validate({ ...review, reasonChips: ['interrupted', 'interrupted'] })).toBe(false);
  expect(validate({ ...review, note: 'x'.repeat(2000) })).toBe(true);
  expect(validate({ ...review, note: 'x'.repeat(2001) })).toBe(false);
  expect(validate({ ...review, extra: true })).toBe(false);
});

test('estimation feedback mirrors the M4 learning-input columns', () => {
  const validate = compile(EstimationFeedbackSchema);
  const feedback = { taskId: ID, estimatedP50: 120, actualFocusMin: 95, quality: 'ok' };
  expect(validate(feedback)).toBe(true);
  expect(validate({ ...feedback, quality: 'outlier' })).toBe(true);
  expect(validate({ ...feedback, quality: 'excluded' })).toBe(true);
  expect(validate({ ...feedback, quality: 'great' })).toBe(false);
  expect(validate({ ...feedback, estimatedP50: -1 })).toBe(false);
  expect(validate({ ...feedback, actualFocusMin: -1 })).toBe(false);
  expect(validate({ ...feedback, extra: true })).toBe(false);
});

test('today proposals expose only shrink/reschedule kinds and a version', () => {
  const validate = compile(TodayProposalSchema);
  const proposal = {
    id: ID,
    kind: 'shrink',
    date: '2026-11-11',
    timeZone: 'Asia/Seoul',
    blocks: [
      {
        blockId: BLOCK_ID,
        taskId: OTHER_ID,
        startAt: INSTANT,
        endAt: '2026-11-11T10:00:00+09:00',
      },
    ],
    version: 2,
    createdAt: INSTANT,
  };
  expect(validate(proposal)).toBe(true);
  expect(validate({ ...proposal, kind: 'reschedule' })).toBe(true);
  expect(validate({ ...proposal, kind: 'delete' })).toBe(false);
  expect(validate({ ...proposal, expiresAt: INSTANT })).toBe(true);
  expect(validate({ ...proposal, extra: true })).toBe(false);
  expect(validate({ ...proposal, blocks: [{ ...proposal.blocks[0], extra: true }] })).toBe(false);
});

test('Notification carries dedupe key, channel and state enums', () => {
  const validate = compile(NotificationSchema);
  const notification = {
    id: ID,
    kind: 'deadline_risk',
    dedupeKey: 'deadline:2026-11-20',
    scheduledAt: INSTANT,
    channel: 'push',
    state: 'scheduled',
    version: 1,
  };
  expect(validate(notification)).toBe(true);
  expect(validate({ ...notification, sentAt: INSTANT, state: 'sent' })).toBe(true);
  expect(validate({ ...notification, state: 'dismissed' })).toBe(true);
  expect(validate({ ...notification, state: 'unknown' })).toBe(false);
  expect(validate({ ...notification, channel: 'email' })).toBe(false);
  expect(validate({ ...notification, kind: 'surprise' })).toBe(false);
  expect(validate({ ...notification, dedupeKey: '' })).toBe(false);
  expect(validate({ ...notification, dedupeKey: 'x'.repeat(201) })).toBe(false);
  expect(validate({ ...notification, extra: true })).toBe(false);

  const query = compile(NotificationQuerySchema);
  expect(query({ state: 'sent', limit: 50 })).toBe(true);
  expect(query({ limit: 0 })).toBe(false);
  expect(query({ extra: true })).toBe(false);
});

test('PushSubscriptionCreate requires an https endpoint and both key halves', () => {
  const validate = compile(PushSubscriptionCreateSchema);
  const keys = {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  };
  const create = { endpoint: 'https://push.example.test/sub/abc', keys, deviceLabel: 'Pixel' };
  expect(validate(create)).toBe(true);
  expect(validate({ endpoint: 'https://push.example.test/sub/abc', keys })).toBe(true);
  expect(validate({ ...create, endpoint: 'http://push.example.test/sub/abc' })).toBe(false);
  expect(validate({ ...create, endpoint: 'push.example.test' })).toBe(false);
  expect(validate({ ...create, keys: { p256dh: keys.p256dh } })).toBe(false);
  expect(validate({ ...create, keys: { ...keys, extra: 'x' } })).toBe(false);
  expect(validate({ ...create, keys: { p256dh: '', auth: keys.auth } })).toBe(false);
  expect(validate({ ...create, deviceLabel: '' })).toBe(false);
  expect(validate({ ...create, extra: true })).toBe(false);
});

test('Export models queued/running/ready/failed and a short-lived download URL', () => {
  const validate = compile(ExportSchema);
  const queued = { id: ID, state: 'queued', createdAt: INSTANT };
  expect(validate(queued)).toBe(true);
  for (const state of ['running', 'ready', 'failed']) {
    expect(validate({ ...queued, state })).toBe(true);
  }
  expect(validate({ ...queued, state: 'done' })).toBe(false);
  expect(
    validate({
      ...queued,
      state: 'ready',
      downloadUrl: 'https://exports.example.test/abc.zip',
      expiresAt: '2026-11-12T09:00:00+09:00',
      sizeBytes: 1024,
    }),
  ).toBe(true);
  expect(validate({ ...queued, state: 'failed', failureReason: 'render_failed' })).toBe(true);
  expect(validate({ ...queued, sizeBytes: -1 })).toBe(false);
  expect(validate({ ...queued, downloadUrl: 'not a url' })).toBe(false);
  expect(validate({ ...queued, failureReason: 'x'.repeat(501) })).toBe(false);
  expect(validate({ ...queued, extra: true })).toBe(false);
});

test('M4 problem codes are part of the stable enum', () => {
  const validate = compile(ProblemCodeSchema);
  expect(validate('active_session_exists')).toBe(true);
  expect(validate('session_state_conflict')).toBe(true);
  expect(validate('not_a_code')).toBe(false);
});
