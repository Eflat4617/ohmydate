import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, plannerClient } from '../src/api';
import { readPlannerRange } from '../src/composables/usePlannerRange';
import { DESKTOP_BUILD_MODE } from '../src/platform/mode';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';

/**
 * RC-20: the planner reads three lists — approved blocks, 약속 and tasks —
 * and the desktop core serves them one area at a time: 약속 and tasks are
 * there, blocks arrive with the plans (blueprint 15 §10, RC-40). Until then
 * `GET /schedule-blocks` answers 501 "not ready", and the planner must still
 * show the 약속 it can read: no block is approved where no plan can be.
 *
 * Only that list, only "not ready", only in the desktop bundle — each
 * negative below is one of those limits.
 */
const OWNER = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const RANGE = { from: '2026-11-16T00:00:00.000Z', to: '2026-11-23T00:00:00.000Z' };

function page<T>(items: T[]): { items: T[]; nextCursor: null } {
  return { items, nextCursor: null };
}

function notServed(): ApiError {
  return new ApiError(501, 'internal_error', 'operation is not available in this build of the core');
}

const commitment = { id: 'c-1', title: '치과' } as never;
const task = { id: 't-1', title: '보고서' } as never;
const block = { id: 'b-1' } as never;

beforeEach(() => {
  adoptActiveOwner(OWNER, 'bootstrap');
  vi.spyOn(plannerClient, 'listCommitments').mockResolvedValue(page([commitment]));
  vi.spyOn(plannerClient, 'listTasks').mockResolvedValue(page([task]));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  adoptActiveOwner(null, 'bootstrap');
});

describe('the planner range while the core does not serve blocks yet (RC-20)', () => {
  it('desktop bundle: blocks that are not ready are no blocks, and the 약속 and tasks are shown', async () => {
    vi.stubEnv('MODE', DESKTOP_BUILD_MODE);
    vi.spyOn(plannerClient, 'listScheduleBlocks').mockRejectedValue(notServed());
    await expect(readPlannerRange(captureOwnerBinding(), RANGE)).resolves.toEqual({
      blocks: [],
      commitments: [commitment],
      tasks: [task],
      truncated: false,
    });
  });

  it('desktop bundle: blocks that are served are read as always', async () => {
    vi.stubEnv('MODE', DESKTOP_BUILD_MODE);
    vi.spyOn(plannerClient, 'listScheduleBlocks').mockResolvedValue(page([block]));
    const range = await readPlannerRange(captureOwnerBinding(), RANGE);
    expect(range.blocks).toEqual([block]);
  });

  it('server bundle: a 501 from the blocks is the failure it always was (negative)', async () => {
    vi.spyOn(plannerClient, 'listScheduleBlocks').mockRejectedValue(notServed());
    await expect(readPlannerRange(captureOwnerBinding(), RANGE)).rejects.toMatchObject({ status: 501 });
  });

  it('desktop bundle: any other failure of the blocks still fails the range (negative)', async () => {
    vi.stubEnv('MODE', DESKTOP_BUILD_MODE);
    for (const failure of [new ApiError(500, 'internal_error', 'x'), new ApiError(422, 'validation_failed', 'x'), new TypeError('network')]) {
      vi.spyOn(plannerClient, 'listScheduleBlocks').mockRejectedValue(failure);
      await expect(readPlannerRange(captureOwnerBinding(), RANGE)).rejects.toBe(failure);
    }
  });

  it('desktop bundle: 약속 or tasks that are not ready are not papered over (negative)', async () => {
    vi.stubEnv('MODE', DESKTOP_BUILD_MODE);
    vi.spyOn(plannerClient, 'listScheduleBlocks').mockResolvedValue(page([block]));
    vi.spyOn(plannerClient, 'listCommitments').mockRejectedValue(notServed());
    await expect(readPlannerRange(captureOwnerBinding(), RANGE)).rejects.toMatchObject({ status: 501 });
    vi.spyOn(plannerClient, 'listCommitments').mockResolvedValue(page([commitment]));
    vi.spyOn(plannerClient, 'listTasks').mockRejectedValue(notServed());
    await expect(readPlannerRange(captureOwnerBinding(), RANGE)).rejects.toMatchObject({ status: 501 });
  });
});
