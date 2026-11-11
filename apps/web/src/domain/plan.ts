import type { PlanCandidate, PlanMetrics, Violation } from '../api';
import { formatDuration, formatPercent, formatSignedDuration } from '../i18n/format';
import { t, tp } from '../i18n';

export type PolicyName = PlanCandidate['policy'];

const POLICIES: readonly PolicyName[] = ['front_loaded', 'balanced', 'focus_blocked'];

function isPolicy(policy: string): policy is PolicyName {
  return (POLICIES as readonly string[]).includes(policy);
}

export function policyLabel(policy: string): string {
  return isPolicy(policy) ? t(`policy.${policy}.label`) : policy;
}

export function policySummary(policy: string): string | null {
  return isPolicy(policy) ? t(`policy.${policy}.summary`) : null;
}

export function violationText(violation: Pick<Violation, 'code'>): string {
  return t(`violation.${violation.code}`);
}

export function metricsRows(metrics: PlanMetrics): Array<{ key: keyof PlanMetrics; label: string; value: string }> {
  return [
    { key: 'totalFocusMin', label: t('metrics.totalFocusMin'), value: formatDuration(metrics.totalFocusMin) },
    { key: 'minSlackMin', label: t('metrics.minSlackMin'), value: formatSignedDuration(metrics.minSlackMin) },
    { key: 'maxDailyLoadMin', label: t('metrics.maxDailyLoadMin'), value: formatDuration(metrics.maxDailyLoadMin) },
    { key: 'avgDailyLoadMin', label: t('metrics.avgDailyLoadMin'), value: formatDuration(metrics.avgDailyLoadMin) },
    {
      key: 'contextSwitches',
      label: t('metrics.contextSwitches'),
      value: tp('metrics.times', metrics.contextSwitches),
    },
    {
      key: 'changedBlocks',
      label: t('metrics.changedBlocks'),
      value: tp('metrics.blocks', metrics.changedBlocks),
    },
    { key: 'deficitMin', label: t('metrics.deficitMin'), value: formatDuration(metrics.deficitMin) },
    {
      key: 'p90CoverageRatio',
      label: t('metrics.p90CoverageRatio'),
      value: formatPercent(metrics.p90CoverageRatio),
    },
  ];
}

/** Map a problem `errors[].path` such as `/blocks/2` onto a block index. */
export function blockIndexFromPath(path: string): number | null {
  const match = /^\/(?:blocks|editedBlocks)\/(\d+)$/.exec(path);
  return match === null ? null : Number(match[1]);
}
