/**
 * Dynamic intake questions (05-AI-AGENT-SPEC §4).
 *
 * Pure and deterministic: the planner removes fields that are already known from the
 * intake input, the user profile, or previous answers, caps each round at five questions
 * and the interview at two rounds, and turns `skip`/`idk` answers into explicit,
 * conservative assumptions. No I/O, no clocks, no randomness.
 */

export const REQUIRED_INTAKE_FIELDS = [
  'deliverable',
  'dueAt',
  'estimatedScope',
  'currentProgress',
  'availabilityConfirmed',
] as const;

export const OPTIONAL_INTAKE_FIELDS = [
  'prerequisites',
  'priority',
  'maxFocusMinutes',
  'reviewNeeded',
] as const;

export type RequiredIntakeField = (typeof REQUIRED_INTAKE_FIELDS)[number];
export type OptionalIntakeField = (typeof OPTIONAL_INTAKE_FIELDS)[number];
export type IntakeField = RequiredIntakeField | OptionalIntakeField;

export const MAX_QUESTIONS_PER_ROUND = 5;
export const MAX_QUESTION_ROUNDS = 2;

export const QUESTION_PROMPTS: Readonly<Record<IntakeField, string>> = {
  deliverable: 'What exactly should be produced as the deliverable?',
  dueAt: 'When is it due?',
  estimatedScope: 'How large does this feel: small, medium, or large?',
  currentProgress: 'How much have you already completed?',
  availabilityConfirmed: 'Are the available work hours for this already confirmed?',
  prerequisites: 'Is anything required before you can start?',
  priority: 'How important is this compared with your other work?',
  maxFocusMinutes: 'What is the longest single focus session you can sustain? (minutes)',
  reviewNeeded: 'Do you need a review or buffer step before the deadline?',
};

/**
 * Conservative fallbacks shown to the user as facts (`assumptions[]`), never silently
 * invented. Values are intentionally conservative in the direction that reduces the
 * chance of an optimistic schedule.
 */
export const CONSERVATIVE_DEFAULTS: Readonly<Record<IntakeField, string>> = {
  deliverable: 'unspecified deliverable (confirm before scheduling)',
  dueAt: 'no deadline assumed',
  estimatedScope: 'use the P90 estimate',
  currentProgress: '0%',
  availabilityConfirmed: 'not confirmed (manual check before approval)',
  prerequisites: 'none assumed',
  priority: '3',
  maxFocusMinutes: '60',
  reviewNeeded: 'true',
};

export type IntakeAnswerAction = 'answer' | 'skip' | 'idk';

export interface IntakeAnswer {
  readonly field: IntakeField;
  readonly action: IntakeAnswerAction;
  readonly value?: unknown;
}

export interface IntakeAssumption {
  readonly field: IntakeField;
  readonly reason: 'skip' | 'idk';
  readonly value: string;
}

export interface PlannedQuestion {
  readonly field: IntakeField;
  readonly prompt: string;
  readonly required: boolean;
  readonly choices: readonly ['answer', 'skip', 'idk'];
}

export interface QuestionPlan {
  readonly round: number;
  readonly questions: readonly PlannedQuestion[];
  readonly assumptions: readonly IntakeAssumption[];
  /** True when no field remains to ask about. */
  readonly complete: boolean;
  /** True when the two-round cap was reached with fields still unanswered. */
  readonly exhausted: boolean;
  /** Fields that remain unanswered once the round/field caps are applied. */
  readonly remainingFields: readonly IntakeField[];
}

export interface QuestionPlannerInput {
  readonly requiredFields?: readonly IntakeField[];
  readonly optionalFields?: readonly IntakeField[];
  /** Values already supplied by the intake form, the user profile, or prior answers. */
  readonly known?: Partial<Record<IntakeField, unknown>>;
  /** Answers collected in earlier rounds. */
  readonly previousAnswers?: readonly IntakeAnswer[];
  /** Fields already asked in earlier rounds (deduplicated across rounds). */
  readonly askedFields?: readonly IntakeField[];
  /** 1-based round number; defaults to 1. */
  readonly round?: number;
  readonly maxPerRound?: number;
}

