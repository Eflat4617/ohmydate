import type {
  Availability,
  Export,
  Notification,
  Commitment,
  DecompositionStep,
  IntakeField,
  IntakeSession,
  IntakeState,
  EstimationProfile,
  Plan,
  PlanVersion,
  Project,
  ReplanProposal,
  PushSubscription,
  Task,
  ScheduleBlock,
  TaskTemplate,
  Today,
  TodayProposal,
  User,
  WorkSession,
} from '../api/client';
import { seedEstimationProfile } from './replan-seed';
import { createNotesState, type MockNotesState } from './notes-seed';
import { createGoogleState, type MockGoogleState } from './google-seed';

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
  extraScheduleBlocks: ScheduleBlock[];
  /** FU-71: lock state of Today blocks (they carry no lock/version of their own). */
  todayBlockLocks: Map<string, { locked: boolean; version: number }>;
  proposals: Map<string, StoredProposal>;
  sessions: Map<string, WorkSession>;
  sessionClocks: Map<string, SessionClock>;
  activeSessionId: string | null;
  notifications: Map<string, Notification>;
  pushSubscriptions: Map<string, PushSubscription>;
  exports: Map<string, Export>;
  /** M5-03: replan proposals (empty by default; see `seedReplanScenario`). */
  replanProposals: Map<string, ReplanProposal>;
  /** Suppression windows after a rejection: reason code → until (epoch ms). */
  replanSuppressions: Map<string, number>;
  /** "내 패턴" profile (learned by default). */
  estimation: EstimationProfile;
  /** M6-03: notes, their AI usage history and the goals intake sessions created. */
  notes: MockNotesState;
  /** CAL-04: the Google Calendar connection (not configured by default; see `seedGoogle`). */
  google: MockGoogleState;
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
export const SEED_TASK_TITLE = '주간 계획 돌아보기';
export const TODAY_TASK_ONE_ID = '01900000-0000-7000-8000-0000000000a1';
export const TODAY_TASK_TWO_ID = '01900000-0000-7000-8000-0000000000a2';
export const TODAY_BLOCK_ONE_ID = '01900000-0000-7000-8000-0000000000b1';
export const TODAY_BLOCK_TWO_ID = '01900000-0000-7000-8000-0000000000b2';
export const TODAY_TASK_ONE_TITLE = '연구 노트 요약';
export const TODAY_TASK_TWO_TITLE = '발표 개요 초안';
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
      // Same reason code the API emits (today-service: `daily_focus_cap_exceeded:<min>`).
      reasons: ['daily_focus_cap_exceeded:310'],
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
    // FU-91: like the live GU-1 owner (FU-89R), so the mock's Korean AI reasons match it.
    locale: 'ko-KR',
    llmProvider: 'fake',
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
    title: '졸업 논문',
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
    title: '팀 회의',
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
    title: '논문 검토',
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
    extraScheduleBlocks: [],
    todayBlockLocks: new Map(),
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
    replanProposals: new Map(),
    replanSuppressions: new Map(),
    estimation: seedEstimationProfile({
      templateId: REPORT_TEMPLATE_ID,
      taskOne: TODAY_TASK_ONE_ID,
      taskTwo: TODAY_TASK_TWO_ID,
    }),
    notes: createNotesState({ ownerId: USER_ID, projectId: SAMPLE_PROJECT_ID, createdAt, uuid: createUuidV7 }),
    google: createGoogleState(),
    idempotency: new Map(),
    pendingIdempotency: new Set(),
    authenticated: true,
    taskRevision: 1,
    projectRevision: 1,
  };
}

export const mockDb = createMockDb();

/** The approved row of a Today block the way `GET /schedule-blocks` reports it. */
export function todayScheduleBlock(
  db: MockDb,
  block: Today['blocks'][number],
  planVersionId: string,
): ScheduleBlock {
  const lock = db.todayBlockLocks.get(block.id);
  return {
    id: block.id,
    planVersionId,
    taskId: block.taskId,
    startAt: block.startAt,
    endAt: block.endAt,
    locked: lock?.locked ?? false,
    status: block.status,
    version: lock?.version ?? 1,
  };
}

