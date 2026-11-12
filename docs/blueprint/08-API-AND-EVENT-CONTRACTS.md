# 08. API·이벤트 계약 (`packages/contracts`)

## 1. 공통 규약
- Base: `/api/v1` (planner 자체 버전; Vikunja 버전과 무관). JSON, camelCase, 시각은 RFC 3339 오프셋 포함, 날짜는 `YYYY-MM-DD` + 사용자 tz.
- 단일 소스: TypeBox 스키마(`packages/contracts/src/**`) → Fastify 검증 + `@fastify/swagger`로 **OpenAPI 3.1 산출** → `apps/web`은 `openapi-typescript`(또는 hey-api) 생성 클라이언트. CI에서 생성물 diff 0 검사(ADR-005).
- 인증: 세션 쿠키(`HttpOnly; Secure; SameSite=Lax`) + 변경 메서드에 `X-CSRF-Token`. 장래 API 토큰(Bearer, scope).
  - **세션 지속(2026-11-12, FU-92):** `PROVIDER=vikunja` + `DATABASE_URL`(로컬·운영 기본)에서는 로그인 세션이 planner DB `auth_session`(04 §3)에 저장되어 **API 재시작(`local:stop`/`local:start`, 재부팅, 업데이트) 뒤에도 로그인이 유지**된다(마지막 사용부터 14일, 로그아웃·만료·사용자 삭제 시 종료). 쿠키·CSRF 이중 제출·오류 코드(401 `unauthenticated`, 403 `forbidden`)는 그대로다. `PROVIDER=memory`는 프로세스 메모리 세션.
- 오류: RFC 9457 `application/problem+json` `{type, title, status, detail, code, errors?[{path,message}], traceId}`. `code`는 안정 enum(`validation_failed`, `version_conflict`, `availability_changed`, `idempotency_mismatch`, `provider_unavailable`, `llm_unavailable`, `budget_exceeded`, `dependency_cycle`, `not_found`, `forbidden`, `rate_limited`).
- **제약 위반 코드(2026-11-11 확정, FU-62):** `constraint_violation`의 `violations[]`(및 preview-edit 응답의 `violations[]`)는 `{code(H1–H8), taskId?, message}`에 선택 필드 `messageCode` + `params`를 더한다. `message`는 영문 로그용이고, 클라이언트는 닫힌 enum `messageCode`(06 §6.1)와 `params`(숫자·ID·UTC instant·날짜만, 제목·노트 금지)로 현지어 문장을 만든다. 후보·재계획 후보의 `explanationItems[]`도 같은 `{code, params}` 형식이다.
- 상태 코드: 200/201/202/204, 304(If-None-Match), 400(형식), 401, 403, 404, 409(상태 전이 불가), 412(If-Match 불일치), 422(도메인 검증), 428(If-Match 필수 누락), 429, 503(provider/LLM).
- 낙관적 잠금: 모든 PATCH/PUT/DELETE와 상태 변경 POST는 `If-Match: W/"<version>"` 필수(누락 428).
- 멱등: 모든 생성 POST·승인 POST·세션 이벤트는 `Idempotency-Key` 필수. 같은 키+같은 본문 해시 → 저장된 응답 재생, 다른 본문 → 422 `idempotency_mismatch`. 보존 24h.
- **헤더 규칙 확정(2026-11-11, M1-02R 지적 반영 — 이 표가 정본):**
  | 경로 종류 | If-Match | Idempotency-Key | 추가 오류 응답 |
  |---|---|---|---|
  | 생성 POST (컬렉션에 새 리소스) | 없음 | **필수** | 422 idempotency_mismatch |
  | 기존 리소스 변경(PATCH/PUT/DELETE, `:action` POST, 하위 리소스 추가 POST 예: `/tasks/{id}/dependencies`) | **필수**(누락 428, 불일치 412) | **필수** | 412, 428, 422 |
  | GET | 선택 If-None-Match(304) | 없음 | — |
  | `/auth/login`, `/auth/logout` | 없음 | 없음 | — |
  모든 Problem 응답 media type = `application/problem+json`. 모든 경로는 입력 검증 실패 400(형식)/422(도메인), provider를 거치는 경로는 503을 개별 선언.
