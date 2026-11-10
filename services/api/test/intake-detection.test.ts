import type { TaskTemplate } from '@ohmydate/contracts';
import {
  detectTypeDeterministic,
  scoreTemplate,
} from '../src/application/intake/detection.js';
import { INTAKE_AGENT_CONFIG } from '../src/application/intake/config.js';

const template: TaskTemplate = {
  id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55',
  ownerId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56',
  name: 'Quarterly report',
  steps: [
    {
      key: 's1',
      title: 'Prepare',
      deliverable: 'Inputs',
      doneCriteria: 'Inputs ready',
      kind: 'prep',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: [],
      splittable: false,
    },
    {
      key: 's2',
      title: 'Write quarterly report',
      deliverable: 'Report',
      doneCriteria: 'Draft done',
      kind: 'work',
      estimate: { p50Minutes: 120, p90Minutes: 240 },
      dependsOn: ['s1'],
      splittable: true,
    },
    {
      key: 's3',
      title: 'Review',
      deliverable: 'Reviewed report',
      doneCriteria: 'Review complete',
      kind: 'review',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: ['s2'],
      splittable: false,
    },
  ],
  stats: {},
  source: 'system',
  confidence: 0.8,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('similarity weights come from the versioned agent config', () => {
  const weights = INTAKE_AGENT_CONFIG.similarity.weights;
  expect(INTAKE_AGENT_CONFIG.version).toBe('intake-agent-config@1');
  expect(
    weights.tagJaccard + weights.projectMatch + weights.textSimilarity + weights.metaMatch,
  ).toBeCloseTo(1);
  expect(INTAKE_AGENT_CONFIG.similarity.similarThreshold).toBe(0.75);
});

test('matching text proposes a similar template and unrelated text stays new', () => {
  const similar = detectTypeDeterministic(
    { deliverable: 'Quarterly report' },
    [template],
    [],
    INTAKE_AGENT_CONFIG,
  );
  expect(similar.detected.classification).toBe('similar');
  expect(similar.detected.templateId).toBe(template.id);
  expect(scoreTemplate({ deliverable: 'Quarterly report' }, template).score).toBeGreaterThan(
    INTAKE_AGENT_CONFIG.similarity.weakThreshold,
  );

  const unrelated = detectTypeDeterministic(
    { deliverable: 'Bake sourdough bread' },
    [template],
    [],
    INTAKE_AGENT_CONFIG,
  );
  expect(unrelated.detected.classification).toBe('new');
  expect(unrelated.detected.templateId).toBeUndefined();

  const empty = detectTypeDeterministic({ deliverable: 'Anything' }, [], []);
  expect(empty.detected.classification).toBe('new');
});
