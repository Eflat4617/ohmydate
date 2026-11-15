# 15. 데스크톱 앱과 Rust 코어

> 작성 2026-11-13 · Task RC-00 · 결정 근거는 `13-ADR.md` ADR-025.
> 이 문서는 RC 프로그램(M7)의 기준 계획이다. 표의 수치와 분류는 코드에서 뽑았고, 표 두 개(§2.2, §3.3)는 `tests-core/docs.test.ts`가 계약·마이그레이션과 맞는지 검사한다.
> "지금 있음"은 RC-00에서 구현해 시험까지 마친 것, 나머지는 계획이다.

## 0. 한눈에 보기

- 만드는 것: 리눅스 데스크톱 앱 하나. 사용자 한 명, 설치할 서버 없음. 창은 Tauri 2 웹뷰, 화면은 지금의 Vue 앱(`apps/web`), 뒤는 Rust 코어(`core/`).
- 코어는 지금의 HTTP 계약(`packages/contracts`, `openapi.json`)을 그대로 127.0.0.1에서 서빙한다. 그래서 웹 클라이언트, 계약 테스트, Playwright E2E를 계속 쓴다.
- 저장은 SQLite 파일 하나. PostgreSQL·docker·Node·Vikunja가 실행 환경에서 빠진다.
- TypeScript 코어(`services/api`, `packages/*`)는 전환 때까지 기준 구현이다. 스케줄러는 TypeScript 출력과 바이트 단위로 같아야 한다.
- RC-00에서 끝낸 것: 이 계획, 워크스페이스 5개 크레이트, owner·프로젝트·작업 API 10개, 스케줄러 포팅의 바닥 층(PRNG·정규 JSON·시간 분할·inputHash)과 TypeScript 오라클 대조, 블랙박스 패리티 하네스.

RC-00에서 측정한 것:

| 항목 | 값 |
|---|---|
| 계약 operation | 84개 → 유지 54, 차이를 두고 유지 26, 제외 4 (§2.2) |
| PostgreSQL 테이블 / 컬럼 (0001–0016) | 53 / 555 → 유지 28, 변형 11, 제외 14 테이블 (§3.3) |
| 코드가 한 번도 읽지 않는 테이블 | `outbox_event`(쓰기 6곳, 읽기 0), `audit_event`(2/0), `estimate_evidence`(1/0), `job`·`inbox_event`·`task_dependency`·`external_provider_mapping`(0/0) |
| advisory lock 호출 | 11곳 → 0 (프로세스 하나, 쓰기 트랜잭션 하나) |
| EXCLUDE 제약 위반 처리(`23P01`) | 3곳(승인·Today·재계획) → 트랜잭션 안 코드 검사 |
| Rust 테스트 (RC-00) | 178개: domain 37, store 27, app 26, scheduler 19 + 오라클 8, server 43 + bin 4 + HTTP 14 |
| 패리티 하네스 (RC-00) | operation 10개, 테스트 85개 통과(해당 없는 조합 49개는 건너뜀) |
| 오라클 팩 `sample.json` | 27건(golden 15, 생성 9, 재계획 1, 잘못된 입력 2), 211 KiB, 기준 tzdata 2026c vs jiff 2026e — 불일치 0 |
| 서드파티 크레이트 | 126개(리눅스 그래프). MIT/Apache-2.0/BSD 밖은 4건(§9.4) |

## 1. 목표 아키텍처

### 1.1 프로세스

```text
 ┌──────────────────────── 데스크톱 앱 (프로세스 1개 + WebKit 자식 프로세스) ────────────────────────┐
 │ 셸: apps/desktop (Tauri 2, RC-100)                                                               │
 │   트레이 · OS 알림 · 자동 시작 · 단일 인스턴스 · 창                                               │
 │   └─ 라이브러리로 링크: ohmydate-server                                                           │
 │        HTTP 서버 127.0.0.1:<임의 포트>  ──  /api/v1/** (계약), 웹 정적 파일, /healthz, /readyz    │
 │        백그라운드 작업(타이머): 알림 · 재계획 감지 · Google 동기화 · 백업 · 청소                  │
 │        ohmydate-app → ohmydate-store → SQLite 파일                                                │
 │ 웹뷰(WebKitGTK): apps/web 빌드 결과를 http://127.0.0.1:<포트>/ 에서 같은 출처로 불러온다          │
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
   나가는 연결만: LLM 게이트웨이(HTTPS), Google(oauth2/www.googleapis.com). 들어오는 연결 없음.
```

- 운영에서는 프로세스가 하나다. 셸이 `ohmydate-server` 크레이트를 라이브러리로 쓰고, 창을 닫아도(트레이에 남아) 서버와 백그라운드 작업은 계속 돈다.
- `ohmydate-core` 바이너리는 같은 라이브러리를 창 없이 띄운다. 테스트(패리티 하네스, Playwright)와 개발용이다. **지금 있음.**

### 1.2 크레이트와 경계

| 크레이트 | 책임 | 의존해도 되는 것 | 상태 |
|---|---|---|---|
| `ohmydate-domain` | id·시각·버전·문제 코드, 엔터티, 입력 규칙, DAG 검사 | 표준 라이브러리만 (I/O·serde 없음) | 있음 |
| `ohmydate-scheduler` | 스케줄러 포팅. 순수 함수, 시드 고정 | `jiff`, `sha2`, `ryu-js`, `serde_json` — 우리 크레이트에는 의존하지 않는다(TS 패키지와 같음) | 바닥 층 있음 |
| `ohmydate-llm` (RC-70) | 프롬프트·스키마 등록, 마스킹, 예산 규칙, 구조화 호출. HTTP는 포트 trait | `domain`, `jsonschema`, `serde_json` | 계획 |
| `ohmydate-store` | SQLite: 연결, 마이그레이션, 형이 있는 쿼리 | `domain`, `rusqlite` | 있음 |
| `ohmydate-app` | 유스케이스. 트랜잭션 경계를 가진다 | `domain`, `store`, (뒤에) `scheduler`, `llm` | 있음 |
| `ohmydate-integrations` (RC-70/90) | LLM HTTP 클라이언트, Google HTTP, 키링 | `app`의 포트 trait, HTTP·키링 크레이트 | 계획 |
| `ohmydate-server` | HTTP: 계약 로드, 라우팅, 헤더 규칙, 검증, DTO, 보안 게이트. 바이너리 `ohmydate-core` | `app`, `domain`, `store`(열기만), `axum`, `jsonschema` | 있음 |
| `apps/desktop` (RC-100) | Tauri 셸 | `server` | 계획 |

규칙(TypeScript 쪽 경계 규칙과 같은 뜻):

1. `domain`과 `scheduler`는 I/O를 하지 않는다. 시계·난수·id는 `Clock`·`RandomSource`·`IdGenerator`로 받는다.
2. 방향은 한쪽이다: `server → app → {store, scheduler, llm} → domain`. 아래 크레이트는 위를 모른다. Cargo가 강제한다(의존하지 않은 크레이트는 import할 수 없다).
3. `store`는 SQL과 엔터티만 안다. HTTP·JSON 전송 형식·업무 규칙이 없다. 업무 규칙(프로젝트 존재, 순환, 버전)은 `app`이 같은 트랜잭션에서 검사한다.
4. `server`의 핸들러는 JSON ↔ 유스케이스 변환만 한다. 경로·헤더 규칙·요청 형태는 계약에서 읽는다(아래 1.4).
5. 저장소 trait(Repository 포트)은 두지 않는다. 저장소는 SQLite 하나이고 테스트도 임시 파일의 진짜 SQLite로 한다(빠르다: 스토어 테스트 27개가 0.03초). 포트 trait은 바꿔 끼울 일이 실제로 있는 곳에만 둔다: 시계, 난수, LLM, Google HTTP, 키링, 알림.

### 1.3 웹뷰가 코어에 닿는 방법 (결정)

**127.0.0.1의 임의 포트 + 실행마다 새로 만드는 토큰. 화면과 API를 같은 출처로 서빙한다.** 셸의 커스텀 프로토콜은 쓰지 않는다.

이유:

- 웹 클라이언트는 상대 경로 `/api/v1`에 `fetch`로 말한다(`apps/web/src/api/client.ts`: `baseUrl ?? '/api/v1'`, `credentials: 'include'`). 같은 출처로 서빙하면 **API를 부르는 웹 코드가 바뀌지 않는다**(데스크톱 모드의 화면 변경은 §4.2).
- 클라이언트는 평범한 HTTP 동작에 기대고 있다: `AbortSignal`로 끊기, 최대 315초 붙잡는 AI 요청, `ETag`/`If-None-Match`/304. WebKitGTK의 커스텀 스킴 핸들러가 이것들을 똑같이 해 주는지는 이 Task에서 확인할 수 없었다(WebKitGTK 개발 헤더가 없어 셸을 빌드하지 못한다). 진짜 HTTP는 확인할 필요가 없다.
- 패리티 하네스와 E2E가 운영과 **같은 전송 경로**를 시험한다.
- 라우터는 라이브러리 값이라(`handle(state, request)`), 나중에 커스텀 프로토콜이 안전하다고 확인되면 전송만 바꿀 수 있다.

loopback은 같은 기계의 다른 사용자와, 이 기계의 브라우저에 열린 아무 웹 페이지나 닿을 수 있다. 그래서 검사 세 가지를 둔다(**지금 있음**, `core/crates/server/src/security.rs`):

| 검사 | 내용 | 실패 |
|---|---|---|
| 실행 토큰 | 시작할 때 만드는 256비트 난수. `Authorization: Bearer <토큰>` 또는 쿠키 `omd_launch`로 낸다. 비교는 상수 시간 | 401 `unauthenticated` |
| Host | `127.0.0.1:<포트>` 또는 `localhost:<포트>`여야 한다(DNS rebinding 차단) | 403 `forbidden` |
| Origin | 변경 요청에 브라우저가 붙인 `Origin`이 자기 출처가 아니면 거부. 개발용 출처는 `--allow-origin`으로만 추가 | 403 `forbidden` |

웹뷰에 토큰을 넘기는 방법: 셸이 첫 주소로 `http://127.0.0.1:<포트>/__boot?token=<토큰>`을 연다 → 코어가 `Set-Cookie: omd_launch=…; HttpOnly; SameSite=Strict`와 303 `/`로 답한다. 그 뒤로는 전부 같은 출처 요청이다. 토큰은 디스크에 쓰지 않는다(창 없는 바이너리만 `--ready-file`에 0600으로 쓴다). 로그에 남기지 않는다(테스트로 확인).

이 방식이 로그인·세션·CSRF·로그인 rate limit을 대신한다. 위협 모델은 "다른 로컬 사용자와 웹 페이지"까지다. 같은 사용자로 도는 악성 프로그램은 데이터 파일을 직접 읽을 수 있으므로 범위 밖이다.

### 1.4 계약이 라우터다 (지금 있음)

`core/crates/server/src/contract.rs`가 `packages/contracts/openapi.json`을 빌드 때 바이너리에 넣고(`include_str!`), 시작할 때 읽어 다음을 만든다.

- 라우트 표: 메서드 + 경로 템플릿(`/tasks/{id}:complete` 같은 액션 접미사 포함) → `operationId`.
- 헤더 규칙: operation마다 `If-Match`가 필요한지(버전 태그인지 `availability:` 태그인지), `Idempotency-Key`가 필요한지.
- 검증기: 경로 파라미터·쿼리·본문을 **계약의 JSON 스키마 그대로** `jsonschema` 크레이트로 검사한다(형식 `date-time`·`uuid`·`email`, 커스텀 `iana-time-zone`).

핸들러는 `operationId`로 등록한 함수 하나다(`handlers::table()`). 그래서 계약이 바뀌면 Rust 쪽은 다시 빌드만 해도 경로·헤더·검증이 따라오고, 계약에 없는 것을 Rust가 따로 정의할 수 없다. 테스트가 고정하는 것: operation 84개, 도메인의 문제 코드 목록 = 계약의 목록, 모든 계약 경로가 자기 operation으로 풀림.

핸들러가 아직 없는 operation은 501(`internal_error`, "Not implemented")로 답한다. 포팅이 끝나면 사라지는 임시 상태다. 제외한 4개는 404다.

요청 한 건이 지나는 순서(TypeScript 코어의 `preValidation` → 검증 → 핸들러 순서와 같다):

```text
/healthz·/readyz → Host → 라우트 찾기(없으면 404) → 실행 토큰(401) → Origin(403) → 핸들러 유무(501)
→ If-Match(428 없음 / 400 형식) → Idempotency-Key(400) → 경로 파라미터 → 본문 → 쿼리(각 400)
→ 핸들러(blocking 스레드): 멱등 조회 + 유스케이스 + 응답 저장이 한 트랜잭션
```

### 1.5 수명 주기

| 단계 | 동작 | 상태 |
|---|---|---|
| 시작 | 데이터 디렉터리 만들기 → `core.lock`에 배타 잠금 → SQLite 열기(WAL, `foreign_keys=ON`, `synchronous=NORMAL`) → 마이그레이션 → owner·Inbox 보장 → 만료 멱등 기록 삭제, pending 키 해제 → 포트 열기 → 토큰 만들기 → (바이너리) ready 파일 | 있음 |
| 단일 인스턴스 | 잠금을 못 얻으면 종료 코드 3. 잠금은 OS가 프로세스 종료 때 푼다(비정상 종료 포함). 셸은 두 번째 실행을 감지해 첫 창을 앞으로 올린다(RC-100, Tauri single-instance) | 코어 쪽 있음 |
| 종료 | SIGINT/SIGTERM 또는 셸의 "끝내기" → 새 연결을 받지 않음 → 진행 중 요청을 12초까지 기다림(TS와 같은 예산) → ready 파일 삭제 → 연결 닫기(WAL 체크포인트) | 있음 |
| 종료 중 AI 호출 | 드레인 예산 뒤 호출을 끊고 지출을 정산, 세션에 `ai_interrupted`(08 §2.3.1 규칙 그대로) | RC-70 |
| 비정상 종료 뒤 | SQLite가 WAL로 일관된 상태를 복구한다. 커밋되지 않은 변경은 없던 일이 되고 그 멱등 키는 비어 있으므로 같은 키로 다시 보내면 된다. pending 멱등 기록은 시작 때 지운다(**있음**). `pending`으로 남은 `agent_run`·예약 지출은 시작 스윕이 `cancelled`·`recovered`로 정리(RC-70) | 일부 있음 |
| 절전에서 깨어남 | 타이머는 벽시계(`Clock`)로 "지금 해야 할 일"을 다시 계산한다. 밀린 알림은 1건으로 합친다(09 §9 규칙) | RC-50 |

종료 코드: 0 정상, 1 실패, 2 인자 오류, 3 이미 실행 중.

### 1.6 데이터·로그·비밀의 위치