- **멱등 기록 저장 규칙 확정(2026-11-11, M1-07R2 지적):** 저장·재생 대상은 **2xx 응답과 409/422 도메인 결과**뿐이다. 400/401/403/412/428/429/5xx, `idempotency_in_progress`, 그리고 일시적 경합 409 `approval_in_progress`(Retry-After 동반, ADR-020 §11)는 저장하지 않으며 같은 키로 재시도 가능(키 예약은 해제). 요청 해시는 메서드+경로+정규화 본문으로 계산하고 **If-Match는 해시에 포함하지 않는다**. 클라이언트는 If-Match가 바뀌는 재시도(예: 충돌 후 덮어쓰기)에 새 키를 발급하는 것을 권장한다.
- 목록: `{items, nextCursor}` 커서 페이지네이션.
- 권한: 모든 리소스 `owner_id = session.userId` 검사(리포지토리 레벨 강제).

## 2. 엔드포인트

### 2.1 Auth/계정
| 메서드 경로 | 입력 | 출력 | 비고 |
|---|---|---|---|
| POST /auth/login | {email,password} | 204 + cookie | rate limit 5/분 |
| POST /auth/logout | — | 204 | |
| GET /me | — | User | ETag |
| PATCH /me/settings | Partial<Settings> | User | If-Match |

### 2.2 Task/Project (M1)
| 메서드 경로 | 입력 | 출력 | 코드 |
|---|---|---|---|
| GET /projects | cursor | Page<Project> | 200 |
| POST /projects | ProjectCreate | Project | 201, Idem |
| GET /tasks?projectId&status&cursor | — | Page<Task> | 200 |
| POST /tasks | TaskCreate | Task | 201, Idem, 503 provider_unavailable |
| GET /tasks/{id} | — | Task | 200/304/404 |
| PATCH /tasks/{id} | TaskPatch | Task | 200/412/422 |
| POST /tasks/{id}:complete | — | Task | 200/409 |
| DELETE /tasks/{id} | — | 204 | soft |
| POST /tasks/{id}/dependencies | {dependsOnTaskId} | 201 | 422 dependency_cycle |

### 2.3 Intake (M2)
| 메서드 경로 | 설명 |
|---|---|
| POST /intake-sessions | 새 과제 등록 + 인터뷰 시작 → `IntakeSession{state, questions?}` 201 (202 가능: LLM 비동기) |
| GET /intake-sessions/{id} | 상태·질문·초안 조회(재개) |
| POST /intake-sessions/{id}/answers | `{answers:[{questionKey, value|skip|idk}]}` |
| POST /intake-sessions/{id}/type-confirmation | `{similar: true, templateId}` 또는 `{similar:false}` |
| GET /intake-sessions/{id}/draft | DecompositionDraft |
| PATCH /intake-sessions/{id}/draft | 단계 편집(If-Match) |
| POST /intake-sessions/{id}/draft:approve | Task 생성(Idem) → state=feasibility_check |
| POST /intake-sessions/{id}:pause / :resume / :cancel | 상태 전이(409 불가 전이) |
| POST /intake-sessions/{id}:manual | 수동 모드 전환(LLM 없이) |
| GET /templates?query= | 템플릿 검색, GET /templates/{id} |

#### 2.3.1 긴 AI 호출: 대기·취소·재개 (FU-76, 2026-11-12)
계약(스키마/OpenAPI)은 바꾸지 않고 기존 필드와 엔드포인트의 의미만 정한다.

