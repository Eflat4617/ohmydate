import type {
  Availability,
  Export,
  Notification,
  Commitment,
  DecompositionStep,
  IntakeField,
  IntakeSession,
  IntakeState,
  Plan,
  PlanVersion,
  Project,
  PushSubscription,
  Task,
  TaskTemplate,
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

export interface MockIntakeSession extends IntakeSession {
  askedFields: IntakeField[];
  pausedFrom?: IntakeState;
  createdTaskIds?: string[];
}

export interface MockDb {
  user: User;
  inboxProjectId: string;
  projects: Map<string, Project>;
  tasks: Map<string, Task>;
  intakeSessions: Map<string, MockIntakeSession>;
  templates: Map<string, TaskTemplate>;
  availability: Availability;
  availabilityVersion: number;
  commitments: Map<string, Commitment>;
  plans: Map<string, Plan>;
  planVersions: Map<string, PlanVersion>;
  today: Today;
  todayRevision: number;
  proposals: Map<string, StoredProposal>;
  sessions: Map<string, WorkSession>;
  sessionClocks: Map<string, SessionClock>;
  activeSessionId: string | null;
  notifications: Map<string, Notification>;
  pushSubscriptions: Map<string, PushSubscription>;
  exports: Map<string, Export>;
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
export const REPORT_TEMPLATE_ID = '01900000-0000-7000-8000-0000000000b1';
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

function seedReportTemplate(createdAt: string): TaskTemplate {
  const steps: DecompositionStep[] = [
    {
      key: 's1',
      title: '자료 조사',
      deliverable: '참고 자료 목록',
      doneCriteria: '핵심 출처 3개 이상 정리',
      kind: 'prep',
      estimate: { p50Minutes: 45, p90Minutes: 75 },
      dependsOn: [],
      splittable: true,
    },
    {
      key: 's2',
      title: '초안 작성',
      deliverable: '보고서 초안',
      doneCriteria: '요구된 목차를 모두 채움',
      kind: 'work',
      estimate: { p50Minutes: 120, p90Minutes: 180 },
      dependsOn: ['s1'],
      splittable: true,
    },
    {
      key: 's3',
      title: '검토 및 수정',
      deliverable: '수정된 보고서',
      doneCriteria: '검토 의견을 모두 반영',
      kind: 'review',
      estimate: { p50Minutes: 30, p90Minutes: 45 },
      dependsOn: ['s2'],
      splittable: false,
    },
    {
      key: 's4',
      title: '제출 준비',
      deliverable: '제출본',
      doneCriteria: '형식과 파일명 확인',
      kind: 'buffer',
      estimate: { p50Minutes: 15, p90Minutes: 30 },
      dependsOn: ['s3'],
      splittable: false,
    },
  ];
  return {
    id: REPORT_TEMPLATE_ID,
    ownerId: USER_ID,
    name: '보고서 작성',
    steps,
    stats: { sampleCount: 3, meanRatio: 1.08, p90Ratio: 1.32 },
    source: 'system',
    confidence: 0.82,
    version: 1,
    createdAt,
    updatedAt: createdAt,
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

function seedNotifications(): [Notification, Notification] {
  return [
    {
      id: SEED_NOTIFICATION_ID,
      kind: 'due_soon',
      dedupeKey: `due-soon:${TODAY_TASK_ONE_ID}`,
      scheduledAt: '2026-11-14T09:50:00.000Z',
      sentAt: '2026-11-14T09:55:00.000Z',
      channel: 'in_app',
      state: 'sent',
      version: 1,
    },
    {
      id: SEED_SCHEDULED_NOTIFICATION_ID,
      kind: 'daily_summary',
      dedupeKey: 'daily-summary:2026-11-14',
      scheduledAt: '2026-11-14T20:00:00.000Z',
      channel: 'in_app',
      state: 'scheduled',
      version: 1,
    },
  ];
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
  const [seededNotification, scheduledNotification] = seedNotifications();
  const reportTemplate = seedReportTemplate(createdAt);
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
    tasks: new Map([
      [seededTask.id, seededTask],
      [todayTaskOne.id, todayTaskOne],
      [todayTaskTwo.id, todayTaskTwo],
    ]),
    intakeSessions: new Map(),
    templates: new Map([[reportTemplate.id, reportTemplate]]),
    availability,
    availabilityVersion: 1,
    commitments: new Map([
      [teamSync.id, teamSync],
      [thesisReview.id, thesisReview],
    ]),
    plans: new Map(),
    planVersions: new Map(),
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
    exports: new Map(),
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
  mockDb.intakeSessions = fresh.intakeSessions;
  mockDb.templates = fresh.templates;
  mockDb.availability = fresh.availability;
  mockDb.availabilityVersion = fresh.availabilityVersion;
  mockDb.commitments = fresh.commitments;
  mockDb.plans = fresh.plans;
  mockDb.planVersions = fresh.planVersions;
  mockDb.today = fresh.today;
  mockDb.todayRevision = fresh.todayRevision;
  mockDb.proposals = fresh.proposals;
  mockDb.sessions = fresh.sessions;
  mockDb.sessionClocks = fresh.sessionClocks;
  mockDb.activeSessionId = fresh.activeSessionId;
  mockDb.notifications = fresh.notifications;
  mockDb.pushSubscriptions = fresh.pushSubscriptions;
  mockDb.exports = fresh.exports;
  mockDb.idempotency = fresh.idempotency;
  mockDb.pendingIdempotency = fresh.pendingIdempotency;
  mockDb.authenticated = fresh.authenticated;
  mockDb.taskRevision = fresh.taskRevision;
  mockDb.projectRevision = fresh.projectRevision;
}
