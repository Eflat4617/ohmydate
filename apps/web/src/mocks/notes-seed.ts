import type { ContextDocument, DocumentLink, DocumentTargetKind, NoteAiUsage } from '../api/client';

/**
 * Synthetic notes for the mock API (M6-03). No imports from `db.ts`, so the
 * mock database can create this state without an import cycle.
 */

export const NOTE_THESIS_ID = '01900000-0000-7000-8000-0000000003a1';
export const NOTE_MEETING_ID = '01900000-0000-7000-8000-0000000003a2';
export const NOTE_PRIVATE_ID = '01900000-0000-7000-8000-0000000003a3';
export const NOTE_USAGE_RUN_ID = '01900000-0000-7000-8000-0000000003b1';
export const NOTE_USAGE_STALE_RUN_ID = '01900000-0000-7000-8000-0000000003b2';

export interface StoredNote extends ContextDocument {
  deletedAt?: string;
}

export interface MockNotesState {
  documents: Map<string, StoredNote>;
  /** Newest last; listed newest first. */
  usage: NoteAiUsage[];
  /** Goals created by intake sessions (id → title). */
  goals: Map<string, string>;
}

/** 16-hex section hash stand-in (FNV-1a over the text), deterministic in the browser. */
export function mockSectionHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

export function bodyHash(text: string): string {
  return `${mockSectionHash(`a${text}`)}${mockSectionHash(`b${text}`)}${mockSectionHash(`c${text}`)}${mockSectionHash(`d${text}`)}`;
}

export function seedLink(
  id: string,
  documentId: string,
  targetKind: DocumentTargetKind,
  targetId: string,
  createdAt: string,
): DocumentLink {
  return { id, documentId, targetKind, targetId, createdAt };
}

const THESIS_BODY = [
  '# 졸업 논문 참고 문헌',
  '',
  '지도 교수님 피드백: **3장 실험 설계**를 먼저 보완하고, 관련 연구는 _최근 3년_ 위주로 정리하기.',
  '',
  '## 할 일',
  '- 선행 연구 표 정리',
  '- 실험 데이터 다시 확인',
  '- 초록 초안',
  '',
  '## 참고',
  '| 자료 | 상태 |',
  '| --- | --- |',
  '| 학회 논문 2편 | 읽는 중 |',
  '| 데이터셋 문서 | 완료 |',
  '',
  '도서관 안내: [학술 DB 이용법](https://library.example.org/guide)',
].join('\n');

const MEETING_BODY = [
  '## 지난 회의 메모',
  '',
  '다음 회의 전까지 발표 자료 목차를 공유해야 해요.',
  '',
  '> 회의실 예약은 금요일 오전까지.',
].join('\n');

const PRIVATE_BODY = '병원 예약 화요일 오후 3시. 연락처는 따로 보관.';

export interface NotesSeedOptions {
  readonly ownerId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly uuid: () => string;
}

export function createNotesState(options: NotesSeedOptions): MockNotesState {
  const { ownerId, projectId, createdAt, uuid } = options;
  const thesis: StoredNote = {
    id: NOTE_THESIS_ID,
    ownerId,
    title: '졸업 논문 참고 문헌',
    bodyMd: THESIS_BODY,
    sensitivity: 'P2',
    llmAllowed: true,
    source: 'manual',
    links: [seedLink('01900000-0000-7000-8000-0000000003c1', NOTE_THESIS_ID, 'project', projectId, createdAt)],
    version: 3,
    createdAt,
    updatedAt: '2026-11-12T05:30:00.000Z',
  };
  const meeting: StoredNote = {
    id: NOTE_MEETING_ID,
    ownerId,
    title: '발표 준비 회의',
    bodyMd: MEETING_BODY,
    sensitivity: 'P2',
    llmAllowed: false,
    source: 'manual',
    links: [],
    version: 1,
    createdAt,
    updatedAt: '2026-11-10T11:00:00.000Z',
  };
  const privateNote: StoredNote = {
    id: NOTE_PRIVATE_ID,
    ownerId,
    title: '개인 일정 메모',
    bodyMd: PRIVATE_BODY,
    sensitivity: 'P1',
    llmAllowed: false,
    source: 'manual',
    links: [],
    version: 1,
    createdAt,
    updatedAt: '2026-11-08T02:00:00.000Z',
  };
  const usage: NoteAiUsage[] = [
    {
      id: uuid(),
      documentId: NOTE_THESIS_ID,
      agentRunId: NOTE_USAGE_STALE_RUN_ID,
      purpose: 'decomposition',
      promptIdVersion: 'decomposition@v2',
      status: 'failed',
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash',
      documentVersion: 1,
      bodyHash: bodyHash('v1'),
      sectionHashes: [mockSectionHash(`${NOTE_THESIS_ID}#0#v1`)],
      sentBytes: 420,
      stale: true,
      createdAt: '2026-11-09T03:00:00.000Z',
    },
    {
      id: uuid(),
      documentId: NOTE_THESIS_ID,
      agentRunId: NOTE_USAGE_RUN_ID,
      purpose: 'decomposition',
      promptIdVersion: 'decomposition@v2',
      status: 'succeeded',
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash',
      documentVersion: 3,
      bodyHash: bodyHash(THESIS_BODY),
      sectionHashes: [mockSectionHash(`${NOTE_THESIS_ID}#0`), mockSectionHash(`${NOTE_THESIS_ID}#1`)],
      sentBytes: 1_536,
      stale: false,
      createdAt: '2026-11-12T06:00:00.000Z',
    },
  ];
  return {
    documents: new Map([
      [thesis.id, thesis],
      [meeting.id, meeting],
      [privateNote.id, privateNote],
    ]),
    usage,
    goals: new Map(),
  };
}