- **호출 방식**: 생성(`POST /intake-sessions` → 유형 탐지)과 `answers`·`type-confirmation`·`:resume`(→ 단계 분해)은 AI 호출이 끝날 때까지 응답을 붙잡는다. 단계 분해는 보통 30–45초, 최대는 아래 상한.
- **진행 중 판정 규칙**(재접속 클라이언트용, 서버도 같은 규칙으로 고아를 판정): `error`가 없고 ① `state=decomposition`·`manual=false`·`draft` 없음, 또는 ② `state=type_detection`·`detectedType` 없음이면 AI 결과를 기다리는 중이다. 클라이언트는 이 상태에서 같은 요청을 다시 보내지 않고 `GET /intake-sessions/{id}`를 폴링한다(웹: 3초). 세션 id를 아직 모르는 생성 요청은 **같은 Idempotency-Key로 재전송**해 저장된 결과를 받는다(처리 중이면 409 `idempotency_in_progress` + `Retry-After`). 둘 다 멱등이라 두 번째 실행·이중 과금이 없다.
- **연결 끊김은 취소가 아니다**: 새로고침·네트워크 끊김이 있어도 서버는 진행 중인 시도를 끝내고 초안/결과를 저장한다.
- **명시적 취소**: 대기 중 `POST /intake-sessions/{id}:manual`(웹의 "취소"·"직접 작성으로 계속")은 그 세션의 진행 중 AI 실행(프로세스 내 레지스트리)을 중단하고, 실행이 지출을 정산(예약 → `reserved_fallback`, 실제 사용량이 있으면 그 값)하며 `agent_run.status='cancelled'`를 기록할 때까지 최대 5초 기다린 뒤 직접 작성 모드로 넘어간다. 이때 `error={code:'ai_cancelled'}`이며 입력은 그대로다. `:cancel`도 진행 중 실행을 먼저 중단한다.
- **종료/크래시**: graceful shutdown은 드레인 예산(12초) 뒤 AI 호출을 중단·정산하고 세션에 `error={code:'ai_interrupted'}`를 남긴다(초안 없음, `manual=false`). 재시작 후 사용자는 "다시 시도"를 보고 `POST :resume`이 단계 분해를 다시 실행한다(사용자 행동에 의한 새 과금 1회). 유형 탐지가 중단되면 `ai_interrupted` + 직접 작성 모드로 이어 간다. 크래시로 남은 `pending` 실행과 진행 중처럼 보이는 세션은 요청 상한보다 오래되면 시작 시 스윕(그리고 `GET` 시 지연 판정)으로 각각 `cancelled` / `ai_interrupted`가 된다.
- **session.error.code**(자유 문자열): `ai_interrupted`(중단, `:resume`으로 재시도 가능), `ai_cancelled`(사용자 취소, 직접 작성 계속), 기존 `llm_unavailable`·`budget_exceeded`. 클라이언트는 모르는 코드를 일반 실패 문구로 보여 준다.
- **유효 상한**: 구조화 호출 1회 = 시도 시간 × 2(1회 + repair 1회) + 10초(단계 분해 기본 250초, 유형 탐지 70초, `runStructured totalTimeoutMs`); 인테이크 AI 요청 1회 = 270초(고아 판정 기준); HTTP 소켓 비활성 가드 300초; 웹 클라이언트 315초(이보다 먼저 포기하지 않으며, 넘으면 재전송 대신 폴링).

### 2.4 Planning (M3)
| 메서드 경로 | 설명 |
|---|---|
| POST /plans | `{scope:{goalId|taskIds}, policies?:[…], horizon}` → Plan + candidates(≤3) 201, Idem. 응답에 `availabilityVersion` |
| GET /plans/{id} | Plan + candidates + metrics |
| POST /plans/{id}/candidates/{cid}:preview-edit | 편집된 블록 → validator 결과(부작용 없음). `If-Match: W/"<plan.version>"`(2026-11-11 확정), 사전 검증 오류 경로 `/blocks/<i>` |
| POST /plans/{id}/candidates/{cid}:approve | `If-Match: W/"availability:<n>"`, Idem, body `{editedBlocks?}` → PlanVersion 201 / 412 availability_changed / 422 constraint_violation{violations[]} |
| POST /plans/{id}:regenerate | 412 후 재생성 |

