import type {
  EstimationProfile,
  EstimationProfileGroup,
  EstimationProfileItem,
  EstimationReset,
} from '@ohmydate/contracts';
import {
  ESTIMATION_PRIORS_VERSION,
  ESTIMATOR_VERSION,
  NotFoundError,
  OUTLIER_Z_THRESHOLD,
  SHRINKAGE_K,
  ValidationFailedError,
  classifySamples,
  correctionFor,
  groupCorrections,
  personalEstimate,
  profileConfidence,
  type BaseEstimate,
  type ClassifiedSample,
  type Clock,
  type EstimateMethod,
  type EstimateResult,
  type EstimationQualityValue,
  type EstimationSample,
  type EstimationStepKind,
  type GroupCorrection,
  type Id,
  type Instant,
} from '@ohmydate/domain';

const MAX_PROFILE_ITEMS = 2_000;
const MAX_PROFILE_GROUPS = 200;
/**
 * FU-64: the estimator only ever classifies the newest feedback window. Rows
 * older than this bound stop contributing to group statistics, so a template
 * whose samples have all aged out loses its learned stats and its open tasks
 * fall back to the kind-group correction when that group has in-window
 * samples, else to the prior/base estimate. Histories within the bound match
 * the unbounded computation except for z-score rounding in the last bits
 * (<= 1e-12); beyond it, in-window z-scores and outlier flags are computed
 * against in-window group members only and can differ (05 §6, FU-64-68R2).
 */
export const MAX_LEARNING_FEEDBACK_ROWS = 2_000;
const PROFILE_METHOD = `${ESTIMATOR_VERSION}: ${ESTIMATION_PRIORS_VERSION} log-normal priors + shrinkage k=${SHRINKAGE_K}, |z|>${OUTLIER_Z_THRESHOLD} outliers`;

export interface FeedbackRow {
  readonly id: Id;
  readonly taskId: Id;
  readonly estimatedP50: number;
  readonly actualFocusMin: number;
  readonly quality: 'ok' | 'outlier' | 'excluded';
  readonly excluded: boolean;
  readonly createdAt: Instant;
  readonly version: number;
}

export interface TaskEstimationContext {
  readonly templateId?: Id;
  readonly kind?: EstimationStepKind;
}

export interface StoredEstimate extends BaseEstimate {
  readonly id: Id;
  readonly taskId: Id;
}

/** Open task with a current estimate: its cold-start base and current row. */
export interface EstimatedTask {
  readonly taskId: Id;
  readonly base: StoredEstimate;
  readonly current: StoredEstimate;
}

export interface EstimationSnapshot {
  readonly feedback: readonly FeedbackRow[];
  readonly contexts: ReadonlyMap<string, TaskEstimationContext>;
  readonly tasks: readonly EstimatedTask[];
  readonly templateIds: ReadonlySet<string>;
}

export interface EstimationRefreshPlan {
  readonly qualities: readonly { readonly id: Id; readonly quality: EstimationQualityValue }[];
  readonly estimates: readonly { readonly taskId: Id; readonly currentId: Id; readonly result: EstimateResult }[];
  readonly templateStats: readonly {
    readonly templateId: Id;
    readonly stats: { readonly sampleCount: number; readonly meanRatio: number; readonly p90Ratio: number } | null;
  }[];
}

export type EstimationMutation =
  | {
      readonly kind: 'exclude';
      readonly feedbackId: Id;
      readonly excluded: boolean;
      readonly expectedVersion: number;
    }
  | { readonly kind: 'reset'; readonly templateId?: Id };

export interface EstimationStore {
  snapshot(ownerId: Id): Promise<EstimationSnapshot>;
  /**
   * One owner-locked transaction: apply the mutation, load the snapshot, run
   * `compute`, persist its plan (quality reclassification, new current
   * estimate rows with evidence, template stats) and return the post-write
   * snapshot.
   */
  refresh(
    ownerId: Id,
    now: Instant,
    mutation: EstimationMutation | undefined,
    compute: (snapshot: EstimationSnapshot) => EstimationRefreshPlan,
  ): Promise<EstimationSnapshot>;
  /** Cold-start (earliest) estimate P50 for a task, if any. */
  baseP50(ownerId: Id, taskId: Id): Promise<number | null>;
  templateExists(ownerId: Id, templateId: Id): Promise<boolean>;
}