| 무엇 | 어디 | 비고 |
|---|---|---|
| 데이터 파일 | `$XDG_DATA_HOME/ohmydate/ohmydate.db` (없으면 `~/.local/share/ohmydate/`) | + `-wal`, `-shm`, `core.lock`. **있음** |
| 업그레이드 전 사본 | 같은 디렉터리 `ohmydate.db.pre-v<N>` | 마이그레이션 직전 `VACUUM INTO`. **있음** |
| 백업 | `…/ohmydate/backups/ohmydate-<날짜>.db` | 하루 1개, 7개 보존(RC-100). 수동 백업·복원 메뉴 |
| 내보내기 | `…/ohmydate/exports/<id>.json` | RC-110 |
| 로그 | `$XDG_STATE_HOME/ohmydate/logs/core.jsonl` (5 MiB × 5개 회전) | 지금은 stderr JSON. 파일 회전은 RC-100 |
| 실행 정보 | `$XDG_RUNTIME_DIR/ohmydate/` | 단일 인스턴스 소켓(RC-100) |
| 비밀 | OS 키링(Secret Service, 서비스 이름 `ohmydate`): `llm_api_key`, `google_oauth_client`, `google_refresh_token` | Secret Service가 없으면 `…/ohmydate/secrets/<이름>` 0600 파일. DB·로그에는 절대 없음(RC-70/90) |

로그 규칙(AGENTS.md와 같음): id·코드·개수·시간만 남긴다. 요청 로그 한 줄은 `trace_id, method, operation, status, duration_ms`다. 경로(검색어가 실릴 수 있다)와 본문은 남기지 않는다. 검증 오류 문구는 `jsonschema`의 masked 형식이라 거부된 값을 되풀이하지 않는다. **있음**: 제목·본문·쿼리·경로·토큰이 로그에 없는지 통합 테스트가 확인한다.

## 2. 라우트 패리티

### 2.1 살아남는 헤더 규칙과 문제 코드

08 §1의 표가 그대로 정본이다. Rust 코어에서 확인된 것(**지금 있음**, 패리티 하네스가 operation마다 검사):

| 경로 종류 | If-Match | Idempotency-Key | 응답 |
|---|---|---|---|
| 생성 POST | 없음 | 필수(UUID, 누락·형식 오류 400) | 같은 키 + 같은 요청 → 저장된 응답 재생, 다른 요청 → 422 `idempotency_mismatch` |
| 기존 리소스 변경(PATCH/PUT/DELETE, `:action`, 하위 리소스 POST) | 필수: 누락 428(`version_conflict`), 형식 오류 400, 불일치 412 | 필수 | 위와 같음 |
| GET | 선택 `If-None-Match` → 304 | 없음 | `ETag`: 엔터티 `W/"<version>"`, 목록 `W/"<본문 해시 16자>"`, `/me` `W/"<id>:<version>"` |

- 멱등 저장 규칙 유지: 2xx와 409/422 도메인 결과만 저장하고 재생한다. 400/401/403/404/412/428/5xx는 저장하지 않아 같은 키로 다시 시도할 수 있다. 요청 해시 = 메서드 + 경로 + 정규화한 본문, `If-Match`는 넣지 않는다. 보존 24시간.
- 문제 응답: `application/problem+json`, `{type, title, status, detail?, code, errors?, traceId}`, `x-trace-id` 헤더.
- 문제 코드 21개는 계약 목록 그대로 둔다(계약을 바꾸지 않는다). 데스크톱에서의 쓰임:

| 코드 | 데스크톱에서 |
|---|---|
| `validation_failed`, `version_conflict`, `idempotency_mismatch`, `dependency_cycle`, `illegal_transition`, `not_found`, `internal_error` | 그대로 |
| `availability_changed`, `constraint_violation`, `active_session_exists`, `session_state_conflict`, `replan_suppressed`, `proposal_state_conflict` | 그대로(해당 슬라이스에서) |
| `llm_unavailable`, `budget_exceeded` | 그대로(RC-70) |
| `unauthenticated` | 뜻이 바뀐다: 실행 토큰이 없거나 틀림 |
| `forbidden` | 뜻이 바뀐다: Host 또는 Origin 검사 실패(CSRF 대신) |
| `idempotency_in_progress` | LLM을 부르는 긴 요청에서만 나온다. 동기 변경에서는 생기지 않는다(§6.9) |
| `provider_unavailable` | Google 동기화에서만. 작업 경로에서는 사라진다 |
| `approval_in_progress`, `rate_limited` | 만들어 내는 곳이 없어진다(목록에는 남는다) |

### 2.2 operation별 판정

판정: **유지** = 계약과 동작이 같다. **유지(차이)** = 계약은 같고 적어 둔 동작 차이가 있다. **제외** = 서빙하지 않는다(404).

<!-- route-matrix:start -->
| operationId | 메서드·경로 | 판정 | 단계 | 차이·이유 |
|---|---|---|---|---|
| `getMe` | GET `/me` | 유지(차이) | RC-00 | 하나뿐인 로컬 owner. 쿠키·세션 없음. `email`은 표시용 값. `llm`·`llmProvider`(선택 필드)는 RC-70에서 채운다 |
| `listProjects` | GET `/projects` | 유지 | RC-00 | Inbox는 데이터 파일을 만들 때 함께 만든다(읽기에서 쓰지 않음) |
| `createProject` | POST `/projects` | 유지 | RC-00 |  |
| `listTasks` | GET `/tasks` | 유지(차이) | RC-00 | 503 `provider_unavailable`이 더는 나오지 않는다(Vikunja 없음) |
| `createTask` | POST `/tasks` | 유지(차이) | RC-00 | 503 없음. `external`은 항상 `[]` |
| `getTask` | GET `/tasks/{id}` | 유지(차이) | RC-00 | 503 없음 |
| `updateTask` | PATCH `/tasks/{id}` | 유지(차이) | RC-00 | 503 없음 |
| `completeTask` | POST `/tasks/{id}:complete` | 유지(차이) | RC-00 | 503 없음. 이미 완료된 작업은 그대로 200(버전 불변) — 기준 구현과 같음 |
| `deleteTask` | DELETE `/tasks/{id}` | 유지(차이) | RC-00 | 503 없음. 지운 작업을 기다리던 작업의 `dependsOn`에서 그 id를 같은 트랜잭션에서 뺀다(그 작업 version +1). 지금 운영 중인 Vikunja 경로의 동작(FU-81)과 같고, InMemory 기준 구현과는 다르다 |
| `createTaskDependency` | POST `/tasks/{id}/dependencies` | 유지(차이) | RC-00 | 503 없음 |
| `updateMySettings` | PATCH `/me/settings` | 유지(차이) | RC-10 | `timeZone`·`locale`은 RC-10, `llm`(동의·예산)은 값은 저장하되 효과는 RC-70. IANA 별칭 이름도 받는다(§2.3 ⑧) |
| `login` | POST `/auth/login` | 제외 | — | 계정이 없다(결정 5). 404 `not_found` |
| `logout` | POST `/auth/logout` | 제외 | — | 위와 같음 |
| `createPushSubscription` | POST `/push-subscriptions` | 제외 | — | Web Push 대신 OS 알림(§4.2). 404 |
| `deletePushSubscription` | DELETE `/push-subscriptions/{id}` | 제외 | — | 위와 같음 |
| `getAvailability` | GET `/availability` | 유지 | RC-20 | `ETag: W/"availability:<n>"` |
| `putAvailability` | PUT `/availability` | 유지 | RC-20 | `If-Match: W/"availability:<n>"` |
| `listCommitments` | GET `/commitments` | 유지 | RC-20 | 반복 전개는 `rrule.ts`(452줄) 포팅. 상한 366일·2,000건 유지 |
| `createCommitment` | POST `/commitments` | 유지 | RC-20 | `availability_version` +1 |
| `updateCommitment` | PATCH `/commitments/{id}` | 유지 | RC-20 | source `google`은 409 `illegal_transition` |
| `deleteCommitment` | DELETE `/commitments/{id}` | 유지 | RC-20 |  |
| `listCalendarDayEvents` | GET `/calendar-day-events` | 유지(차이) | RC-20 | RC-20에서는 항상 빈 목록(달력 화면이 호출한다), 내용은 RC-90부터 |
| `createPlan` | POST `/plans` | 유지 | RC-40 | 스케줄러(RC-30~32) 필요 |
| `getPlan` | GET `/plans/{id}` | 유지 | RC-40 |  |
| `previewPlanCandidateEdit` | POST `/plans/{id}/candidates/{cid}:preview-edit` | 유지 | RC-40 | validator(RC-31) 필요 |
| `approvePlanCandidate` | POST `/plans/{id}/candidates/{cid}:approve` | 유지(차이) | RC-40 | 동시 승인 경합이 없으므로 `approval_in_progress`·503이 나오지 않는다. 겹침은 EXCLUDE 제약 대신 같은 트랜잭션의 코드 검사가 `h1_active_block_overlap`으로 거부한다 |
| `regeneratePlan` | POST `/plans/{id}:regenerate` | 유지 | RC-40 |  |
| `listScheduleBlocks` | GET `/schedule-blocks` | 유지 | RC-40 |  |
| `lockScheduleBlock` | POST `/schedule-blocks/{id}:lock` | 유지 | RC-40 | `audit_event` 기록 |
| `unlockScheduleBlock` | POST `/schedule-blocks/{id}:unlock` | 유지 | RC-40 |  |
| `getToday` | GET `/today` | 유지 | RC-50 |  |
| `acceptToday` | POST `/today:accept` | 유지 | RC-50 |  |
| `shrinkToday` | POST `/today:shrink` | 유지 | RC-50 |  |
| `rescheduleToday` | POST `/today:reschedule` | 유지 | RC-50 |  |
| `approveTodayProposal` | POST `/today/proposals/{id}:approve` | 유지 | RC-50 | `If-Match`는 availability 태그 |
| `listSessions` | GET `/sessions` | 유지 | RC-50 |  |
| `createSession` | POST `/sessions` | 유지 | RC-50 | 409 `active_session_exists` |
| `getSession` | GET `/sessions/{id}` | 유지 | RC-50 |  |
| `pauseSession` | POST `/sessions/{id}:pause` | 유지 | RC-50 |  |
| `resumeSession` | POST `/sessions/{id}:resume` | 유지 | RC-50 |  |
| `completeSession` | POST `/sessions/{id}:complete` | 유지 | RC-50 |  |
| `reviewSession` | POST `/sessions/{id}/review` | 유지 | RC-50 | `estimation_feedback` 생성 |
| `listNotifications` | GET `/notifications` | 유지(차이) | RC-50 | 같은 행을 셸이 OS 알림으로도 띄운다(RC-100). 계약의 `channel` 값은 그대로 |
| `dismissNotification` | POST `/notifications/{id}:dismiss` | 유지 | RC-50 |  |
| `listReplanProposals` | GET `/replan-proposals` | 유지 | RC-60 |  |
| `getReplanProposal` | GET `/replan-proposals/{id}` | 유지 | RC-60 |  |
| `requestReplanProposal` | POST `/replan-proposals:request` | 유지 | RC-60 | 스케줄러 재계획(RC-33) 필요. 409 `replan_suppressed` + `Retry-After` |
| `approveReplanProposal` | POST `/replan-proposals/{id}:approve` | 유지(차이) | RC-60 | 503 없음(같은 이유) |
| `rejectReplanProposal` | POST `/replan-proposals/{id}:reject` | 유지 | RC-60 | 24시간 억제 |
| `getEstimationProfile` | GET `/estimation/profile` | 유지 | RC-60 |  |
| `patchEstimationFeedback` | PATCH `/estimation/feedback/{id}` | 유지 | RC-60 |  |
| `resetEstimation` | POST `/estimation:reset` | 유지 | RC-60 |  |
| `parseTasks` | POST `/tasks:parse` | 유지(차이) | RC-70 | LLM. 키는 OS 키링에서 읽는다. 409 `idempotency_in_progress`는 이런 긴 호출에서만 나온다 |
| `parseCommitments` | POST `/commitments:parse` | 유지(차이) | RC-70 | 위와 같음 |
| `createIntakeSession` | POST `/intake-sessions` | 유지 | RC-70 | LLM 호출을 기다리는 동안 pending 멱등 기록 |
| `getIntakeSession` | GET `/intake-sessions/{id}` | 유지 | RC-70 |  |
| `answerIntakeQuestions` | POST `/intake-sessions/{id}/answers` | 유지(차이) | RC-70 | 503은 `llm_unavailable`·`budget_exceeded`만 |
| `getIntakeDraft` | GET `/intake-sessions/{id}/draft` | 유지 | RC-70 |  |
| `updateIntakeDraft` | PATCH `/intake-sessions/{id}/draft` | 유지 | RC-70 |  |
| `approveIntakeDraft` | POST `/intake-sessions/{id}/draft:approve` | 유지(차이) | RC-70 | 작업 생성이 한 트랜잭션이다. `approval_in_progress`(ADR-020)·503·부분 생성 복구가 없다 |
| `confirmIntakeType` | POST `/intake-sessions/{id}/type-confirmation` | 유지(차이) | RC-70 | 503은 LLM 사유만 |
| `cancelIntakeSession` | POST `/intake-sessions/{id}:cancel` | 유지 | RC-70 |  |
| `enterManualIntakeMode` | POST `/intake-sessions/{id}:manual` | 유지 | RC-70 |  |
| `pauseIntakeSession` | POST `/intake-sessions/{id}:pause` | 유지 | RC-70 |  |
| `resumeIntakeSession` | POST `/intake-sessions/{id}:resume` | 유지 | RC-70 |  |
| `listTaskTemplates` | GET `/templates` | 유지 | RC-70 |  |
| `getTaskTemplate` | GET `/templates/{id}` | 유지 | RC-70 |  |
| `listGoals` | GET `/goals` | 유지 | RC-70 | goal은 인테이크 세션이 만든다 |
| `listDocuments` | GET `/documents` | 유지(차이) | RC-80 | 검색이 PostgreSQL `simple` tsvector 대신 FTS5(unicode61) 접두 일치. 일치 집합은 같게 맞추고(테스트), 순위는 `ts_rank` 대신 bm25라 순서가 다를 수 있다 |
| `createDocument` | POST `/documents` | 유지(차이) | RC-80 | 503 없음 |
| `getDocument` | GET `/documents/{id}` | 유지 | RC-80 |  |
| `updateDocument` | PATCH `/documents/{id}` | 유지 | RC-80 |  |
| `deleteDocument` | DELETE `/documents/{id}` | 유지 | RC-80 |  |
| `listDocumentAiUsage` | GET `/documents/{id}/ai-usage` | 유지 | RC-80 |  |
| `addDocumentLink` | POST `/documents/{id}/links` | 유지(차이) | RC-80 | 503 없음(대상 확인이 로컬 조회) |
| `removeDocumentLink` | DELETE `/documents/{id}/links/{linkId}` | 유지 | RC-80 |  |
| `promoteTaskDescription` | POST `/tasks/{id}:promote-description` | 유지(차이) | RC-80 | 설명이 네이티브 `task.description`이라 Vikunja HTML → Markdown 변환이 없다. 503 없음 |
| `getGoogleIntegration` | GET `/integrations/google` | 유지(차이) | RC-90 | `not_configured` = 키링에 OAuth 클라이언트가 없음(파일 권한 검사 대신) |
| `connectGoogleIntegration` | POST `/integrations/google:connect` | 유지(차이) | RC-90 | 리디렉션 URI가 앱이 여는 loopback 주소. OAuth 클라이언트 종류가 "데스크톱 앱"으로 바뀐다(§6.6, 사용자 작업 필요) |
| `updateGoogleIntegrationSettings` | PUT `/integrations/google/settings` | 유지 | RC-90 |  |
| `syncGoogleIntegration` | POST `/integrations/google:sync` | 유지 | RC-90 | 503 `provider_unavailable`은 여기서 계속 쓴다 |
| `disconnectGoogleIntegration` | DELETE `/integrations/google` | 유지 | RC-90 | 토큰 삭제 = 키링 항목 삭제 |
| `createExport` | POST `/exports` | 유지(차이) | RC-110 | 형식이 `formatVersion` 2(§8.1). 202 + 조회 계약은 그대로 |
| `getExport` | GET `/exports/{id}` | 유지(차이) | RC-110 | `?download=1` 유지. 산출물은 파일 |
<!-- route-matrix:end -->