**승인 원자성:** 단일 PG 트랜잭션: (1) `SELECT … FOR UPDATE` user availability_version (2) 최신 commitments/locked로 validator 재실행 (3) 이전 active version 블록 `superseded` (4) 새 blocks insert(EXCLUDE 제약) (5) schedule_approval(idempotency_key unique) (6) outbox `plan.approved`. 하나라도 실패 시 롤백.

### 2.4a 가용 시간·약속 (M3, 2026-11-11 추가)
| 메서드 경로 | 설명 |
|---|---|
| GET /availability | `{version, timeZone, rules[{weekday,startLocal,endLocal,kind}], exceptions[{date,kind,startLocal?,endLocal?}], prefs{maxDailyFocusMin,breakAfterMin,breakMin,dayStartLocal,dayEndLocal,riskLevel}}` + `ETag: W/"availability:<version>"` |
| PUT /availability | 전체 교체, `If-Match: W/"availability:<n>"`(누락 428/불일치 412), Idem. 성공 시 `availability_version` +1(사용자 단위 단조 증가) |
| GET /commitments?from&to&cursor | 고정 약속(반복 포함, `rrule?` + IANA tz). 응답에 기간 내 **전개된 발생** `occurrences[]` 포함 |
| POST /commitments | 201, Idem. 생성·변경·삭제 모두 `availability_version` +1 (승인 412 판정에 쓰임) |
| PATCH /commitments/{id} · DELETE /commitments/{id} | If-Match(약속 version) + Idem |
- 시간 규칙: rule/exception은 로컬 벽시계(사용자 tz), commitment는 Instant + tz(반복은 해당 tz 벽시계 기준 전개). 전개 상한: 조회 기간 ≤ 366일, 발생 ≤ 2,000건(초과 시 422 `validation_failed`).
- 입력 상한(스케줄러 계약과 일치): 분 값은 정수 0..100000, horizon ≤ 366일(`MAX_HORIZON_DAYS`).
- Plan(§2.4) 생성 시 서버가 위 데이터 + 승인된 활성 블록(locked/history)으로 `ScheduleInput`을 조립한다. 클라이언트는 ScheduleInput을 직접 보내지 않는다.

### 2.5 Today/Session (M4)
| 메서드 경로 | 설명 |
|---|---|
| GET /today?date= | 오늘 블록 2–3개 + 여유 + 위험 |
| POST /today:accept / :shrink / :reschedule | 축소/재배치는 proposal 반환 → :approve |
| POST /sessions | `{taskId, blockId?, clientStartedAt}` 201 Idem, 409 active_session_exists |
| POST /sessions/{id}:pause / :resume / :complete | Idem(이벤트별 키), If-Match |
| POST /sessions/{id}/review | `{outcome, reasonChips[], note?}` → EstimationFeedback 생성 |
| GET /schedule-blocks?from&to&cursor&limit | 확정된 활성 블록(겹치는 구간, 366일 이하) `Page<ScheduleBlock>` (FU-51) |
| POST /schedule-blocks/{id}:lock · :unlock | 블록 고정/고정 해제 → ScheduleBlock 200 (FU-71, §2.5.1) |

#### 2.5.1 블록 고정 (FU-71, 2026-11-12)
고정된 블록은 재계획·다시 만들기·Today 동작이 옮기지 않는다(06 §7, M5-02R-1 H1). 사용자는 `:lock`/`:unlock` 액션 POST로 이 상태를 바꾼다(PATCH `locked` 필드 대신 기존 `:action` 규약을 택함).

