import type { DecompositionDraft, DecompositionStep } from '../api';
import { t } from '../i18n';

export const MIN_STEPS = 3;
export const MAX_STEPS = 12;
export const MAX_STEP_P50_MINUTES = 240;

export type DraftIssueCode =
  | 'step_count_out_of_range'
  | 'duplicate_key'
  | 'step_too_large'
  | 'p90_less_than_p50'
  | 'missing_review_or_buffer'
  | 'cycle'
  | 'unknown_ref';

export interface DraftIssue {
  readonly code: DraftIssueCode;
  readonly message: string;
  readonly stepKey?: string;
  readonly ref?: string;
}

export interface DraftValidationResult {
  readonly valid: boolean;
  readonly issues: readonly DraftIssue[];
}

function hasCycle(steps: readonly DecompositionStep[]): string[] | null {
  const dependencies = new Map<string, readonly string[]>();
  for (const step of steps) dependencies.set(step.key, step.dependsOn);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(key: string): string[] | null {
    if (visiting.has(key)) {
      const start = path.indexOf(key);
      return [...path.slice(start >= 0 ? start : 0), key];
    }
    if (visited.has(key)) return null;
    visiting.add(key);
    path.push(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (dependencies.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      }
    }
    path.pop();
    visiting.delete(key);
    visited.add(key);
    return null;
  }

  for (const step of steps) {
    const cycle = visit(step.key);
    if (cycle !== null) return cycle;
  }
  return null;
}

export function validateDraft(draft: DecompositionDraft): DraftValidationResult {
  const issues: DraftIssue[] = [];
  const { steps } = draft;

  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    issues.push({
      code: 'step_count_out_of_range',
      message: t('draft.stepCount', { min: MIN_STEPS, max: MAX_STEPS, count: steps.length }),
    });
  }

  const keys: string[] = [];
  const duplicates = new Set<string>();
  for (const step of steps) {
    if (keys.includes(step.key)) duplicates.add(step.key);
    else keys.push(step.key);
  }
  for (const key of duplicates) {
    issues.push({ code: 'duplicate_key', message: t('draft.duplicateKey'), stepKey: key });
  }

  const known = new Set(keys);
  for (const step of steps) {
    if (step.estimate.p50Minutes > MAX_STEP_P50_MINUTES) {
      issues.push({
        code: 'step_too_large',
        message: t('draft.stepTooLarge', { max: MAX_STEP_P50_MINUTES }),
        stepKey: step.key,
      });
    }
    if (step.estimate.p90Minutes < step.estimate.p50Minutes) {
      issues.push({
        code: 'p90_less_than_p50',
        message: t('draft.p90LessThanP50'),
        stepKey: step.key,
      });
    }
    for (const ref of step.dependsOn) {
      if (!known.has(ref)) {
        issues.push({
          code: 'unknown_ref',
          message: t('draft.unknownRef'),
          stepKey: step.key,
          ref,
        });
      }
    }
  }

  if (!steps.some((step) => step.kind === 'review' || step.kind === 'buffer')) {
    issues.push({
      code: 'missing_review_or_buffer',
      message: t('draft.missingReviewOrBuffer'),
    });
  }

  const cycle = hasCycle(steps);
  if (cycle !== null) {
    // A person reads step numbers, not the draft's internal keys.
    const position = (key: string): string => t('planSteps.step', { index: steps.findIndex((step) => step.key === key) + 1 });
    issues.push({ code: 'cycle', message: t('draft.cycle', { cycle: cycle.map(position).join(' → ') }) });
  }

  return { valid: issues.length === 0, issues };
}

export function issuesForStep(
  result: DraftValidationResult,
  stepKey: string,
): readonly DraftIssue[] {
  return result.issues.filter((issue) => issue.stepKey === stepKey);
}

export function generalIssues(result: DraftValidationResult): readonly DraftIssue[] {
  return result.issues.filter((issue) => issue.stepKey === undefined);
}