function toSamples(snapshot: EstimationSnapshot): EstimationSample[] {
  return snapshot.feedback.map((row) => {
    const context = snapshot.contexts.get(row.taskId);
    return {
      id: row.id,
      taskId: row.taskId,
      ...(context?.templateId === undefined ? {} : { templateId: context.templateId }),
      ...(context?.kind === undefined ? {} : { kind: context.kind }),
      estimatedP50: row.estimatedP50,
      actualFocusMin: row.actualFocusMin,
      excluded: row.excluded,
      createdAt: row.createdAt,
    };
  });
}

function sameEstimate(current: StoredEstimate, next: EstimateResult): boolean {
  return (
    current.p50Min === next.p50Min &&
    current.p90Min === next.p90Min &&
    current.method === next.method &&
    Math.abs(current.confidence - next.confidence) < 1e-6
  );
}

/**
 * Pure refresh computation: reclassify outliers, recompute every open task's
 * current estimate from its cold-start base and the group correction, and
 * derive template.stats (05 §10 "추정(학습값) | template.stats").
 */
export function computeRefresh(snapshot: EstimationSnapshot): EstimationRefreshPlan {
  const classified = classifySamples(toSamples(snapshot));
  const corrections = groupCorrections(classified);
  const byId = new Map(snapshot.feedback.map((row) => [row.id, row]));
  const qualities = classified
    .filter((sample) => {
      const row = byId.get(sample.id as Id);
      return row !== undefined && row.quality !== sample.quality;
    })
    .map((sample) => ({ id: sample.id as Id, quality: sample.quality }));

  const estimates: EstimationRefreshPlan['estimates'][number][] = [];
  for (const task of snapshot.tasks) {
    const context = snapshot.contexts.get(task.taskId) ?? {};
    const result = personalEstimate(task.base, correctionFor(corrections, context));
    if (!sameEstimate(task.current, result)) {
      estimates.push({ taskId: task.taskId, currentId: task.current.id, result });
    }
  }

  const templateStats = [...snapshot.templateIds].sort().map((templateId) => {
    const correction = corrections.get(`template:${templateId}`);
    return {
      templateId: templateId as Id,
      stats:
        correction === undefined || correction.sampleCount === 0
          ? null
          : {
              sampleCount: correction.sampleCount,
              meanRatio: correction.p50Ratio,
              p90Ratio: correction.p90Ratio,
            },
    };
  });
  return { qualities, estimates, templateStats };
}

function groupDto(
  correction: GroupCorrection,
): EstimationProfileGroup | null {
  const [dimension, ...rest] = correction.key.split(':');
  const value = rest.join(':');
  if ((dimension !== 'template' && dimension !== 'kind') || value.length === 0) return null;
  return {
    dimension,
    key: correction.key,
    ...(dimension === 'template' ? { templateId: value as Id } : {}),
    ...(dimension === 'kind' ? { taskKind: value as EstimationStepKind } : {}),
    stats: {
      sampleCount: correction.sampleCount,
      logRatioMean: correction.logRatioMean,
      logRatioStdDev: correction.logRatioStdDev,
      p50Ratio: correction.p50Ratio,
      p90Ratio: correction.p90Ratio,
    },
    sampleCount: correction.sampleCount,
    confidence: profileConfidence(correction.sampleCount),
    method: `shrinkage k=${SHRINKAGE_K} toward the ${dimension} prior`,
  };
}

function itemDto(
  sample: ClassifiedSample,
  row: FeedbackRow,
): EstimationProfileItem {
  return {
    feedbackId: row.id,
    taskId: row.taskId,
    ...(sample.templateId === undefined ? {} : { templateId: sample.templateId as Id }),
    ...(sample.kind === undefined ? {} : { taskKind: sample.kind }),
    estimatedP50: row.estimatedP50,
    actualFocusMin: row.actualFocusMin,
    ratio: sample.ratio,
    zScore: sample.zScore,
    quality: sample.quality,
    excluded: row.excluded,
    createdAt: row.createdAt,
    version: row.version,
  };
}

