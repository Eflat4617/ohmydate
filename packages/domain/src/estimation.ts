/**
 * Pure time estimator (05 §6, §10). No I/O: callers load samples and base
 * estimates, this module classifies, shrinks and produces P50/P90 intervals
 * with confidence, method and evidence.
 *
 * Model
 * - Priors are log-normal per decomposition step kind (versioned table below);
 *   a template step's own interval is the template prior.
 * - A learning sample is `logRatio = ln(actualFocusMin / estimatedP50)`. Only
 *   the latest non-excluded usable feedback per task counts (later reviews of
 *   the same task carry the cumulative actual, so earlier rows are superseded).
 * - Outliers: leave-one-out z-score inside the sample's most specific group
 *   (template, else kind, else all). |z| > 2.5 => `quality = 'outlier'`,
 *   excluded from statistics. Fewer than three other samples => no z test.
 * - Personal correction: Bayesian shrinkage of the mean log-ratio toward the
 *   prior mean 0 with prior weight k = 5: `m = n * mean / (n + k)`.
 *   P50 = base P50 * e^m; P90 = max(P50, base P90 * e^m * e^(z90 * tau)) with
 *   `tau = sd * sqrt(n / (n + k))` (the personal spread, shrunk the same way).
 * - Cold start: template prior; else LLM estimate x 1.3 with confidence <= 0.3;
 *   else the kind prior. A user-edited draft estimate is kept as stated and
 *   recorded with method `personal` (FU-48; the stored method enum is
 *   prior/template/personal/llm, 04 §2).
 * - All minute outputs are rounded up to the scheduler's 5-minute grid.
 */

export const ESTIMATION_PRIORS_VERSION = 'estimation-priors@1' as const;
export const ESTIMATOR_VERSION = 'estimator@1' as const;
export const SHRINKAGE_K = 5;
export const OUTLIER_Z_THRESHOLD = 2.5;
export const LLM_COLD_START_FACTOR = 1.3;
export const LLM_COLD_START_MAX_CONFIDENCE = 0.3;
export const ESTIMATE_GRID_MIN = 5;
/** Standard-normal 90th percentile. */
export const Z90 = 1.2815515655446004;
/** Minimum number of *other* samples before a z-score is meaningful. */
export const MIN_OUTLIER_REFERENCE = 3;
/** Floor for the reference spread (log units) so identical samples do not divide by 0. */
export const LOG_SPREAD_FLOOR = 0.1;
const MAX_CONFIDENCE = 0.9;
const MAX_MINUTES = 100_000;

export type EstimateMethod = 'prior' | 'template' | 'personal' | 'llm';
export type EstimationStepKind = 'prep' | 'work' | 'review' | 'buffer';
export type EstimationQualityValue = 'ok' | 'outlier';

export interface LogNormalPrior {
  readonly mu: number;
  readonly sigma: number;
}

export interface EstimationPriorTable {
  readonly version: string;
  readonly kinds: Readonly<Record<EstimationStepKind, LogNormalPrior>>;
  readonly fallback: LogNormalPrior;
}

/** [가정] initial priors (05 §6 `estimator/priors.json`), versioned. */
export const ESTIMATION_PRIORS: EstimationPriorTable = {
  version: ESTIMATION_PRIORS_VERSION,
  kinds: {
    prep: { mu: Math.log(30), sigma: 0.5 },
    work: { mu: Math.log(90), sigma: 0.6 },
    review: { mu: Math.log(45), sigma: 0.5 },
    buffer: { mu: Math.log(30), sigma: 0.4 },
  },
  fallback: { mu: Math.log(60), sigma: 0.6 },
};

export interface EstimateInterval {
  readonly p50Min: number;
  readonly p90Min: number;
}

export type EstimateEvidenceKind =
  | 'prior'
  | 'template'
  | 'llm'
  | 'user_edit'
  | 'personal_correction';

/** Evidence item: numbers and references only, never personal text. */
export interface EstimateEvidence {
  readonly kind: EstimateEvidenceKind;
  readonly ref?: string;
  readonly summary: string;
}

export interface EstimateResult extends EstimateInterval {
  readonly method: EstimateMethod;
  readonly confidence: number;
  readonly evidence: readonly EstimateEvidence[];
}

