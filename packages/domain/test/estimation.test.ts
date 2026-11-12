import {
  ESTIMATION_PRIORS,
  LLM_COLD_START_MAX_CONFIDENCE,
  OUTLIER_Z_THRESHOLD,
  SHRINKAGE_K,
  Z90,
  classifySamples,
  coldStartEstimate,
  correctionFor,
  groupCorrection,
  groupCorrections,
  kindGroupKey,
  logNormalFromInterval,
  personalEstimate,
  priorInterval,
  profileConfidence,
  roundUpToGrid,
  templateGroupKey,
  type EstimationSample,
} from '../src/index.js';

function sample(
  index: number,
  ratio: number,
  overrides: Partial<EstimationSample> = {},
): EstimationSample {
  return {
    id: `f${String(index).padStart(3, '0')}`,
    taskId: `t${String(index).padStart(3, '0')}`,
    kind: 'work',
    estimatedP50: 60,
    actualFocusMin: Math.round(60 * ratio),
    excluded: false,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
    ...overrides,
  };
}

describe('estimator grid and priors', () => {
  it('rounds every output up to the 5-minute grid with a 5-minute floor', () => {
    expect(roundUpToGrid(61)).toBe(65);
    expect(roundUpToGrid(60)).toBe(60);
    expect(roundUpToGrid(0)).toBe(5);
    expect(roundUpToGrid(Number.NaN)).toBe(5);
    expect(roundUpToGrid(10_000_000)).toBe(100_000);
  });

  it('derives log-normal intervals from the versioned prior table', () => {
    expect(ESTIMATION_PRIORS.version).toBe('estimation-priors@1');
    const work = priorInterval(ESTIMATION_PRIORS.kinds.work);
    expect(work.p50Min).toBe(90);
    expect(work.p90Min).toBe(roundUpToGrid(90 * Math.exp(Z90 * 0.6)));
    const fitted = logNormalFromInterval({ p50Min: 60, p90Min: 120 });
    expect(Math.exp(fitted.mu)).toBeCloseTo(60, 6);
    expect(Math.exp(fitted.mu + Z90 * fitted.sigma)).toBeCloseTo(120, 6);
  });
});

describe('cold start (05 §6)', () => {
  it('prefers the template prior', () => {
    const result = coldStartEstimate({
      template: { p50Min: 60, p90Min: 90 },
      templateId: 'tpl',
      llm: { p50Min: 30, p90Min: 40 },
    });
    expect(result).toMatchObject({ p50Min: 60, p90Min: 90, method: 'template' });
    expect(result.evidence[0]).toMatchObject({ kind: 'template', ref: 'tpl' });
  });

  it('inflates an LLM estimate by 1.3 with confidence <= 0.3 when no template exists', () => {
    const result = coldStartEstimate({ llm: { p50Min: 60, p90Min: 100 } });
    expect(result.method).toBe('llm');
    expect(result.p50Min).toBe(80); // 78 -> grid
    expect(result.p90Min).toBe(130);
    expect(result.confidence).toBeLessThanOrEqual(LLM_COLD_START_MAX_CONFIDENCE);
  });

  it('falls back to the kind prior when nothing else is known', () => {
    const result = coldStartEstimate({ kind: 'review' });
    expect(result.method).toBe('prior');
    expect(result.p50Min).toBe(45);
    expect(result.evidence[0]?.ref).toBe('estimation-priors@1:review');
  });

  it('keeps a user-edited draft estimate as stated with method personal (FU-48)', () => {
    const result = coldStartEstimate({
      user: { p50Min: 42, p90Min: 50 },
      llm: { p50Min: 60, p90Min: 90 },
    });
    expect(result).toMatchObject({ p50Min: 45, p90Min: 50, method: 'personal' });
    expect(result.evidence[0]?.kind).toBe('user_edit');
  });
});