| 항목 | 규칙 |
|---|---|
| 헤더 | `If-Match: W/"<ScheduleBlock.version>"`(블록 version; 누락 428, 불일치 412 `version_conflict`) + `Idempotency-Key`(같은 키 재전송은 저장된 응답 재생, 같은 키로 다른 동작은 422 `idempotency_mismatch`). 본문 없음 |
| 대상 | 소유자의 블록만(남의 블록·없는 블록·삭제된 일정안의 블록은 404). 활성 일정안의 `status=planned`이고 아직 시작하지 않은(`startAt ≥ now`, 06 §7.1) 블록만 바꿀 수 있다. 시작한 블록(이력)·`done`/`skipped`/`moved`/`superseded` 블록·활성이 아닌 일정안의 블록은 409 `illegal_transition`(멱등 기록에 저장) |
| 효과 | 블록 시각은 바뀌지 않는다. 상태가 바뀌면 블록 `version` +1, 일정안 revision(`plan.version` = `Today.version`, 일정안 ETag) +1 — 이전 revision에 묶인 Today 동작·미리보기·Today 제안 승인은 412(경합 시 409)가 되어 다시 읽어야 한다. `plan.updated_at`은 바꾸지 않는다(활성 일정안 선택 순서). 이미 요청한 상태면 그대로 200(버전·revision 불변, 감사 기록 없음) |
| 감사 | `audit_event{actor:'user', action:'schedule_block.locked' 또는 'schedule_block.unlocked', entity:'schedule_block', entity_id, diff_summary:{planId, locked, version}}` — id와 상태만, 제목 없음 |
| 이후 | 고정: 다음 재계획 후보에 그 블록이 없고 승인 시 같은 행·시각으로 남는다. 해제: 다음 재계획이 그 블록을 옮길 수 있다(후보가 대체하는 미래 블록에 포함). 고정을 바꾸기 전에 만든 재계획 제안은 승인 TX가 잠금 상태를 다시 읽어 검증한다: 그 뒤 고정한 블록을 옮기는 후보, 그 뒤 고정을 푼 블록을 빼먹는 후보 모두 422 `constraint_violation`(블록은 그대로) |
| 웹 | Today 카드와 일정안 비교의 "확정된 일정"에 토글("블록 고정"/"고정 해제", `aria-pressed`), 재계획 제안 화면은 읽기 전용 배지. 낙관적 표시는 `runOwnerBound` 작업 안에서만, 412/409면 다시 읽는다 |

### 2.6 Replanning (M5)
GET /replan-proposals?state=pending · POST /replan-proposals/{id}:approve (If-Match, Idem) · POST /replan-proposals/{id}:reject `{reason?}` (24h 억제)