/** Round up to the 5-minute grid, clamped to [5, 100000]. */
export function roundUpToGrid(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= ESTIMATE_GRID_MIN) return ESTIMATE_GRID_MIN;
  const rounded = Math.ceil(minutes / ESTIMATE_GRID_MIN - 1e-9) * ESTIMATE_GRID_MIN;
  return Math.min(MAX_MINUTES, rounded);
}

function gridInterval(p50: number, p90: number): EstimateInterval {
  const p50Min = roundUpToGrid(p50);
  return { p50Min, p90Min: Math.max(p50Min, roundUpToGrid(p90)) };
}

export function priorInterval(prior: LogNormalPrior): EstimateInterval {
  return gridInterval(Math.exp(prior.mu), Math.exp(prior.mu + Z90 * prior.sigma));
}

/** Log-normal fitted to a P50/P90 pair (template step prior). */
export function logNormalFromInterval(interval: EstimateInterval): LogNormalPrior {
  const p50 = Math.max(1, interval.p50Min);
  const p90 = Math.max(p50, interval.p90Min);
  return { mu: Math.log(p50), sigma: (Math.log(p90) - Math.log(p50)) / Z90 };
}

function clampConfidence(value: number, max = 1): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

export interface ColdStartInput {
  /** The user edited this draft estimate (FU-48): kept as stated. */
  readonly user?: EstimateInterval;
  /** Template step interval (template prior). */
  readonly template?: EstimateInterval;
  readonly templateId?: string;
  /** LLM-proposed interval; inflated by the conservative factor. */
  readonly llm?: EstimateInterval;
  readonly kind?: EstimationStepKind;
  readonly priors?: EstimationPriorTable;
}

/**
 * 05 §6 cold start. Precedence: user edit > template prior > LLM x 1.3 >
 * kind prior.
 */
export function coldStartEstimate(input: ColdStartInput): EstimateResult {
  if (input.user !== undefined) {
    const interval = gridInterval(input.user.p50Min, input.user.p90Min);
    return {
      ...interval,
      method: 'personal',
      confidence: 0.5,
      evidence: [{ kind: 'user_edit', summary: `user-edited draft estimate ${interval.p50Min}/${interval.p90Min} min` }],
    };
  }
  if (input.template !== undefined) {
    const interval = gridInterval(input.template.p50Min, input.template.p90Min);
    return {
      ...interval,
      method: 'template',
      confidence: 0.6,
      evidence: [
        {
          kind: 'template',
          ...(input.templateId === undefined ? {} : { ref: input.templateId }),
          summary: `template prior ${interval.p50Min}/${interval.p90Min} min`,
        },
      ],
    };
  }
  if (input.llm !== undefined) {
    const interval = gridInterval(
      input.llm.p50Min * LLM_COLD_START_FACTOR,
      input.llm.p90Min * LLM_COLD_START_FACTOR,
    );
    return {
      ...interval,
      method: 'llm',
      confidence: LLM_COLD_START_MAX_CONFIDENCE,
      evidence: [
        {
          kind: 'llm',
          summary: `llm estimate ${input.llm.p50Min}/${input.llm.p90Min} min x ${LLM_COLD_START_FACTOR}`,
        },
      ],
    };
  }
  const priors = input.priors ?? ESTIMATION_PRIORS;
  const prior = input.kind === undefined ? priors.fallback : priors.kinds[input.kind];
  const interval = priorInterval(prior);
  return {
    ...interval,
    method: 'prior',
    confidence: 0.2,
    evidence: [
      {
        kind: 'prior',
        ref: `${priors.version}:${input.kind ?? 'fallback'}`,
        summary: `log-normal prior ${interval.p50Min}/${interval.p90Min} min`,
      },
    ],
  };
}

/** One estimation_feedback row as the estimator sees it. */
export interface EstimationSample {
  readonly id: string;
  readonly taskId: string;
  readonly templateId?: string;
  readonly kind?: EstimationStepKind;
  readonly estimatedP50: number;
  readonly actualFocusMin: number;
  /** Owner override (05 §10). */
  readonly excluded: boolean;
  /** Ordering key for "latest per task": canonical UTC ISO instant, then id. */
  readonly createdAt: string;
}