콜백 `GET /api/v1/integrations/google/callback`은 계약 표 밖이다(08 §2.11). 데스크톱에서는 시스템 브라우저가 부르므로 실행 토큰 없이 받는다. `state`(256비트, 1회용, 10분)가 자격이다(§6.6).

### 2.3 모든 operation에 걸친 차이

① 인증: 쿠키 세션 + `X-CSRF-Token` 대신 실행 토큰 + Host/Origin 검사(§1.3). `X-CSRF-Token`은 무시한다.
② 깨진 JSON, `application/json`이 아닌 본문, 1 MiB를 넘는 본문은 400 `validation_failed`다. TypeScript 코어는 이 셋을 500으로 답한다(Fastify 오류가 일반 분기로 떨어진다) — 기준 구현의 결함으로 보고 따라가지 않는다.
③ 본문 스키마가 없는 operation에 온 본문은 읽지 않는다(요청 해시에도 넣지 않는다). TypeScript는 파싱해서 해시에 넣는다. 웹 클라이언트는 그런 요청을 보내지 않는다.
④ 400의 `errors[].message` 문구는 Ajv가 아니라 `jsonschema` 문구다. `path`(JSON 포인터, 최상위는 `/`)와 `code`·`status`는 같다. 클라이언트는 문구에 기대지 않는다.
⑤ `format: date-time`: Ajv가 받아 주고 도메인이 422로 거부하던 일부 표기(구분자 공백, 소문자 `t`/`z`, `+0900`)는 400이 된다. 둘 다 클라이언트 오류이고 웹은 `toISOString()`만 보낸다.
⑥ 쿼리 스키마가 있는 operation은 모르는 파라미터를 400으로 거부하고, 없는 operation은 쿼리를 보지 않는다 — TypeScript와 같다.
⑦ 문제 `detail`은 리소스 종류와 id만 담는다(제목 없음) — 같다.
⑧ `iana-time-zone` 형식: 번들 tzdb가 아는 이름이면 받는다. TypeScript는 `Intl.supportedValuesOf('timeZone')`의 대표 이름만 받으므로 별칭(`Asia/Calcutta`)은 Rust에서만 통과한다.
⑨ 응답의 `ownerId`는 언제나 하나뿐인 owner의 id다. 다른 owner의 리소스라는 경우가 없으므로 "남의 것 404" 테스트는 "없는 것 404"와 같아진다.

## 3. 데이터 모델

### 3.1 규약 (SQLite)

- 데이터 파일 하나 = owner 한 명. 그래서 **모든 테이블에서 `owner_id`가 빠진다.** owner는 `owner` 테이블의 한 행이고 계약의 `ownerId`는 그 id다. 프로필을 여럿 쓰고 싶어지면 파일을 여럿 둔다.
- id: UUIDv7, 소문자 36자 TEXT. 앱이 만든다(`UuidV7Generator`: 같은 밀리초 안에서는 12비트 카운터로 순서 보장 — TS `createUuidV7Generator` 포팅).
- 시각: UTC epoch 밀리초 INTEGER(`CHECK (x BETWEEN 0 AND 253402300799999)`). 전송 형식은 `YYYY-MM-DDTHH:MM:SS.mmmZ`(JS `toISOString`과 같음). 로컬 벽시계(`start_local`)와 날짜(`date`)는 TEXT, 시간대는 IANA 이름 TEXT.
- 모든 테이블 `STRICT`. boolean은 INTEGER 0/1, enum은 TEXT + CHECK, JSON은 TEXT + `CHECK (json_valid(x))`.
- 낙관적 잠금 `version INTEGER`(1부터), soft delete `deleted_at`.
- SQL에 시간 기본값(`now()`)을 두지 않는다. 시각은 항상 `Clock`이 준다(테스트에서 시간을 고정할 수 있다).
- 마이그레이션: `core/crates/store/migrations/NNNN_name.sql`, 전진 전용, 바이너리에 포함. 적용 기록에 SHA-256을 남겨, 이미 적용한 파일이 바뀌었으면 열기를 거부한다. 파일이 이 빌드보다 새 스키마면 열기를 거부한다(다운그레이드 방지). 데이터가 있는 파일을 올리기 전에는 사본을 뜬다. **모두 있음**(`migrate.rs`, 테스트 6개).
- 연결: 쓰기·읽기 연결 하나를 뮤텍스로 직렬화, 모든 쓰기는 `BEGIN IMMEDIATE`. 사용자 한 명 규모에 맞고 쓰기 충돌 재시도가 없다. 읽기 지연이 문제가 되면 WAL이라 읽기 전용 연결을 더하면 된다(호출자 변경 없음).

### 3.2 PostgreSQL 전용 기능의 대체

| PostgreSQL | SQLite 코어 | 검증 |
|---|---|---|
| `uuid` | TEXT(36) + `CHECK (length(id) = 36)`, 형식은 `domain::Id::parse` | 있음 |
| `timestamptz`, `now()` | INTEGER ms, `Clock` 주입 | 있음 |
| `jsonb` (coordinator 측정 183곳) | TEXT + `json_valid`. 안을 조건으로 쓰는 쿼리가 생기면 `json_extract` 생성 컬럼 + 인덱스 | JSON1 사용 가능 확인(스토어 테스트) |
| `text[]` (`reason_chips`, `granted_scopes`, `section_hashes`, `tags`) | JSON 배열 TEXT. 원소 검사(`<@`, 정규식)는 코드 + 테스트 | 해당 슬라이스 |
| `tsvector` + GIN, `to_tsquery`, `ts_rank` (노트 검색) | FTS5 가상 테이블(unicode61), 토큰을 `"토큰"*`로 AND. 순위는 bm25(제목 가중) | FTS5가 번들 SQLite에 있고 한글 접두 일치가 됨을 확인(스토어 테스트) |
| `EXCLUDE USING gist` (`schedule_block_no_overlap`) | 쓰기 트랜잭션 안에서 겹침 조회 후 삽입. 쓰기 트랜잭션이 하나뿐이라 경합이 없다. 위반은 지금처럼 422 `constraint_violation` / `h1_active_block_overlap` | RC-40: 무작위 삽입 property 테스트 + 저장된 데이터의 불변식 검사 함수(`store::invariants`, 테스트와 백업 검증에서 실행) |
| gist 인덱스 `tstzrange` | `(start_at)` 인덱스 + `start_at < :to AND end_at > :from` | RC-20 |
| 부분 유니크 인덱스 | SQLite가 지원한다. 그대로 옮긴다(inbox 1개, 활성 세션 1개, 현재 추정 1개, 사유별 pending 제안 1개, google 참조, 승격 노트) | inbox는 있음 |
| advisory lock 11곳(작업 리더, 인테이크 승인, owner별 직렬화) | 필요 없음: 프로세스 하나 + 쓰기 트랜잭션 하나. Google 동기화 직렬화는 프로세스 안 뮤텍스 | — |
| `FOR UPDATE`, `SKIP LOCKED` | `BEGIN IMMEDIATE` | 있음 |
| 복합 FK `(id, owner_id)` | 단순 FK(owner가 하나) | 있음 |
| `DEFERRABLE INITIALLY DEFERRED` FK (`plan.current_version_id`) | SQLite가 지원한다 | RC-40 |
| 트리거(availability version 단조 증가) | SQLite 트리거 `RAISE(ABORT)` | RC-20 |
| `numeric`(USD) | INTEGER 마이크로달러. 계약의 `dailyUsd: number`와는 경계에서 변환 | RC-70 |
| `real` | REAL | — |
| `bytea` | 암호문 컬럼은 키링으로 이동, 내보내기 산출물은 파일 | RC-90/110 |
| `date` | TEXT `YYYY-MM-DD` + GLOB CHECK | RC-20 |
| 정규식 CHECK(`~`) | GLOB CHECK 또는 코드 검증 | 해당 슬라이스 |
| 생성 컬럼 `body_tsv` | FTS5 + 트리거 | RC-80 |
| `btree_gist`, `uuidv7()` | 필요 없음 | — |

### 3.3 테이블·컬럼 대응

컬럼 칸 읽는 법: `` `a` `` 그대로(3.1 규약의 형 변환만), `` `a`→`b` `` 이름·형 변경, ~~`a`~~ 제외. `owner_id`는 3.1에 따라 모든 테이블에서 빠진다. "단계"는 그 테이블이 처음 필요한 슬라이스다.

