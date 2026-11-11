import type {
  Notification,
  PlanVersion,
  Project,
  PushSubscription,
  Task,
  Today,
  TodayProposal,
  User,
  WorkSession,
} from '../api/client';

export interface StoredResponse {
  readonly hash: string;
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export interface StoredProposal {
  readonly proposal: TodayProposal;
  readonly availabilityVersion: number;
  applied: boolean;
  planVersion?: PlanVersion;
}

export interface SessionClock {
  activeSince: number | null;
  pausedSince: number | null;
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
  today: Today;
  todayRevision: number;
  proposals: Map<string, StoredProposal>;
  sessions: Map<string, WorkSession>;
  sessionClocks: Map<string, SessionClock>;
  activeSessionId: string | null;
  notifications: Map<string, Notification>;
  pushSubscriptions: Map<string, PushSubscription>;
}

export const USER_ID = '01900000-0000-7000-8000-000000000002';
export const INBOX_PROJECT_ID = '01900000-0000-7000-8000-000000000001';
export const SAMPLE_PROJECT_ID = '01900000-0000-7000-8000-000000000003';
export const SEED_TASK_TITLE = 'Review weekly plan';
export const TODAY_TASK_ONE_ID = '01900000-0000-7000-8000-0000000000a1';
export const TODAY_TASK_TWO_ID = '01900000-0000-7000-8000-0000000000a2';
export const TODAY_BLOCK_ONE_ID = '01900000-0000-7000-8000-0000000000b1';
export const TODAY_BLOCK_TWO_ID = '01900000-0000-7000-8000-0000000000b2';
export const TODAY_TASK_ONE_TITLE = 'Summarise research notes';
export const TODAY_TASK_TWO_TITLE = 'Draft presentation outline';
export const SEED_NOTIFICATION_ID = '01900000-0000-7000-8000-0000000000c1';
export const SEED_SCHEDULED_NOTIFICATION_ID = '01900000-0000-7000-8000-0000000000c2';

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

function seedTask(title: string, version: number, id?: string): Task {
  const createdAt = '2026-11-01T09:00:00.000Z';
  return {
    ...(id === undefined ? { id: createUuidV7() } : { id }),
    ownerId: USER_ID,
    projectId: INBOX_PROJECT_ID,
    title,
    status: 'todo',
    splittable: true,
    priority: 2,
    dependsOn: [],
    session: { minMinutes: 25, maxMinutes: 90 },
    version,
    createdAt,
    updatedAt: createdAt,
    external: [],
  };
}

function createToday(): Today {
  return {
    date: '2026-11-14',
    timeZone: 'Asia/Seoul',
    slackMin: 200,
    risk: {
      level: 'medium',
      reasons: ['One block ends close to a task deadline'],
    },
    version: 1,
    blocks: [
      {
        id: TODAY_BLOCK_ONE_ID,
        taskId: TODAY_TASK_ONE_ID,
        title: TODAY_TASK_ONE_TITLE,
        startAt: '2026-11-14T10:00:00.000Z',
        endAt: '2026-11-14T11:30:00.000Z',
        status: 'planned',
      },
      {
        id: TODAY_BLOCK_TWO_ID,
        taskId: TODAY_TASK_TWO_ID,
        title: TODAY_TASK_TWO_TITLE,
        startAt: '2026-11-14T12:00:00.000Z',
        endAt: '2026-11-14T12:40:00.000Z',
        status: 'planned',
      },
    ],
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
  const todayTaskOne = seedTask(TODAY_TASK_ONE_TITLE, 1, TODAY_TASK_ONE_ID);
  const todayTaskTwo = seedTask(TODAY_TASK_TWO_TITLE, 1, TODAY_TASK_TWO_ID);
  const seededNotification: Notification = {
    id: SEED_NOTIFICATION_ID,
    kind: 'due_soon',
    dedupeKey: `due-soon:${TODAY_TASK_ONE_ID}`,
    scheduledAt: '2026-11-14T09:50:00.000Z',
    sentAt: '2026-11-14T09:55:00.000Z',
    channel: 'in_app',
    state: 'sent',
    version: 1,
  };
  const scheduledNotification: Notification = {
    id: SEED_SCHEDULED_NOTIFICATION_ID,
    kind: 'daily_summary',
    dedupeKey: 'daily-summary:2026-11-14',
    scheduledAt: '2026-11-14T20:00:00.000Z',
    channel: 'in_app',
    state: 'scheduled',
    version: 1,
  };
  return {
    user,
    inboxProjectId: INBOX_PROJECT_ID,
    projects: new Map([
      [inbox.id, inbox],
      [sample.id, sample],
    ]),
    tasks: new Map([
      [seededTask.id, seededTask],
      [todayTaskOne.id, todayTaskOne],
      [todayTaskTwo.id, todayTaskTwo],
    ]),
    idempotency: new Map(),
    pendingIdempotency: new Set(),
    authenticated: true,
    taskRevision: 1,
    projectRevision: 1,
    today: createToday(),
    todayRevision: 1,
    proposals: new Map(),
    sessions: new Map(),
    sessionClocks: new Map(),
    activeSessionId: null,
    notifications: new Map([
      [seededNotification.id, seededNotification],
      [scheduledNotification.id, scheduledNotification],
    ]),
    pushSubscriptions: new Map(),
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
  mockDb.today = fresh.today;
  mockDb.todayRevision = fresh.todayRevision;
  mockDb.proposals = fresh.proposals;
  mockDb.sessions = fresh.sessions;
  mockDb.sessionClocks = fresh.sessionClocks;
  mockDb.activeSessionId = fresh.activeSessionId;
  mockDb.notifications = fresh.notifications;
  mockDb.pushSubscriptions = fresh.pushSubscriptions;
}
