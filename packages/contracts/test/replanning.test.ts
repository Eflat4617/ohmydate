import {
  ESTIMATION_RESET_SCOPES,
  EstimationFeedbackPatchSchema,
  EstimationProfileSchema,
  EstimationResetSchema,
  PROBLEM_CODES,
  REPLAN_PROPOSAL_STATES,
  REPLAN_REASON_CODES,
  REPLAN_TRIGGER_KINDS,
  ReplanProposalPageSchema,
  ReplanProposalSchema,
  ReplanRejectSchema,
  ReplanRequestSchema,
} from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const OTHER_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56';
const VERSION_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c57';
const FEEDBACK_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c58';
const INSTANT = '2026-11-11T09:00:00Z';

const block = {
  taskId: ID,
  startAt: INSTANT,
  endAt: '2026-11-11T10:00:00Z',
};

const proposal = {
  id: ID,
  state: 'pending',
  trigger: {
    kind: 'deadline_risk',
    reason: 'deadline_slack_negative',
    detectedAt: INSTANT,
    affectedTaskIds: [ID, OTHER_ID],
  },
  basePlanVersionId: VERSION_ID,
  availabilityVersion: 4,
  candidate: {
    blocks: [block],
    metrics: {
      totalFocusMin: 60,
      minSlackMin: 15,
      maxDailyLoadMin: 60,
      avgDailyLoadMin: 60,
      contextSwitches: 1,
      changedBlocks: 1,
      deficitMin: 0,
      capacityDeficitMin: 0,
      p90CoverageRatio: 1,
    },
    changedBlocks: 1,
    bound: 4,
    flags: ['scope_extended'],
    explanation: ['Moved one block to protect the deadline.'],
  },
  createdAt: INSTANT,
  expiresAt: '2026-11-11T21:00:00Z',
  version: 1,
};

const profile = {
  generatedAt: INSTANT,
  sampleCount: 12,
  confidence: 0.72,
  method: 'personal_log_ratio_shrinkage',
  shrinkageK: 5,
  outlierZThreshold: 2.5,
  groups: [
    {
      dimension: 'kind',
      key: 'work',
      taskKind: 'work',
      stats: {
        sampleCount: 12,
        logRatioMean: 0.11,
        logRatioStdDev: 0.32,
        p50Ratio: 1.12,
        p90Ratio: 1.48,
      },
      sampleCount: 12,
      confidence: 0.72,
      method: 'personal_log_ratio_shrinkage',
    },
    {
      dimension: 'template',
      key: VERSION_ID,
      templateId: VERSION_ID,
      stats: {
        sampleCount: 0,
        logRatioMean: 0,
        logRatioStdDev: 0,
        p50Ratio: 1,
        p90Ratio: 1.3,
      },
      sampleCount: 0,
      confidence: 0.3,
      method: 'template_prior',
    },
  ],
  items: [
    {
      feedbackId: FEEDBACK_ID,
      taskId: ID,
      taskKind: 'work',
      estimatedP50: 90,
      actualFocusMin: 180,
      ratio: 2,
      zScore: 2.8,
      quality: 'outlier',
      excluded: false,
      createdAt: INSTANT,
      version: 1,
    },
  ],
};

test('replan trigger, state and reason enums cover 05 §11 and 06 §7', () => {
  expect([...REPLAN_TRIGGER_KINDS]).toEqual([
    'deadline_risk',
    'commitment_conflict',
    'early_completion',
    'user_request',
  ]);
  expect([...REPLAN_PROPOSAL_STATES]).toEqual([
    'pending',
    'approved',
    'rejected',
    'expired',
    'superseded',
  ]);
  expect([...REPLAN_REASON_CODES]).toContain('deadline_slack_negative');
  expect([...REPLAN_REASON_CODES]).toContain('user_request');
  expect([...ESTIMATION_RESET_SCOPES]).toEqual(['template', 'all']);
});

