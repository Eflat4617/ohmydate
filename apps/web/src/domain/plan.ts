import type { PlanCandidate, Violation } from '../api';
import { t } from '../i18n';

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

/** Map a problem `errors[].path` such as `/blocks/2` onto a block index. */
export function blockIndexFromPath(path: string): number | null {
  const match = /^\/(?:blocks|editedBlocks)\/(\d+)$/.exec(path);
  return match === null ? null : Number(match[1]);
}
