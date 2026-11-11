import type {
  Availability,
  Commitment,
  Plan,
  PlanVersion,
  Project,
  Task,
  User,
} from '../api/client';

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
  availability: Availability;
  availabilityVersion: number;
  commitments: Map<string, Commitment>;
  plans: Map<string, Plan>;
  planVersions: Map<string, PlanVersion>;
  idempotency: Map<string, StoredResponse>;
  pendingIdempotency: Set<string>;
  authenticated: boolean;
  taskRevision: number;
  projectRevision: number;
}

export const SEED_COMMITMENT_ID = '01900000-0000-7000-8000-000000000010';
export const SEED_ONE_OFF_COMMITMENT_ID = '01900000-0000-7000-8000-000000000011';

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
    kind: 'inbox',
    archived: false,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const sample: Project = {
    id: SAMPLE_PROJECT_ID,
    ownerId: USER_ID,
    title: 'Thesis',
    kind: 'normal',
    archived: false,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const seededTask = seedTask(SEED_TASK_TITLE, 1);
  const availability: Availability = {
    version: 1,
    timeZone: 'Asia/Seoul',
    rules: [
      { weekday: 1, startLocal: '09:00', endLocal: '18:00', kind: 'work' },
      { weekday: 2, startLocal: '09:00', endLocal: '18:00', kind: 'work' },
      { weekday: 3, startLocal: '09:00', endLocal: '18:00', kind: 'work' },
      { weekday: 4, startLocal: '09:00', endLocal: '18:00', kind: 'work' },
      { weekday: 5, startLocal: '09:00', endLocal: '18:00', kind: 'work' },
    ],
    exceptions: [],
    prefs: {
      maxDailyFocusMin: 300,
      breakAfterMin: 60,
      breakMin: 15,
      dayStartLocal: '08:00',
      dayEndLocal: '22:00',
      riskLevel: 'p50',
    },
  };
  const teamSync: Commitment = {
    id: SEED_COMMITMENT_ID,
    ownerId: USER_ID,
    title: 'Team sync',
    startAt: '2026-11-09T00:00:00.000Z',
    endAt: '2026-11-09T01:00:00.000Z',
    timeZone: 'Asia/Seoul',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    source: 'manual',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const thesisReview: Commitment = {
    id: SEED_ONE_OFF_COMMITMENT_ID,
    ownerId: USER_ID,
    title: 'Thesis review',
    startAt: '2026-11-11T10:00:00.000Z',
    endAt: '2026-11-11T11:00:00.000Z',
    timeZone: 'Asia/Seoul',
    source: 'manual',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    user,
    inboxProjectId: INBOX_PROJECT_ID,
    projects: new Map([
      [inbox.id, inbox],
      [sample.id, sample],
    ]),
    tasks: new Map([[seededTask.id, seededTask]]),
    availability,
    availabilityVersion: 1,
    commitments: new Map([
      [teamSync.id, teamSync],
      [thesisReview.id, thesisReview],
    ]),
    plans: new Map(),
    planVersions: new Map(),
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
  mockDb.availability = fresh.availability;
  mockDb.availabilityVersion = fresh.availabilityVersion;
  mockDb.commitments = fresh.commitments;
  mockDb.plans = fresh.plans;
  mockDb.planVersions = fresh.planVersions;
  mockDb.idempotency = fresh.idempotency;
  mockDb.pendingIdempotency = fresh.pendingIdempotency;
  mockDb.authenticated = fresh.authenticated;
  mockDb.taskRevision = fresh.taskRevision;
  mockDb.projectRevision = fresh.projectRevision;
}
