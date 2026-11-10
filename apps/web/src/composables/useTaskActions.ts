import { ref, type Ref } from 'vue';
import {
  ApiError,
  IdempotencyKeyStore,
  plannerClient,
  type PlannerClient,
  type Task,
} from '../api';

export interface TaskConflict {
  readonly taskId: string;
  readonly localTitle: string;
  readonly server: Task;
}

export interface TaskActions {
  conflict: Ref<TaskConflict | null>;
  error: Ref<string | null>;
  busy: Ref<boolean>;
  create: (title: string, actionId: string) => Promise<Task>;
  rename: (task: Task, title: string) => Promise<Task | null>;
  complete: (task: Task) => Promise<Task>;
  remove: (task: Task, actionId?: string) => Promise<void>;
  overwrite: () => Promise<Task | null>;
  reload: () => Promise<Task | null>;
  dismissConflict: () => void;
}

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError) return cause.detail;
  return 'Something went wrong. Please try again.';
}

export function useTaskActions(
  client: PlannerClient = plannerClient,
  keys: IdempotencyKeyStore = new IdempotencyKeyStore(),
): TaskActions {
  const conflict = ref<TaskConflict | null>(null);
  const error = ref<string | null>(null);
  const busy = ref(false);

  async function create(title: string, actionId: string): Promise<Task> {
    const key = keys.keyFor(actionId);
    busy.value = true;
    error.value = null;
    try {
      const task = await client.createTask({ title }, key);
      keys.settle(actionId);
      return task;
    } catch (cause) {
      error.value = messageFor(cause);
      throw cause;
    } finally {
      busy.value = false;
    }
  }

  async function rename(task: Task, title: string): Promise<Task | null> {
    const actionId = `task:${task.id}:rename`;
    const key = keys.keyFor(actionId);
    busy.value = true;
    error.value = null;
    try {
      const updated = await client.updateTask(task.id, { title }, key, task.version);
      keys.settle(actionId);
      return updated;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 412) {
        const server = await client.getTask(task.id, { fresh: true });
        conflict.value = { taskId: task.id, localTitle: title, server };
        return null;
      }
      error.value = messageFor(cause);
      throw cause;
    } finally {
      busy.value = false;
    }
  }

  async function overwrite(): Promise<Task | null> {
    const current = conflict.value;
    if (current === null) return null;
    const actionId = `task:${current.taskId}:rename`;
    const key = keys.keyFor(actionId);
    busy.value = true;
    error.value = null;
    try {
      const updated = await client.updateTask(
        current.taskId,
        { title: current.localTitle },
        key,
        current.server.version,
      );
      keys.settle(actionId);
      conflict.value = null;
      return updated;
    } catch (cause) {
      error.value = messageFor(cause);
      throw cause;
    } finally {
      busy.value = false;
    }
  }

  async function reload(): Promise<Task | null> {
    const current = conflict.value;
    if (current === null) return null;
    busy.value = true;
    try {
      const fresh = await client.getTask(current.taskId, { fresh: true });
      keys.settle(`task:${current.taskId}:rename`);
      conflict.value = null;
      return fresh;
    } finally {
      busy.value = false;
    }
  }

  async function complete(task: Task): Promise<Task> {
    const actionId = `task:${task.id}:complete`;
    const key = keys.keyFor(actionId);
    busy.value = true;
    error.value = null;
    try {
      const updated = await client.completeTask(task.id, key, task.version);
      keys.settle(actionId);
      return updated;
    } catch (cause) {
      error.value = messageFor(cause);
      throw cause;
    } finally {
      busy.value = false;
    }
  }

  async function remove(task: Task, actionId = `task:${task.id}:delete`): Promise<void> {
    const key = keys.keyFor(actionId);
    busy.value = true;
    error.value = null;
    try {
      await client.deleteTask(task.id, key, task.version);
      keys.settle(actionId);
    } catch (cause) {
      error.value = messageFor(cause);
      throw cause;
    } finally {
      busy.value = false;
    }
  }

  function dismissConflict(): void {
    conflict.value = null;
  }

  return { conflict, error, busy, create, rename, complete, remove, overwrite, reload, dismissConflict };
}