export function buildProfile(snapshot: EstimationSnapshot, now: Instant): EstimationProfile {
  const classified = classifySamples(toSamples(snapshot));
  const rows = new Map(snapshot.feedback.map((row) => [row.id, row]));
  const corrections = groupCorrections(classified);
  const groups = [...corrections.values()]
    .map(groupDto)
    .filter((group): group is EstimationProfileGroup => group !== null && group.sampleCount > 0)
    .slice(0, MAX_PROFILE_GROUPS);
  const counted = classified.filter((sample) => sample.counted).length;
  const items = [...classified]
    .reverse()
    .slice(0, MAX_PROFILE_ITEMS)
    .flatMap((sample) => {
      const row = rows.get(sample.id as Id);
      return row === undefined ? [] : [itemDto(sample, row)];
    });
  return {
    generatedAt: now,
    sampleCount: counted,
    confidence: profileConfidence(counted),
    method: PROFILE_METHOD,
    shrinkageK: SHRINKAGE_K,
    outlierZThreshold: OUTLIER_Z_THRESHOLD,
    groups,
    items,
  };
}

/**
 * "내 패턴" (05 §10) and quiet estimate learning (05 §11 "세션 종료 → 추정
 * 갱신(조용히)"). Every mutation recomputes from scratch, so a failed quiet
 * refresh after a review self-heals on the next review, feedback toggle or
 * reset.
 */
export class EstimationService {
  readonly #store: EstimationStore;
  readonly #clock: Clock;

  constructor(deps: { readonly store: EstimationStore; readonly clock: Clock }) {
    this.#store = deps.store;
    this.#clock = deps.clock;
  }

  async profile(ownerId: Id): Promise<EstimationProfile> {
    return buildProfile(await this.#store.snapshot(ownerId), this.#clock.now());
  }

  async patchFeedback(
    ownerId: Id,
    feedbackId: Id,
    excluded: boolean,
    expectedVersion: number,
  ): Promise<EstimationProfileItem> {
    const now = this.#clock.now();
    const snapshot = await this.#store.refresh(
      ownerId,
      now,
      { kind: 'exclude', feedbackId, excluded, expectedVersion },
      computeRefresh,
    );
    const profile = buildProfile(snapshot, now);
    const item = profile.items.find((entry) => entry.feedbackId === feedbackId);
    if (item !== undefined) return item;
    // Older than the item window: classify the row directly.
    const row = snapshot.feedback.find((entry) => entry.id === feedbackId);
    if (row === undefined) throw new NotFoundError('estimation feedback', feedbackId);
    const sample = classifySamples(toSamples(snapshot)).find((entry) => entry.id === feedbackId);
    if (sample === undefined) throw new NotFoundError('estimation feedback', feedbackId);
    return itemDto(sample, row);
  }

  /** 05 §6 / 08 §2.10: forget learned corrections for one template or all. */
  async reset(ownerId: Id, input: EstimationReset): Promise<EstimationProfile> {
    if (input.scope === 'template') {
      if (input.templateId === undefined) {
        throw new ValidationFailedError([
          { path: '/templateId', message: 'templateId is required when scope is "template"' },
        ]);
      }
      if (!(await this.#store.templateExists(ownerId, input.templateId as Id))) {
        throw new ValidationFailedError([
          { path: '/templateId', message: `unknown template ${input.templateId}` },
        ]);
      }
    }
    const now = this.#clock.now();
    const snapshot = await this.#store.refresh(
      ownerId,
      now,
      input.scope === 'template'
        ? { kind: 'reset', templateId: input.templateId as Id }
        : { kind: 'reset' },
      computeRefresh,
    );
    return buildProfile(snapshot, now);
  }

  /** Quiet post-review refresh; returns the reviewed feedback's quality. */
  async refreshAfterReview(
    ownerId: Id,
    feedbackId: Id,
  ): Promise<EstimationQualityValue | undefined> {
    const snapshot = await this.#store.refresh(ownerId, this.#clock.now(), undefined, computeRefresh);
    const sample = classifySamples(toSamples(snapshot)).find((entry) => entry.id === feedbackId);
    return sample?.quality;
  }

  async baseP50(ownerId: Id, taskId: Id): Promise<number | null> {
    return this.#store.baseP50(ownerId, taskId);
  }
}

export type { EstimateMethod };
