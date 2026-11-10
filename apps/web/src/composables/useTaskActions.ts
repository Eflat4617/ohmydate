import { computed, ref, type ComputedRef, type Ref } from 'vue';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type IdempotentAction,
  type PlannerClient,
  type Task,
} from '../api';

export type ConflictOperation = 'rename' | 'complete' | 'delete';

export interface TaskConflict {
  readonly operation: ConflictOperation;
  readonly taskId: string;
  readonly localTitle: string | null;
  readonly server: Task;
}

export interface TaskActions {
  conflict: Ref<TaskConflict | null>;
  error: Ref<string | null>;
  busy: ComputedRef<boolean>;
  create: (title: string, scope?: string) => Promise<Task>;
  rename: (task: Task, title: string) => Promise<Task | null>;
  complete: (task: Task) => Promise<Task | null>;
  remove: (task: Task, actionId?: string) => Promise<boolean>;
  overwrite: () => Promise<Task | null>;
  reload: () => Promise<Task | null>;
  dismissConflict: () => void;
  discard: (scope: string) => void;
}

export class OfflineMutationError extends Error {
  constructor() {
    super('You are offline. Editing is disabled until the connection returns.');
    this.name = 'OfflineMutationError';
  }
}

interface RenamePayload {
  readonly taskId: string;
  readonly title: string;
}

interface IntentPayload {
  readonly taskId: string;
  readonly intent: 'complete' | 'delete';
}

const sameRename = (left: RenamePayload, right: RenamePayload): boolean =>
  left.taskId === right.taskId && left.title === right.title;

const sameIntent = (left: IntentPayload, right: IntentPayload): boolean =>
  left.taskId === right.taskId && left.intent === right.intent;

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError) return cause.detail;
  if (cause instanceof Error) return cause.message;
  return 'Something went wrong. Please try again.';
}

function isVersionConflict(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status === 412;
}

function scopeFor(conflict: TaskConflict): string {
  switch (conflict.operation) {
    case 'rename':
      return `task:${conflict.taskId}:rename`;
    case 'complete':
      return `task:${conflict.taskId}:complete`;
    case 'delete':
      return `task:${conflict.taskId}:delete`;
  }
}

