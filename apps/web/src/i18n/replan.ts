import type {
  EstimationProfileGroup,
  ReplanCandidateFlag,
  ReplanProposalState,
  ReplanReasonCode,
  ReplanTriggerKind,
} from '../api';
import type { BlockChangeKind } from '../domain/replan';
import { retryWait } from '../domain/replan';
import { formatDateTime, formatDuration, formatNumber, formatPercent } from './format';
import { t } from './index';

/**
 * Korean labels for 다시 맞추기 and AI 분석 (M5-03). Every contract
 * enum value has a catalog entry (checked by test/i18n-catalog.spec.ts), so
 * these never fall back to raw codes.
 */

export function triggerLabel(kind: ReplanTriggerKind): string {
  return t(`replan.trigger.${kind}`);
}

export function triggerBody(kind: ReplanTriggerKind): string {
  return t(`replan.triggerBody.${kind}`);
}

export function reasonLabel(reason: ReplanReasonCode): string {
  return t(`replan.reason.${reason}`);
}

/** Short noun for a reason code (dialog copy: "같은 이유(약속과 겹침)의 …"). */
export function reasonShort(reason: ReplanReasonCode): string {
  return t(`replan.reasonShort.${reason}`);
}

export function proposalStateLabel(state: ReplanProposalState): string {
  return t(`replan.state.${state}`);
}

export function flagText(flag: ReplanCandidateFlag): string {
  return t(`replan.flag.${flag}`);
}

export function changeLabel(kind: BlockChangeKind): string {
  return t(`replan.change.${kind}`);
}

export type ConfidenceLevel = 'low' | 'medium' | 'high';

/** n / (n + 5) buckets: below 1/3 is low (cold start stays ≤ 0.3), from 2/3 high. */
export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (!Number.isFinite(confidence) || confidence < 1 / 3) return 'low';
  if (confidence < 2 / 3) return 'medium';
  return 'high';
}

/** `보통 (50%)`. */
export function confidenceText(confidence: number): string {
  const percent = formatPercent(Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0, 0);
  return t(`insights.confidenceLevel.${confidenceLevel(confidence)}`, { percent });
}

/** `1.42배` (actual ÷ estimate). */
export function ratioText(ratio: number): string {
  return t('insights.ratio', { value: formatNumber(Number.isFinite(ratio) ? ratio : 0, 2) });
}

export function groupDimensionLabel(group: Pick<EstimationProfileGroup, 'dimension'>): string {
  return t(`insights.groups.dimension.${group.dimension}`);
}

export function stepKindLabel(kind: NonNullable<EstimationProfileGroup['taskKind']>): string {
  return t(`planSteps.kinds.${kind}`);
}

/**
 * `409 replan_suppressed` with `Retry-After`: "1일 뒤(11월 15일 (일) 오후 6:30)
 * 에 요청할 수 있어요". Without a usable header the generic copy is used.
 */
export function suppressedText(retryAfterSeconds: number | undefined, nowMs: number, timeZone: string): string {
  const wait = retryAfterSeconds === undefined ? null : retryWait(retryAfterSeconds, nowMs);
  if (wait === null) return t('replan.suppressedNoWait');
  return t('replan.suppressed', {
    wait: formatDuration(wait.minutes),
    at: formatDateTime(wait.untilMs, timeZone),
  });
}