<!-- data-model:start -->
| PostgreSQL 테이블 | 마이그레이션 | 판정 | SQLite 테이블 | 단계 | 컬럼 | 비고 |
|---|---|---|---|---|---|---|
| `user` | 0001 | 변형 | `owner` | RC-00 | `id` `email` ~~`password_hash`~~ `time_zone` `locale` `settings` ~~`llm_consent`~~ `created_at` `updated_at` `version` | 행 1개(`singleton` UNIQUE). `password_hash`: 로그인 없음. `llm_consent`: 코드에서 읽고 쓰는 곳 없음(동의는 `settings.llm.consent`). `email`은 계약의 `User.email` 표시용으로만 남는다. `settings` jsonb → JSON TEXT |
| `project` | 0001 | 유지 | `project` | RC-00 | `id` ~~`owner_id`~~ `title` `archived` `created_at` `updated_at` `version` `deleted_at` `kind` | inbox 1개 부분 유니크 인덱스 유지(SQLite 지원) |
| `task` | 0001 | 변형 | `task` | RC-00 | `id` ~~`owner_id`~~ `project_id` `title_cache`→`title` `status_cache`→`status` `due_at` `splittable` `min_session_min` `max_session_min` `priority` ~~`earliest_start_at`~~ ~~`provider_etag`~~ `created_at` `updated_at` `version` `deleted_at` | 작업의 원본이 된다. 새 컬럼 `description`(Vikunja가 갖고 있던 것). `earliest_start_at`·`provider_etag`: 코드에서 읽고 쓰는 곳 없음 |
| `task_dependency` | 0001 | 변형 | `task_dependency` | RC-00 | `task_id` `depends_on_task_id` ~~`owner_id`~~ ~~`kind`~~ ~~`created_at`~~ ~~`updated_at`~~ ~~`version`~~ | 새 컬럼 `position`(`dependsOn` 배열 순서). `kind`는 값이 하나뿐(`finish_to_start`). 지금까지 이 테이블은 한 번도 쓰이지 않았다(의존 관계는 Vikunja relation + `vikunja_planner_fields`). 순환 검사는 코드(`domain::assert_acyclic`), 같은 트랜잭션 |
| `external_provider_mapping` | 0001 | 제외 | — | — | ~~`id`~~ ~~`owner_id`~~ ~~`entity_type`~~ ~~`entity_id`~~ ~~`provider`~~ ~~`external_id`~~ ~~`external_etag`~~ ~~`external_updated_at`~~ ~~`local_version`~~ ~~`last_synced_at`~~ ~~`created_at`~~ ~~`updated_at`~~ ~~`version`~~ | Vikunja 전용. 코드에서 읽고 쓰는 곳 없음(0/0) |
| `idempotency_record` | 0001 | 변형 | `idempotency_record` | RC-00 | ~~`id`~~ ~~`owner_id`~~ `key` `route` `request_hash` `response`→response_status + response_headers + response_body `status` `expires_at` `created_at` ~~`updated_at`~~ ~~`version`~~ | `key`가 PK(owner 하나). 동기 변경은 효과와 같은 트랜잭션에서 `completed`로 바로 기록(§6.9) |
| `outbox_event` | 0001 | 제외 | — | — | ~~`id`~~ ~~`owner_id`~~ ~~`topic`~~ ~~`payload`~~ ~~`available_at`~~ ~~`attempts`~~ ~~`processed_at`~~ ~~`created_at`~~ ~~`updated_at`~~ ~~`version`~~ | 6곳에서 쓰지만 읽는 코드가 없다(디스패처 미구현). 프로세스 안 커밋 후 이벤트 + 주기 스윕으로 대체(§6.8) |
| `inbox_event` | 0001 | 제외 | — | — | ~~`id`~~ ~~`owner_id`~~ ~~`provider`~~ ~~`event_hash`~~ ~~`payload`~~ ~~`received_at`~~ ~~`created_at`~~ ~~`updated_at`~~ ~~`version`~~ | 웹훅 중복 제거용. 코드에서 읽고 쓰는 곳 없음(0/0), 들어오는 연결도 없다 |
| `audit_event` | 0001 | 유지 | `audit_event` | RC-40 | `id` ~~`owner_id`~~ `actor` `action` `entity` `entity_id` `diff_summary` `created_at` `updated_at` `version` | `diff_summary` jsonb → JSON TEXT(id·상태만). 1년 보존 스윕 |
| `job` | 0001 | 제외 | — | — | ~~`id`~~ ~~`owner_id`~~ ~~`kind`~~ ~~`run_at`~~ ~~`lease_until`~~ ~~`attempts`~~ ~~`unique_key`~~ ~~`status`~~ ~~`created_at`~~ ~~`updated_at`~~ ~~`version`~~ | 코드에서 읽고 쓰는 곳 없음(0/0). 작업은 프로세스 안 타이머(§6.8) |
| `vikunja_mapping` | 0003 | 제외 | — | — | ~~`entity_type`~~ ~~`entity_id`~~ ~~`owner_id`~~ ~~`external_id`~~ ~~`external_etag`~~ ~~`external_updated_at`~~ ~~`local_version`~~ ~~`content_fingerprint`~~ ~~`needs_reconcile`~~ ~~`pending_completion`~~ ~~`created_at`~~ ~~`updated_at`~~ ~~`deleted_at`~~ ~~`is_inbox`~~ | Vikunja 제거(결정 4). 가져오기에서 planner UUID는 그대로 쓰고 외부 id는 버린다 |
| `vikunja_planner_fields` | 0003 | 제외 | — | — | ~~`task_id`~~ ~~`owner_id`~~ ~~`fields`~~ ~~`created_at`~~ ~~`updated_at`~~ | `fields`(splittable·priority·status·dependsOn·session)는 가져올 때 `task` 컬럼과 `task_dependency`로 들어간다(§8.2) |
| `vikunja_change_journal` | 0003 | 제외 | — | — | ~~`owner_id`~~ ~~`epoch`~~ ~~`seq`~~ ~~`task_id`~~ ~~`external_id`~~ ~~`version`~~ ~~`deleted_at`~~ ~~`completed_occurrence_at`~~ ~~`at`~~ | 재조정 전용 |
| `vikunja_journal_epoch` | 0003 | 제외 | — | — | ~~`owner_id`~~ ~~`epoch`~~ ~~`snapshot_done`~~ ~~`updated_at`~~ | 재조정 전용 |
| `vikunja_owner_account` | 0003 | 제외 | — | — | ~~`owner_id`~~ ~~`vikunja_user_id`~~ ~~`token_secret_ref`~~ ~~`created_at`~~ ~~`updated_at`~~ | 토큰 참조. Vikunja 제거 |
| `goal` | 0005 | 유지 | `goal` | RC-70 | `id` ~~`owner_id`~~ `title` `target_date` `status` `created_at` `updated_at` `version` `deleted_at` | `target_date` date → TEXT `YYYY-MM-DD` |
| `task_template` | 0005 | 유지 | `task_template` | RC-70 | `id` ~~`owner_id`~~ `name` `steps` `stats` `source` `confidence` `created_at` `updated_at` `version` `deleted_at` | `steps`·`stats` jsonb → JSON TEXT, `confidence` real → REAL |
| `task_type_fingerprint` | 0005 | 변형 | `task_type_fingerprint` | RC-70 | `id` ~~`owner_id`~~ `template_id` `tags` `keywords` `meta` `false_positive_count` `created_at` `updated_at` `version` | `tags` text[] → JSON 배열, `keywords` tsvector → 정규화한 토큰의 JSON 배열(유사도는 Rust 코드에서 계산), `meta` → JSON TEXT |
| `intake_session` | 0005 | 유지 | `intake_session` | RC-70 | `id` ~~`owner_id`~~ `goal_id` `state` `input` `detected_type` `template_id` `round` `manual` `error` `created_at` `updated_at` `version` | `input`·`detected_type`·`error` → JSON TEXT |
| `intake_answer` | 0005 | 유지 | `intake_answer` | RC-70 | `id` ~~`owner_id`~~ `session_id` `question_key` `question_text` `answer` `skipped` `created_at` `updated_at` `version` | `answer` → JSON TEXT |
| `estimate` | 0005 | 유지 | `estimate` | RC-40 | `id` ~~`owner_id`~~ `task_id` `p50_min` `p90_min` `method` `confidence` `is_current` `created_at` `updated_at` `version` | `is_current` 부분 유니크 인덱스 유지 |
| `estimate_evidence` | 0005 | 제외 | — | — | ~~`id`~~ ~~`owner_id`~~ ~~`estimate_id`~~ ~~`kind`~~ ~~`ref`~~ ~~`summary`~~ ~~`created_at`~~ ~~`updated_at`~~ ~~`version`~~ | 쓰기만 하고(1곳) 읽는 코드가 없다. 근거를 보여 주는 기능을 만들 때 `estimate.evidence` JSON으로 추가 |
| `agent_run` | 0005 | 변형 | `agent_run` | RC-70 | `id` ~~`owner_id`~~ `purpose` `prompt_id_version` `model` `provider` `tokens_in` `tokens_out` `cost_usd`→`cost_micro_usd` `latency_ms` `status` `redaction_report` `created_at` `updated_at` `version` | numeric(12,6) → INTEGER 마이크로달러(정확한 정수 합산). `redaction_report` → JSON TEXT |
| `agent_proposal` | 0005 | 유지 | `agent_proposal` | RC-70 | `id` ~~`owner_id`~~ `run_id` `kind` `payload` `schema_ok` `policy_ok` `constraint_ok` `decision` `created_at` `updated_at` `version` | `payload` → JSON TEXT |
| `intake_approval` | 0006 | 제외 | — | — | ~~`session_id`~~ ~~`owner_id`~~ ~~`draft_version`~~ ~~`state`~~ ~~`lease_expires_at`~~ ~~`idempotency_key`~~ ~~`holder_token`~~ ~~`last_call_started_at`~~ ~~`created_at`~~ ~~`updated_at`~~ | Vikunja에 작업을 여러 요청으로 만들 때 이어 하기 위한 장치(ADR-020). 네이티브에서는 초안 승인이 한 트랜잭션이라 필요 없다. 승인 멱등은 `idempotency_record` |
| `intake_approval_step` | 0006 | 제외 | — | — | ~~`session_id`~~ ~~`step_key`~~ ~~`planned_task_id`~~ ~~`state`~~ ~~`task_id`~~ ~~`dependency_state`~~ | 위와 같음 |
| `commitment_event` | 0007 | 유지 | `commitment_event` | RC-20 | `id` ~~`owner_id`~~ `title` `start_at` `end_at` `rrule` `time_zone` `source` `created_at` `updated_at` `version` `deleted_at` `external_calendar_id` `external_event_id` `external_etag` | gist(tstzrange) 인덱스 → `(start_at)` 인덱스 + `start_at < :to AND end_at > :from`. google 참조 부분 유니크 유지. 외부 참조 CHECK 유지 |
| `availability_rule` | 0007 | 유지 | `availability_rule` | RC-20 | `id` ~~`owner_id`~~ `weekday` `start_local` `end_local` `time_zone` `kind` `created_at` `updated_at` `version` | `HH:MM` 정규식 CHECK → GLOB CHECK + 코드 검증 |
| `availability_exception` | 0007 | 유지 | `availability_exception` | RC-20 | `id` ~~`owner_id`~~ `date` `kind` `start_local` `end_local` `created_at` `updated_at` `version` | `date` → TEXT `YYYY-MM-DD` |
| `user_availability_version` | 0007 | 변형 | `availability_state` | RC-20 | ~~`owner_id`~~ `version` `updated_at` `time_zone` `prefs` | 행 1개. `version` 단조 증가 트리거는 SQLite 트리거(`RAISE(ABORT)`)로 유지. `prefs` → JSON TEXT |
| `plan` | 0007 | 유지 | `plan` | RC-40 | `id` ~~`owner_id`~~ `scope` `status` `current_version_id` `availability_version` `horizon_start` `horizon_end` `time_zone` `created_at` `updated_at` `version` `deleted_at` | `scope` → JSON TEXT. `current_version_id` 지연 FK는 SQLite `DEFERRABLE INITIALLY DEFERRED` |
| `plan_candidate` | 0007 | 유지 | `plan_candidate` | RC-40 | `id` ~~`owner_id`~~ `plan_id` `policy` `blocks` `metrics` `explanation` `diversity_note` `feasible` `deficit_min` `input_hash` `generator_version` `created_at` `updated_at` `version` | `blocks`·`metrics`·`explanation` → JSON TEXT |
| `plan_version` | 0007 | 유지 | `plan_version` | RC-40 | `id` ~~`owner_id`~~ `plan_id` `seq` `candidate_id` `reason` `created_by` `availability_version` `created_at` `updated_at` `version` | `(plan_id, seq)` 유니크 유지 |
| `schedule_block` | 0007 | 유지 | `schedule_block` | RC-40 | `id` ~~`owner_id`~~ `plan_version_id` `task_id` `start_at` `end_at` `locked` `status` `created_at` `updated_at` `version` | **EXCLUDE(gist) 겹침 금지 → 코드 검사**: 쓰기 트랜잭션 안에서 `status <> 'superseded' AND start_at < :end AND end_at > :start` 조회 후 삽입(§3.2). `(start_at)` 부분 인덱스 |
| `schedule_approval` | 0007 | 유지 | `schedule_approval` | RC-40 | `id` ~~`owner_id`~~ `plan_version_id` `approved_at` `idempotency_key` `availability_version` `created_at` `updated_at` `version` | `idempotency_key` 유니크 유지 |
| `work_session` | 0009 | 유지 | `work_session` | RC-50 | `id` ~~`owner_id`~~ `task_id` `block_id` `state` `started_at` `ended_at` `focused_sec` `paused_sec` `client_id` `created_at` `updated_at` `version` | 활성 세션 1개 부분 유니크 유지 |
| `task_completion_review` | 0009 | 유지 | `task_completion_review` | RC-50 | `id` ~~`owner_id`~~ `session_id` `outcome` `reason_chips` `note` `created_at` `updated_at` `version` | `reason_chips` text[] → JSON 배열. 허용 값 검사(`<@`)는 코드 + 테스트 |
| `estimation_feedback` | 0009 | 유지 | `estimation_feedback` | RC-50 | `id` ~~`owner_id`~~ `task_id` `estimated_p50` `actual_focus_min` `quality` `created_at` `updated_at` `version` `excluded` |  |
| `notification` | 0009 | 유지 | `notification` | RC-50 | `id` ~~`owner_id`~~ `kind` `dedupe_key` `scheduled_at` `sent_at` `channel` `state` `created_at` `updated_at` `version` | `dedupe_key` 유니크 유지. `channel` 값은 계약대로 두고(`in_app`), OS 알림은 셸이 같은 행을 보고 띄운다 |
| `push_subscription` | 0009 | 제외 | — | — | ~~`id`~~ ~~`owner_id`~~ ~~`endpoint`~~ ~~`p256dh_ciphertext`~~ ~~`auth_ciphertext`~~ ~~`key_id`~~ ~~`device_label`~~ ~~`created_at`~~ ~~`updated_at`~~ ~~`version`~~ | Web Push 없음. OS 알림으로 대체(§4.2) |
| `export_job` | 0009 | 변형 | `export_job` | RC-110 | `id` ~~`owner_id`~~ `state` `requested_at` `started_at` `completed_at` `expires_at` `artifact_key` `size_bytes` `failure_code` `created_at` `updated_at` `version` ~~`artifact`~~ `content_type` | 산출물은 DB BLOB이 아니라 데이터 디렉터리의 파일(`exports/<id>.json`), `artifact_key`가 그 상대 경로 |
| `today_proposal` | 0010 | 유지 | `today_proposal` | RC-50 | `id` ~~`owner_id`~~ `base_plan_version_id` `availability_version` `payload` `state` `expires_at` `created_at` | `payload` → JSON TEXT |
| `llm_spend` | 0011 | 변형 | `llm_spend` | RC-70 | `id` ~~`owner_id`~~ `agent_run_id` `purpose` `state` `reserved_usd`→`reserved_micro_usd` `actual_usd`→`actual_micro_usd` `input_tokens` `output_tokens` `cached_tokens` `created_at` `settled_at` `settle_reason` | numeric → INTEGER 마이크로달러. 예약·정산은 `BEGIN IMMEDIATE` 한 트랜잭션 |
| `replan_proposal` | 0012 | 유지 | `replan_proposal` | RC-60 | `id` ~~`owner_id`~~ `plan_id` `base_plan_version_id` `result_plan_version_id` `trigger_kind` `reason_code` `detected_at` `availability_version` `payload` `state` `created_at` `updated_at` `expires_at` `version` | 사유별 pending 1개 부분 유니크 유지. `payload` → JSON TEXT |
| `replan_suppression` | 0012 | 유지 | `replan_suppression` | RC-60 | ~~`owner_id`~~ `reason_code` `until` `created_at` `updated_at` `version` | PK가 `reason_code` 하나로 줄어든다 |
| `context_document` | 0013 | 변형 | `context_document` | RC-80 | `id` ~~`owner_id`~~ `title` `body_md` ~~`body_tsv`~~ `sensitivity` `llm_allowed` `source` `source_task_id` `created_at` `updated_at` `deleted_at` `version` | 생성 컬럼 tsvector + GIN → FTS5 가상 테이블 `context_document_fts(title, body_md)`(트리거로 동기화, unicode61). 승격 노트 부분 유니크 유지 |
| `document_link` | 0013 | 유지 | `document_link` | RC-80 | `id` ~~`owner_id`~~ `document_id` `target_kind` `target_id` `created_at` `updated_at` `version` |  |
| `note_ai_usage` | 0013 | 유지 | `note_ai_usage` | RC-80 | `id` ~~`owner_id`~~ `document_id` `agent_run_id` `purpose` `document_version` `body_hash` `section_hashes` `sent_bytes` `created_at` `updated_at` `version` | `section_hashes` text[] → JSON 배열, 형식 검사는 코드 |
| `auth_session` | 0015 | 제외 | — | — | ~~`id_hash`~~ ~~`user_id`~~ ~~`csrf_token_hash`~~ ~~`created_at`~~ ~~`last_seen_at`~~ ~~`expires_at`~~ | 로그인·세션·CSRF 없음(결정 5). 실행마다 새로 만드는 토큰이 대신한다(§1.3) |
| `google_calendar_connection` | 0016 | 변형 | `google_calendar_connection` | RC-90 | `id` ~~`owner_id`~~ `status` ~~`refresh_token_ciphertext`~~ ~~`token_key_id`~~ `granted_scopes` `export_calendar_id` `settings` `last_sync_at` `last_error` `created_at` `updated_at` `version` | refresh token은 OS 키링으로(결정 6). 토큰⇔상태 CHECK는 코드로. `granted_scopes` text[] → JSON 배열 |
| `google_calendar` | 0016 | 유지 | `google_calendar` | RC-90 | `id` ~~`owner_id`~~ `connection_id` `google_calendar_id` `name` `access_role` `is_primary` `selected` `time_zone` `created_at` `updated_at` `version` |  |
| `calendar_day_event` | 0016 | 유지 | `calendar_day_event` | RC-20 | `id` ~~`owner_id`~~ `title` `start_date` `end_date` `source` `external_calendar_id` `external_event_id` `external_etag` `created_at` `updated_at` `version` `deleted_at` | 테이블은 RC-20(빈 목록을 돌려주기 위해), 내용은 RC-90. 날짜 → TEXT |
| `google_export_mapping` | 0016 | 유지 | `google_export_mapping` | RC-90 | `id` ~~`owner_id`~~ `local_kind` `local_key` `google_calendar_id` `google_event_id` `fingerprint` `ends_at` `created_at` `updated_at` `version` |  |
<!-- data-model:end -->

새로 생기는 것: `schema_migration`(적용 기록, **있음**), `task.description`·`task_dependency.position`(**있음**), `context_document_fts`(RC-80), `app_setting`(셸 설정: 자동 시작·알림·백업, RC-100).

## 4. 옮기지 않는 것, 새로 생기는 것

### 4.1 옮기지 않는 것

| 무엇 | 크기(줄) | 이유 |
|---|---|---|
| `packages/provider-vikunja`, `services/api/src/adapters/vikunja/**`, 재조정기 | 3.9k + 1.2k | Vikunja 제거(결정 4) |
| 로그인·세션·CSRF·rate limit·argon2 (`auth-service`, `*session-store`, `session-tokens`, `login-rate-limiter`, `session-sweep-job`, `create-user` CLI) | 약 0.7k | owner 하나, 실행 토큰이 대신한다 |
| 리더 잠금·advisory lock·풀 타임아웃·연결 끊김 처리 (`pg-intake-approval-lock`, `intake-session-advisory`, 풀 관련 테스트) | — | 프로세스 하나, SQLite |
| 인테이크 승인의 단계 원장·승계 대기·펜싱(ADR-020 전체) | `pg-intake-approval-repository` 0.4k 외 | 작업 생성이 한 트랜잭션 |
| outbox 쓰기 | 6곳 | 읽는 쪽이 없었다 |
| Web Push(VAPID, `push-crypto`, `pg-push-subscription-store`) | 약 0.15k | OS 알림 |
| refresh token 봉투 암호화(`at-rest-crypto`)와 키 파일 관리 | 약 0.1k | OS 키링 |
| 설정 표면의 대부분(`config.ts` 766줄: `DATABASE_URL`, 쿠키, trust proxy, Vikunja, HTTP 타임아웃, 가짜 LLM 스위치…) | — | 남는 설정은 데이터 위치, 로그 수준, 개발용 출처 정도 |
| `scripts/local/**`, `deploy/**`, compose | — | 설치할 서버가 없다 |
| `packages/provider-native`의 InMemory 저장소 | 1.0k | 규칙은 `app::tasks`로 옮겼다(RC-00). 기준 구현으로만 남는다 |