function isProvided(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

export function isFieldKnown(field: IntakeField, value: unknown): boolean {
  return isProvided(value);
}

export function conservativeAssumptions(
  answers: readonly IntakeAnswer[],
): readonly IntakeAssumption[] {
  const seen = new Set<IntakeField>();
  const assumptions: IntakeAssumption[] = [];
  for (const answer of answers) {
    if (answer.action === 'answer') continue;
    if (seen.has(answer.field)) continue;
    seen.add(answer.field);
    assumptions.push({
      field: answer.field,
      reason: answer.action,
      value: CONSERVATIVE_DEFAULTS[answer.field],
    });
  }
  return assumptions;
}

function clampPerRound(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_QUESTIONS_PER_ROUND;
  return Math.max(0, Math.min(MAX_QUESTIONS_PER_ROUND, Math.floor(value)));
}

/**
 * Plan the next round of questions.
 *
 * Invariants:
 * - a field is never asked when it is already known or was asked before;
 * - at most `MAX_QUESTIONS_PER_ROUND` questions per round and `MAX_QUESTION_ROUNDS` rounds;
 * - `skip`/`idk` answers are recorded as assumptions with conservative defaults;
 * - the output is a pure function of the input (stable ordering).
 */
export function planQuestions(input: QuestionPlannerInput = {}): QuestionPlan {
  const requiredFields = input.requiredFields ?? REQUIRED_INTAKE_FIELDS;
  const optionalFields = input.optionalFields ?? OPTIONAL_INTAKE_FIELDS;
  const known = input.known ?? {};
  const previousAnswers = input.previousAnswers ?? [];
  const asked = new Set<IntakeField>(input.askedFields ?? []);
  const round = Math.max(1, Math.floor(input.round ?? 1));
  const assumptions = conservativeAssumptions(previousAnswers);

  const answeredFields = new Set(previousAnswers.map((answer) => answer.field));
  const providedByAnswer = new Set(
    previousAnswers
      .filter((answer) => answer.action === 'answer' && isProvided(answer.value))
      .map((answer) => answer.field),
  );

  const ordered: { field: IntakeField; required: boolean }[] = [];
  const seen = new Set<IntakeField>();
  for (const field of requiredFields) {
    if (seen.has(field)) continue;
    seen.add(field);
    ordered.push({ field, required: true });
  }
  for (const field of optionalFields) {
    if (seen.has(field)) continue;
    seen.add(field);
    ordered.push({ field, required: false });
  }

  const unresolved: { field: IntakeField; required: boolean }[] = [];
  for (const candidate of ordered) {
    const { field } = candidate;
    if (isProvided(known[field])) continue;
    if (answeredFields.has(field)) continue;
    if (providedByAnswer.has(field)) continue;
    if (asked.has(field)) continue;
    unresolved.push(candidate);
  }

  if (round > MAX_QUESTION_ROUNDS) {
    return {
      round,
      questions: [],
      assumptions,
      complete: unresolved.length === 0,
      exhausted: unresolved.length > 0,
      remainingFields: unresolved.map((candidate) => candidate.field),
    };
  }

  const perRound = clampPerRound(input.maxPerRound);
  const selected = unresolved.slice(0, perRound);
  const questions: PlannedQuestion[] = selected.map((candidate) => ({
    field: candidate.field,
    prompt: QUESTION_PROMPTS[candidate.field],
    required: candidate.required,
    choices: ['answer', 'skip', 'idk'] as const,
  }));

  const remainingFields = unresolved
    .slice(selected.length)
    .map((candidate) => candidate.field);
  const lastRound = round >= MAX_QUESTION_ROUNDS;

  return {
    round,
    questions,
    assumptions,
    complete: unresolved.length === 0,
    exhausted: lastRound && remainingFields.length > 0,
    remainingFields,
  };
}
