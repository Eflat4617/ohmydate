import { BudgetExceeded, BudgetGuard } from '../src/index.js';

const at = (iso: string) => () => new Date(iso);

test('blocks when the daily limit is already reached (spent == limit)', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { spentTodayUsd: 1 },
    at('2026-11-11T12:00:00.000Z'),
  );
  expect(() => guard.assertCanSpend()).toThrow(
    expect.objectContaining({ code: 'budget_exceeded', kind: 'daily', reason: 'limit_reached' }),
  );
});

test('blocks when the monthly limit is reached', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { spentTodayUsd: 0.5, spentThisMonthUsd: 10 },
    at('2026-11-11T12:00:00.000Z'),
  );
  expect(() => guard.assertCanSpend()).toThrow(
    expect.objectContaining({ code: 'budget_exceeded', kind: 'monthly', reason: 'limit_reached' }),
  );
});

test('blocks a zero daily limit', () => {
  const guard = new BudgetGuard({ dailyUsd: 0, monthlyUsd: 10 });
  expect(() => guard.assertCanSpend()).toThrow(
    expect.objectContaining({ kind: 'daily', reason: 'invalid_limit' }),
  );
});

test('blocks a NaN daily limit even when nothing was spent', () => {
  const guard = new BudgetGuard({ dailyUsd: Number.NaN, monthlyUsd: 10 });
  expect(() => guard.assertCanSpend()).toThrow(
    expect.objectContaining({ kind: 'daily', reason: 'invalid_limit' }),
  );
});

test('blocks a missing monthly limit', () => {
  const guard = new BudgetGuard({ dailyUsd: 1 });
  expect(() => guard.assertCanSpend()).toThrow(
    expect.objectContaining({ kind: 'monthly', reason: 'invalid_limit' }),
  );
});

test('blocks an infinite limit (non-finite must fail closed)', () => {
  const guard = new BudgetGuard({ dailyUsd: 1, monthlyUsd: Number.POSITIVE_INFINITY });
  expect(() => guard.assertCanSpend()).toThrow(
    expect.objectContaining({ kind: 'monthly', reason: 'invalid_limit' }),
  );
});

test('the default estimate does not let an exhausted budget pass', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { spentTodayUsd: 1 },
    at('2026-11-11T12:00:00.000Z'),
  );
  expect(() => guard.assertCanSpend(0)).toThrow(BudgetExceeded);
});

test('blocks a projected estimate that would cross the daily limit', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { spentTodayUsd: 0.9 },
    at('2026-11-11T12:00:00.000Z'),
  );
  expect(() => guard.assertCanSpend(0.2)).toThrow(
    expect.objectContaining({ kind: 'daily', reason: 'projected_limit' }),
  );
});

test('daily spend rolls over on a new UTC day', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { dayKey: '2026-11-10', monthKey: '2026-11', spentTodayUsd: 5, spentThisMonthUsd: 5 },
    at('2026-11-11T00:01:00.000Z'),
  );
  expect(() => guard.assertCanSpend()).not.toThrow();
  expect(guard.snapshot()).toMatchObject({ dayKey: '2026-11-11', spentTodayUsd: 0 });
  expect(guard.snapshot().spentThisMonthUsd).toBe(5);
});

test('both daily and monthly spend roll over on a new UTC month', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { dayKey: '2026-11-30', monthKey: '2026-11', spentTodayUsd: 5, spentThisMonthUsd: 9 },
    at('2026-12-01T00:00:01.000Z'),
  );
  expect(() => guard.assertCanSpend()).not.toThrow();
  expect(guard.snapshot()).toMatchObject({
    dayKey: '2026-12-01',
    monthKey: '2026-12',
    spentTodayUsd: 0,
    spentThisMonthUsd: 0,
  });
});

test('records cost into both windows', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    {},
    at('2026-11-11T12:00:00.000Z'),
  );
  guard.record({ inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
  guard.record(0.25);
  expect(guard.snapshot()).toMatchObject({ spentTodayUsd: 0.5, spentThisMonthUsd: 0.5 });
});

test.each([
  { label: 'NaN daily spend', init: { spentTodayUsd: Number.NaN } },
  { label: 'negative daily spend', init: { spentTodayUsd: -1 } },
  { label: 'NaN monthly spend', init: { spentThisMonthUsd: Number.NaN } },
  { label: 'negative monthly spend', init: { spentThisMonthUsd: -1 } },
])('rejects invalid initial $label', ({ init }) => {
  expect(() => new BudgetGuard({ dailyUsd: 1, monthlyUsd: 10 }, init)).toThrow(RangeError);
});