### 2.7 Knowledge (M6)
**노트(ContextDocument) — M6-01 구현(2026-11-12).** 노트는 planner 소유 Markdown이며 Vikunja와 동기화하지 않는다(07 §7). `bodyMd`는 저장된 원문 Markdown 그대로 반환하고 API는 HTML을 렌더링·반환하지 않는다(표시용 sanitize는 웹 책임). 모든 경로는 owner 범위이며 다른 사용자의 노트·대상은 404.
| 메서드 경로 | 헤더 | 입력 → 출력 | 코드 |
|---|---|---|---|
| GET /documents?q&targetKind&targetId&cursor&limit | If-None-Match | → Page<ContextDocument> (최신 수정순; `q`는 title+body 검색) | 200/304/400/401/422 |
| POST /documents | Idem | `{title(1–200자), bodyMd?(≤65,536자), sensitivity?(P1\|P2, 기본 P2), llmAllowed?(기본 false), links?[{targetKind,targetId}]≤50}` → ContextDocument | 201/400/401/403/404(대상)/409/422/503 |
| GET /documents/{id} | If-None-Match | → ContextDocument, `ETag: W/"<version>"` | 200/304/400/401/404 |
| PATCH /documents/{id} | If-Match + Idem | `{title?,bodyMd?,sensitivity?,llmAllowed?}`(≥1개) → ContextDocument | 200/400/401/403/404/409/412/422/428 |
| DELETE /documents/{id} | If-Match + Idem | soft delete(목록·조회·AI 전송에서 제외) | 204/400/401/403/404/409/412/422/428 |
| POST /documents/{id}/links | If-Match(노트 version) + Idem | `{targetKind: goal\|project\|task, targetId}` → ContextDocument(version+1) | 201/400/401/403/404/409/412/422(중복·50개 초과)/428/503 |
| DELETE /documents/{id}/links/{linkId} | If-Match(노트 version) + Idem | → ContextDocument(version+1) | 200/400/401/403/404/409/412/422/428 |
| GET /documents/{id}/ai-usage?cursor&limit | If-None-Match | → Page<NoteAiUsage> | 200/304/400/401/404/422 |
| POST /tasks/{id}:promote-description | If-Match(**task** version) + Idem | 현재 provider 설명을 1회 복사해 task에 연결된 노트 생성 → ContextDocument | 201/400/401/403/404/409(이미 승격된 살아있는 노트 `illegal_transition`)/412/422(설명 없음)/428/503 |
- **검색:** `body_tsv`는 `setweight(to_tsvector('simple', title),'A') || setweight(to_tsvector('simple', body_md),'B')` 생성 컬럼 + GIN. 한국어 형태소 사전이 PostgreSQL에 없어 `simple`을 쓴다. `q`는 NFKC·소문자 후 글자/숫자 토큰(최대 8개)만 남겨 `token:*` 접두 일치를 AND로 묶고 `ts_rank` 순 정렬 — "논문"은 "논문을"과 맞지만 중간 일치·형태소 일치는 지원하지 않는다. 연산자만 있는 `q`는 빈 결과. 커서는 offset 기반 불투명 문자열(잘못된 커서 422). 요청 로그는 모든 경로에서 **path만** 기록한다(`?`·`;`·`#` 이후 제거). 쿼리는 허용 목록의 파라미터 **이름**과 생략 개수만 남기고 값은 기록하지 않는다(`services/api/src/http/log-url.ts`; 오류 처리기·멱등 해제 경고도 동일, M6-01R2).
- **승격:** Vikunja 편집기 HTML은 일반 Markdown 텍스트로 변환(블록→줄바꿈, li→`- `, script/style 제거, 결과에 `<` 없음). 이후 작업 설명이 바뀌어도 노트는 바뀌지 않는다(동기화 없음). 승격 노트를 삭제하면 다시 승격할 수 있다.
- **AI 사용 이력(`note_ai_usage`):** 노트 구간이 실제로 프롬프트에 실려 공급자로 나간 호출(어댑터의 `onDispatch` — 동의·예산 게이트에서 거부된 호출은 기록 안 함, 전송 후 실패한 호출은 기록)마다 `{agentRunId, purpose, promptIdVersion, status, provider, model, documentVersion, bodyHash(sha256), sectionHashes[16hex], sentBytes, stale, createdAt}`. 본문·프롬프트는 저장하지 않는다. `stale`은 그 뒤 노트가 수정됨을 뜻한다.
- **AI 근거(05 §9/§10):** Intake 분해에서 세션 goal에 연결된 `llmAllowed=true` 노트(살아있는 것, 같은 owner)만 구간 선택(요청과의 용어 겹침 순, 바이트 예산 6 KiB·구간 1.5 KiB·최대 12구간, 겹침 0인 구간은 문서 첫 구간만) → ADR-019 마스킹(본문 전체 대상) → HTML 주석·zero-width·태그 문자 제거 → 구간마다 `<untrusted_document id section hash>`(내용 XML 이스케이프)로 감싸 `decomposition@v2`/`llm.decomposition.v2`로 보낸다. 연결 노트가 없으면 기존 `decomposition@v1` 입력과 동일. 모델 출력의 `evidence[{kind: fact|inference, docId, sectionHash, statement, stepKeys}]`는 보낸 (docId, sectionHash)·초안 step key에 있는 것만 남기고 나머지는 제거 + `hallucinated_ref`(draft issues/hallucinatedRefs, `audit_event(action=hallucinated_ref, 개수만)`). 노트 기반 출력의 URL은 `[link removed]`. 초안 DTO의 선택 필드 `evidence[{kind, statement, source{kind:'note',docId,sectionHash}, stepKeys, updatedAt}]`(PATCH로 설정 불가, step 편집 시 stepKeys 재필터).
- **미구현(후속):** POST /attachments, GET /ai-context/preview, PATCH /ai-context/selection, 노트 요약 캐시(본문 해시 키 — 요약 기능 도입 시), 내보내기(zip)에 노트 포함.

