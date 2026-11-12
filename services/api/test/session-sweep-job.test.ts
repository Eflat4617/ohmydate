import {
  DEFAULT_SESSION_SWEEP_INTERVAL_MS,
  SessionSweepJob,
  type SessionSweepStore,
} from '../src/application/session-sweep-job.js';

/** FU-92: expired-session sweep lifecycle (boot run, ticks, shutdown). */

function fakeScheduler() {
  const timers: Array<{ callback: () => void; milliseconds: number; stopped: boolean }> = [];
  return {
    timers,
    scheduler: (callback: () => void, milliseconds: number) => {
      const timer = { callback, milliseconds, stopped: false };
      timers.push(timer);
      return {
        stop: () => {
          timer.stopped = true;
        },
      };
    },
  };
}

function countingStore(result: () => Promise<number> = async () => 0) {
  const calls: Array<number | undefined> = [];
  const store: SessionSweepStore = {
    sweepExpired: (limit?: number) => {
      calls.push(limit);
      return result();
    },
  };
  return { store, calls };
}

test('default interval is ten minutes', () => {
  expect(DEFAULT_SESSION_SWEEP_INTERVAL_MS).toBe(600_000);
});

test('start sweeps once at boot and then on every tick with the batch size', async () => {
  const { store, calls } = countingStore(async () => 3);
  const { timers, scheduler } = fakeScheduler();
  const job = new SessionSweepJob({ store, intervalMs: 600_000, batchSize: 50, scheduler });

  job.start();
  job.start(); // idempotent: still one timer, one boot sweep
  expect(timers).toHaveLength(1);
  expect(timers[0]?.milliseconds).toBe(600_000);
  expect(calls).toEqual([50]);

  await job.runOnce();
  timers[0]?.callback();
  expect(calls).toEqual([50, 50]);
  await job.stop();
});

test('stop clears the timer and waits for an in-flight sweep; later ticks do nothing', async () => {
  let release: (value: number) => void = () => undefined;
  const { store, calls } = countingStore(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  const { timers, scheduler } = fakeScheduler();
  const job = new SessionSweepJob({ store, intervalMs: 1_000, scheduler });
  job.start();
  expect(calls).toHaveLength(1);

  let stopped = false;
  const stopping = job.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(timers[0]?.stopped).toBe(true);
  expect(stopped).toBe(false);
  release(0);
  await stopping;
  expect(stopped).toBe(true);

  timers[0]?.callback();
  expect(await job.runOnce()).toBe(0);
  job.start();
  expect(calls).toHaveLength(1);
  expect(timers).toHaveLength(1);
});

test('overlapping ticks share one in-flight sweep', async () => {
  let release: (value: number) => void = () => undefined;
  const { store, calls } = countingStore(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  const job = new SessionSweepJob({ store, intervalMs: 1_000, scheduler: fakeScheduler().scheduler });
  const first = job.runOnce();
  const second = job.runOnce();
  expect(calls).toHaveLength(1);
  release(4);
  expect(await first).toBe(4);
  expect(await second).toBe(4);
  await job.stop();
});

test('a failing sweep is logged by error name only and never rejects', async () => {
  const warnings: Array<{ message: string; details: unknown }> = [];
  const failure = Object.assign(new Error('connection to 10.0.0.1 secret=abc refused'), {
    name: 'DatabaseError',
  });
  const { store } = countingStore(async () => {
    throw failure;
  });
  const job = new SessionSweepJob({
    store,
    intervalMs: 1_000,
    scheduler: fakeScheduler().scheduler,
    logger: { warn: (message, details) => warnings.push({ message, details }) },
  });
  await expect(job.runOnce()).resolves.toBe(0);
  expect(warnings).toEqual([
    { message: 'expired session sweep failed', details: { name: 'DatabaseError' } },
  ]);
  expect(JSON.stringify(warnings)).not.toContain('secret');
  await job.stop();
});

test('a store that throws synchronously is handled like a rejected sweep', async () => {
  const warnings: unknown[] = [];
  const store: SessionSweepStore = {
    sweepExpired: () => {
      throw new TypeError('boom');
    },
  };
  const { timers, scheduler } = fakeScheduler();
  const job = new SessionSweepJob({
    store,
    intervalMs: 1_000,
    scheduler,
    logger: { warn: (_message, details) => warnings.push(details) },
  });
  expect(() => job.start()).not.toThrow();
  expect(() => timers[0]?.callback()).not.toThrow();
  await expect(job.runOnce()).resolves.toBe(0);
  expect(warnings[0]).toEqual({ name: 'TypeError' });
  await job.stop();
});

test('a non-positive or fractional interval disables the job entirely', async () => {
  for (const intervalMs of [0, -1, 1.5, Number.NaN]) {
    const { store, calls } = countingStore();
    const { timers, scheduler } = fakeScheduler();
    const job = new SessionSweepJob({ store, intervalMs, scheduler });
    job.start();
    expect(timers).toHaveLength(0);
    expect(calls).toHaveLength(0);
    await job.stop();
  }
});

test('the default scheduler does not keep the process alive and stops cleanly', async () => {
  vi.useFakeTimers();
  try {
    const { store, calls } = countingStore();
    const job = new SessionSweepJob({ store, intervalMs: 1_000 });
    job.start();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls).toHaveLength(3);
    await job.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
  } finally {
    vi.useRealTimers();
  }
});
