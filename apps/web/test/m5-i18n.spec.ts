import type {
  EstimationProfileGroup,
  EstimationProfileItem,
  ReplanCandidateFlag,
  ReplanProposalState,
  ReplanReasonCode,
  ReplanTriggerKind,
} from '../src/api';
import type { BlockChangeKind } from '../src/domain/replan';
import { lookup, type MessageKey } from '../src/i18n';
import {
  confidenceLevel,
  confidenceText,
  ratioText,
  suppressedText,
  type ConfidenceLevel,
} from '../src/i18n/replan';

const HANGUL = /[가-힣]/;

function expectKorean(key: MessageKey): void {
  const value = lookup(key);
  expect(typeof value, key).toBe('string');
  expect(HANGUL.test(String(value)), `${key} → ${String(value)}`).toBe(true);
}

describe('M5-03 catalog coverage of replan and estimation enums', () => {
  it('has Korean copy for every trigger kind, reason code, proposal state and candidate flag', () => {
    const kinds = {
      deadline_risk: true,
      commitment_conflict: true,
      early_completion: true,
      user_request: true,
    } satisfies Record<ReplanTriggerKind, true>;
    const reasons = {
      deadline_slack_negative: true,
      commitment_overlap: true,
      early_completion_capacity: true,
      dependency_change: true,
      user_request: true,
    } satisfies Record<ReplanReasonCode, true>;
    const states = {
      pending: true,
      approved: true,
      rejected: true,
      expired: true,
      superseded: true,
    } satisfies Record<ReplanProposalState, true>;
    const flags = {
      infeasible: true,
      bound_exceeded: true,
      scope_extended: true,
      capacity_deficit: true,
    } satisfies Record<ReplanCandidateFlag, true>;
    const changes = { moved: true, shrunk: true, extended: true, added: true, removed: true } satisfies Record<
      BlockChangeKind,
      true
    >;
    for (const kind of Object.keys(kinds) as ReplanTriggerKind[]) {
      expectKorean(`replan.trigger.${kind}`);
      expectKorean(`replan.triggerBody.${kind}`);
    }
    for (const reason of Object.keys(reasons) as ReplanReasonCode[]) {
      expectKorean(`replan.reason.${reason}`);
      expectKorean(`replan.reasonShort.${reason}`);
    }
    for (const state of Object.keys(states) as ReplanProposalState[]) expectKorean(`replan.state.${state}`);
    for (const state of ['approved', 'rejected', 'expired', 'superseded'] as const) expectKorean(`replan.stateBody.${state}`);
    for (const flag of Object.keys(flags) as ReplanCandidateFlag[]) expectKorean(`replan.flag.${flag}`);
    for (const change of Object.keys(changes) as BlockChangeKind[]) expectKorean(`replan.change.${change}`);
  });

  it('has Korean copy for estimation dimensions, qualities and confidence levels', () => {
    const dimensions = { template: true, kind: true } satisfies Record<EstimationProfileGroup['dimension'], true>;
    const qualities = { ok: true, outlier: true, excluded: true } satisfies Record<EstimationProfileItem['quality'], true>;
    const levels = { low: true, medium: true, high: true } satisfies Record<ConfidenceLevel, true>;
    for (const dimension of Object.keys(dimensions) as EstimationProfileGroup['dimension'][]) {
      expectKorean(`patterns.dimension.${dimension}`);
    }
    for (const quality of Object.keys(qualities) as EstimationProfileItem['quality'][]) {
      expectKorean(`patterns.quality.${quality}`);
    }
    for (const level of Object.keys(levels) as ConfidenceLevel[]) expectKorean(`patterns.confidenceLevel.${level}`);
  });

  it('formats confidence, ratios and Retry-After waits through Intl', () => {
    expect(confidenceLevel(0)).toBe('low');
    expect(confidenceLevel(0.3)).toBe('low');
    expect(confidenceLevel(0.5)).toBe('medium');
    expect(confidenceLevel(0.75)).toBe('high');
    expect(confidenceLevel(Number.NaN)).toBe('low');
    expect(confidenceText(0.375)).toBe('보통 (38%)');
    expect(confidenceText(1.4)).toBe('높음 (100%)');
    expect(ratioText(1.4166)).toBe('1.42배');
    expect(ratioText(1)).toBe('1배');
    const now = Date.parse('2026-11-14T09:40:00Z');
    expect(suppressedText(86_400, now, 'Asia/Seoul')).toBe(
      '지금은 재계획을 더 요청할 수 없어요. 1일 뒤(11월 15일 (일) 오후 6:40)에 다시 요청할 수 있어요.',
    );
    expect(suppressedText(5_400, now, 'Asia/Seoul')).toBe(
      '지금은 재계획을 더 요청할 수 없어요. 1시간 30분 뒤(11월 14일 (토) 오후 8:10)에 다시 요청할 수 있어요.',
    );
    // Without a usable header the generic copy is used (negative).
    expect(suppressedText(undefined, now, 'Asia/Seoul')).toBe('지금은 재계획을 더 요청할 수 없어요. 잠시 뒤에 다시 시도해 주세요.');
    expect(suppressedText(0, now, 'Asia/Seoul')).toBe('지금은 재계획을 더 요청할 수 없어요. 잠시 뒤에 다시 시도해 주세요.');
  });
});