test('replan proposal accepts a bounded pending proposal', () => {
  const validate = compile(ReplanProposalSchema);
  expect(validate(proposal)).toBe(true);
  expect(validate({ ...proposal, state: 'approved' })).toBe(true);
  expect(validate({ ...proposal, state: 'superseded' })).toBe(true);

  expect(validate({ ...proposal, state: 'draft' })).toBe(false);
  expect(validate({ ...proposal, extra: true })).toBe(false);
  expect(validate({ ...proposal, availabilityVersion: 0 })).toBe(false);
  expect(validate({ ...proposal, version: 0 })).toBe(false);
  expect(
    validate({
      ...proposal,
      trigger: { ...proposal.trigger, kind: 'capacity_shortfall' },
    }),
  ).toBe(false);
  expect(
    validate({
      ...proposal,
      trigger: { ...proposal.trigger, reason: 'made_up_reason' },
    }),
  ).toBe(false);
  expect(
    validate({ ...proposal, trigger: { ...proposal.trigger, affectedTaskIds: 'all' } }),
  ).toBe(false);
  expect(
    validate({
      ...proposal,
      candidate: { ...proposal.candidate, flags: ['bound_exceeded', 'bound_exceeded'] },
    }),
  ).toBe(false);
  expect(
    validate({ ...proposal, candidate: { ...proposal.candidate, changedBlocks: -1 } }),
  ).toBe(false);
  expect(
    validate({ ...proposal, candidate: { ...proposal.candidate, metrics: { ...proposal.candidate.metrics, changedBlocks: -1 } } }),
  ).toBe(false);
  expect(
    validate({ ...proposal, candidate: { ...proposal.candidate, blocks: [{ ...block, extra: true }] } }),
  ).toBe(false);
});

test('replan proposal page and reject/request bodies match the route contract', () => {
  const page = { items: [proposal], nextCursor: null };
  expect(compile(ReplanProposalPageSchema)(page)).toBe(true);
  expect(compile(ReplanProposalPageSchema)({ items: [proposal] })).toBe(false);
  expect(compile(ReplanProposalPageSchema)({ ...page, extra: true })).toBe(false);

  const reject = compile(ReplanRejectSchema);
  expect(reject({})).toBe(true);
  expect(reject({ reason: 'not now' })).toBe(true);
  expect(reject({ reason: 'x'.repeat(501) })).toBe(false);
  expect(reject({ reason: 'x', extra: true })).toBe(false);

  const request = compile(ReplanRequestSchema);
  expect(request({ planId: ID })).toBe(true);
  expect(request({ planId: ID, reason: 'user_request', affectedTaskIds: [OTHER_ID] })).toBe(true);
  expect(request({ planId: ID, affectedTaskIds: [] })).toBe(false);
  expect(request({ planId: ID, reason: 'deadline_slack_negative', extra: true })).toBe(false);
});

test('estimation profile exposes ratio stats, confidence and excludable items', () => {
  const validate = compile(EstimationProfileSchema);
  expect(validate(profile)).toBe(true);

  expect(validate({ ...profile, confidence: 1.1 })).toBe(false);
  expect(validate({ ...profile, shrinkageK: -1 })).toBe(false);
  expect(validate({ ...profile, extra: true })).toBe(false);
  expect(
    validate({ ...profile, groups: [{ ...profile.groups[0], dimension: 'tag' }] }),
  ).toBe(false);
  expect(
    validate({
      ...profile,
      items: [{ ...profile.items[0], quality: 'maybe' }],
    }),
  ).toBe(false);
  expect(
    validate({
      ...profile,
      items: [{ ...profile.items[0], excluded: 'yes' }],
    }),
  ).toBe(false);
});

test('estimation feedback patch and reset bodies are strict', () => {
  const patch = compile(EstimationFeedbackPatchSchema);
  expect(patch({ excluded: true })).toBe(true);
  expect(patch({ excluded: false })).toBe(true);
  expect(patch({})).toBe(false);
  expect(patch({ excluded: true, extra: true })).toBe(false);

  const reset = compile(EstimationResetSchema);
  expect(reset({ scope: 'all' })).toBe(true);
  expect(reset({ scope: 'template', templateId: ID })).toBe(true);
  expect(reset({ scope: 'template' })).toBe(true);
  expect(reset({ scope: 'everything' })).toBe(false);
  expect(reset({ scope: 'all', extra: true })).toBe(false);
});

test('replan suppression problems are part of the stable code enum', () => {
  expect(PROBLEM_CODES).toContain('replan_suppressed');
  expect(PROBLEM_CODES).toContain('proposal_state_conflict');
});
