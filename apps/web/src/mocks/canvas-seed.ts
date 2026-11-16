import type { Project, Task } from '../api/client';
import { SAMPLE_PROJECT_ID, USER_ID, type MockDb } from './db';

/**
 * HOLO-05: a believable 할 일 for mock mode and the screenshot sweep — to-dos
 * with deadlines near and far around the pinned mock day (2026-11-14,
 * Asia/Seoul), some without one, and three folders (the seeded 졸업 논문 and
 * two more) with a few to-dos each. Synthetic; the unit tests start without
 * it (`createMockDb`).
 */
export const CANVAS_FOLDER_SEMINAR_ID = '01900000-0000-7000-8000-0000000005f1';
export const CANVAS_FOLDER_HOME_ID = '01900000-0000-7000-8000-0000000005f2';

function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

/** [title, due date, due time, folder] — no date is no deadline; no folder is the inbox. */
const TODOS: readonly (readonly [title: string, date?: string | undefined, time?: string | undefined, folder?: string | undefined])[] = [
  ['지도 교수님께 메일 답장', '2026-11-14', '21:00'],
  ['도서관 책 반납', '2026-11-15', '18:00'],
  ['통계 과제 2번 풀이', '2026-11-17', '23:59'],
  ['선배에게 추천서 부탁', '2026-11-19', '12:00'],
  ['독서 모임 책 읽기', '2026-11-22', '19:00'],
  ['기숙사 관리비 납부', '2026-11-25', '17:00'],
  ['헬스장 등록 연장', '2026-11-30', '20:00'],
  ['수강 신청 장바구니 정리', '2026-12-01', '10:00'],
  ['연말 여행 숙소 알아보기', '2026-12-10', '18:00'],
  ['운동화 주문'],
  ['치과 예약 다시 잡기'],
  ['노트북 백업'],
  ['영양제 주문'],
  ['방 청소'],
  ['참고 문헌 정리', '2026-11-21', '18:00', SAMPLE_PROJECT_ID],
  ['2장 그림 다시 그리기', undefined, undefined, SAMPLE_PROJECT_ID],
  ['초록 영문 교정', '2026-12-08', '18:00', SAMPLE_PROJECT_ID],
  ['발표 리허설', '2026-11-19', '20:00', CANVAS_FOLDER_SEMINAR_ID],
  ['질문 예상 목록', undefined, undefined, CANVAS_FOLDER_SEMINAR_ID],
  ['청중용 한 장 요약', '2026-11-20', '12:00', CANVAS_FOLDER_SEMINAR_ID],
  ['세탁소 들르기', '2026-11-16', '19:00', CANVAS_FOLDER_HOME_ID],
  ['분리수거', undefined, undefined, CANVAS_FOLDER_HOME_ID],
  ['장보기 목록 쓰기', undefined, undefined, CANVAS_FOLDER_HOME_ID],
];

/** Titles the long field is made of (`extra`): everyday things, cycled with a number. */
const EXTRA_TITLES = [
  '읽을 논문 훑어보기',
  '회의록 정리',
  '실험 데이터 백업',
  '과제 채점 기준 확인',
  '동아리 회비 보내기',
  '자전거 바람 넣기',
  '택배 찾아오기',
  '식단 계획 세우기',
  '영어 단어 복습',
  '포트폴리오 사진 고르기',
] as const;

function todo(db: MockDb, index: number, title: string, dueAt: string | undefined, projectId: string): Task {
  // Created a minute apart, newest last: an order that does not depend on the clock.
  const createdAt = new Date(Date.parse('2026-11-08T00:00:00.000Z') + index * 60_000).toISOString();
  return {
    id: `01900000-0000-7000-8000-00000005${(0x1000 + index).toString(16)}`,
    ownerId: db.user.id,
    projectId,
    title,
    status: 'todo',
    splittable: true,
    priority: 2,
    dependsOn: [],
    session: { minMinutes: 25, maxMinutes: 90 },
    version: 1,
    createdAt,
    updatedAt: createdAt,
    external: [],
    ...(dueAt === undefined ? {} : { dueAt }),
  };
}

export function seedCanvas(db: MockDb, options: { readonly extra?: number } = {}): void {
  const createdAt = '2026-11-05T00:00:00.000Z';
  const folder = (id: string, title: string): Project => ({
    id,
    ownerId: USER_ID,
    title,
    kind: 'normal',
    archived: false,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  db.projects.set(CANVAS_FOLDER_SEMINAR_ID, folder(CANVAS_FOLDER_SEMINAR_ID, '세미나'));
  db.projects.set(CANVAS_FOLDER_HOME_ID, folder(CANVAS_FOLDER_HOME_ID, '집안일'));
  db.projectRevision += 1;

  TODOS.forEach(([title, date, time, folderId], index) => {
    const dueAt = date === undefined ? undefined : seoul(date, time ?? '18:00');
    const task = todo(db, index, title, dueAt, folderId ?? db.inboxProjectId);
    db.tasks.set(task.id, task);
  });
  // A long field: undated and far-dated to-dos in the inbox, for looking at many at once.
  for (let index = 0; index < (options.extra ?? 0); index += 1) {
    const title = `${EXTRA_TITLES[index % EXTRA_TITLES.length] as string} ${Math.floor(index / EXTRA_TITLES.length) + 1}`;
    const dueAt = index % 4 === 0 ? seoul(`2026-11-${String(16 + (index % 14)).padStart(2, '0')}`, '18:00') : undefined;
    const task = todo(db, TODOS.length + index, title, dueAt, db.inboxProjectId);
    db.tasks.set(task.id, task);
  }
  db.taskRevision += 1;
}

/** Leave only a handful of open to-dos: the canvas with five things on it. */
export function trimCanvas(db: MockDb, keep: number): void {
  let kept = 0;
  for (const task of [...db.tasks.values()]) {
    if (task.status === 'done' || task.deletedAt !== undefined) continue;
    kept += 1;
    if (kept > keep) db.tasks.delete(task.id);
  }
  db.taskRevision += 1;
}