TypeScript에 그대로 남는 것: `apps/web`, `packages/contracts`(계약의 단일 소스), `packages/ui-policy`(웹만 쓴다 — API는 import하지 않음), `packages/llm/prompts`·`schemas`(파일이 단일 소스, Rust가 빌드 때 포함), `e2e/`.

### 4.2 데스크톱에서 새로 생기는 것

| 기능 | 어디에 | 내용 | 단계 |
|---|---|---|---|
| 트레이 아이콘 | 셸 | 창 열기, 오늘 요약, 끝내기. 창을 닫으면 트레이에 남는다 | RC-100 |
| OS 알림 | 코어(무엇을·언제) + 셸(띄우기) | 블록 시작 10분 전(`session_reminder`, 지금의 60초 틱과 같은 규칙·dedupe 키), 아침 요약(하루 시작 시각, 첫 블록이 더 이르면 그 시각 — Google 요약과 같은 규칙), 재계획 제안 | RC-50(행), RC-100(띄우기) |
| 자동 시작 | 셸 | `~/.config/autostart/ohmydate.desktop`(XDG autostart), 창 없이 트레이로 시작. 끄고 켤 수 있다 | RC-100 |
| 창을 닫은 채 Google 동기화 | 코어 타이머 | 5분 주기 + 변경 뒤 3초 디바운스 내보내기(지금 규칙 그대로) | RC-90 |
| 단일 인스턴스 | 코어 잠금 + 셸 | §1.5 | 코어 있음 / RC-100 |
| 백업·복원 | 코어 | `VACUUM INTO`로 일관된 사본(**함수 있음**: `Store::backup_to`). 하루 1개·7개 보존, 메뉴에서 "지금 백업"·"백업에서 복원"(복원은 앱 재시작) | RC-100 |
| 키링 | integrations | Secret Service + 파일 대체 | RC-70 |
| 업데이트 | 셸 | 처음에는 새 패키지를 내려받아 설치(수동). 자동 업데이트는 서명 키와 배포 위치가 정해져야 한다 — 사용자 결정(§11 Q3) | RC-100 이후 |
| 웹의 데스크톱 모드 | `apps/web` (작은 변경) | 로그인·로그아웃·푸시 구독 UI 숨김, 서비스 워커 등록 안 함, Google 연결 안내 문구 | RC-100 |

## 5. 스케줄러 포팅

### 5.1 모듈 대응

| TypeScript (`packages/scheduler/src`) | 줄 | Rust (`core/crates/scheduler/src`) | 단계 | 오라클에서 대조하는 값 |
|---|---|---|---|---|
| `prng.ts` | 32 | `prng.rs` | **있음** | `primitives.prng` |
| `hash.ts` | 159 | `canonical.rs` (SHA-256은 `sha2`) | **있음** | `primitives.canonical`, `resultHash` |
| — (`Math.max`·`Math.min`·`Math.round`, `Number::toString`) | — | `js.rs` — `f64`의 같은 이름 함수와 결과가 다른 것만 | **있음**(RC-30) | 단위 테스트 |
| `time.ts` | 277 | `time.rs` — 시각 파싱·출력, `Zone`(시간대 id 해석·오프셋·로컬 날짜 분할), `LocalDate`, `parse_clock`, `project_window_on_segment`, 그리드 정렬 | **있음**(RC-30) | `primitives.instants`·`zones`·`dates`·`clocks`·`partitions` |
| `generate.ts`의 `canonicalInput` | — | `input_hash.rs` | **있음** | 모든 후보의 `inputHash` |
| `types.ts` (입력) | 331 | `types.rs` — 입력 타입과 JSON 읽기·쓰기 | **있음**(RC-30) | 입력 왕복(`to_json`의 정규 JSON = 입력) |
| `slots.ts` | 249 | `slots.rs` | **있음**(RC-30) | `slots` |
| `requirements.ts`, `sessions.ts` | 79 | 같은 이름 | **있음**(RC-30) | `primitives.sessions`, 단위 테스트 |
| `codes.ts` | 278 | `codes.rs` (닫힌 enum + params) | RC-31 | 계약의 enum 목록과 일치 테스트 |
| `validate.ts` | 1,407 | `validate.rs` — 생성기와 **다른 구현**이라는 규칙 유지(자체 분할 로직을 따로 둔다) | RC-31 | `inputIssues`, `validation`, `probes` |
| `explain.ts` | 238 | `explain.rs` | RC-31 | `deficit`, 후보의 `capacityDeficitMin` |
| `policies.ts` | 97 | `policies.rs` | RC-32 | — |
| `generate.ts` (새 계획) | 약 2,400 | `generate/{mod,context,order,place,h6,improve,metrics,lines}.rs` | RC-32 | `result`(재계획 아닌 건) |
| `generate.ts` (재계획·빈틈 맞춤) | 약 1,600 | `generate/{replan,gapfit}.rs` | RC-33 | `result`(재계획 건) |

타입 모델(RC-30에서 정함): JavaScript의 수는 전부 `f64`로 둔다 — `12.5`분이나 `1e21`분짜리 추정이 틀렸다고 판정하는 것이 `validate_input`의 일이라, 타입이 그런 값을 담을 수 있어야 한다. 닫힌 문자열 집합(`riskLevel`, 예외·가용 `kind`, `preferredWindows`, `autoSplit`, 정책 이름)은 enum이다. `ScheduleInput::from_json`은 작업·가용 규칙·예외·`prefs` 객체에 모르는 필드가 있으면 거부한다(기준 구현은 그 객체들을 통째로 해시하므로, 조용히 버리면 `inputHash`가 달라진다). 최상위·약속·블록의 모르는 필드는 기준 구현처럼 무시한다. 오류 문구에는 위치(JSON 포인터)와 종류만 있고 값은 없다.

### 5.2 결정론 계약

같은 입력·시드에서 TypeScript와 **같은 바이트**가 나와야 한다. 지켜야 할 것과 Rust에서의 방법:

| 항목 | TypeScript | Rust |
|---|---|---|
| 난수 | mulberry32, 시드 `ToUint32(trunc(seed))`, 0이면 `0x9e3779b9`. 정책별 시드 오프셋 0 / 7919 / 15486. 쓰는 곳은 국소 개선의 셔플(`nextInt(index + 1)`)뿐 | `u32` wrapping 연산 — 있음, 스트림 비트 일치 확인 |
| 시간 | epoch ms(double이지만 정수) | 분할·슬롯은 `i64`(2^53 미만이라 손실 없음). 분 단위 값과 섞이는 계산은 `f64` — 기준 구현의 ±∞ 표식과 NaN 규칙을 그대로 쓴다 |
| 실수 | 목적함수 `objectiveScore`와 지표(`avgDailyLoadMin`, `p90CoverageRatio`)만 double. 식의 순서가 결과다 | `f64`, **같은 순서로 같은 연산**. Rust는 식을 재배열하거나 FMA로 합치지 않는다. 비교는 비트 단위 |
| 반올림·최대·최소 | `Math.round`(절반은 +∞ 쪽), `Math.max`/`Math.min`(NaN이 하나라도 있으면 NaN, `+0` > `-0`) | `f64::round`·`f64::max`·`f64::min`과 다르다 → `js::round`·`js::max`·`js::min` — 있음. `floor`/`ceil`/`trunc`/`%`는 같다 |
| NaN 비교 | `compareDue`의 `Infinity - Infinity = NaN`은 `\|\|` 사슬에서 0으로 취급된다 | 비교 헬퍼가 NaN을 "같음"으로 넘긴다 |
| 정렬 | `Array.prototype.sort`는 안정 정렬 | `sort_by`만 쓴다. `sort_unstable*`·`select_nth_unstable*`는 `core/crates/scheduler/clippy.toml`의 `disallowed-methods`가 막는다 — 있음(RC-30, 일부러 넣어 보고 clippy가 거부하는 것을 확인) |
| 문자열 순서 | `<`, `.sort()` = UTF-16 코드 유닛 순 | `compare_utf16` — 있음. `str::cmp`(UTF-8 바이트 순)를 쓰지 않는다 |
| 맵 순회 | `Map`/`Set`은 삽입 순 | 삽입 순서를 지키는 구조만 쓴다. 스케줄러 크레이트에서는 `HashMap`·`HashSet` 타입 자체를 쓸 수 없다(같은 `clippy.toml`의 `disallowed-types`) — 있음(RC-30) |
| 수 → 글자 | 설명 문장과 정규 JSON의 수는 `Number::toString` (`1e+21`, `5`) | 정규 JSON은 `js_number`, 문장은 `js::number_to_string`(`NaN`·`Infinity`까지) — 있음 |
| 정규 JSON | 키 정렬(UTF-16), `JSON.stringify` 이스케이프, `undefined` 생략 | `canonical_json` — 있음 |
| 시간대 전환 | `getTimeZoneTransition('next')` = **오프셋이 바뀌는** 전환만 | tzdb의 전환 중 오프셋이 그대로인 것(약어·DST 표시만 바뀜)은 건너뛴다 — 있음 |
| 시각 표기 | `Temporal.Instant`: 초 생략 허용, ms보다 가는 값 거부, 출력은 소수부를 필요한 만큼만 | `jiff::Timestamp` + ms 검사 — 있음, 50개 표기 일치 확인(소문자 `t`/`z`, 공백 구분, 쉼표 소수점, 기본 형식, `+0900`/`+09`, 초 단위 오프셋, 대괄호 주석, `:60` 초) |
| 시간대 id | `Temporal`이 받는 것: IANA 이름(대소문자 무시, 옛 별칭 포함), `±HH`·`±HHMM`·`±HH:MM` 오프셋, 시간대를 가리키는 ISO 날짜-시각 문자열 | `time::Zone::get` — 있음, 54개 id 일치 확인. `Etc/Unknown`·`Factory`는 거부 |
| 날짜 | 예외의 `date`는 **문자열로** 비교한다(`exception.date === segment.date`). 유효성 검사는 `Temporal.PlainDate.from` | `LocalDate::from_printed`(출력 형태 그대로일 때만 날짜), `is_plain_date` — 있음, 28개 표기 일치 확인 |
| 로컬 시각 | `/^(\d{1,2}):(\d{2})$/`, `24:00` 허용 | `parse_clock` — 있음, 23개 표기 일치 확인 |
| 탐색 상한 | 국소 개선 200회, 빈틈 맞춤 512회, 전환 4096개 | 같은 상수, 같은 순회 순서 → 같은 지점에서 멈춘다 |
| 출력 | 블록 배열 순서, 선택 필드는 생략(null 아님) | serde `skip_serializing_if` |

tzdata: 기준 구현은 Node에 든 ICU의 tzdata(오늘 2026c), Rust는 `jiff-tzdb`에 든 것(2026e, 바이너리에 포함 — 시스템 tzdata를 보지 않으므로 기계마다 결과가 달라지지 않는다)을 쓴다. 팩이 기준의 버전(`oracle.tzdata`)과 분할 결과를 싣고 있으므로, 데이터 차이는 스케줄 불일치가 아니라 **분할 불일치**로 먼저 드러난다. 팩의 29개 구간(RC-00의 16개 + RC-30에서 더한 13개: 분 단위가 아닌 오프셋(1908년 서울 +08:27:52, 1972년 Monrovia), Kathmandu +05:45, 오프셋으로 준 시간대, 모로코의 라마단 전환, 1988년 서울 DST, Troll의 2시간 전환, 표 밖의 미래(뉴욕 2037·2100, 베를린 2060))에서 불일치는 없다.

Rust 쪽이 기준 구현과 **다르게 답하지 않고 거부하는** 입력(문서화한 한계, `time::tests::known_differences_from_the_reference_are_refusals_not_other_answers`):

| 입력 | 기준 구현(Temporal) | Rust(`jiff`) | 영향 |
|---|---|---|---|
| 9999-12-30T22:00Z 뒤, −9999-01-02 앞의 시각 | ±275760년까지 받는다 | 잘못된 시각으로 본다 | 없음: 앱은 그런 시각을 만들지 않는다 |
| critical 표시가 붙은 주석(`…Z[!u-ca=iso8601]`) | 받는다 | 잘못된 시각으로 본다 | 없음: 앱은 주석을 쓰지 않는다 |

### 5.3 차분 테스트

- 내보내기: `packages/scheduler/scripts/export-oracle.mts`(**있음**). `corepack pnpm run core:oracle -- --count N --seed S --name NAME --out DIR`. 같은 시드·개수면 같은 파일이 나온다(RC-00에서 두 번 돌려 SHA-256 일치 확인, RC-30에서 다시 확인).
- 팩 형식(`formatVersion` 2 — RC-30에서 올렸다. 버전이 다른 팩은 Rust 테스트가 "다시 만들라"는 말과 함께 거부한다):

```text
{ format: "ohmydate-scheduler-oracle", formatVersion: 2,
  oracle: { generatorVersion, policyVersion, node, tzdata, seed, count },
  primitives: {
    prng:       [{ seed, floats[8], ints: [{ maxExclusive, values[8] }] }],
    canonical:  [{ value, text, sha256 }],
    instants:   [{ text, epochMs | null, utc | null, subMillisecond }],
    zones:      [{ id, valid }],                       // isValidTimeZone
    dates:      [{ text, valid, printed | null }],     // Temporal.PlainDate.from
    clocks:     [{ text, minutes | null }],            // parseClock
    sessions:   [{ breakAfterMin, maxDailyFocusMin, limit | null, autoSplitMin[] }],
    partitions: [{ timeZone, start, end, segments: [{ date, weekday, offsetMs, startMs, endMs, localMidnightMs }] }] },
  cases: [{ id, kind: "golden" | "generated" | "replan" | "invalid",   // 한 줄에 한 건
            input: ScheduleInput, options: GenerateOptions | null,
            inputIssues,        // validateInput(input)
            slots | null,       // computeAvailableSlots(input), 던지면 null
            deficit | null,     // deficit(input), 던지면 null
            result,             // generate(input, options): candidates[], diversityNote?, diversityNoteItems?
            validation,         // 후보마다 validate(input, blocks, { riskLevel, historyBlocks }) 전체
            probes,             // 일부러 망가뜨린 계획 4개와 그 validate 결과
            resultHash }] }     // sha256(canonicalJson(result))
```