export function useTaskActions(
  client: PlannerClient = plannerClient,
  actions: ActionStore = new ActionStore(),
  canMutate: () => boolean = () => true,
): TaskActions {
  const conflict = ref<TaskConflict | null>(null);
  const error = ref<string | null>(null);
  const pendingCount = ref(0);
  const busy = computed(() => pendingCount.value > 0);

  function assertOnline(): void {
    if (canMutate()) return;
    const failure = new OfflineMutationError();
    error.value = failure.message;
    throw failure;
  }

  async function mutate<T>(operation: () => Promise<T>): Promise<T> {
    assertOnline();
    pendingCount.value += 1;
    error.value = null;
    try {
      return await operation();
    } catch (cause) {
      error.value = messageFor(cause);
      throw cause;
    } finally {
      pendingCount.value -= 1;
    }
  }

  async function fetchLatest(taskId: string): Promise<Task | null> {
    try {
      return await client.getTask(taskId, { fresh: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) return null;
      throw cause;
    }
  }

  function settleCurrent(scope: string): void {
    const action = actions.peek(scope);
    if (action !== undefined) actions.settle(scope, action);
  }

  async function refreshConflict(current: TaskConflict, scope: string): Promise<void> {
    const server = await fetchLatest(current.taskId);
    if (server === null) {
      settleCurrent(scope);
      conflict.value = null;
      return;
    }
    conflict.value = { ...current, server };
  }

  async function create(title: string, scope = 'task:create:inbox'): Promise<Task> {
    return mutate(async () => {
      const action = actions.begin(scope, { title }, (left, right) => left.title === right.title);
      const task = await client.createTask({ title: action.payload.title }, action.key);
      actions.settle(scope, action);
      return task;
    });
  }

  async function rename(task: Task, title: string): Promise<Task | null> {
    return mutate(async () => {
      const scope = `task:${task.id}:rename`;
      const action = actions.begin<RenamePayload>(scope, { taskId: task.id, title }, sameRename);
      try {
        const updated = await client.updateTask(
          task.id,
          { title: action.payload.title },
          action.key,
          task.version,
        );
        actions.settle(scope, action);
        conflict.value = null;
        return updated;
      } catch (cause) {
        if (isVersionConflict(cause)) {
          const server = await fetchLatest(task.id);
          if (server === null) {
            settleCurrent(scope);
            return null;
          }
          conflict.value = {
            operation: 'rename',
            taskId: task.id,
            localTitle: title,
            server,
          };
          return null;
        }
        throw cause;
      }
    });
  }

  async function complete(task: Task): Promise<Task | null> {
    return mutate(async () => {
      const scope = `task:${task.id}:complete`;
      const action = actions.begin<IntentPayload>(
        scope,
        { taskId: task.id, intent: 'complete' },
        sameIntent,
      );
      try {
        const updated = await client.completeTask(task.id, action.key, task.version);
        actions.settle(scope, action);
        conflict.value = null;
        return updated;
      } catch (cause) {
        if (isVersionConflict(cause)) {
          const server = await fetchLatest(task.id);
          if (server === null) {
            settleCurrent(scope);
            return null;
          }
          conflict.value = {
            operation: 'complete',
            taskId: task.id,
            localTitle: null,
            server,
          };
          return null;
        }
        throw cause;
      }
    });
  }

  async function remove(task: Task, actionId?: string): Promise<boolean> {
    return mutate(async () => {
      const scope = actionId ?? `task:${task.id}:delete`;
      const action = actions.begin<IntentPayload>(
        scope,
        { taskId: task.id, intent: 'delete' },
        sameIntent,
      );
      try {
        await client.deleteTask(task.id, action.key, task.version);
        actions.settle(scope, action);
        conflict.value = null;
        return true;
      } catch (cause) {
        if (isVersionConflict(cause)) {
          const server = await fetchLatest(task.id);
          if (server === null) {
            settleCurrent(scope);
            return true;
          }
          conflict.value = {
            operation: 'delete',
            taskId: task.id,
            localTitle: null,
            server,
          };
          return false;
        }
        throw cause;
      }
    });
  }

  async function overwrite(): Promise<Task | null> {
    const current = conflict.value;
    if (current === null) return null;
    return mutate(async () => {
      const scope = scopeFor(current);
      const fresh = await fetchLatest(current.taskId);
      if (fresh === null) {
        settleCurrent(scope);
        conflict.value = null;
        return null;
      }

      if (current.operation === 'delete') {
        const existing = actions.peek<IntentPayload>(scope);
        const action: IdempotentAction<IntentPayload> =
          existing ?? actions.begin(scope, { taskId: current.taskId, intent: 'delete' }, sameIntent);
        try {
          await client.deleteTask(current.taskId, action.key, fresh.version);
          actions.settle(scope, action);
          conflict.value = null;
          return null;
        } catch (cause) {
          if (isVersionConflict(cause)) {
            await refreshConflict(current, scope);
            return null;
          }
          throw cause;
        }
      }

      if (current.operation === 'complete' && fresh.status === 'done') {
        settleCurrent(scope);
        conflict.value = null;
        return fresh;
      }

      if (current.operation === 'rename') {
        const existing = actions.peek<RenamePayload>(scope);
        const payload: RenamePayload = {
          taskId: current.taskId,
          title: current.localTitle ?? fresh.title,
        };
        const action: IdempotentAction<RenamePayload> =
          existing ?? actions.begin(scope, payload, sameRename);
        try {
          const updated = await client.updateTask(
            current.taskId,
            { title: action.payload.title },
            action.key,
            fresh.version,
          );
          actions.settle(scope, action);
          conflict.value = null;
          return updated;
        } catch (cause) {
          if (isVersionConflict(cause)) {
            await refreshConflict(current, scope);
            return null;
          }
          throw cause;
        }
      }

      const existing = actions.peek<IntentPayload>(scope);
      const action: IdempotentAction<IntentPayload> =
        existing ?? actions.begin(scope, { taskId: current.taskId, intent: 'complete' }, sameIntent);
      try {
        const updated = await client.completeTask(current.taskId, action.key, fresh.version);
        actions.settle(scope, action);
        conflict.value = null;
        return updated;
      } catch (cause) {
        if (isVersionConflict(cause)) {
          await refreshConflict(current, scope);
          return null;
        }
        throw cause;
      }
    });
  }

  async function reload(): Promise<Task | null> {
    const current = conflict.value;
    if (current === null) return null;
    const scope = scopeFor(current);
    const fresh = await fetchLatest(current.taskId);
    settleCurrent(scope);
    conflict.value = null;
    return fresh;
  }

  function dismissConflict(): void {
    conflict.value = null;
  }

  function discard(scope: string): void {
    settleCurrent(scope);
  }

  return {
    conflict,
    error,
    busy,
    create,
    rename,
    complete,
    remove,
    overwrite,
    reload,
    dismissConflict,
    discard,
  };
}
