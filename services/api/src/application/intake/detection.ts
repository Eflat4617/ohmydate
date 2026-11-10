import type {
  IntakeDetectedType,
  IntakeFieldName,
  IntakeInput,
  TaskTemplate,
} from '@ohmydate/contracts';
import type { IntakeAgentConfig } from './config.js';
import { INTAKE_AGENT_CONFIG } from './config.js';

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

export interface ScoredTemplate {
  readonly template: TaskTemplate;
  readonly score: number;
  readonly tagJaccard: number;
  readonly textSimilarity: number;
  readonly reasons: readonly string[];
}

export function tokenizeText(text: string): ReadonlySet<string> {
  const tokens = text
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return new Set(tokens);
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function inputTokens(input: IntakeInput): ReadonlySet<string> {
  // FU-40: the user-facing title is the canonical similarity text.
  return tokenizeText(input.title);
}

function templateNameTokens(template: TaskTemplate): ReadonlySet<string> {
  return tokenizeText(template.name);
}

function templateTextTokens(template: TaskTemplate): ReadonlySet<string> {
  const parts = [template.name];
  for (const step of template.steps) {
    parts.push(step.title, step.deliverable, step.doneCriteria, step.kind);
  }
  return tokenizeText(parts.join(' '));
}

function metaMatch(template: TaskTemplate): number {
  return template.source === 'system' ? 1 : 0.5;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Deterministic similarity score (05 §3). Candidates are already owner-scoped,
 * so `projectMatch` is 1 for every supplied template; the other terms come
 * from template text. The LLM may only add explanations, never change this
 * classification.
 */
export function scoreTemplate(
  input: IntakeInput,
  template: TaskTemplate,
  config: IntakeAgentConfig = INTAKE_AGENT_CONFIG,
  falsePositiveCount = 0,
): ScoredTemplate {
  const weights = config.similarity.weights;
  const tags = jaccard(inputTokens(input), templateNameTokens(template));
  const text = jaccard(inputTokens(input), templateTextTokens(template));
  const project = 1;
  const meta = metaMatch(template);
  const cappedFalsePositives = Math.min(
    Math.max(0, falsePositiveCount),
    config.similarity.maxFalsePositiveCount,
  );
  const penalty =
    weights.falsePositivePenalty *
    (cappedFalsePositives / config.similarity.maxFalsePositiveCount);
  const score = clamp01(
    weights.tagJaccard * tags +
      weights.projectMatch * project +
      weights.textSimilarity * text +
      weights.metaMatch * meta -
      penalty,
  );
  const reasons = [
    `config:${config.version}`,
    `tag_jaccard=${tags.toFixed(3)}`,
    `text_similarity=${text.toFixed(3)}`,
    ...(cappedFalsePositives > 0
      ? [`false_positive_penalty=${penalty.toFixed(3)}`]
      : []),
    `template=${template.name.slice(0, 120)}`,
  ];
  if (score < config.similarity.similarThreshold && score >= config.similarity.weakThreshold) {
    reasons.push('weak_similarity');
  }
  return { template, score, tagJaccard: tags, textSimilarity: text, reasons };
}

export interface DeterministicDetection {
  readonly detected: IntakeDetectedType;
  readonly template?: TaskTemplate;
}

export function detectTypeDeterministic(
  input: IntakeInput,
  templates: readonly TaskTemplate[],
  missingRequired: readonly IntakeFieldName[],
  config: IntakeAgentConfig = INTAKE_AGENT_CONFIG,
  falsePositiveCounts: ReadonlyMap<string, number> = new Map(),
): DeterministicDetection {
  let best: ScoredTemplate | undefined;
  for (const template of templates) {
    const scored = scoreTemplate(
      input,
      template,
      config,
      falsePositiveCounts.get(template.id) ?? 0,
    );
    if (best === undefined || scored.score > best.score) best = scored;
  }

  const matched = best !== undefined && best.score >= config.similarity.weakThreshold ? best : undefined;

  return {
    detected: {
      classification: matched === undefined ? 'new' : 'similar',
      ...(matched === undefined ? {} : { templateId: matched.template.id }),
      confidence: matched === undefined ? 1 - (best?.score ?? 0) : clamp01(matched.score),
      reasons: (matched?.reasons ?? ['no_similar_template', `config:${config.version}`]).map(
        (reason) => reason.slice(0, 200),
      ),
      missingRequired: [...missingRequired],
    },
    ...(matched === undefined ? {} : { template: matched.template }),
  };
}
