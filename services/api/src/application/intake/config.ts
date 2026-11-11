/**
 * Versioned intake agent configuration (05 §3, §4).
 *
 * Weights are published here rather than inlined at call sites so the
 * deterministic similarity scorer can be audited and versioned with the
 * prompts it accompanies. Changing a weight is a behaviour change and must
 * bump `version`.
 */
export interface IntakeSimilarityWeights {
  readonly tagJaccard: number;
  readonly projectMatch: number;
  readonly textSimilarity: number;
  readonly metaMatch: number;
  readonly falsePositivePenalty: number;
}

export interface IntakeAgentConfig {
  readonly version: string;
  readonly similarity: {
    readonly weights: IntakeSimilarityWeights;
    /** Score at or above this value proposes a similar type (05 §3). */
    readonly similarThreshold: number;
    /** Below `similarThreshold` but at or above this value is a weak proposal. */
    readonly weakThreshold: number;
    /** Denominator cap for `false_positive_count` in the penalty term. */
    readonly maxFalsePositiveCount: number;
  };
  readonly questions: {
    readonly maxPerRound: number;
    readonly maxRounds: number;
  };
}

export const INTAKE_AGENT_CONFIG: IntakeAgentConfig = Object.freeze({
  version: 'intake-agent-config@1',
  similarity: {
    weights: Object.freeze({
      tagJaccard: 0.35,
      projectMatch: 0.25,
      textSimilarity: 0.3,
      metaMatch: 0.1,
      falsePositivePenalty: 0.15,
    }),
    similarThreshold: 0.75,
    weakThreshold: 0.5,
    maxFalsePositiveCount: 3,
  },
  questions: {
    maxPerRound: 5,
    maxRounds: 2,
  },
});