/** CAL-01: synthetic ids of the November month (`seedMonth`). */
export const MONTH_TASK_THESIS_ID = '01900000-0000-7000-8000-0000000004a1';
export const MONTH_TASK_SLIDES_ID = '01900000-0000-7000-8000-0000000004a2';
export const MONTH_TASK_SCHOLARSHIP_ID = '01900000-0000-7000-8000-0000000004a3';
export const MONTH_TASK_ENGLISH_ID = '01900000-0000-7000-8000-0000000004a4';
export const MONTH_TASK_SUMMARY_ID = '01900000-0000-7000-8000-0000000004a5';
export const MONTH_TASK_REPORT_ID = '01900000-0000-7000-8000-0000000004a6';
export const MONTH_COMMITMENT_YOGA_ID = '01900000-0000-7000-8000-0000000004c1';
export const MONTH_COMMITMENT_DENTIST_ID = '01900000-0000-7000-8000-0000000004c2';
export const MONTH_COMMITMENT_CALL_ID = '01900000-0000-7000-8000-0000000004c3';
export const MONTH_COMMITMENT_SEMINAR_ID = '01900000-0000-7000-8000-0000000004c4';
export const MONTH_COMMITMENT_ADVISOR_ID = '01900000-0000-7000-8000-0000000004c5';
const MONTH_PLAN_VERSION_ID = '01900000-0000-7000-8000-0000000000d1';

