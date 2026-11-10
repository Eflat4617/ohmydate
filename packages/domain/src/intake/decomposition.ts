/**
 * Deterministic post-validation of an LLM decomposition draft (05 §5).
 *
 * The LLM proposes; these rules decide. Unknown `dependsOn` keys are stripped and reported
 * as `hallucinated_ref` (F2), so the sanitized draft can be shown to the user as a proposal
 * without ever trusting a reference that does not exist in the draft.
 */

import type { Id } from '../brand.js';
import { assertAcyclic, type DependencyEdge } from '../dag.js';
import { DependencyCycleError } from '../errors.js';

export type DecompositionStepKind = 'prep' | 'work' | 'review' | 'buffer';

export interface DecompositionEstimate {
  readonly p50Minutes: number;
  readonly p90Minutes: number;
}

export interface DecompositionStep {
  readonly key: string;
  readonly title: string;
  readonly deliverable: string;
  readonly doneCriteria: string;
  readonly kind: DecompositionStepKind;
  readonly estimate: DecompositionEstimate;
  readonly dependsOn: readonly string[];
  readonly splittable: boolean;
}

export interface DecompositionDraft {
  readonly steps: readonly DecompositionStep[];
  readonly assumptions: readonly string[];
  readonly questionsRemaining: readonly string[];
}

export type DecompositionIssueCode =
  | 'step_count_out_of_range'
  | 'duplicate_key'
  | 'step_too_large'
  | 'p90_less_than_p50'
  | 'missing_review_or_buffer'
  | 'cycle'
  | 'hallucinated_ref';

export interface DecompositionIssue {
  readonly code: DecompositionIssueCode;
  readonly message: string;
  readonly stepKey?: string;
  readonly ref?: string;
  /** Set when the step exceeds the single-step P50 ceiling and must be split. */
  readonly splitRequested?: boolean;
}

export interface DecompositionValidationResult {
  readonly valid: boolean;
  readonly draft: DecompositionDraft;
  readonly issues: readonly DecompositionIssue[];
  readonly hallucinatedRefs: readonly string[];
  readonly splitRequested: boolean;
}

export const MIN_DECOMPOSITION_STEPS = 3;
export const MAX_DECOMPOSITION_STEPS = 12;
export const MAX_STEP_P50_MINUTES = 240;

export function validateDecomposition(draft: DecompositionDraft): DecompositionValidationResult {
  const issues: DecompositionIssue[] = [];
  const hallucinatedRefs: string[] = [];
  let splitRequested = false;

  if (draft.steps.length < MIN_DECOMPOSITION_STEPS || draft.steps.length > MAX_DECOMPOSITION_STEPS) {
    issues.push({
      code: 'step_count_out_of_range',
      message: `expected ${MIN_DECOMPOSITION_STEPS}-${MAX_DECOMPOSITION_STEPS} steps, got ${draft.steps.length}`,
    });
  }

  const keys: string[] = [];
  const duplicateKeys = new Set<string>();
  for (const step of draft.steps) {
    if (keys.includes(step.key)) duplicateKeys.add(step.key);
    else keys.push(step.key);
  }
  for (const key of duplicateKeys) {
    issues.push({
      code: 'duplicate_key',
      message: `duplicate step key: ${key}`,
      stepKey: key,
    });
  }

  const knownKeys = new Set(keys);
  const edges: DependencyEdge[] = [];
  const sanitizedSteps: DecompositionStep[] = [];

  for (const step of draft.steps) {
    if (step.estimate.p50Minutes > MAX_STEP_P50_MINUTES) {
      splitRequested = true;
      issues.push({
        code: 'step_too_large',
        message: `step ${step.key} P50 ${step.estimate.p50Minutes}m exceeds ${MAX_STEP_P50_MINUTES}m; split it`,
        stepKey: step.key,
        splitRequested: true,
      });
    }
    if (step.estimate.p90Minutes < step.estimate.p50Minutes) {
      issues.push({
        code: 'p90_less_than_p50',
        message: `step ${step.key} has P90 ${step.estimate.p90Minutes}m below P50 ${step.estimate.p50Minutes}m`,
        stepKey: step.key,
      });
    }

    const dependsOn: string[] = [];
    for (const ref of step.dependsOn) {
      if (!knownKeys.has(ref)) {
        hallucinatedRefs.push(ref);
        issues.push({
          code: 'hallucinated_ref',
          message: `step ${step.key} depends on unknown key ${ref}; reference removed`,
          stepKey: step.key,
          ref,
        });
        continue;
      }
      dependsOn.push(ref);
      edges.push({ taskId: step.key as unknown as Id, dependsOnTaskId: ref as unknown as Id });
    }

    sanitizedSteps.push({ ...step, dependsOn });
  }

  if (!sanitizedSteps.some((step) => step.kind === 'review' || step.kind === 'buffer')) {
    issues.push({
      code: 'missing_review_or_buffer',
      message: 'at least one review or buffer step is required before the deadline',
    });
  }

  try {
    assertAcyclic(edges);
  } catch (error) {
    if (error instanceof DependencyCycleError) {
      issues.push({
        code: 'cycle',
        message: `dependency cycle: ${error.cycle.join(' -> ')}`,
      });
    } else {
      throw error;
    }
  }

  const sanitized: DecompositionDraft = {
    steps: sanitizedSteps,
    assumptions: draft.assumptions,
    questionsRemaining: draft.questionsRemaining,
  };

  return {
    valid: issues.length === 0,
    draft: sanitized,
    issues,
    hallucinatedRefs,
    splitRequested,
  };
}
