import type { EstimationProfile, EstimationProfileGroup, EstimationProfileItem } from '../api/client';

/**
 * Synthetic "내 패턴" data for the MSW mock (M5-03). Pure data plus a small
 * re-implementation of the estimator's group statistics (05 §6: log-ratio
 * mean shrunk toward the prior with k = 5, confidence n / (n + k)) so the
 * exclude/include toggle and resets change the numbers the way the API does.
 * Only ids, minutes and ratios: no task text and no notes.
 */

export const SHRINKAGE_K = 5;
export const OUTLIER_Z = 2.5;
const Z90 = 1.2815515655446004;

export const FEEDBACK_IDS = {
  one: '01900000-0000-7000-8000-0000000001f1',
  two: '01900000-0000-7000-8000-0000000001f2',
  three: '01900000-0000-7000-8000-0000000001f3',
  outlier: '01900000-0000-7000-8000-0000000001f4',
  excluded: '01900000-0000-7000-8000-0000000001f5',
  six: '01900000-0000-7000-8000-0000000001f6',
} as const;

/** Tasks that only exist in feedback (finished work not in the mock inbox). */
export const PAST_TASK_IDS = {
  prep: '01900000-0000-7000-8000-0000000001a3',
  outlier: '01900000-0000-7000-8000-0000000001a4',
  free: '01900000-0000-7000-8000-0000000001a5',
  draft: '01900000-0000-7000-8000-0000000001a6',
} as const;

function item(
  feedbackId: string,
  taskId: string,
  estimatedP50: number,
  actualFocusMin: number,
  options: {
    templateId?: string;
    taskKind?: EstimationProfileItem['taskKind'];
    quality?: EstimationProfileItem['quality'];
    excluded?: boolean;
    zScore?: number;
    createdAt: string;
  },
): EstimationProfileItem {
  return {
    feedbackId,
    taskId,
    ...(options.templateId === undefined ? {} : { templateId: options.templateId }),
    ...(options.taskKind === undefined ? {} : { taskKind: options.taskKind }),
    estimatedP50,
    actualFocusMin,
    ratio: actualFocusMin / estimatedP50,
    zScore: options.zScore ?? 0,
    quality: options.quality ?? 'ok',
    excluded: options.excluded ?? false,
    createdAt: options.createdAt,
    version: 1,
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

export function confidenceFor(count: number): number {
  return count <= 0 ? 0 : count / (count + SHRINKAGE_K);
}

function counted(entry: EstimationProfileItem): boolean {
  return !entry.excluded && entry.quality !== 'outlier' && entry.estimatedP50 > 0 && entry.actualFocusMin > 0;
}

function group(
  dimension: EstimationProfileGroup['dimension'],
  value: string,
  members: readonly EstimationProfileItem[],
): EstimationProfileGroup {
  const logs = members.map((entry) => Math.log(entry.actualFocusMin / entry.estimatedP50));
  const n = logs.length;
  const weight = n === 0 ? 0 : n / (n + SHRINKAGE_K);
  const raw = mean(logs);
  const spread = stdDev(logs);
  const shrunk = raw * weight;
  return {
    dimension,
    key: `${dimension}:${value}`,
    ...(dimension === 'template' ? { templateId: value } : {}),
    ...(dimension === 'kind' ? { taskKind: value as NonNullable<EstimationProfileItem['taskKind']> } : {}),
    stats: {
      sampleCount: n,
      logRatioMean: raw,
      logRatioStdDev: spread,
      p50Ratio: Math.exp(shrunk),
      p90Ratio: Math.exp(shrunk + Z90 * spread * Math.sqrt(weight)),
    },
    sampleCount: n,
    confidence: confidenceFor(n),
    method: `shrinkage k=${SHRINKAGE_K} toward the ${dimension} prior`,
  };
}

/** Recompute groups and the summary from the items (newest first). */
export function recomputeProfile(profile: EstimationProfile, now: string = new Date().toISOString()): EstimationProfile {
  const usable = profile.items.filter(counted);
  const templateIds = [...new Set(usable.flatMap((entry) => (entry.templateId === undefined ? [] : [entry.templateId])))].sort();
  const kinds = [...new Set(usable.flatMap((entry) => (entry.taskKind === undefined ? [] : [entry.taskKind])))].sort();
  const groups = [
    ...templateIds.map((id) => group('template', id, usable.filter((entry) => entry.templateId === id))),
    ...kinds.map((kind) => group('kind', kind, usable.filter((entry) => entry.taskKind === kind))),
  ];
  return {
    ...profile,
    generatedAt: now,
    sampleCount: usable.length,
    confidence: confidenceFor(usable.length),
    groups,
  };
}

export function emptyEstimationProfile(now = '2026-11-14T09:30:00.000Z'): EstimationProfile {
  return {
    generatedAt: now,
    sampleCount: 0,
    confidence: 0,
    method: `estimator@1: estimation-priors@1 log-normal priors + shrinkage k=${SHRINKAGE_K}, |z|>${OUTLIER_Z} outliers`,
    shrinkageK: SHRINKAGE_K,
    outlierZThreshold: OUTLIER_Z,
    groups: [],
    items: [],
  };
}

/** Learned profile: a report template, review/work kinds, one outlier, one excluded item. */
export function seedEstimationProfile(ids: {
  readonly templateId: string;
  readonly taskOne: string;
  readonly taskTwo: string;
}): EstimationProfile {
  const items = [
    item(FEEDBACK_IDS.one, ids.taskOne, 60, 85, {
      templateId: ids.templateId,
      taskKind: 'work',
      zScore: 0.4,
      createdAt: '2026-11-13T12:30:00.000Z',
    }),
    item(FEEDBACK_IDS.two, ids.taskTwo, 30, 35, { taskKind: 'review', createdAt: '2026-11-12T11:00:00.000Z' }),
    item(FEEDBACK_IDS.three, PAST_TASK_IDS.prep, 45, 60, {
      templateId: ids.templateId,
      taskKind: 'prep',
      zScore: -0.2,
      createdAt: '2026-11-11T08:15:00.000Z',
    }),
    item(FEEDBACK_IDS.outlier, PAST_TASK_IDS.outlier, 120, 480, {
      templateId: ids.templateId,
      taskKind: 'work',
      quality: 'outlier',
      zScore: 3.1,
      createdAt: '2026-11-10T13:00:00.000Z',
    }),
    item(FEEDBACK_IDS.excluded, PAST_TASK_IDS.free, 90, 100, {
      taskKind: 'work',
      excluded: true,
      createdAt: '2026-11-09T10:00:00.000Z',
    }),
    item(FEEDBACK_IDS.six, PAST_TASK_IDS.draft, 60, 75, {
      templateId: ids.templateId,
      taskKind: 'work',
      zScore: -0.3,
      createdAt: '2026-11-08T09:00:00.000Z',
    }),
  ];
  return recomputeProfile({ ...emptyEstimationProfile(), items }, '2026-11-14T09:30:00.000Z');
}