describe('Bayesian shrinkage (k = 5)', () => {
  it('shrinks the mean log-ratio toward zero by n / (n + k)', () => {
    const samples = [sample(1, 2), sample(2, 2), sample(3, 2)];
    const classified = classifySamples(samples);
    const correction = groupCorrection(classified, kindGroupKey('work'));
    expect(correction.sampleCount).toBe(3);
    expect(correction.logRatioMean).toBeCloseTo(Math.log(2), 9);
    expect(correction.shrunkLogRatio).toBeCloseTo((3 * Math.log(2)) / (3 + SHRINKAGE_K), 9);
    expect(correction.p50Ratio).toBeCloseTo(Math.exp((3 * Math.log(2)) / 8), 9);
    // Identical ratios: no personal spread, P90 ratio equals the P50 ratio.
    expect(correction.p90Ratio).toBeCloseTo(correction.p50Ratio, 9);
  });

  it('applies the correction to the base interval and raises confidence', () => {
    const classified = classifySamples([sample(1, 2)]);
    const corrections = groupCorrections(classified);
    const correction = correctionFor(corrections, { kind: 'work' });
    const result = personalEstimate(
      { p50Min: 60, p90Min: 60, method: 'template', confidence: 0.6 },
      correction,
    );
    // e^(ln 2 / 6) = 1.1225 -> 67.3 -> 70
    expect(result).toMatchObject({ p50Min: 70, p90Min: 70, method: 'personal' });
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.confidence).toBeLessThanOrEqual(0.9);
    expect(result.evidence.map((entry) => entry.kind)).toEqual(['template', 'personal_correction']);
  });

  it('widens P90 by the personal spread', () => {
    const classified = classifySamples([sample(1, 1), sample(2, 2), sample(3, 1.5)]);
    const correction = groupCorrection(classified, kindGroupKey('work'));
    expect(correction.logRatioStdDev).toBeGreaterThan(0);
    expect(correction.p90Ratio).toBeGreaterThan(correction.p50Ratio);
  });

  it('prefers the template group over the kind group, and never uses the owner-wide group', () => {
    const classified = classifySamples([
      sample(1, 2, { templateId: 'tpl' }),
      sample(2, 0.5, { kind: 'review' }),
    ]);
    const corrections = groupCorrections(classified);
    expect(correctionFor(corrections, { templateId: 'tpl', kind: 'review' })?.key).toBe(
      templateGroupKey('tpl'),
    );
    expect(correctionFor(corrections, { templateId: 'other', kind: 'review' })?.key).toBe(
      kindGroupKey('review'),
    );
    expect(correctionFor(corrections, { kind: 'prep' })).toBeUndefined();
  });

  it('returns the base unchanged without counted samples (negative)', () => {
    const result = personalEstimate(
      { p50Min: 80, p90Min: 130, method: 'llm', confidence: 0.3 },
      undefined,
    );
    expect(result).toMatchObject({ p50Min: 80, p90Min: 130, method: 'llm', confidence: 0.3 });
  });

  it('reports profile confidence as n / (n + k)', () => {
    expect(profileConfidence(0)).toBe(0);
    expect(profileConfidence(5)).toBeCloseTo(0.5, 9);
  });
});

describe('outliers and exclusions', () => {
  it('marks |z| > 2.5 as outlier and excludes it from the statistics', () => {
    const steady = [1, 1.1, 0.9, 1.05, 0.95].map((ratio, index) => sample(index + 1, ratio));
    const wild = sample(9, 6);
    const classified = classifySamples([...steady, wild]);
    const outlier = classified.find((entry) => entry.id === wild.id);
    expect(outlier?.quality).toBe('outlier');
    expect(Math.abs(outlier?.zScore ?? 0)).toBeGreaterThan(OUTLIER_Z_THRESHOLD);
    expect(outlier?.counted).toBe(false);
    const correction = groupCorrection(classified, kindGroupKey('work'));
    expect(correction.sampleCount).toBe(5);
    expect(Math.abs(correction.logRatioMean)).toBeLessThan(0.05);
  });

  it('does not run a z test with fewer than three reference samples (negative)', () => {
    const classified = classifySamples([sample(1, 1), sample(2, 1), sample(3, 9)]);
    expect(classified.every((entry) => entry.quality === 'ok')).toBe(true);
    expect(classified.every((entry) => entry.zScore === 0)).toBe(true);
  });

  it('honours the owner exclusion and lets a re-included sample count again', () => {
    const base = [sample(1, 2), sample(2, 2)];
    const excluded = classifySamples([base[0] as EstimationSample, { ...(base[1] as EstimationSample), excluded: true }]);
    expect(groupCorrection(excluded, kindGroupKey('work')).sampleCount).toBe(1);
    expect(excluded.find((entry) => entry.id === 'f002')).toMatchObject({ counted: false, excluded: true });
    const included = classifySamples(base);
    expect(groupCorrection(included, kindGroupKey('work')).sampleCount).toBe(2);
  });

  it('marks unknown-estimate and zero-focus rows as outliers that never count', () => {
    const classified = classifySamples([
      sample(1, 1, { estimatedP50: 0 }),
      sample(2, 0),
    ]);
    expect(classified.map((entry) => entry.quality)).toEqual(['outlier', 'outlier']);
    expect(classified.every((entry) => !entry.counted && entry.ratio === 0)).toBe(true);
  });

  it('counts only the latest feedback per task (cumulative actual)', () => {
    const first = sample(1, 0.5, { taskId: 'same' });
    const second = sample(2, 1.5, { taskId: 'same' });
    const classified = classifySamples([second, first]);
    expect(classified.find((entry) => entry.id === first.id)).toMatchObject({
      superseded: true,
      counted: false,
    });
    expect(classified.find((entry) => entry.id === second.id)?.counted).toBe(true);
    const correction = groupCorrection(classified, kindGroupKey('work'));
    expect(correction.sampleCount).toBe(1);
    expect(correction.logRatioMean).toBeCloseTo(Math.log(1.5), 9);
  });

  it('is independent of input order (determinism)', () => {
    const samples = [sample(1, 1), sample(2, 1.2), sample(3, 0.8), sample(4, 1.1), sample(5, 7)];
    const forward = classifySamples(samples);
    const reversed = classifySamples([...samples].reverse());
    expect(reversed).toEqual(forward);
  });

  it('classifies a large history in linear time (FU-64)', () => {
    const samples = Array.from({ length: 20_000 }, (_, index) =>
      sample(index + 1, 0.5 + ((index * 37) % 100) / 50),
    );
    const start = Date.now();
    const classified = classifySamples(samples);
    const elapsedMs = Date.now() - start;
    expect(classified).toHaveLength(samples.length);
    expect(groupCorrections(classified).get('all')?.sampleCount).toBe(samples.length);
    // The previous leave-one-out loop compared every candidate with every
    // other one (O(n^2)); this wide wall-clock budget only linear work meets.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