### 2.8 UI 레이아웃 (M6)
GET /ui/layout-policy (정책 버전·규칙 파라미터) · GET/PUT /ui/layout-preferences (사용자 override, If-Match)

### 2.9 알림 (M4)
GET /notifications · POST /notifications/{id}:dismiss · POST /push-subscriptions (Idem) · DELETE /push-subscriptions/{id}

### 2.10 데이터 권리 (M4 최소, M7 완성)
POST /exports → 202 `{exportId}` · GET /exports/{id} (zip: JSON + Markdown + 첨부) · POST /account:delete (재인증 + 확인 문구, 7일 유예 [가정]) · POST /estimation:reset

## 3. 타임존 규칙
요청 날짜 파라미터는 사용자 tz 해석. 반복/가용은 로컬 벽시계로 저장. DST gap 시각은 다음 유효 시각으로, overlap은 첫 번째 발생으로 해석(문서화·테스트 G06).

## 4. 이벤트 방식 비교와 선택 (ADR-007)

| 방식 | 장점 | 단점 | 선택 |
|---|---|---|---|
| DB outbox + in-process dispatcher | 트랜잭션 일관성, 인프라 0 | 단일 프로세스 처리량 | **선택(M1)** |
| 주기 재조정(reconcile) | 누락 내성 | 지연 | **선택(Vikunja 동기화 필수)** |
| Vikunja 웹훅 | 저지연 | 재시도 없음[확인], 사설 대상 기본 거부 설정 필요 | 힌트로만(M2+) |
| Redis/NATS/RabbitMQ | 확장성 | 운영 부담, 16GB 예산 | 기각(트리거: 프로세스 2개 이상 필요 시) |

- `outbox_event` 처리: `FOR UPDATE SKIP LOCKED` 배치, 최대 5회 지수 백오프, 실패 시 `dead` + 배지.
- 리더 선출: `pg_try_advisory_lock(hash('ohmydate.jobs'))` 보유 인스턴스만 스케줄 잡 실행(중복 실행 방지).
- 웹훅 수신: HMAC 검증 → `inbox_event` unique insert(중복 시 200 무시) → 해당 entity **재조회**로 상태 확정(페이로드 신뢰 안 함).

## 5. 내부 이벤트 토픽
`task.created|updated|completed`, `plan.approved`, `session.completed`, `estimate.updated`, `replan.proposed`, `notification.due`, `provider.sync_failed`. 페이로드는 ID + version만(민감 본문 미포함).

## 6. TaskRepository 포트 (계약 테스트 대상, `packages/domain/ports`)
```ts
interface TaskRepository {
  create(ownerId, input: TaskCreate, idemKey): Promise<Task>;
  get(ownerId, id): Promise<Task | null>;
  list(ownerId, q: TaskQuery): Promise<Page<Task>>;
  update(ownerId, id, patch: TaskPatch, expectedVersion: number): Promise<Task>; // VersionConflictError
  complete(ownerId, id, expectedVersion): Promise<Task>;
  softDelete(ownerId, id, expectedVersion): Promise<void>;
  listChangedSince(ownerId, cursor): Promise<{ changes: TaskChange[]; cursor }>; // 재조정용
}
```
오류 타입: `NotFound`, `VersionConflict`, `ProviderUnavailable`, `ValidationFailed`. Vikunja ETag ↔ planner version 매핑은 어댑터 책임.
