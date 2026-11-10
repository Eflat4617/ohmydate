import type { Id, TaskRepository, Version } from '@ohmydate/domain';
import { TaskService } from '../src/application/task-service.js';

const owner = '01900000-0000-7000-8000-000000000001' as Id;
const taskId = '01900000-0000-7000-8000-000000000002' as Id;

function repository(overrides: Partial<TaskRepository>): TaskRepository {
  return {
    capabilities: {
      strictConcurrency: true,
      idempotentCreate: true,
      softDeleteReturnsVersion: true,
    },
    create: async () => {
      throw new Error('not used');
    },
    get: async () => null,
    list: async () => ({ items: [], nextCursor: null }),
    update: async () => {
      throw new Error('not used');
    },
    complete: async () => {
      throw new Error('not used');
    },
    softDelete: async () => undefined,
    listChangedSince: async () => ({ changes: [], cursor: null }),
    ...overrides,
  };
}

describe('TaskService.remove', () => {
  it('uses the version returned by softDelete without scanning the change feed', async () => {
    const listChangedSince = vi.fn(async () => ({ changes: [], cursor: null }));
    const service = new TaskService(
      repository({
        softDelete: async () => 7 as Version,
        listChangedSince,
      }),
    );

    await expect(service.remove(owner, taskId, 6 as Version)).resolves.toBe(7 as Version);
    expect(listChangedSince).not.toHaveBeenCalled();
  });

  it('falls back to the change feed for legacy adapters that return void', async () => {
    const listChangedSince = vi.fn(async () => ({
      changes: [{ id: taskId, version: 4 as Version }],
      cursor: null,
    }));
    const service = new TaskService(repository({ listChangedSince }));

    await expect(service.remove(owner, taskId, 3 as Version)).resolves.toBe(4 as Version);
    expect(listChangedSince).toHaveBeenCalledTimes(1);
  });
});