export interface ClassifiedSample extends EstimationSample {
  readonly ratio: number;
  readonly logRatio: number | null;
  readonly zScore: number;
  readonly quality: EstimationQualityValue;
  /** Superseded by a later feedback of the same task. */
  readonly superseded: boolean;
  /** Counts toward the group statistics. */
  readonly counted: boolean;
}

export function templateGroupKey(templateId: string): string {
  return `template:${templateId}`;
}

export function kindGroupKey(kind: EstimationStepKind): string {
  return `kind:${kind}`;
}

export const ALL_GROUP_KEY = 'all';

function referenceGroup(sample: EstimationSample): string {
  if (sample.templateId !== undefined) return templateGroupKey(sample.templateId);
  if (sample.kind !== undefined) return kindGroupKey(sample.kind);
  return ALL_GROUP_KEY;
}

function groupsOf(sample: EstimationSample): string[] {
  const keys: string[] = [];
  if (sample.templateId !== undefined) keys.push(templateGroupKey(sample.templateId));
  if (sample.kind !== undefined) keys.push(kindGroupKey(sample.kind));
  keys.push(ALL_GROUP_KEY);
  return keys;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation (n - 1); 0 for fewer than two values. */
function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** UTC ISO instants of one canonical spelling order lexicographically. */
function compareSamples(a: EstimationSample, b: EstimationSample): number {
  return compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id);
}

function usable(sample: EstimationSample): boolean {
  return (
    Number.isFinite(sample.estimatedP50) &&
    Number.isFinite(sample.actualFocusMin) &&
    sample.estimatedP50 > 0 &&
    sample.actualFocusMin > 0
  );
}

/**
 * Classify every sample. Deterministic: the result only depends on the
 * sample set, not on input order.
 */
export function classifySamples(samples: readonly EstimationSample[]): ClassifiedSample[] {
  const ordered = [...samples].sort(compareSamples);
  // Latest non-excluded usable feedback per task is the candidate sample.
  const latestByTask = new Map<string, EstimationSample>();
  for (const sample of ordered) {
    if (sample.excluded || !usable(sample)) continue;
    latestByTask.set(sample.taskId, sample);
  }
  const candidates = [...latestByTask.values()];
  const logRatioOf = (sample: EstimationSample): number =>
    Math.log(sample.actualFocusMin / sample.estimatedP50);

  const zScores = new Map<string, number>();
  for (const sample of candidates) {
    const group = referenceGroup(sample);
    const others = candidates
      .filter((other) => other.id !== sample.id && referenceGroup(other) === group)
      .map(logRatioOf);
    if (others.length < MIN_OUTLIER_REFERENCE) {
      zScores.set(sample.id, 0);
      continue;
    }
    const spread = Math.max(stdDev(others), LOG_SPREAD_FLOOR);
    zScores.set(sample.id, (logRatioOf(sample) - mean(others)) / spread);
  }

  return ordered.map((sample) => {
    const isUsable = usable(sample);
    const logRatio = isUsable ? logRatioOf(sample) : null;
    const candidate = latestByTask.get(sample.taskId)?.id === sample.id;
    const zScore = candidate ? (zScores.get(sample.id) ?? 0) : 0;
    // An unusable row (unknown P50 or zero focus) can never be learned from.
    const quality: EstimationQualityValue =
      !isUsable || Math.abs(zScore) > OUTLIER_Z_THRESHOLD ? 'outlier' : 'ok';
    return {
      ...sample,
      ratio: isUsable ? sample.actualFocusMin / sample.estimatedP50 : 0,
      logRatio,
      zScore: Number.isFinite(zScore) ? zScore : 0,
      quality,
      superseded: !sample.excluded && isUsable && !candidate,
      counted: candidate && quality === 'ok',
    };
  });
}

export interface GroupCorrection {
  readonly key: string;
  readonly sampleCount: number;
  /** Raw mean of counted log-ratios. */
  readonly logRatioMean: number;
  readonly logRatioStdDev: number;
  /** Shrunk log-ratio `n * mean / (n + k)`. */
  readonly shrunkLogRatio: number;
  readonly p50Ratio: number;
  readonly p90Ratio: number;
  /** n / (n + k): how much the personal data outweighs the prior. */
  readonly weight: number;
}

