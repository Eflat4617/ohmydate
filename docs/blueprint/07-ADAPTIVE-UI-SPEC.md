# 07. 적응형 UI·디자인 시스템 명세 (`apps/web`, `packages/ui-policy`)

## 1. 결정
- 자체 Vue 3 + TS + Vite + Pinia + vue-router 앱. 서버 상태는 TanStack Vue Query, 생성 클라이언트는 `packages/contracts` OpenAPI에서 생성(ADR-005). Vikunja 프런트와 스택을 맞추되 **코드는 복사하지 않음**.
- 스타일: CSS 변수 기반 토큰 + 경량 유틸(Tailwind 4 [가정]). 컴포넌트는 headless 패턴 + 자체 구현.
- 원칙: "사용자가 지금 착수할 **하나의 다음 행동**을 쉽게 찾는다."

## 2. 적응 파이프라인

```text
Context Observer ──signals──► Layout Policy ──LayoutSpec(JSON)──► Component Registry(allowlist) ──► Renderer
 (route, active session,       (규칙 기반, 순수 함수,             (id→Vue 컴포넌트, props 스키마)    (CSS grid, 안정 키)
  deadline risk, device,        hysteresis, user overrides 우선)
  user prefs, time of day)        ▲ 선택적: AI layout_suggestion (제안만, 동일 검증)
```

### 2.1 LayoutSpec 계약 (`ui.layout.v1`)
```json
{
  "mode": "focus",
  "regions": {
    "primary":   [{ "component": "FocusTimer", "props": { "sessionId": "0193…" } }],
    "secondary": [{ "component": "CurrentTaskCard" }, { "component": "RelatedNotes", "props": { "limit": 3 } }],
    "tertiary":  [{ "component": "NextUp", "props": { "count": 2 } }]
  },
  "pinned": ["NavRail"],
  "reason": "active_session",
  "policyVersion": "ui-policy@0.1.0"
}
```
- `component`는 Registry enum만 허용, `props`는 컴포넌트별 JSON Schema(additionalProperties:false). HTML/JS/URL/스타일 문자열 필드 없음.
- 검증 실패 → 직전 레이아웃 유지 + 로그. AI 제안은 사용자 설정·접근성·기기 한계보다 **낮은 우선순위**.

### 2.2 모드 결정 규칙(우선순위 순)
1. 사용자가 수동 고정(`layout.locked`) → 고정 레이아웃
2. active work_session → `focus`
3. 진행 중 Intake/Plan 비교 라우트 → `planning`
4. 위험 task(slack_P90 < 0) 존재 & 오늘 미확인 → `deadline_risk`
5. 하루 마감 시간대 + 미검토 세션 → `review`
6. 노트 라우트 → `notes`
7. 기본 → `overview`

### 2.3 안정성 규칙
- 핵심 내비게이션(NavRail/BottomNav) 고정, 항상 렌더.
- hysteresis: 자동 전환 후 최소 10분 유지 [가정], 사용자 입력 중(포커스된 입력/드래그) 전환 보류.
- 작업 중 패널 제거 금지: 사용자가 상호작용 중인 컴포넌트는 다음 idle까지 유지.
- 전환 시 "레이아웃이 바뀌었어요 · 되돌리기" 토스트(undo 1단계) + 자동 전환 끄기 링크.
- `prefers-reduced-motion` 시 애니메이션 0.

## 3. 화면 목록과 텍스트 와이어프레임
화면: Today, Inbox, Calendar, Project, Planning Wizard, Plan Comparison, Focus Mode, Review, Notes, AI Chat(M6+, 제안 생성 전용), Settings.

### 3.1 Today (M4)
```text
Desktop                                         Mobile (≤640px)
┌Nav┬──────────────────────────────┬─────────┐  ┌──────────────────┐
│ ▣ │ 오늘 11/14 (목)  여유 3h20m   │ 다음 일정 │  │ 오늘 · 여유 3h20m │
│ ▢ │ ① 논문 요약 19:00–20:30 [시작]│ 14:00 수업│  │ ① 논문 요약 [시작]│
│ ▢ │ ② 발표 개요 21:00–21:40 [시작]│ 마감 위험 │  │ ② 발표 개요       │
│ ▢ │ + 축소 · 재배치 · 내일로      │  없음     │  │ [축소][재배치]    │
└───┴──────────────────────────────┴─────────┘  └─[Today][Inbox][+][Cal][≡]┘
```
- 액션: 수락(`POST /today/accept`), 축소/재배치(proposal→승인), 세션 시작.
- 서버: `GET /today?date=` (ETag). 빈 상태: "오늘 예정 없음 · 인박스에서 하나 고르기". 로딩: 스켈레톤(레이아웃 고정 높이). 오류: 캐시 표시 + 재시도 배너. 오프라인: 읽기 전용 배지.

