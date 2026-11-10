import type { Project, Task, User } from '../api/client';

export interface StoredResponse {
  readonly hash: string;
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export interface MockDb {
  user: User;
  inboxProjectId: string;
  projects: Map<string, Project>;
  tasks: Map<string, Task>;
  idempotency: Map<string, StoredResponse>;
  pendingIdempotency: Set<string>;
  authenticated: boolean;
  taskRevision: number;
  projectRevision: number;
}

export const USER_ID = '01900000-0000-7000-8000-000000000002';
export const INBOX_PROJECT_ID = '01900000-0000-7000-8000-000000000001';
export const SAMPLE_PROJECT_ID = '01900000-0000-7000-8000-000000000003';
export const SEED_TASK_TITLE = 'Review weekly plan';

export function createUuidV7(): string {
  const timestamp = Date.now().toString(16).padStart(12, '0').slice(-12);
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let random = '';
  for (const byte of bytes) random += byte.toString(16).padStart(2, '0');
  const variant = (8 + (Number.parseInt(random.slice(6, 7), 16) & 0x3)).toString(16);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(7, 10)}-${random.slice(10, 22)}`;
}

function seedTask(title: string, version: number): Task {
  const createdAt = '2026-11-01T09:00:00.000Z';
  return {
    id: createUuidV7(),
    ownerId: USER_ID,
    projectId: INBOX_PROJECT_ID,
    title,
    status: 'todo',
    splittable: true,
    priority: 2,
    dependsOn: [],
    version,
    createdAt,
    updatedAt: createdAt,
    external: [],
  };
}

export function createMockDb(): MockDb {
  const createdAt = '2026-11-01T08:00:00.000Z';
  const user: User = {
    id: USER_ID,
    email: 'planner@example.test',
    timeZone: 'Asia/Seoul',
    locale: 'en',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const inbox: Project = {
    id: INBOX_PROJECT_ID,
    ownerId: USER_ID,
    title: 'Inbox',
    archived: false,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const sample: Project = {
    id: SAMPLE_PROJECT_ID,
    ownerId: USER_ID,
    title: 'Thesis',
    archived: false,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const seededTask = seedTask(SEED_TASK_TITLE, 1);
  return {
    user,
    inboxProjectId: INBOX_PROJECT_ID,
    projects: new Map([
      [inbox.id, inbox],
      [sample.id, sample],
    ]),
    tasks: new Map([[seededTask.id, seededTask]]),
    idempotency: new Map(),
    pendingIdempotency: new Set(),
    authenticated: true,
    taskRevision: 1,
    projectRevision: 1,
  };
}

export const mockDb = createMockDb();

export function resetMockDb(): void {
  const fresh = createMockDb();
  mockDb.user = fresh.user;
  mockDb.inboxProjectId = fresh.inboxProjectId;
  mockDb.projects = fresh.projects;
  mockDb.tasks = fresh.tasks;
  mockDb.idempotency = fresh.idempotency;
  mockDb.pendingIdempotency = fresh.pendingIdempotency;
  mockDb.authenticated = fresh.authenticated;
  mockDb.taskRevision = fresh.taskRevision;
  mockDb.projectRevision = fresh.projectRevision;
}