/** A Seoul wall-clock time (UTC+9, no DST) as an instant. */
function seoulInstant(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

/**
 * CAL-01: a believable November 2026 around the pinned mock day (11-14,
 * Asia/Seoul) for the month page and the screenshot sweep — finished blocks
 * before today, planned ones after, a weekly 약속 next to the seeded team
 * meeting, one-off 약속 (two of them today), and deadlines (one today, one
 * overdue, one in the next month's first week). The same database and
 * handlers serve it; the unit tests start without it (`createMockDb`).
 */
export function seedMonth(db: MockDb): void {
  const createdAt = '2026-11-02T00:00:00.000Z';
  const task = (
    id: string,
    title: string,
    dueAt: string,
    status: Task['status'] = 'todo',
    projectId: string = db.inboxProjectId,
  ): Task => ({
    ...seedTask(title, 1, id),
    projectId,
    status,
    dueAt,
    createdAt,
    updatedAt: createdAt,
  });
  const tasks = [
    task(MONTH_TASK_THESIS_ID, '졸업 논문 3장 초고', seoulInstant('2026-11-27', '18:00'), 'in_progress', SAMPLE_PROJECT_ID),
    task(MONTH_TASK_SLIDES_ID, '세미나 발표 자료', seoulInstant('2026-11-20', '14:00'), 'in_progress'),
    task(MONTH_TASK_SCHOLARSHIP_ID, '장학금 신청서 제출', seoulInstant('2026-11-14', '23:00')),
    task(MONTH_TASK_ENGLISH_ID, '영어 회화 과제', seoulInstant('2026-11-06', '18:00')),
    task(MONTH_TASK_SUMMARY_ID, '세미나 논문 요약', seoulInstant('2026-11-10', '18:00'), 'done'),
    task(MONTH_TASK_REPORT_ID, '실험 보고서', seoulInstant('2026-12-04', '17:00'), 'todo', SAMPLE_PROJECT_ID),
  ];
  for (const item of tasks) db.tasks.set(item.id, item);
  db.taskRevision += 1;

  const blocks: [string, string, string, string, ScheduleBlock['status']][] = [
    [MONTH_TASK_THESIS_ID, '2026-11-02', '19:00', '20:30', 'done'],
    [MONTH_TASK_ENGLISH_ID, '2026-11-03', '20:00', '21:00', 'done'],
    [MONTH_TASK_THESIS_ID, '2026-11-04', '19:30', '21:00', 'done'],
    [MONTH_TASK_ENGLISH_ID, '2026-11-05', '20:00', '21:00', 'done'],
    [MONTH_TASK_THESIS_ID, '2026-11-07', '10:00', '12:00', 'done'],
    [MONTH_TASK_SUMMARY_ID, '2026-11-09', '19:00', '20:00', 'done'],
    [MONTH_TASK_SLIDES_ID, '2026-11-10', '19:00', '20:30', 'done'],
    [MONTH_TASK_THESIS_ID, '2026-11-12', '20:00', '21:30', 'done'],
    [MONTH_TASK_SLIDES_ID, '2026-11-13', '19:00', '20:00', 'done'],
    [MONTH_TASK_THESIS_ID, '2026-11-15', '14:00', '16:00', 'planned'],
    [MONTH_TASK_SLIDES_ID, '2026-11-16', '19:00', '20:30', 'planned'],
    [MONTH_TASK_SLIDES_ID, '2026-11-17', '20:00', '21:00', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-18', '19:00', '20:00', 'planned'],
    [MONTH_TASK_SLIDES_ID, '2026-11-18', '20:30', '21:30', 'planned'],
    [MONTH_TASK_SLIDES_ID, '2026-11-19', '19:00', '20:00', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-19', '20:30', '22:00', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-20', '19:00', '20:00', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-21', '10:00', '12:00', 'planned'],
    [MONTH_TASK_REPORT_ID, '2026-11-21', '14:00', '15:30', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-23', '19:00', '20:30', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-24', '20:00', '21:30', 'planned'],
    [MONTH_TASK_REPORT_ID, '2026-11-25', '13:00', '14:00', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-25', '15:00', '16:00', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-25', '19:00', '20:30', 'planned'],
    [MONTH_TASK_REPORT_ID, '2026-11-25', '21:00', '22:00', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-26', '19:00', '21:00', 'planned'],
    [MONTH_TASK_THESIS_ID, '2026-11-27', '10:00', '12:00', 'planned'],
    [MONTH_TASK_REPORT_ID, '2026-11-30', '19:00', '20:30', 'planned'],
    [MONTH_TASK_REPORT_ID, '2026-12-02', '19:00', '20:30', 'planned'],
  ];
  db.extraScheduleBlocks = [
    ...db.extraScheduleBlocks,
    ...blocks.map(([taskId, date, start, end, status], index): ScheduleBlock => ({
      id: `01900000-0000-7000-8000-0000000004${(0xd0 + index).toString(16)}`,
      planVersionId: MONTH_PLAN_VERSION_ID,
      taskId,
      startAt: seoulInstant(date, start),
      endAt: seoulInstant(date, end),
      locked: false,
      status,
      version: 1,
    })),
  ];

  const commitment = (id: string, title: string, date: string, start: string, end: string, rrule?: string): Commitment => ({
    id,
    ownerId: db.user.id,
    title,
    startAt: seoulInstant(date, start),
    endAt: seoulInstant(date, end),
    timeZone: 'Asia/Seoul',
    ...(rrule === undefined ? {} : { rrule }),
    source: 'manual',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  for (const item of [
    commitment(MONTH_COMMITMENT_YOGA_ID, '요가', '2026-11-03', '07:30', '08:30', 'FREQ=WEEKLY;BYDAY=TU,TH'),
    commitment(MONTH_COMMITMENT_DENTIST_ID, '치과 예약', '2026-11-14', '15:00', '15:40'),
    commitment(MONTH_COMMITMENT_CALL_ID, '가족 통화', '2026-11-14', '22:00', '22:30'),
    commitment(MONTH_COMMITMENT_SEMINAR_ID, '세미나 발표', '2026-11-20', '15:00', '16:30'),
    commitment(MONTH_COMMITMENT_ADVISOR_ID, '지도 교수 면담', '2026-11-25', '17:00', '18:00'),
  ]) {
    db.commitments.set(item.id, item);
  }
}

/** M6-02 screenshots: Today with a deadline risk (same reason codes as the API). */
export function seedTodayRisk(db: MockDb): void {
  db.today = {
    ...db.today,
    slackMin: -45,
    risk: {
      level: 'high',
      reasons: ['negative_slack:-45', `task_overdue:${TODAY_TASK_TWO_ID}`, 'daily_focus_cap_exceeded:310'],
    },
  };
  db.todayRevision += 1;
}

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
  mockDb.extraScheduleBlocks = fresh.extraScheduleBlocks;
  mockDb.todayBlockLocks = fresh.todayBlockLocks;
  mockDb.proposals = fresh.proposals;
  mockDb.sessions = fresh.sessions;
  mockDb.sessionClocks = fresh.sessionClocks;
  mockDb.activeSessionId = fresh.activeSessionId;
  mockDb.notifications = fresh.notifications;
  mockDb.pushSubscriptions = fresh.pushSubscriptions;
  mockDb.exports = fresh.exports;
  mockDb.replanProposals = fresh.replanProposals;
  mockDb.replanSuppressions = fresh.replanSuppressions;
  mockDb.estimation = fresh.estimation;
  mockDb.notes = fresh.notes;
  mockDb.google = fresh.google;
  mockDb.idempotency = fresh.idempotency;
  mockDb.pendingIdempotency = fresh.pendingIdempotency;
  mockDb.authenticated = fresh.authenticated;
  mockDb.taskRevision = fresh.taskRevision;
  mockDb.projectRevision = fresh.projectRevision;
}
