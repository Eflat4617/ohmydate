/**
 * Post-processing for note-grounded decomposition output (`llm.decomposition.v2`).
 *
 * Runs AFTER schema validation (unknown fields such as injected `actions`/`tool_calls`
 * are already rejected there) and BEFORE the deterministic draft rules:
 *
 * - every evidence item must cite a (docId, sectionHash) pair that was actually sent;
 *   unknown ones are removed and reported as `hallucinated_ref` (05 §9);
 * - evidence `stepKeys` must name steps of this draft; unknown keys are removed and
 *   reported the same way;
 * - links copied from untrusted notes are neutralised in every free-text field. Nothing
 *   in the planner executes URLs or commands; this only keeps a planted link out of the
 *   suggestion the user is asked to approve.
 */

import {
  neutralizeLinks,
  partitionGroundedRefs,
  type GroundingIndex,
  type HallucinatedRefReason,
} from './note-context.js';

export interface GroundedEvidenceOutput {
  readonly kind: 'fact' | 'inference';
  readonly docId: string;
  readonly sectionHash: string;
  readonly statement: string;
  readonly stepKeys: readonly string[];
}

export interface GroundedStepOutput {
  readonly key: string;
  readonly title: string;
  readonly deliverable: string;
  readonly doneCriteria: string;
  readonly kind: 'prep' | 'work' | 'review' | 'buffer';
  readonly estimate: { readonly p50Minutes: number; readonly p90Minutes: number };
  readonly dependsOn: readonly string[];
  readonly splittable: boolean;
}

export interface GroundedDecompositionOutput {
  readonly steps: readonly GroundedStepOutput[];
  readonly assumptions: readonly string[];
  readonly questionsRemaining: readonly string[];
  readonly evidence: readonly GroundedEvidenceOutput[];
}

export type GroundedRefIssueReason = HallucinatedRefReason | 'unknown_step';

export interface GroundedRefIssue {
  /** `doc:<id>`, `section:<docId>#<hash>`, `task:<id>` or `step:<key>`; ids only. */
  readonly ref: string;
  readonly reason: GroundedRefIssueReason;
  readonly evidenceIndex: number;
}

export interface GroundedSanitizeResult {
  readonly output: GroundedDecompositionOutput;
  readonly hallucinatedRefs: readonly GroundedRefIssue[];
  readonly linksRemoved: number;
}

const MAX_TEXT = { title: 120, deliverable: 300, doneCriteria: 300, assumption: 200, question: 300, statement: 200 };

/** Cut to at most `max` UTF-16 units (the schema measure) without splitting a pair. */
function truncateCodeUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function sanitizeGroundedDecomposition(
  output: GroundedDecompositionOutput,
  index: GroundingIndex,
): GroundedSanitizeResult {
  let linksRemoved = 0;
  const clean = (text: string, max: number): string => {
    const result = neutralizeLinks(text);
    linksRemoved += result.removed;
    return truncateCodeUnits(result.text, max);
  };

  const steps = output.steps.map((step) => ({
    ...step,
    title: clean(step.title, MAX_TEXT.title),
    deliverable: clean(step.deliverable, MAX_TEXT.deliverable),
    doneCriteria: clean(step.doneCriteria, MAX_TEXT.doneCriteria),
    dependsOn: [...step.dependsOn],
    estimate: { ...step.estimate },
  }));
  const stepKeys = new Set(steps.map((step) => step.key));

  const indexed = output.evidence.map((item, evidenceIndex) => ({ ...item, evidenceIndex }));
  const partition = partitionGroundedRefs(indexed, index);
  const hallucinatedRefs: GroundedRefIssue[] = partition.removed.map(({ item, reason }) => ({
    ref:
      reason === 'unknown_document'
        ? `doc:${item.docId}`
        : reason === 'unknown_section'
          ? `section:${item.docId}#${item.sectionHash}`
          : `task:${String((item as { taskId?: string }).taskId)}`,
    reason,
    evidenceIndex: item.evidenceIndex,
  }));

  const evidence: GroundedEvidenceOutput[] = [];
  for (const item of partition.kept) {
    const keys: string[] = [];
    for (const key of item.stepKeys) {
      if (stepKeys.has(key)) {
        if (!keys.includes(key)) keys.push(key);
      } else {
        hallucinatedRefs.push({ ref: `step:${key}`, reason: 'unknown_step', evidenceIndex: item.evidenceIndex });
      }
    }
    evidence.push({
      kind: item.kind,
      docId: item.docId,
      sectionHash: item.sectionHash,
      statement: clean(item.statement, MAX_TEXT.statement),
      stepKeys: keys,
    });
  }
  hallucinatedRefs.sort((left, right) => left.evidenceIndex - right.evidenceIndex);

  return {
    output: {
      steps,
      assumptions: output.assumptions.map((text) => clean(text, MAX_TEXT.assumption)),
      questionsRemaining: output.questionsRemaining.map((text) => clean(text, MAX_TEXT.question)),
      evidence,
    },
    hallucinatedRefs,
    linksRemoved,
  };
}