### 3.2 Planning Wizard (M2)
```text
[1 기본정보]─[2 유형 확인]─[3 질문(≤5)]─[4 단계 초안]─[5 일정안]
 제목/마감/설명/파일   "이전 '보고서' 유형과 비슷해요(0.82: 태그·과거 3건) 맞나요? [예][아니오]"
 질문 카드: 질문 · [답변] [모름] [건너뛰기]           하단 고정: [직접 작성으로 전환]
```
상태 전이: Intake 상태 기계(05 §2)와 1:1. 새로고침/다른 기기에서 재개.

### 3.3 Plan Comparison (M3)
```text
┌ front_loaded ───────┬ balanced ───────────┬ focus_blocked ──────┐
│ 완료 예상 11/17      │ 완료 11/19          │ 완료 11/18          │
│ 마감 여유 3일        │ 1일                 │ 2일                 │
│ 최대 일부담 3h       │ 1h30                │ 2h30                │
│ 전환 6회             │ 9회                 │ 3회                 │
│ [미니 타임라인]      │ [미니 타임라인]     │ [미니 타임라인]     │
│ [선택]               │ [선택]              │ [선택]              │
└──────────────────────┴─────────────────────┴─────────────────────┘
 "서로 다른 안이 2개뿐입니다: 가용 시간이 적어 balanced와 focus_blocked가 같아짐" (diversityNote)
 선택 후: 블록 드래그 편집(validator 실시간) → [이 일정으로 확정]
```
모바일: 카드 가로 스와이프 + 비교 표 토글. 승인 412 시 충돌 블록 하이라이트 + [재생성].

### 3.4 Focus Mode (M4)
타이머(집중/경과 분리 표시), 현재 할 일·완료 기준, 관련 노트 3개, [일시정지][완료][중단]. 완료 시 1탭 피드백 시트(완료/부분/미완 + 사유 칩). 네트워크 끊김 시 로컬 타이머 지속, 복귀 시 업로드.

### 3.5 Inbox / Project / Calendar / Review / Notes / Settings
- Inbox(M1): 빠른 추가(제목만), 목록, 편집, 완료. Vikunja 동기화 상태 배지.
- Project(M1): 작업 목록 + 노트 탭(M6).
- Calendar(M3): 주/일 뷰, commitment·block 구분 색 + 패턴(색각 이상 대응).
- Review(M4): 오늘 세션 요약, 추정 vs 실측, "내 패턴".
- Notes(M6): Markdown 편집/미리보기, 연결 대상, AI 근거 사용 이력.
- Settings: 가용 시간, 집중 한도, 알림, LLM 동의/예산, 레이아웃 자동 전환, 데이터 내보내기/삭제.

## 4. 기기별
- Desktop(Win/Linux): 키보드 단축키(`n` 새 작업, `t` Today, `f` 포커스, `/` 검색, `?` 도움말), 멀티패널(≥1280px 3열).
- Android(PWA): 하단 탭, 44px 이상 터치 타깃, Web Push, 오프라인 배지, 화면 꺼짐 대비 타이머는 서버 시각 기준 계산.

## 5. 접근성 수락 기준
키보드만으로 시나리오 A·C 완주, 모든 인터랙티브 요소 accessible name, 대비 WCAG 2.2 AA, 레이아웃 전환 시 포커스 보존 + `aria-live=polite` 안내, axe 위반 0(critical/serious).

## 6. 오프라인·동기화 (ADR-010)
- M1–M7: Service Worker 캐시 읽기 + 명시적 오프라인 제한(편집 비활성). 예외: Focus 세션 로컬 기록(멱등 업로드).
- 편집 큐는 M8+ 재평가(조건: 실제 오프라인 편집 요구 빈도 측정).
- 모든 변경 요청: `If-Match` + `Idempotency-Key`(클라이언트 UUIDv7).

## 7. Vikunja 설명란 vs 노트 경계
- Vikunja `description` = 작업 짧은 설명(동기화 대상, HTML 가능 → 표시 시 sanitize).
- ContextDocument = planner 소유 Markdown 지식(동기화하지 않음). 작업 설명에서 노트로 "승격" 액션만 제공.