- 시나리오(RC-30에서 넓혔다): golden 15개 전부 + 시드로 만든 입력. 시간대 7종(DST 있는 곳 5), 전환 직전에 시작하는 기간, 그리드에서 벗어난 약속과 가용 규칙, +09:00 표기의 마감, 과부하 25%, 그리드에 안 맞거나 5분보다 짧은 추정, `autoSplit` 표시, `remainingMin`, 예외 4종(종일 off/extra, 시간 범위 off/extra). 작업의 85%는 혼자서는 가능하게 만든다(한 블록짜리는 휴식 규칙과 자기 세션 범위 안, 나눌 수 있는 것은 최소 세션 이상) — 그래야 feasible 후보와 재계획이 충분히 나온다.
  - 재계획(3건 중 1건을 시도, feasible 후보가 있어야 성립): 승인한 계획 위에 바뀐 것 1–3가지를 얹는다 — 블록 위에 새 약속, `now`가 지나 일부 블록이 이력이 됨(+ 절반은 `remainingMin`), 블록 잠금(`lockedBlocks`에만 / 양쪽에), 추정 변경, 새 의존 관계, 블록이 있는 날을 쉬는 날로, 새 작업, 호출자가 지정한 `affectedTaskIds`(없는 id 포함).
  - 잘못된 입력(6건 중 1건): 24가지 변형 — 없는 시간대, 뒤집힌·너무 긴·읽을 수 없는 기간, 잘못된 `now`, 중복 id, 자기·없는 의존, 정수가 아닌 추정과 세션 범위, 뒤집힌 세션 범위와 음수 버퍼, 빈 작업 창, 잘못된 마감, 잘못된 `prefs`, 요일 9·뒤집힌 창·잘못된 시각, 잘못된 예외(없는 날짜, 한쪽만 있는 창, 뒤집힌 창), 잘못된·너무 긴 약속, 모르는 작업·그리드 밖·ms보다 가는·뒤집힌·읽을 수 없는·너무 긴 블록. 2,000건 팩에서 입력 문제 코드 29개가 전부 나온다. `validate`는 공개 함수이므로 거부된 입력에서도 판정을 싣는다.
  - 검증기 탐침(`probes`): 생성된 후보는 대부분 feasible이라 그것만으로는 validator의 가지를 거의 지나지 않는다. 그래서 건마다 후보의 블록을 1–2군데 망가뜨린 계획 4개(밀기, 늘이기, 빼기, 작업 바꾸기, 복제, 기간 밖, 그리드 밖, ms보다 가는 시각, 읽을 수 없는 시각, 뒤집기, 모르는 작업, 겹치기)를 만들어 기준 구현의 판정을 싣는다. 2,000건 팩에서 위반 코드 24개가 전부 나온다(판정 44,087건). 생성기 문장 코드는 15개 중 14개가 나온다 — 나머지 `heuristic_estimate_below_grid`는 기준 구현에서 도달할 수 없다(5분 미만으로 남은 양은 5로 나누어떨어지지 않으므로 항상 `estimate_not_grid_aligned`가 먼저 붙는다).
- 커밋하는 것: `core/crates/scheduler/tests/oracle/sample.json` 하나(27건, 372 KiB)와 `README.md`(시드 목록·명령). 큰 팩은 커밋하지 않고 `core/target/oracle/`에 만들어 `OHMYDATE_ORACLE_DIR`로 읽는다(**있음**, RC-30). 팩은 한 줄에 한 건이라 테스트가 한 건씩 읽는다(큰 팩을 통째로 메모리에 올리지 않는다).
- 실행: `corepack pnpm run core:diff` = 2,000건 팩을 만들고 `OHMYDATE_ORACLE_DIR=target/oracle cargo test -p ohmydate-scheduler --test oracle -- --nocapture`. 층마다 "비교 수, 불일치 수"를 찍는다. `ORACLE_COUNT`·`ORACLE_SEED`로 개수와 시드를 바꾼다.
- 개수: 스케줄러 슬라이스의 "Exact tests"는 2,000건, 전환 관문은 10,000건 + golden 15(§7.7). 불일치 허용 0.
- 대조 순서(앞 층이 틀리면 뒤는 보지 않는다): 원시값 → 입력 왕복 → `inputHash` → `slots` → `inputIssues` → `deficit` → `validation`·`probes` → 정책별 `blocks` → `metrics` → `explanation`/`explanationItems` → `diversityNote` → `resultHash`. 보고는 건 id + 층 + JSON 포인터 + 양쪽 값. 한 층의 비교 수가 기대보다 적어도 실패한다(빈 팩이 통과하지 못하게).
- 최소화(RC-31): `packages/scheduler/scripts/shrink-oracle.mts`가 불일치 건의 입력에서 작업·약속·가용 규칙·예외를 하나씩 빼 보며, 빼도 불일치가 남으면 뺀 채로 둔다(delta debugging). 양쪽 실행은 TypeScript 함수와 Rust 쪽 작은 CLI(`sched-diff`: 입력 JSON → 결과 JSON). 남은 최소 입력을 `tests/oracle/regressions/`에 건 하나짜리 팩으로 커밋한다.

### 5.4 옮길 테스트

| TypeScript | 내용 | Rust |
|---|---|---|
| `test/golden/*.json` + `golden.test.ts` | G01–G15 기대값 | 오라클 팩의 golden 건 + 기대값 단언 |
| `property.test.ts`(7), `generate.property.test.ts`(3), `replan.property.test.ts`(4), `fu41`(2), `explanation-codes`(1) — fast-check 속성 17개 | 반환된 후보는 H1–H8 위반 0, validator ↔ 1분 단위 오라클(`minuteOracle.ts`) 일치, 고정 블록 보존, 변경 상한 명시, 같은 입력 두 번 = 같은 출력, 문장 ↔ 코드 1:1 | `proptest`로 옮긴다. 생성기는 fast-check arbitrary를 손으로 옮긴다. 평소 1,000회, 관문 10,000회(11 §1과 같음) |
| 테스트 파일 21개 전체(`validate`, `slots`, `transitions`, `fu39r`…`fu96`, `history-exemption`, `replanning`, `explain` 등) 236건(2026-11-13 실행) | 회귀 고정 | 건별로 옮기고 원장에 대응을 적는다(§7.5) |
| `performance.test.ts` | 작업 50 / 14일 / 3정책 | criterion 없이 단순 시간 측정 테스트(의존성 최소) |

성능 목표: 06 §11의 "작업 50 / 14일 / 3정책 p95 < 500 ms"를 그대로 관문으로 두고, 추가로 **같은 입력에서 TypeScript 엔진보다 느리지 않을 것**(p95 비율 ≤ 1.0). 실측은 RC-32에서 한다. 수치는 그때 이 절에 적는다.

### 5.5 스케줄러 테스트 대응과 단계별 결과

TypeScript 테스트 파일 → Rust 테스트(스케줄러 크레이트의 원장. `core/PARITY.md`가 생기면 이 표를 그대로 옮긴다).

| TypeScript (`packages/scheduler/test`) | Rust (`core/crates/scheduler`) | 상태 |
|---|---|---|
| `slots.test.ts`(5) | `tests/slots.rs` — 슬롯 단언 5건 + 기준 동작을 고정한 3건(예외 종류별 효과, 약속·잠금 블록 빼기와 그리드 정렬, 읽을 수 없는 입력이 오류가 되는 지점) | 슬롯 부분 옮김(RC-30). 같은 블록의 `validate` 단언은 RC-31 |
| `transitions.test.ts`(17) | `tests/transitions.rs` — 슬롯·1분 오라클 단언 9건(고정 7개 표는 한 테스트), `time::tests::a_runaway_transition_walk_stops_at_the_guard`(전환 4096개 상한) | 슬롯·분 오라클 부분 옮김(RC-30). `validate` 코드 단언과 validator 쪽 상한은 RC-31 |
| `minuteOracle.ts` | `tests/support/minute_oracle.rs` — `jiff`의 로컬 시각 변환만 쓰는 1분 단위 오라클(크레이트의 분할·투영 코드를 쓰지 않는다) | 옮김(RC-30) |
| 나머지 19개 파일 | — | RC-31~33 |

| 단계 | 팩 | 층별 비교 수 → 불일치 | Rust 테스트(스케줄러) |
|---|---|---|---|
| RC-00 | sample 27건 | 원시값·`inputHash`·`resultHash` → 0 | 단위 19 + 오라클 8 |
| RC-30 | sample 27건 + 시드 20261113의 2,015건(golden 15, 생성 1,260, 재계획 407, 잘못된 입력 333; 후보 feasible 2,005 / infeasible 2,169) | 원시값 1,214(prng 260, canonical 108, instants 300, zones 108, dates 112, clocks 46, sessions 222, partitions 58) → 0 · 입력 왕복 2,042 → 0 · `inputHash` 4,216(후보) → 0 · `slots` 2,042건(구간 25,881개, 읽을 수 없어 `null`인 입력 64건 포함) → 0 | 단위 49 + 오라클 15 + `slots` 8 + `transitions` 8 |

## 6. 영역별로 Rust에서 필요한 것

크기는 지금 TypeScript 구현의 줄 수(테스트 제외)다. 포팅 분량을 가늠하는 용도다.

### 6.1 계획(Plan)·가용 시간·약속 — RC-20, RC-40

- 대상: `plan-service`(1,139) + `pg-planning-store`(1,536) + `rrule`(452) + `session-bounds`(66).
- 필요한 것: 반복 약속 전개(`rrule.ts`를 그대로 포팅 — 외부 RRULE 크레이트를 쓰면 전개 결과가 달라질 수 있다), `assembleScheduleInput`(저장된 데이터 → `ScheduleInput`), `schedulingSessionBounds`(FU-96 자동 분할), 승인 트랜잭션.
- 쉬워지는 것: 승인 원자성(08 §2.4의 6단계)이 `BEGIN IMMEDIATE` 하나다. `SELECT … FOR UPDATE`, EXCLUDE 위반 잡기(`23P01`), 동시 승인 경합 처리가 없다. 겹침 검사는 같은 트랜잭션의 조회다.

### 6.2 Today·세션·알림 — RC-50

- 대상: `today-service`(831) + `pg-today-store`(712), `session-service`(321) + `pg-work-session-store`(307), 알림(약 250).
- 필요한 것: 60초 틱의 알림 생성(블록 시작 10분 전, `dedupe_key = session_reminder:<blockId>:<startAt>`), Today 제안 만료.
- 새로 필요한 것: 알림이 "보낼 때가 됨"을 셸에 알리는 프로세스 안 채널(셸이 OS 알림을 띄운다), 아침 요약 알림.

### 6.3 재계획·추정 — RC-60

- 대상: `replan-service`(819) + `pg-replan-store`(1,079) + 감지(301), 추정 `domain/estimation`(503) + 서비스·저장소(790).
- 필요한 것: 5분 주기 감지 작업, 24시간 억제, 하루 제안 상한. 추정 통계는 실수 계산이지만 저장·표시용이라 TypeScript와 비트 단위로 같을 필요는 없다 — 대신 같은 입력에서 계약 필드가 같은지 fixture로 고정한다.
- 쉬워지는 것: 리더 잠금 없음, owner 순회 없음.

### 6.4 LLM — RC-70a(크레이트), RC-70b(연결)

- 대상: `packages/llm/src` 약 6.0k. 큰 덩어리: 마스킹 `privacy.ts`(1,477), 노트 맥락 `note-context.ts`(545), 클라이언트 `openai-compatible-llm.ts`(417), 구조화 호출 `run-structured.ts`(354), 출력 계약 `output-contract.ts`(332), 지출 원장 `spend-ledger.ts`(301), 동의·예산 게이트 `policy-llm.ts`(287).
- 프롬프트·스키마는 지금 파일이 단일 소스로 남는다: `packages/llm/prompts/<purpose>/vN.md`(7종 11개)와 `packages/llm/schemas/*.json`(8개)을 `include_str!`로 넣는다. 등록 목록이 `prompts.generated.ts`·`schemas.generated.ts`와 같은지 테스트로 고정한다.
- JSON 스키마 검증: 요청 검증에 이미 쓰는 `jsonschema` 크레이트. 출력은 스키마 검증을 통과한 뒤에만 proposal로 저장한다(규칙 유지).
- HTTP 클라이언트: OpenAI 호환 Chat Completions 한 종류(게이트웨이 주소·모델은 설정). 타임아웃, 429/5xx 재시도 2회, 연결 끊김 시 중단, `x-opencode-session` 헤더(ADR-022 보강 2)를 유지한다. HTTP·TLS 크레이트는 RC-70a에서 고른다 — TLS 라이브러리는 허용 목록 밖 라이선스일 수 있어 사용자 확인 대상이다(§9.4, §11 Q4).
- 마스킹(ADR-019)은 가장 위험한 포팅이다. 방법은 스케줄러와 같다: TypeScript `redact`를 ADR-019의 A/B 퍼징 코퍼스에 돌린 결과를 오라클 팩으로 내보내고(`packages/llm/scripts/export-masking-oracle.mts`, RC-70a) Rust 출력이 구간·라벨까지 같아야 한다. 정규화(NFKC)는 `unicode-normalization` 크레이트. Rust `regex`에는 lookbehind가 없으므로 첫날에 패턴 목록을 대조해 손으로 쓸 스캐너 범위를 확정한다(§11 R4).
- 예산: `llm_spend` 예약 → 호출 → 정산을 정수 마이크로달러로. 시작 스윕이 오래된 예약을 `recovered`로 정산한다.
- 동의: `owner.settings.llm.consent`. 동의가 없으면 호출하지 않는다. 고지 문구(05 §12)는 웹에 그대로.
- 테스트는 FakeLlm과 녹화 fixture만. 실제 호출 스모크는 coordinator가 수동으로 한다(지금 규칙과 같다).
- 쉬워지는 것: 키는 키링에서 읽는다(`LLM_API_KEY_FILE` 권한 검사·부팅 거부 로직 없음). 키가 없으면 수동 모드(`llm_unavailable`)가 정상 상태다.

### 6.5 인테이크·말로 적기 — RC-70b

- 대상: `intake-service`(2,020) + 도메인 `intake/*`(676) + 저장소(약 800), `commitment-parse`·`task-parse` 서비스(409), `nl-read`(289).
- 필요한 것: 상태 기계(도메인 순수 함수 포팅), 질문 계획, 긴 호출의 대기·취소·재개 규칙(08 §2.3.1) — pending 멱등 기록, 프로세스 안 실행 레지스트리, 종료 시 `ai_interrupted`.
- 쉬워지는 것: **초안 승인이 한 트랜잭션**이다. 작업 N개·의존 관계·추정을 한 번에 쓴다. ADR-020의 세션 잠금, 단계 원장, 승계 대기, 요청 단위 펜싱, 고아 마커 조회, 롤백 억제가 전부 사라진다(`intake_approval*` 테이블 제외). 재시도는 `Idempotency-Key`가 맡는다.

### 6.6 Google 캘린더 — RC-90

- 대상: 약 3.5k(`google-calendar-service` 1,026, 저장소 837, HTTP 482, 포트 391, 가져오기 256, 내보내기 195 등).
- 유지: scope 3개, 전용 "OhMyDate" 캘린더, 창 단위 전체 목록 가져오기, 결정적 이벤트 id + fingerprint, 호출 타임아웃·백오프·실행 상한, `lastError` 닫힌 코드, 나가는 호스트 고정(ADR-024 그대로).
- 바뀌는 것 — OAuth 리디렉션: 지금은 웹 출처의 고정 경로(`http://127.0.0.1:5180/api/v1/integrations/google/callback`)와 같은 owner의 세션 쿠키가 필요하다. 데스크톱에서는 **앱이 연 loopback 주소**로 받는다. 동의 화면은 시스템 브라우저가 연다(셸이 `xdg-open`). 콜백 요청은 시스템 브라우저에서 오므로 실행 토큰이 없다 → `state`(256비트, 1회용, 10분)만으로 받아들이고, 응답은 "앱으로 돌아가세요" 정적 페이지다. 임의 포트를 쓰려면 Google Cloud의 OAuth 클라이언트가 "데스크톱 앱" 종류여야 한다(사용자 작업, §11 Q2). 대안은 지금의 "웹 애플리케이션" 클라이언트를 그대로 쓰고 동의하는 동안만 등록된 고정 포트를 여는 것이다.
- 바뀌는 것 — 토큰: refresh token을 키링에 둔다. AES-256-GCM 봉투와 키 파일이 없어진다. 키링 항목이 사라지면 `needs_reauth`.
- 쉬워지는 것: owner 순회·리더 잠금 없음, 동기화 직렬화는 뮤텍스 하나, 넛지는 커밋 뒤 직접 호출.

