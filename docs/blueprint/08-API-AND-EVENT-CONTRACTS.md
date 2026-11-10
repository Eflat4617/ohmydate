# 08. API·이벤트 계약 (`packages/contracts`)

## 1. 공통 규약
- Base: `/api/v1` (planner 자체 버전; Vikunja 버전과 무관). JSON, camelCase, 시각은 RFC 3339 오프셋 포함, 날짜는 `YYYY-MM-DD` + 사용자 tz.
- 단일 소스: TypeBox 스키마(`packages/contracts/src/**`) → Fastify 검증 + `@fastify/swagger`로 **OpenAPI 3.1 산출** → `apps/web`은 `openapi-typescript`(또는 hey-api) 생성 클라이언트. CI에서 생성물 diff 0 검사(ADR-005).
- 인증: 세션 쿠키(`HttpOnly; Secure; SameSite=Lax`) + 변경 메서드에 `X-CSRF-Token`. 장래 API 토큰(Bearer, scope).
- 오류: RFC 9457 `application/problem+json` `{type, title, status, detail, code, errors?[{path,message}], traceId}`. `code`는 안정 enum(`validation_failed`, `version_conflict`, `availability_changed`, `idempotency_mismatch`, `provider_unavailable`, `llm_unavailable`, `budget_exceeded`, `dependency_cycle`, `not_found`, `forbidden`, `rate_limited`).
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
- **멱등 기록 저장 규칙 확정(2026-11-11, M1-07R2 지적):** 저장·재생 대상은 **2xx 응답과 409/422 도메인 결과**뿐이다. 400/401/403/412/428/429/5xx 및 `idempotency_in_progress`는 저장하지 않으며 같은 키로 재시도 가능(키 예약은 해제). 요청 해시는 메서드+경로+정규화 본문으로 계산하고 **If-Match는 해시에 포함하지 않는다**. 클라이언트는 If-Match가 바뀌는 재시도(예: 충돌 후 덮어쓰기)에 새 키를 발급하는 것을 권장한다.
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

### 2.4 Planning (M3)
| 메서드 경로 | 설명 |
|---|---|
| POST /plans | `{scope:{goalId|taskIds}, policies?:[…], horizon}` → Plan + candidates(≤3) 201, Idem. 응답에 `availabilityVersion` |
| GET /plans/{id} | Plan + candidates + metrics |
| POST /plans/{id}/candidates/{cid}:preview-edit | 편집된 블록 → validator 결과(부작용 없음) |
| POST /plans/{id}/candidates/{cid}:approve | `If-Match: W/"availability:<n>"`, Idem, body `{editedBlocks?}` → PlanVersion 201 / 412 availability_changed / 422 constraint_violation{violations[]} |
| POST /plans/{id}:regenerate | 412 후 재생성 |

**승인 원자성:** 단일 PG 트랜잭션: (1) `SELECT … FOR UPDATE` user availability_version (2) 최신 commitments/locked로 validator 재실행 (3) 이전 active version 블록 `superseded` (4) 새 blocks insert(EXCLUDE 제약) (5) schedule_approval(idempotency_key unique) (6) outbox `plan.approved`. 하나라도 실패 시 롤백.

### 2.5 Today/Session (M4)
| 메서드 경로 | 설명 |
|---|---|
| GET /today?date= | 오늘 블록 2–3개 + 여유 + 위험 |
| POST /today:accept / :shrink / :reschedule | 축소/재배치는 proposal 반환 → :approve |
| POST /sessions | `{taskId, blockId?, clientStartedAt}` 201 Idem, 409 active_session_exists |
| POST /sessions/{id}:pause / :resume / :complete | Idem(이벤트별 키), If-Match |
| POST /sessions/{id}/review | `{outcome, reasonChips[], note?}` → EstimationFeedback 생성 |

### 2.6 Replanning (M5)
GET /replan-proposals?state=pending · POST /replan-proposals/{id}:approve (If-Match, Idem) · POST /replan-proposals/{id}:reject `{reason?}` (24h 억제)

### 2.7 Knowledge (M6)
GET/POST /documents · GET/PATCH/DELETE /documents/{id} · GET /documents:search?q= · POST /documents/{id}/links · POST /attachments (multipart, ≤20MB [가정], MIME allowlist) · GET /ai-context/preview?taskId= (AI에 보낼 근거 목록과 마스킹 결과 미리보기) · PATCH /ai-context/selection

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
