import type { PlanMetrics, Violation } from '../api';

export const POLICY_LABELS: Record<string, string> = {
  front_loaded: 'Front-loaded',
  balanced: 'Balanced',
  focus_blocked: 'Focus-blocked',
};

export function policyLabel(policy: string): string {
  return POLICY_LABELS[policy] ?? policy;
}

const VIOLATION_TEXT: Record<Violation['code'], string> = {
  H1: 'Blocks overlap each other, a commitment, or a locked block.',
  H2: 'Block falls outside the available windows.',
  H3: 'A dependency runs before the task it depends on.',
  H4: 'A block misses the earliest start or the deadline buffer.',
  H5: 'Session length is outside the allowed minimum/maximum.',
  H6: 'Daily focus limit or the break rule is exceeded.',
  H7: 'There is not enough available time to place all the work.',
  H8: 'A time is not on the 5-minute grid or the time zone is invalid.',
};

export function violationText(violation: Pick<Violation, 'code'>): string {
  return VIOLATION_TEXT[violation.code];
}

export function metricsRows(metrics: PlanMetrics): Array<{ key: string; label: string; value: string }> {
  return [
    { key: 'totalFocusMin', label: 'Total focus', value: `${metrics.totalFocusMin} min` },
    { key: 'minSlackMin', label: 'Minimum slack', value: signedMinute(metrics.minSlackMin) },
    { key: 'maxDailyLoadMin', label: 'Max daily load', value: `${metrics.maxDailyLoadMin} min` },
    {
      key: 'avgDailyLoadMin',
      label: 'Avg daily load',
      value: `${Math.round(metrics.avgDailyLoadMin * 10) / 10} min`,
    },
    { key: 'contextSwitches', label: 'Context switches', value: String(metrics.contextSwitches) },
    { key: 'changedBlocks', label: 'Changed blocks', value: String(metrics.changedBlocks) },
    { key: 'deficitMin', label: 'Deficit', value: `${metrics.deficitMin} min` },
    {
      key: 'p90CoverageRatio',
      label: 'P90 coverage',
      value: `${Math.round(metrics.p90CoverageRatio * 1000) / 10}%`,
    },
  ];
}

function signedMinute(value: number): string {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  const minutes = `${rounded} min`;
  if (value < 0) return `−${minutes}`;
  if (value === 0) return '0 min';
  return `+${minutes}`;
}

/** Map a problem `errors[].path` such as `/blocks/2` onto a block index. */
export function blockIndexFromPath(path: string): number | null {
  const match = /^\/(?:blocks|editedBlocks)\/(\d+)$/.exec(path);
  return match === null ? null : Number(match[1]);
}