### 6.7 노트 — RC-80

- 대상: `notes-service`(268) + `pg-note-store`(566) + 도메인 `notes/document`(307) + LLM `note-context`(545).
- 필요한 것: FTS5 색인과 트리거, 질의 정규화(NFKC·소문자·토큰 8개·접두 일치 — 지금 규칙), AI 근거 구간 선택과 `note_ai_usage` 기록, 승격.
- 쉬워지는 것: 승격할 설명이 로컬 텍스트라 HTML 변환기가 필요 없다(가져올 때 한 번 변환한다, §8.2).

### 6.8 백그라운드 작업

지금: 알림 60초, 재계획 감지 5분, 내보내기 청소 5분, 로그인 세션 스윕 10분, Google 동기화 5분, Vikunja 재조정 5분 — 대부분 advisory lock 리더. Rust: 프로세스 안 스케줄러 하나(tokio 타이머)가 `Clock` 기준으로 "지금 할 일"을 돌린다. 재조정과 로그인 세션 스윕은 없어지고, 멱등 기록 청소·백업·아침 요약이 추가된다. 커밋 뒤에 해야 하는 반응(내보내기 넛지 등)은 outbox 테이블 대신 프로세스 안 채널로 보내고, 놓친 것은 주기 작업이 따라잡는다(지금 Google 넛지가 그렇게 동작한다, 08 §5).

### 6.9 멱등 (지금 있음)

TypeScript: 키 예약(pending) 커밋 → 유스케이스 실행 → 완료 기록 + outbox가 별도 트랜잭션. 사이에 죽으면 pending이 남아 정리 로직이 필요하다. Rust: **키 조회 + 변경 + 응답 저장이 한 트랜잭션**(`App::mutate_idempotent`). 죽으면 셋 다 없던 일이 된다. 409/422 도메인 결과는 savepoint로 변경만 되돌리고 응답은 저장한다. pending 상태는 LLM을 부르는 긴 요청에서만 쓰고, 프로세스가 시작할 때 전부 해제한다.

## 7. 테스트 전략

### 7.1 층

| 층 | 도구 | 무엇을 | 명령 | 상태 |
|---|---|---|---|---|
| 정적 | `cargo fmt --check`, `clippy -D warnings`, `#![forbid(unsafe_code)]`(워크스페이스 lint) | 전체 | `core:check` | 있음 |
| 단위 | `cargo test`. 동작마다 네거티브 1개 이상 | 크레이트별 | `core:check` | 있음(178) |
| 속성 | `proptest` | 스케줄러 하드 제약, DAG, 블록 겹침 불변식, 시간 | `core:check`(1,000) / 관문(10,000) | RC-30~ |
| 차분 | 오라클 팩 | 스케줄러(RC-30~33), 마스킹(RC-70a) | `core:oracle` + `cargo test` | 바닥 층 있음 |
| 계약 패리티 | `tests-core/`(vitest + ajv + `@ohmydate/contracts`), 진짜 바이너리 | operation마다 상태 코드·스키마·헤더 행렬·오류 | `core:parity` | 있음(10 operation) |
| E2E | 지금의 Playwright, 대상만 Rust 코어 | 사용자 흐름 | `e2e`(대상 선택) | RC-10~ |
| 가져오기 | 내보내기 → 가져오기 → 내보내기 | 전환 | RC-110 | 계획 |

### 7.2 계약 패리티 하네스 (지금 있음)

`tests-core/support/routes.ts`의 표에 operation 한 줄을 넣으면, `parity.test.ts`가 계약에서 메서드·경로·필수 헤더·스키마·선언된 상태 코드를 읽어 다음을 돌린다: 정상 요청(스키마 일치, `ETag` 종류), 토큰 없음 401, 다른 출처의 변경 403, `If-Match` 428/400/412, `Idempotency-Key` 400·재생·422, `If-None-Match` 304, 스키마 밖 본문·id·쿼리 400, 없는 id 404. 모든 응답은 그 operation에 **선언된 상태 코드**여야 한다. `services/api/test/conformance.test.ts`의 경우들(등록 여부, 미인증, 선언된 상태만, CSRF 없음 → 여기서는 Origin, 없는 프로젝트 404, 스키마 일치)이 들어 있다.

`coverage` 테스트가 계약의 84개 operation을 전부 찔러 보고, 코어가 서빙하는데 표에 없는 operation이 있으면 실패한다. `lifecycle.test.ts`는 ready 파일(0600), 단일 인스턴스(종료 코드 3), 재시작 뒤 데이터·멱등 재생, 실행마다 다른 토큰을 본다.

### 7.3 E2E를 Rust 코어로

지금 `e2e/global-setup.ts`는 PostgreSQL 스키마, Vikunja 사용자·토큰, `create-user` CLI, API(`PROVIDER=vikunja`), Vite를 띄운다. spec 13개(약 35건) 중 로그인 화면, Vikunja API 확인, DB 직접 조회(`helpers/db.ts`), 여러 owner 전환(`e2e-5-owner-reset`), `NODE_OPTIONS`로 시계 옮기기에 기대는 부분이 있다.

- RC-10: `E2E_TARGET=core` 모드. global-setup이 `ohmydate-core`를 임시 디렉터리로 띄우고 Vite 프록시가 실행 토큰 헤더를 붙인다(`--allow-origin`에 Vite 출처). 헬퍼는 "드라이버" 뒤로 옮긴다(작업 존재 확인 = API 조회). 시계는 코어의 테스트 전용 옵션 `--clock-offset-ms`로 옮긴다.
- 해당 없음으로 분류할 것(원장에 사유): 로그인·로그아웃 화면, owner 전환(`e2e-5-owner-reset` 전체), Vikunja 쪽 확인.
- 슬라이스마다 그 기능의 spec을 `core` 대상으로 통과시키는 것이 수용 기준이다(§10).

### 7.4 가져오기 왕복 — §8.4

### 7.5 패리티 원장

`core/PARITY.md`(RC-10에서 만든다): TypeScript 테스트 파일마다 한 줄 — `옮김(→ Rust 테스트 경로)` / `대체(→ 무엇)` / `해당 없음(사유)`. 오늘의 모수:

| 위치 | 파일 | 테스트(소스에서 센 어림수) | 예상 |
|---|---|---|---|
| `services/api/test` | 105 | 793 | 인증·세션·CSRF·풀·리더·Vikunja·종료 정산 일부는 해당 없음, 나머지는 옮김 또는 패리티 하네스로 대체 |
| `packages/scheduler/test` | 21 | 236(실행 결과, 속성 17개 포함) | 전부 옮김 |
| `packages/llm/test` | 20 | 267 | 평가 도구 2개 빼고 옮김 |
| `packages/domain/test` | 11 | 100 | 옮김 |
| `packages/provider-native/test`, `packages/testkit` | 4 | 계약 스위트 | `app::tasks` 테스트로 대체(RC-00에서 일부) |
| `packages/provider-vikunja/test` | 15 | 120 | 해당 없음 |
| `packages/contracts/test` | 19 | 121 | TypeScript에 남는다 |
| `e2e/tests` | 13 | 35 | §7.3 |

### 7.6 CI에 넣는 시점

- 지금: `core:check`와 `core:parity`는 `pnpm run ci`에 **넣지 않는다**(이 Task의 조건: 통합 CI는 오늘 그대로). RC Task의 "Exact tests"에 둘을 적는다.
- RC-10이 끝나면: `ci:core`(= `core:check` + `core:parity`) 스크립트를 따로 두고 병합 뒤 통합 테스트에서 함께 돌린다. `ci` 자체는 그대로 둔다(Rust 없이 웹 작업을 하는 워커가 있다).
- 전환(RC-110) 때: `ci`가 `ci:core`를 포함하고, TypeScript 코어의 테스트는 계약·웹·`packages/llm` 프롬프트 검사만 남긴다.

### 7.7 "패리티에 도달했다"의 뜻 (전환 관문)

전부 만족해야 전환한다.

| # | 기준 | 수치 |
|---|---|---|
| 1 | 계약 패리티 | 유지하는 operation **80/80**이 하네스 표에 있고 통과. 501 응답 0. 선언되지 않은 상태 코드 0 |
| 2 | 스케줄러 차분 | 생성 **10,000건** + golden 15건, `resultHash` 불일치 **0**. 회귀 팩 전부 통과 |
| 3 | 스케줄러 속성 | 속성 17개 × **10,000회**, 실패 0 |
| 4 | 스케줄러 성능 | 작업 50 / 14일 / 3정책 p95 < 500 ms, 그리고 TypeScript 대비 p95 비율 ≤ 1.0 |
| 5 | 마스킹 차분 | ADR-019 관문 코퍼스에서 구간·라벨 불일치 **0** |
| 6 | 패리티 원장 | TypeScript 테스트 파일 **100%** 분류, "옮김"은 전부 통과 |
| 7 | E2E | 해당하는 spec 전부 `core` 대상 통과, 사유 없는 skip 0 |
| 8 | 가져오기 | 실제 데이터의 드라이런 보고서에 설명되지 않은 차이 **0**, 왕복(내보내기 → 가져오기 → 내보내기) 바이트 일치 |
| 9 | 로그 | 사용자 글·비밀이 로그에 없음을 확인하는 테스트 통과(영역마다) |
| 10 | 사용자 확인 | 사용자가 자기 데이터로 며칠 써 보고 전환을 승인 |

## 8. 가져오기와 전환

### 8.1 지금의 내보내기로는 부족하다

고정 결정 9는 "옛 DB를 직접 읽지 말고 owner 내보내기(`/exports`)를 가져오라"다. 방향은 맞다. 다만 지금 내보내기(`formatVersion` 1, `PgExportPayloadBuilder`)에 든 것은 `tasks`, `projects`, `plans`(+versions, blocks), `sessions`, `reviews`, `estimationFeedback`뿐이고 다음이 빠져 있다.

| 빠진 것 | 왜 문제인가 |
|---|---|
| 작업 대부분 | `tasks`는 planner의 `task` 캐시 테이블에서 나온다. Vikunja 구성에서 이 행은 계획에 들어간 작업에만 생긴다(`ensurePlannerTaskIdentity`). 계획에 넣지 않은 작업은 내보내기에 없다 |
| 작업 설명, 의존 관계 | Vikunja와 `vikunja_planner_fields`에만 있다 |
| 약속, 가용 규칙·예외·설정, availability version | 계획의 전제 |
| 추정(`estimate`), `estimation_feedback.excluded` | 학습 데이터 |
| 목표, 템플릿, 인테이크 세션·답·초안 | 마법사 기록 |
| 노트, 연결, AI 사용 기록 | 사용자 글 |
| 재계획 제안 기록, 알림, 감사 기록 | 이력 |
| LLM 지출(`llm_spend`), `agent_run` | 이번 달 예산 누계가 0으로 돌아간다 |
| owner 설정(시간대, 로캘, 동의, 예산), Google 설정·선택 | 설정 |

그래서 **TypeScript 코어에 내보내기 `formatVersion` 2를 추가한다**(RC-110a). 기능 동결의 예외다: 읽기 전용이고, 전환에만 쓰이고, 없으면 옛 DB를 직접 읽어야 한다. 작업은 캐시 테이블이 아니라 `TaskRepository`(Vikunja 어댑터)를 거쳐 계약 `Task` 모양으로 내보낸다 — 그러면 가져오기는 Vikunja를 전혀 모른다. 비밀(refresh token, 키)은 내보내지 않는다.

### 8.2 Vikunja가 갖고 있던 것의 대응

| Vikunja / 어댑터 | 가져온 뒤 |
|---|---|
| 작업: 제목·설명·완료·마감·프로젝트 | `task` 행. id는 planner UUID 그대로(이미 자체 id를 쓰고 있어 블록·세션·추정의 참조가 그대로 맞는다) |
| 설명(Vikunja 편집기 HTML) | 내보낼 때 Markdown 텍스트로 한 번 변환한다(지금 승격 기능의 변환기). 설명 끝의 `<!-- ohmydate:<uuid> -->` 마커는 뗀다 |
| `vikunja_planner_fields.fields`(splittable, priority, status, dependsOn, session) | `task` 컬럼 + `task_dependency` 행(순서 유지) |
| 프로젝트, 기본 프로젝트 | `project` 행, 기본 프로젝트가 `kind = 'inbox'` |
| planner 캐시에는 있는데 Vikunja에는 없는 작업(휴지통·삭제) | 블록·세션이 참조하면 `deleted_at`이 있는 행으로 가져온다(FK 유지). 아니면 건너뛰고 보고서에 센다 |
| Vikunja에만 있는 것: 반복 설정, 라벨, 댓글, 첨부, 알림 | 계약·도메인에 없는 정보라 가져오지 않는다. 드라이런 보고서가 있는 경우 개수를 적는다 |
| `vikunja_mapping`, 저널, 계정, ETag | 버린다 |

가져오지 않는 planner 데이터: `auth_session`, `idempotency_record`, `outbox_event`, pending 상태의 Today·재계획 제안과 억제 기록(24시간 안에 만료), 예약만 된 알림(다시 만들어진다), Google에서 가져온 약속·종일 일정·내보내기 매핑(첫 동기화가 다시 만든다 — 이벤트 id가 결정적이라 중복되지 않는다, ADR-024 §5).

### 8.3 드라이런 보고서

`ohmydate-core import --dry-run <export.json>`은 아무것도 쓰지 않고 사람이 읽는 보고서와 JSON을 낸다.

- 엔터티별 개수: 내보내기에 있는 수 / 가져올 수 / 건너뛸 수와 사유.
- 불변식 검사: 활성 블록 겹침, 의존 순환, 참조가 끊어진 행, 활성 세션 2개 이상, inbox 개수.
- 변환 기록: 변환된 설명 수, 잘라낸 필드, 알 수 없는 enum 값.
- 가져오지 않는 것의 목록(8.2).
- 종료 코드: 차이가 전부 설명되면 0, 아니면 1.

### 8.4 검증과 왕복

1. 가져온 뒤 Rust 코어의 API로 전부 다시 읽어, 내보내기의 계약 모양 값과 엔터티별 정규 JSON SHA-256을 비교한다.
2. Rust 코어의 내보내기(v2) → 새 파일에 가져오기 → 다시 내보내기가 바이트 단위로 같아야 한다.
3. 같은 `ScheduleInput`(가져온 데이터로 조립)에서 Rust 스케줄러의 후보가 TypeScript 코어의 후보와 같은지 한 번 대조한다(`inputHash`와 블록).

### 8.5 전환 절차와 롤백

1. 리허설: 실제 데이터의 내보내기 v2로 드라이런 → 임시 디렉터리에 가져오기 → 사용자가 데스크톱 앱(리허설 프로필)으로 확인. 차이가 없을 때까지 반복한다.
2. 전환일: 옛 앱 사용을 멈춘다 → 내보내기 v2 → `local:stop` → 가져오기 → 검증(8.4) → 데스크톱 앱 사용 시작.
3. 옛 스택(PostgreSQL 볼륨, Vikunja 볼륨, `deploy/secrets`)은 **건드리지 않고** 30일 둔다. 가져오기는 내보내기 파일만 읽으므로 옛 데이터를 바꾸지 않는다.
4. 롤백: 데스크톱 앱을 끄고 `local:start`. 옛 데이터는 전환 시점 그대로다. 전환 뒤 데스크톱 앱에서 한 변경은 옛 스택으로 돌아가지 않는다 — 그래서 리허설(1)을 충분히 한다.
5. 30일 뒤 사용자 승인으로 옛 인프라와 TypeScript 코어(`services/api`, `packages/provider-*`, `scripts/local`, `deploy`)를 지운다.