export function groupCorrection(
  classified: readonly ClassifiedSample[],
  key: string,
  k: number = SHRINKAGE_K,
): GroupCorrection {
  const values = classified
    .filter((sample) => sample.counted && groupsOf(sample).includes(key))
    .map((sample) => sample.logRatio as number);
  const n = values.length;
  const rawMean = mean(values);
  const spread = stdDev(values);
  const weight = n === 0 ? 0 : n / (n + k);
  const shrunk = rawMean * weight;
  const tau = spread * Math.sqrt(weight);
  return {
    key,
    sampleCount: n,
    logRatioMean: rawMean,
    logRatioStdDev: spread,
    shrunkLogRatio: shrunk,
    p50Ratio: Math.exp(shrunk),
    p90Ratio: Math.exp(shrunk + Z90 * tau),
    weight,
  };
}

/** All group corrections present in the samples (template, kind and all). */
export function groupCorrections(
  classified: readonly ClassifiedSample[],
  k: number = SHRINKAGE_K,
): Map<string, GroupCorrection> {
  const keys = new Set<string>();
  for (const sample of classified) {
    for (const key of groupsOf(sample)) keys.add(key);
  }
  const result = new Map<string, GroupCorrection>();
  for (const key of [...keys].sort()) result.set(key, groupCorrection(classified, key, k));
  return result;
}

export interface BaseEstimate extends EstimateInterval {
  readonly method: EstimateMethod;
  readonly confidence: number;
}

/**
 * Pick the correction for a task: its template group when it has counted
 * samples, else its kind group. Never the owner-wide group: a generic bias is
 * not applied to unrelated work.
 */
export function correctionFor(
  corrections: ReadonlyMap<string, GroupCorrection>,
  task: { readonly templateId?: string; readonly kind?: EstimationStepKind },
): GroupCorrection | undefined {
  if (task.templateId !== undefined) {
    const template = corrections.get(templateGroupKey(task.templateId));
    if (template !== undefined && template.sampleCount > 0) return template;
  }
  if (task.kind !== undefined) {
    const kind = corrections.get(kindGroupKey(task.kind));
    if (kind !== undefined && kind.sampleCount > 0) return kind;
  }
  return undefined;
}

/**
 * Personal estimate from a task's cold-start base and its group correction.
 * Without counted samples the base is returned unchanged (method and
 * confidence included).
 */
export function personalEstimate(
  base: BaseEstimate,
  correction: GroupCorrection | undefined,
): EstimateResult {
  if (correction === undefined || correction.sampleCount === 0) {
    return {
      ...gridInterval(base.p50Min, base.p90Min),
      method: base.method,
      confidence: clampConfidence(base.confidence),
      evidence: [{ kind: baseEvidenceKind(base.method), summary: `base ${base.method} estimate ${base.p50Min}/${base.p90Min} min` }],
    };
  }
  const p50 = base.p50Min * correction.p50Ratio;
  const p90 = Math.max(p50, base.p90Min * correction.p90Ratio);
  const interval = gridInterval(p50, p90);
  const confidence = clampConfidence(
    base.confidence + (MAX_CONFIDENCE - base.confidence) * correction.weight,
    MAX_CONFIDENCE,
  );
  return {
    ...interval,
    method: 'personal',
    confidence,
    evidence: [
      { kind: baseEvidenceKind(base.method), summary: `base ${base.method} estimate ${base.p50Min}/${base.p90Min} min` },
      {
        kind: 'personal_correction',
        ref: correction.key,
        summary: `n=${correction.sampleCount} k=${SHRINKAGE_K} ratio x${correction.p50Ratio.toFixed(3)} (P90 x${correction.p90Ratio.toFixed(3)})`,
      },
    ],
  };
}

function baseEvidenceKind(method: EstimateMethod): EstimateEvidenceKind {
  switch (method) {
    case 'template':
      return 'template';
    case 'llm':
      return 'llm';
    case 'personal':
      return 'user_edit';
    case 'prior':
      return 'prior';
  }
}

/** Owner-level confidence for the "내 패턴" header: n / (n + k). */
export function profileConfidence(countedSamples: number, k: number = SHRINKAGE_K): number {
  return countedSamples <= 0 ? 0 : countedSamples / (countedSamples + k);
}