test.each([
  { label: 'NaN', estimate: Number.NaN },
  { label: 'Infinity', estimate: Number.POSITIVE_INFINITY },
  { label: 'negative', estimate: -0.5 },
])('rejects a $label estimate instead of treating it as zero', ({ estimate }) => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    {},
    at('2026-11-11T12:00:00.000Z'),
  );
  expect(() => guard.assertCanSpend(estimate)).toThrow(
    expect.objectContaining({ kind: 'daily', reason: 'invalid_estimate' }),
  );
});

test('real-model usage without costUsd exhausts the guard (fail closed)', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    {},
    at('2026-11-11T12:00:00.000Z'),
  );
  guard.record({ inputTokens: 100_000, outputTokens: 100_000 }, { model: 'real-adapter' });
  expect(guard.isExhausted()).toBe(true);
  expect(() => guard.assertCanSpend()).toThrow(
    expect.objectContaining({ reason: 'unpriced_usage' }),
  );
});

test('real-model usage with a non-finite cost exhausts the guard', () => {
  const guard = new BudgetGuard({ dailyUsd: 1, monthlyUsd: 10 });
  guard.record({ inputTokens: 1, outputTokens: 1, costUsd: Number.NaN }, { model: 'real-adapter' });
  expect(guard.isExhausted()).toBe(true);
});

test('fake models may omit costUsd only when explicitly allow-listed', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { allowUnpricedModels: ['fake-llm'] },
    at('2026-11-11T12:00:00.000Z'),
  );
  guard.record({ inputTokens: 100_000, outputTokens: 100_000 }, { model: 'fake-llm' });
  expect(guard.isExhausted()).toBe(false);
  expect(() => guard.assertCanSpend()).not.toThrow();
});

test('a fake-prefixed model is not exempt without an exact allow-list match', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    {},
    at('2026-11-11T12:00:00.000Z'),
  );
  guard.record({ inputTokens: 100_000, outputTokens: 100_000 }, { model: 'fake-llm' });
  expect(guard.isExhausted()).toBe(true);
  expect(() => guard.assertCanSpend()).toThrow(
    expect.objectContaining({ reason: 'unpriced_usage' }),
  );
});

test('the unpriced allow-list requires an exact model match', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { allowUnpricedModels: ['fake-llm'] },
    at('2026-11-11T12:00:00.000Z'),
  );
  guard.record({ inputTokens: 100_000, outputTokens: 100_000 }, { model: 'fake-llm-real' });
  expect(guard.isExhausted()).toBe(true);
});

test.each([
  { label: 'NaN', costUsd: Number.NaN },
  { label: 'positive Infinity', costUsd: Number.POSITIVE_INFINITY },
  { label: 'negative', costUsd: -5 },
])(
  'an allow-listed model with a $label cost still exhausts the guard',
  ({ costUsd }) => {
    const guard = new BudgetGuard(
      { dailyUsd: 1, monthlyUsd: 10 },
      { allowUnpricedModels: ['fake-llm'] },
      at('2026-11-11T12:00:00.000Z'),
    );
    guard.record({ inputTokens: 1, outputTokens: 1, costUsd }, { model: 'fake-llm' });
    expect(guard.isExhausted()).toBe(true);
    expect(guard.snapshot()).toMatchObject({ spentTodayUsd: 0, spentThisMonthUsd: 0 });
    expect(() => guard.assertCanSpend()).toThrow(
      expect.objectContaining({ reason: 'unpriced_usage' }),
    );
  },
);

test('an allow-listed model with no measurable cost stays exempt', () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    { allowUnpricedModels: ['fake-llm'] },
    at('2026-11-11T12:00:00.000Z'),
  );
  guard.record(undefined, { model: 'fake-llm' });
  expect(guard.isExhausted()).toBe(false);
});

test.each([
  { label: 'a bare string', value: 'fake-llm' },
  { label: 'an array with a non-string entry', value: ['fake-llm', 1] },
  { label: 'a number array', value: [1, 2] },
])('rejects allowUnpricedModels as $label', ({ value }) => {
  expect(
    () =>
      new BudgetGuard(
        { dailyUsd: 1, monthlyUsd: 10 },
        { allowUnpricedModels: value as unknown as readonly string[] },
      ),
  ).toThrow(TypeError);
});