## 9. 패키징과 배포 (리눅스)

Tauri 셸을 이 Task에서 빌드해 보지 못했으므로(시스템 패키지 없음) 이 절의 셸 관련 내용은 **[미검증]**이고 RC-100a가 확인한다.

### 9.1 산출물

| 형식 | 용도 | 비고 |
|---|---|---|
| `.deb` | 사용자 기계(Ubuntu) 기본 | WebKitGTK 4.1, 트레이용 appindicator 라이브러리에 의존 [미검증: 정확한 패키지 이름] |
| AppImage | 다른 배포판, 설치 없이 실행 | 크기가 크다 [미검증] |

바이너리에 들어가는 것: 코어(SQLite·tzdb·계약·프롬프트·스키마 포함), 웹 빌드(`apps/web/dist` — 코어가 같은 출처로 서빙). 런타임에 Node·PostgreSQL·docker가 필요 없다.

### 9.2 데이터 위치 — §1.6

### 9.3 업그레이드와 마이그레이션 정책

- 스키마는 전진만 한다. 앱을 시작할 때 자동 적용한다.
- 올리기 전에 `ohmydate.db.pre-v<N>` 사본을 뜬다(**있음**). 최근 3개를 남긴다(RC-100).
- 새 버전이 만든 파일을 옛 버전으로 열면 열기를 거부하고 이유를 보여 준다(**있음**: `NewerSchema`). 되돌리려면 사본으로 바꾼다.
- 이미 배포한 마이그레이션 파일은 고치지 않는다. 체크섬이 다르면 열기를 거부한다(**있음**).
- 계약(`openapi.json`)과 웹 빌드가 같은 바이너리에 들어가므로 "웹과 코어의 버전 불일치"가 생기지 않는다.
- 내보내기 형식은 `formatVersion`으로 구분하고, 가져오기는 자기가 아는 버전만 받는다.

### 9.4 라이선스

AGENTS.md 규칙(MIT / Apache-2.0 / BSD / ISC는 검토 없이)에 비춘 현재 의존성은 `10-LICENSE-AND-MIGRATION.md` §9에 적었다. 요약: 크레이트 126개 중 허용 목록 밖은 `foldhash`(Zlib), `borrow-or-share`(MIT-0), `unicode-ident`(Unicode-3.0 병기, 빌드 때만), 그리고 크레이트가 아닌 포함물 SQLite·IANA tzdb(퍼블릭 도메인). 모두 허용적 라이선스이고 사용자 확인 대상으로 올린다. TLS 라이브러리는 RC-70a에서 정한다.

## 10. 단계 계획

각 Task는 사용자가 돌려 볼 수 있는 것으로 끝난다(B 레인의 순수 크레이트 Task는 오라클 수치로 끝나고, 사용자에게는 RC-40에서 보인다). 워커는 최대 2명: **A 레인**(저장·API)과 **B 레인**(순수 크레이트·셸)이 서로 다른 크레이트를 만지므로 같이 갈 수 있다.

```text
RC-00 ─┬─► RC-10 ─► RC-20 ──────────┬─► RC-40 ─► RC-50 ─┬─► RC-60 ─────────► RC-90 ─┐
 (완료) │   (A)      (A)             │    (A)      (A)   │    (A)              (A)   │
        │                            │                   │                           ├─► RC-110b ─► 전환
        ├─► RC-30 ─► RC-31 ─► RC-32 ─┘─► RC-33 ──────────┘                           │
        │   (B)      (B)      (B)        (B)                                         │
        ├─► RC-05 (B, 짧음)   RC-70a (B, RC-33 뒤) ─► RC-70b (A, RC-40 뒤) ─► RC-80 ─┤
        └─────────► RC-100a (B, RC-10 뒤, 사용자 준비 필요) ─────► RC-100b (B, RC-50 뒤)┤
                                              RC-110a (A/B 빈 틈, RC-40 뒤) ─────────┘
```

| Task | 레인 | 범위 | 의존 | 수용 테스트 | 사용자가 해 볼 수 있는 것 | 주된 위험 |
|---|---|---|---|---|---|---|
| RC-00 | — | 이 문서, ADR-025, 골격(owner·프로젝트·작업 10 operation), 패리티 하네스, 오라클 내보내기 | — | `core:check`, `core:parity` | `ohmydate-core`를 띄워 curl로 작업 만들기 | — (완료) |
| RC-05 | B | 지금 E2E를 Playwright의 WebKit 엔진으로 TypeScript 스택에 돌려 본다(코드 변경 없음, 보고서만) | — | 실패 목록 보고서 | — | WebKit에서 깨지는 웹 기능을 일찍 안다(R1) |
| RC-10 | A | `updateMySettings`, 웹 정적 파일 서빙 + `/__boot`, 개발 실행(`core:dev`: 코어 + Vite 프록시), E2E `core` 대상과 드라이버, `--clock-offset-ms`, `core/PARITY.md`, Ajv ↔ `jsonschema` 스키마 판정 대조 도구, `ci:core` | RC-00 | 패리티 11 operation, `e2e-1`(로그인 부분 제외)·a11y inbox가 `core` 대상 통과, 원장 초판 | 브라우저에서 Rust 코어로 인박스 쓰기 | E2E 헬퍼 개조 범위(R7) |
| RC-20 | A | 가용 시간·약속·`rrule` 포팅·availability version·`listCalendarDayEvents`(빈 목록) | RC-10 | 패리티 +7, `rrule.test.ts` 옮김, 약속 화면 E2E 부분 | 약속·가용 시간 화면 | 반복 전개의 DST 경계 |
| RC-30 | B | 스케줄러 `types`·`time` 나머지·`slots`·`sessions`·`requirements`, 큰 팩 읽기, `sort_unstable`·`HashMap` 순회 금지 lint | RC-00 | 2,000건에서 `slots` 불일치 0, `slots.test`·`transitions.test` 옮김 | — | tzdata 차이(R3) |
| RC-31 | B | `codes`·`validate`·`validateInput`·`explain`, `sched-diff` CLI, `shrink-oracle.mts` | RC-30 | 2,000건에서 `inputIssues`·`validation` 불일치 0, validator ↔ 분 단위 오라클 속성 | — | validator 1,407줄의 독립 구현 유지 |
| RC-32 | B | `policies`·`generate`(새 계획)·지표·설명 문장·다양성 | RC-31 | 재계획 아닌 건 `resultHash` 불일치 0(2,000), golden 통과, 속성(H1–H8) 1,000회, 성능 실측 | — | 실수·정렬 순서의 정확한 재현(R2) |
| RC-33 | B | 재계획(범위·시드·단계 확장)·빈틈 맞춤(FU-69)·FU-96 | RC-32 | 전 건 불일치 0(2,000), 재계획 속성, `fu41`·`fu69`·`fu96` 옮김 | — | 상한 있는 탐색의 순회 순서 |
| RC-40 | A | 계획 8 operation, `assembleScheduleInput`, 승인 트랜잭션, 겹침 불변식, 추정 테이블, 감사 기록 | RC-20, RC-32 | 패리티 +8, `planning.test`·`block-lock.test` 옮김, `e2e-3-plan` `core` 대상, 같은 데이터에서 TypeScript API와 후보 일치 | 일정안 만들기·비교·승인 | `plan-service` + 저장소 2.7k의 규칙 누락 |
| RC-110a | A/B | TypeScript 코어에 내보내기 v2, 가져오기 골격과 드라이런(그때까지 있는 테이블만) | RC-40 | 합성 데이터 왕복, 실제 데이터 드라이런 보고서 | 내 데이터가 어떻게 옮겨지는지 보고서로 보기 | 내보내기에 빠진 것(R9) |
| RC-50 | A | Today 5 + 세션 7 + 알림 2 operation, 알림 틱, 읽기 연결 필요성 실측 | RC-40 | 패리티 +14, `today-api`·`sessions`·`daily-*` 옮김, `e2e-4-today` | 오늘 화면·집중 세션 | 절전 뒤 타이머 |
| RC-60 | A | 재계획 5 + 추정 3 operation, 감지 작업 | RC-50, RC-33 | 패리티 +8, `replanning*`·`estimation-*` 옮김, `e2e-5r-replan` | 재계획 제안·패턴 화면 | 감지 조건의 시간 의존 |
| RC-70a | B | `ohmydate-llm`: 등록, 마스킹 + 오라클, 예산, 구조화 호출, FakeLlm. HTTP·TLS 크레이트 결정 | RC-33(레인이 빌 때) | 마스킹 코퍼스 불일치 0, `packages/llm/test` 옮김 | — | 마스킹(R4), TLS 라이선스(R5) |
| RC-70b | A | 키링, LLM 클라이언트 연결, 말로 적기 2 + 인테이크 11 + 템플릿 2 + 목표 1 operation, 긴 호출 규칙 | RC-70a, RC-40 | 패리티 +16, `intake*`·`*-parse*` 옮김, `e2e-2-wizard`·`e2e-7`·`e2e-8`·`e2e-ai-wait` | 말로 적기·마법사 | 키링이 없는 환경(R6) |
| RC-80 | A | 노트 9 operation, FTS5, AI 근거, 승격 | RC-70b | 패리티 +9, `notes*` 옮김, `e2e-6-notes` | 노트 | 검색 결과 집합의 동등성 |
| RC-90 | A | Google 5 operation + 종일 일정, loopback OAuth, 주기 동기화, 넛지 | RC-50, RC-70b | 패리티 +5, `google-*` 옮김(가짜 Google), 로그 검사 | 폰 캘린더와 동기화 | OAuth 클라이언트 종류(R8) |
| RC-100a | B | 셸 스파이크: Tauri 창에 웹 띄우기, `/__boot`, 단일 인스턴스, 패키징 시도 | RC-10 + 사용자 준비(Q1) | 앱 창에서 인박스 동작, `.deb` 하나 | 아이콘을 눌러 앱 실행 | WebKitGTK(R1), 시스템 패키지 |
| RC-100b | B | 트레이, OS 알림, 자동 시작, 백업·복원, 로그 회전, 웹의 데스크톱 모드 | RC-100a, RC-50 | 수동 체크리스트 + 셸 단위 테스트 | 창을 닫아도 알림이 온다 | 데스크톱 환경별 트레이 차이 |
| RC-110b | A | 내보내기 2 operation, 가져오기 완성, 전환 관문(§7.7) 측정, 전환 | 전부 | §7.7 표 | 내 데이터로 데스크톱 앱 사용 | 데이터 충실도(R9) |

## 11. 위험과 모르는 것

| # | 위험 / 모르는 것 | 일찍 없애는 방법 |
|---|---|---|
| R1 | 웹 앱이 WebKitGTK에서 다르게 동작한다(웹은 Chromium으로만 시험했다: `navigator.locks`, IndexedDB, `AbortSignal.any`, CSS) | RC-05: 지금 E2E를 Playwright WebKit으로 돌린다(Rust와 무관, 바로 가능). RC-100a: 진짜 WebKitGTK 창에서 스모크 |
| R2 | `generate.ts` 3,992줄을 바이트 단위로 재현하지 못한다 | 바닥 층은 이미 일치(RC-00). 층별 대조 + 최소화 도구를 생성기보다 먼저 만든다(RC-31). 불일치가 TypeScript 쪽 결함이면 TypeScript를 고치고(버그 수정은 동결 예외) 팩을 다시 만든다 |
| R3 | Node의 tzdata와 `jiff-tzdb`가 어긋난다(오늘 2026c vs 2026e) | 팩의 분할 결과가 먼저 잡는다. 생성 시나리오의 날짜는 2026–2027로 묶는다. 어긋나면 그 시간대를 보고하고 팩에서 뺀 뒤 원인을 적는다 |
| R4 | 마스킹 포팅에서 재현율이 떨어진다 | 구현 전에 오라클 팩과 관문부터(RC-70a 첫 단계). lookbehind 없는 `regex`로 안 되는 패턴 목록을 첫날 확정 |
| R5 | HTTPS에 필요한 TLS 라이브러리의 라이선스가 허용 목록 밖이다 | RC-70a 시작 때 후보별 라이선스 표를 사용자에게 올린다(Q4). 시스템 OpenSSL 사용이 대안 |
| R6 | Secret Service가 없거나 잠겨 있다 | 파일 대체(0600)와 상태 표시. RC-70b 첫 단계에서 이 기계로 확인 |
| R7 | E2E 헬퍼가 PostgreSQL·Vikunja·로그인에 깊이 묶여 있다 | RC-10에서 `e2e-1` 하나로 드라이버 구조를 먼저 증명 |
| R8 | Google OAuth 클라이언트를 바꿔야 하고 다시 동의해야 한다 | Q2로 미리 묻는다. 테스트 상태 동의 화면의 7일 만료는 그대로 남는다(ADR-024) |
| R9 | 가져오기에서 데이터가 빠진다(설명 HTML, Vikunja 전용 정보) | RC-110a를 RC-40 직후로 당겨 실제 데이터 드라이런을 일찍 돌린다 |
| R10 | 연결 하나로는 긴 읽기(내보내기, 검색)가 쓰기를 막는다 | RC-50에서 작업 1만 개 파일로 실측, 필요하면 읽기 연결 추가 |
| R11 | 동결 중에 계약이 바뀐다(웹 작업은 계속된다) | RC-10부터 계약 변경은 `packages/contracts` + Rust에만 구현한다. TypeScript API에 없는 operation은 원장에 "Rust 전용"으로 적는다. 스케줄러 입력을 바꾸는 변경은 전환 전까지 받지 않는다 |
| R12 | 노트북 메모리(15 GB)에서 cargo 빌드와 워커 2명 | `CARGO_BUILD_JOBS=4`, 워커 Task에서 release 빌드 금지, Tauri 빌드는 다른 워커가 없을 때 |
| R13 | `jsonschema`와 Ajv의 판정이 형식 경계에서 다르다 | RC-10의 대조 도구: 계약 스키마마다 생성한 표본에 두 검증기를 돌려 판정 차이를 목록으로 만든다 |

사용자에게 물어야 하는 것(사용자만 정할 수 있는 것):

- **Q1 시스템 패키지**: 셸을 빌드하려면 WebKitGTK 개발 패키지 등을 `sudo`로 설치해야 한다(워커는 `sudo` 금지). RC-100a 전에 설치해 줄 수 있는지, 정확한 목록은 RC-100a 패킷이 적는다.
- **Q2 Google OAuth 클라이언트**: Google Cloud에서 "데스크톱 앱" 종류의 클라이언트를 새로 만들지(권장: 임의 포트로 받을 수 있다), 지금의 "웹 애플리케이션" 클라이언트를 고정 포트로 계속 쓸지.
- **Q3 배포와 업데이트**: `.deb`만으로 충분한지, AppImage도 필요한지. 자동 업데이트를 원하는지(서명 키와 올려 둘 곳이 필요하다).
- **Q4 라이선스 확인**: §9.4의 허용 목록 밖 4건(모두 허용적)과, RC-70a에서 올릴 TLS 라이브러리.
- **Q5 옛 데이터 보관 기간**: 전환 뒤 PostgreSQL·Vikunja 볼륨을 30일 두는 안.
