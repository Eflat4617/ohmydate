# 13. Architecture Decision Records

> 상태: `Proposed`(D0, 사용자 승인 대기) → `Accepted` → `Superseded`. 변경 시 새 ADR로 대체하고 영향 Task 재평가.

| ADR | 제목 | 상태 |
|---|---|---|
| 001 | 초기 방식 B: 얇은 Vikunja 포크 + 자체 UI/API | Proposed (GA-1) |
| 002 | services/api = TypeScript 모듈러 모놀리스 | Proposed |
| 003 | PostgreSQL 18, 분리 DB, UUIDv7, version 잠금, SQL 마이그레이션 | Proposed |
| 004 | TaskRepository 포트 + ExternalProviderMapping, task core SoR 단계적 이동 | Proposed |
| 005 | 계약 단일 소스: TypeBox → OpenAPI 3.1 → 생성 클라이언트 | Proposed |
| 006 | 스케줄러: 결정론 휴리스틱 + 독립 validator, CP-SAT 트리거 기반 | Proposed |
| 007 | 이벤트: outbox + 재조정, 웹훅은 힌트, 브로커 없음 | Proposed |
| 008 | 제품 LLM: LlmPort, 스키마 검증, proposal-only, 공급자 미정 | Proposed (GB-1) |
| 009 | 적응형 UI: 규칙 기반 정책 + LayoutSpec allowlist | Proposed |
| 010 | 오프라인: 캐시 읽기 + Focus 로컬 기록만 | Proposed |
| 011 | 인증: planner 로컬 계정 + Vikunja 서비스 토큰, Tailscale 전용 | Proposed |
| 012 | 알림: Web Push(PWA) + 인앱, dedupe 키 | Proposed |
| 013 | 개발 런타임: rootless 컨테이너, docker 그룹 가입 금지 | Proposed (GD-1) |
| 014 | 개발 에이전트 바인딩·OpenCode 설정 고정 | Proposed (GM-1) |
| 015 | 디렉터리·라이선스 구역 | Proposed |
| 018 | Inbox 프로젝트 식별: Project.kind | Accepted (구현 FU-18) |
| 017 | 스케줄러 시간 분할: 전환-구간 기반 로컬 날짜 계산 (M3-01R3 결과) | Accepted |
| 016 | VikunjaTaskRepository 동시성·멱등 보정 (M0-03 결과) | Accepted (Sol 리뷰로 사실 재확인 조건) |

---

## ADR-001 초기 방식 B
- **맥락:** 사용자 의도 = 포크 + UI 대수정, 장기 = 독립 제품. Vikunja는 월 단위 릴리스(v2.4→v2.8, 2026-07~11), v1 API 제거 예정, AGPL.
- **결정:** Vikunja v2.8.0 태그를 포크해 `upstream/vikunja` 서브모듈로 고정(패치 예산 초기 0). 사용자 UX는 자체 `apps/web`에서 **전면 신규 UI**로 구현하고, 기능 로직은 `services/api`에. Vikunja는 API v2로만 접근.
- **대안:** A(광범위 포크 수정) — 병합 비용·교체성·라이선스 파급으로 기각. C(포크 없음) — 의도 불일치, 단 B에서 패치 0이면 사실상 C와 같은 비용이라는 장점 공유.
- **결과:** 초기 UI 골격 비용 증가. Vikunja 기본 UI는 관리/폴백. 패치가 필요한 경우(예: API에 필드 노출) 포크에서 처리하고 `PATCHES.md` 기록.
- **재검토 트리거:** 사용자가 Vikunja UI 자체 개조를 명시적으로 원함(GA-1 거부) → A' (Vikunja frontend 개조 + 동일 API 포트 유지) 계획으로 전환.

## ADR-002 TypeScript 모듈러 모놀리스
- **결정:** Node 24 + Fastify + TypeScript strict, 단일 프로세스(HTTP + jobs). 패키지 경계로 모듈화, `dependency-cruiser`로 계층 강제(domain은 I/O import 금지).
- **근거:** 프런트와 타입·스키마 공유, 노트북에 Node 24 설치됨, 16GB 서버 단순 운영, 워커에게 단일 언어.
- **대안:** Go(Vikunja 동일 언어, 기각: 타입 공유 불가·결합 유혹), Python 서비스(CP-SAT 필요 시 추가), 마이크로서비스(기각).

## ADR-003 데이터
- PostgreSQL 18(Vikunja CI 테스트 버전과 일치) 단일 인스턴스, DB `planner`/`vikunja` 분리, 계정 분리.
- 쿼리: Kysely(타입 안전 SQL 빌더) + 순수 SQL 마이그레이션 파일. ORM 매직 회피(리뷰 용이).
- UUIDv7, owner_id 필수, version 컬럼, soft delete, UTC 저장 + IANA tz.

## ADR-004 TaskRepository 포트
- 도메인 Task 타입은 provider 무관. `VikunjaTaskRepository`·`NativeTaskRepository`·`InMemoryTaskRepository`가 동일 계약 스위트 통과.
- 초기 task core SoR = Vikunja, planner 확장 필드는 planner DB. 전환은 freeze-and-import.
- planner는 Vikunja DB에 직접 접근하지 않음.

## ADR-005 계약 단일 소스
- TypeBox 스키마 → Fastify 런타임 검증 + OpenAPI 3.1 산출(`packages/contracts/openapi.json` 커밋) → web 클라이언트 생성. 같은 JSON Schema 기술로 LLM 출력 검증(Ajv).
- CI: 생성물 재생성 diff 0, 파괴적 변경 감지(oasdiff 류 [가정]) 시 ADR 필요.

## ADR-006 스케줄러
- 결정론 휴리스틱 + 독립 validator + golden + property. CP-SAT는 06 §1 트리거 충족 시 ADR로 도입(Python 사이드카 후보). 병렬 구현 금지.

## ADR-007 이벤트
- outbox + in-process dispatcher + advisory-lock 리더 + 주기 재조정(5분) + 웹훅 힌트(HMAC, inbox dedupe, 재조회). 브로커 도입 트리거: api 2개 이상 프로세스 또는 처리 지연 SLA 미달.

## ADR-008 제품 LLM
- LlmPort + 프롬프트 파일 버전 + Ajv 스키마 + FakeLlm. 공급자 선택은 GB-1. 기본 예산 상한 없으면 실제 호출 비활성.

## ADR-009 적응형 UI
- 규칙 기반 `ui-policy`(순수 함수, 단위 테스트), LayoutSpec JSON allowlist, hysteresis, 사용자 override 최우선. AI 제안은 M6 이후 선택 기능.

## ADR-010 오프라인
- Service Worker 캐시 읽기 + 오프라인 편집 비활성, Focus 세션만 로컬 기록 후 멱등 업로드. 편집 큐는 M8 재평가.

## ADR-011 인증
- planner 로컬 계정(argon2id) + 세션 쿠키 + CSRF. Vikunja는 서비스 API 토큰(최소 scope, 서버 측 보관). 외부 노출은 Tailscale 전용. 상용 시 OIDC.

## ADR-012 알림
- 인앱 + Web Push(VAPID). `notification.dedupe_key = kind:entity:scheduledMinute`. 재부팅 후 누락 알림은 1건으로 합침. Android 품질 미달 시 네이티브 셸 ADR.

## ADR-013 개발 런타임
- **사실:** 사용자 `torgal`은 docker 그룹이 아님, 소켓 접근 거부, Go/pnpm/PG 미설치.
- **결정 제안:** docker 그룹 가입 금지(루트 동등 권한을 에이전트가 상속하므로). PG·Vikunja 실행은 rootless Podman/Docker(사용자 승인 설치, GD-1). Vikunja는 공식 **서명 릴리스 바이너리/이미지 v2.8.0** 사용(포크 빌드는 패치 발생 시에만 → Go 설치도 그때).
- 대안: 네이티브 PostgreSQL apt 설치(sudo 필요, 에이전트 sudo 금지 → 사용자가 직접 실행).

## ADR-014 개발 에이전트 바인딩
- **사실(로컬 Orca 1.4.255 `worker-start --help`):** OpenCode는 `--effort` 미지원, `--model`은 기존 worktree에서만. Codex/Claude는 `--model`·`--effort` 지원. (온라인 문서는 OpenCode effort 지원으로 기술 → 로컬 CLI 우선.)
- **결정 제안:** DeepSeek 워커는 저장소 루트 `opencode.jsonc`에서 `model: "opencode-go/deepseek-v4.1-flash"` + reasoningEffort `high`를 고정하고, `worker-start --agent opencode`(모델 플래그 없이). Sol은 `--agent codex --model gpt-6.1-sol --effort high`(사용자 Codex 기본값이 `gpt-6-sol`이므로 **명시 필수**). 프로브로 실효값 확인, 불일치 시 BLOCKED_MODEL_UNAVAILABLE.

## ADR-015 디렉터리·라이선스 구역
- 03 §4 구조. `[OWN]` ↔ `upstream/` 경계 CI 검사, `PATCHES.md`, 서드파티 라이선스 allowlist.

## ADR-016 VikunjaTaskRepository 동시성·멱등 보정
- **맥락(M0-03 실측, 2026-11-11):** Vikunja v2.8.0은 ETag를 내주지만 PUT/PATCH에서 stale `If-Match`를 거부하지 않음(200), `Idempotency-Key` 무시(중복 생성), 목록 `updated`는 초 단위, 삭제 작업은 `/tasks/deleted`에서만 보이며 since 필터 없음, 완료 동사 없음(`done:true`), 반복 작업 완료 시 서버가 재오픈·날짜 이동. 근거: `docs/blueprint/vendor/vikunja-v2.8.0-capabilities.md`.
- **결정:**
  1. planner DB `external_provider_mapping`에 `external_etag`, `external_updated_at`, `local_version`을 두고 **planner가 version의 SoR**. 어댑터 update = (a) GET 현재 ETag (b) mapping의 ETag와 다르면 `VersionConflict` (c) 쓰기 (d) 새 ETag 저장. (a)–(c) 사이 경쟁 창이 남는다 → **보장 수준: "최선 노력 충돌 감지", 완전한 lost-update 방지 아님**을 계약 문서·테스트에 명시.
  2. 멱등: planner `idempotency_record`가 Vikunja 호출 **이전**에 키를 예약(상태 pending) → 성공 시 외부 ID 저장. 크래시로 pending이 남으면 재조정이 제목+생성시각+planner UUID 마커(설명 끝 HTML 주석 `<!-- ohmydate:<uuid> -->` [가정, Sol 리뷰 대상])로 고아 Vikunja task를 찾아 연결.
  3. `listChangedSince`: 커서 = `(updated_seconds, externalId)`; `updated >= cursor_seconds`로 겹치게 조회 후 ETag 비교로 중복 제거. 삭제는 `/tasks/deleted` 전체 비교(단일 사용자 규모에서 허용) .
  4. `complete`: `done:true` PATCH. 반복 작업은 M1에서 **planner 측 완료 이벤트를 SoR**로 기록하고 Vikunja의 재오픈 결과를 재조정으로 반영(테스트 케이스 추가).
  5. 오류 코드: Vikunja 숫자 코드 → planner `code` enum 매핑 테이블.
  6. API 토큰은 `/user/*` 불가 → 서비스 계정은 토큰(엔티티 작업) + 필요 시 JWT 부트스트랩.
- **계약 테스트 영향:** `VersionConflict` 테스트는 InMemory/Native는 "항상 감지", Vikunja는 "순차 시나리오에서 감지"로 구분 표기(동일 스위트, capability flag `strictConcurrency`).
- **Native 전환 트리거 강화:** 실제 사용에서 lost-update 1건 이상 관측 시 M7 앞당김 검토.

## ADR-017 스케줄러 시간 분할 알고리즘 (M3-01 재설계)
- **맥락:** M3-01 리뷰 3회에서 반복된 HIGH의 공통 원인은 "한 로컬 날짜 = 하나의 연속 UTC 구간"이라는 가정. 자정 갭(Santiago), 자정 역행(America/Goose_Bay 2009-11-01: 00:01→23:01, 같은 날짜가 두 번 나타남)에서 깨짐.
- **결정:** 모든 시간 계산(일 상한 H6, 가용 투영 slots, H2 경계 열거)은 다음 공통 원리를 따른다(구현은 slots/validator가 각자 독립 작성):
  1. 대상 UTC 구간 [a,b)를 `getTimeZoneTransition`로 얻은 **모든 오프셋 전환 시점**에서 분할 → 각 조각 내부 오프셋 일정.
  2. 각 조각에서 로컬 시각 = UTC + offset(선형). 조각을 다시 **로컬 자정(그 조각의 오프셋 기준)**에서 분할 → 각 최소 조각은 정확히 하나의 로컬 날짜에 속함.
  3. 날짜별 합계 = 같은 날짜를 가진 모든 최소 조각의 합(불연속·재방문 허용).
  4. 규칙 매칭: 최소 조각마다 그 로컬 날짜·요일 규칙의 로컬 경계를 같은 오프셋으로 UTC 변환해 교차.
- **테스트 오라클:** 1분 단위 UTC 순회(각 분의 로컬 날짜·요일·시각 판정) — 생산 코드와 다른 방식. 고정 케이스: Santiago 2026-09-06, Goose_Bay 2009-11-01, St_Johns, Lord_Howe(30분 DST), Asia/Seoul, America/New_York.
- **지원 범위:** IANA tzdb 전체(temporal-polyfill 내장). 성능: 블록당 전환 수는 작아 O(블록×전환).

## ADR-018 Inbox 프로젝트 식별
- **맥락:** FU-09R: 웹이 제목 'inbox'로 Inbox를 찾고 실패 시 범위 없는 목록으로 대체 → 잘못된 표시·누락. 계약에 Inbox 표식 없음, task.project_id nullable.
- **결정:** `Project.kind: 'inbox' | 'normal'`(계약·도메인·DB `project.kind text not null default 'normal'` + owner당 inbox 1개 partial unique). 서빙 중인 ProjectRepository가 첫 읽기/쓰기에서 Inbox를 보장(getInbox, 멱등; FU-18R2에 따라 '사용자 생성 시 생성'에서 수정). `createTask`에 projectId 없으면 owner의 Inbox로 배정(task.project_id는 NOT NULL로 강화). Vikunja 어댑터는 Vikunja의 기본 프로젝트를 Inbox로 매핑. 웹은 `kind==='inbox'`로만 찾고, 없으면 명시적 오류 상태(범위 없는 목록 대체 금지).
- **영향:** contracts(Project schema), domain(Project), migrations(0002), provider-native/in-memory, provider-vikunja, api(user create), web. → FU-18 단일 Task로 계약 우선 구현 후 소비자 반영.

## ADR-019 개인정보 마스킹 스캐너: 시작 위치 비건너뜀 + 구간 합집합 (FU-38 BLOCKED 후 재설계)
- **맥락(2026-11-11):** FU-38 2회 리뷰에서 HIGH 3건(R1: 위첨자 구간 확장 후 다음 RRN 시작 건너뜀, R2: 혼합 RRN 창이 뒤 RRN 시작 건너뜀, 짧은 전화번호 대체 후 원래 끝으로 이동해 다음 전화번호 건너뜀)이 모두 같은 원인 — **수락된 일치의 끝(또는 더 먼 끝)으로 lastIndex를 옮겨 그 안의 다른 유효 시작을 탐색하지 않음**. 증상별 수정이 새 회귀를 만들었다.
- **결정:**
  1. 각 패턴(전화·RRN·이메일·키 등)은 **모든 후보 시작 위치**를 독립적으로 탐색한다. 수락된 일치가 있어도 다음 탐색은 `start + 1`(정규화 좌표의 다음 후보 시작)에서 이어간다. 단 후보 시작은 경계 규칙을 만족하는 위치로 한정하고, 패턴당 일치 길이 상한(L_max)을 두어 전체 O(n·L_max)를 보장한다.
  2. 최종 마스킹 = 모든 패턴·모든 수락 일치 구간의 **합집합**(정규화→원문 좌표 매핑 후). 종류 라벨은 겹치는 구간에서 결정론적 우선순위(RRN > 카드/계좌 > 전화 > 이메일 > 키)로 선택한다. 구간 확장(위첨자 연속 등)은 수락 후 합집합 단계에서만 적용하며 탐색 위치에 영향을 주지 않는다.
  3. **수용 게이트(병합 조건):** 독립 A/B 퍼징에서 torgal/ohmydate(FU-32) 대비 **토큰별·핵심 글자별 재현율 회귀 0**: 단일 토큰 120k, 같은 종류 2·3 토큰, **종류 혼합 인접(RRN↔전화, 전화↔이메일/키, 3토큰 순열)**, 구분자(붙음/공백/ZWSP/ZWNJ/U+00AD), 자리별 혼합 숫자(Nd/전각/위·아래첨자). 8MiB까지 선형.
  4. 혼합 위첨자+일반 숫자 마스킹, 각주 보존 같은 정밀도 개선은 게이트를 통과할 때만 유지하고, 아니면 knownLimitations로 고정한다.
- **결과:** FU-38 브랜치(04809ca, 571ea09)는 병합하지 않는다. FU-38c가 FU-32 상태에서 새로 시작한다. GB-1 실제 제공자 연결은 FU-38c 승인 + 05 §12 최선 노력 범위·동의 고지 확정 뒤에만 가능.

## ADR-020 Intake 초안 승인 동시성: 세션별 PG 세션 잠금(리스 인계 없음) (M2-03 BLOCKED 후 재설계)
- **맥락(2026-11-11):** M2-03R2에서 60초 리스 만료 후 인계 방식이 펜싱 없이 멈춘 승인자의 재개를 허용해 Vikunja 작업이 중복(12개)됐다. 리스 갱신·세대 펜싱·단계별 CAS는 단일 사용자 개인 배포 규모에 비해 복잡하고 오류가 잦다.
- **결정:**
  1. 승인 실행 동안 **전용 PG 연결에서 `pg_try_advisory_lock(hash('ohmydate.intake.approve', session_id))`(세션 수준 잠금)** 을 보유한다. 잠금을 못 얻으면 409 `approval_in_progress`. 프로세스가 죽으면 연결이 끊겨 잠금이 자동 해제되므로 **시간 기반 인계는 없다**(lease_expires_at는 관측용으로만 유지 또는 제거). 살아 있는 승인자가 멈춰 있으면 다른 요청은 계속 409 — 단일 사용자에서 허용. 잠금 연결은 FU-33/FU-37과 같은 keepalive·오류 리스너 규칙을 따른다.
  2. 세션 변경 동작(PATCH draft, answers, type-confirmation, :pause/:resume/:cancel/:manual)은 **같은 advisory 잠금 키를 `pg_try_advisory_xact_lock`으로 자기 트랜잭션 안에서 시도**하고(실패 시 409 `approval_in_progress`), 그 트랜잭션 안에서 세션 버전 CAS를 한다. 승인은 잠금 획득 후 세션 버전을 다시 확인하고 시작한다 → "변경이 먼저 커밋되면 승인은 작업 0개로 412, 승인이 먼저 잡으면 변경은 409".
  3. 단계별 작업 ID는 **처음 저장된 `intake_approval_step.planned_task_id`만 사용**한다(재시도 시 새로 만들지 않음). 결과 불명 단계는 (a) `get(owner, plannedId)` (b) Vikunja 마커 고아 조회(삭제 목록 포함)로 해결한다. 원격 흔적이 전혀 없으면(사용자가 고아를 삭제했거나 생성 전 실패) **재생성 허용**. 사용자가 마커를 편집한 고아는 찾을 수 없어 중복이 생길 수 있음 → knownLimitation으로 문서화(단일 사용자, 승인 전 노출되지 않은 작업).
  4. 고아 채택 시 의도한 의존 관계를 Vikunja에 **실제로 기록한 뒤에만** 단계를 created로 표시하고, 관계 기록도 재개 가능해야 한다.
  5. 같은 plannedId에 대한 어댑터 수준 동시 생성은 1의 잠금으로 직렬화된다(plannedId 사용자는 승인 경로뿐). TaskRepository 계약 주석에 "호출자는 plannedId별 직렬화 책임"을 명시.
- **결과:** M2-03 브랜치(894daa5)를 기반으로 좁은 수정 Task M2-03c를 진행한다. 0006 마이그레이션은 필요 시 수정(아직 미병합이므로 0006 내용 변경 허용).
- **보강(2026-11-11, M2-03cR-1):** 프로세스가 살아 있는 채 잠금 연결만 끊기면 PG가 잠금을 풀어 두 승인자가 동시에 진행될 수 있다(11개 작업 재현). 규칙:
  6. 잠금 핸들은 연결 `error`/`end`를 `AbortSignal`로 노출한다. 승인자는 **매 제공자 호출 직전과 매 ledger 쓰기 직전** 소유를 확인하고, 잃었으면 즉시 중단(새 호출·ledger 쓰기·완료 처리 금지)하고 진행 중이던 단계는 `unknown`으로 남긴다.
  7. **승계 대기(펜싱 대체):** approval 행에 `holder_token`과 `last_call_started_at`(제공자 호출 시작마다 갱신)을 둔다. 새 승인자가 잠금을 얻었을 때 이전 보유자가 정상 해제하지 않았고 `now − last_call_started_at < PROVIDER_MAX_CALL_MS`(Vikunja 클라이언트 총 예산 = 시도×타임아웃+백오프, 기본 40초, 설정값은 클라이언트 예산 이상이어야 함)이면 잠금을 바로 풀고 409 `approval_in_progress` + `Retry-After`를 반환한다. 대기 시간이 지난 뒤에야 `unknown` 단계를 get/마커로 해결한다 → 이전 보유자의 진행 중 호출이 끝난 뒤에만 조회하므로 중복 창이 닫힌다.
  8. 결과 불명 단계가 이미 매핑돼 있어도(get(plannedId) 성공) **의도한 의존 관계를 비교해 빠진 관계를 기록한 뒤에만** created로 표시하고, 기록 실패 시 503(재개 가능).
- **ADR-019 보강(2026-11-11, FU-38cR-1):** (5) 길이 상한(L_max)은 **탐색 비용 상한**일 뿐 수락 거부 사유가 아니다. 상한에 도달했는데 원문 단어/본문 구간이 이어지면 수락하고 합집합 단계에서 구간 끝까지 확장한다(사전 계산한 run-end 배열로 O(n)). (6) 구분자는 **정규화 단계에서 공백류 연속 구간(공백·탭·개행·U+3000·NBSP 등)을 하나의 구분 단위로 접는다** — 원문 좌표 매핑은 유지. 따라서 구분자 길이와 무관하게 FU-32 재현율을 보존한다. (7) 인접(adjacency) 연속 판정은 연속 토큰 자체가 수락될 때만 오른쪽 경계로 인정한다(정밀도). (8) 성능 게이트는 크기 2배당 best-of-3 비율 ≤ 3.0.
- **ADR-020 보강 2(2026-11-11, M2-03cR2 → M2-03d):** 저장소 호출 1회는 여러 HTTP 요청(마커 조회·순환 검사 GET·POST·후속 GET·관계 POST·롤백 DELETE)이므로 호출 단위 펜싱으로는 승계 창 이후 쓰기가 남는다(7개/5개 재현).
  9. **요청 단위 펜싱:** 승인 제공자 작업 전체를 `runWithAbortSignal(AbortSignal.any([잠금 손실 신호, 요청/종료 신호]))` 안에서 실행한다. VikunjaClient는 **매 HTTP 요청 시도 직전** 신호를 확인하고 fetch에 전달한다(FU-42 메커니즘). 신호가 중단되면 어댑터는 새 요청·**롤백 DELETE를 시작하지 않는다**(롤백 억제; 남은 흔적은 마커/재조정이 처리).
  10. 매 HTTP 요청 시작 전에 `last_call_started_at`을 갱신(touch, holder CAS)한다 → `PROVIDER_MAX_CALL_MS`의 정의는 **HTTP 요청 1건 예산**(시도×타임아웃+백오프)보다 크면 충분하다(이미 시작된 fetch만 창 안에서 끝나거나 중단됨).
  11. 승계 대기로 인한 409 `approval_in_progress`(Retry-After)는 **일시적 경합**이므로 멱등 기록에 저장하지 않는다(`idempotency_in_progress`와 동일 취급, 08 §1 저장 규칙 예외로 명시).
- **ADR-019 보강 2(2026-11-11, FU-38cR2 → FU-38d):** (9) **FU-32 패턴 보존 원칙:** 기존 패턴의 재현율을 넓히는 변경은 기존 패턴을 바꾸지 않고 **별도 패턴을 추가**하는 방식으로만 한다(합집합이 둘 다 덮음). CC_PHONE은 FU-32 원문 그대로, 1자리 지역번호 국제형(+82-2, +81 3, +33 1)은 별도 패턴(minDigits ≥ 8). (10) (7)의 적용 범위 명확화: 같은 종류끼리 붙은 숫자 창(예: `900101-1234567900101-1234567`, 붙은 010/02/070 쌍)과 3개 이상 붙은 ASCII 교차 종류 사슬은 **범위 밖**(FU-32도 노출) — knownLimitations 테스트로 고정한다. 관문 코퍼스에서 사례를 빼는 대신 한계로 고정한다. (11) (6)의 접기는 **공백류에만** 적용된다. 공백이 아닌 구분자(`-`, `.` 등) 33개 이상 연속은 범위 밖으로 knownLimitations에 고정한다(인위적 입력).

## ADR-021 [Superseded by ADR-022] 제품 LLM 공급자: 사용자 ChatGPT 계정(OAuth 로그인)을 쓰는 로컬 Codex CLI 어댑터 (GB-1, 2026-11-11 사용자 결정)
- **사용자 결정:** "llm은 우선 api요금제로 사용하기 보다는, gpt 계정로그인 oauth로 연결해서 사용을 생각중". 홈서버 배포는 보류, 당분간 이 노트북 로컬 사용.
- **결정(구현 방식):** planner가 OAuth 토큰을 직접 발급·저장·갱신하지 **않는다**. 사용자가 이미 로그인한 로컬 Codex CLI(`codex login` → "Logged in using ChatGPT")를 `LlmPort` 어댑터(`CodexCliLlm`)가 하위 프로세스로 호출한다:
  `codex exec --ephemeral --sandbox read-only --skip-git-repo-check -C <빈 임시 디렉터리> -m <model> -c model_reasoning_effort=<low|medium> --output-schema <스키마 파일>` + 프롬프트는 stdin. 출력은 기존 스키마 검증 → proposal 저장 경로 그대로.
  - 이유: 토큰이 planner DB·로그·설정에 전혀 들어오지 않음(09 §6–§7 유지), 로그인·갱신은 Codex CLI 책임, API 요금 없음.
- **안전 장치:** 마스킹(ADR-019) + 입력 크기 제한(`assertRedactInputSize`, FU-49) 통과 후에만 호출; 도구 실행 없음(읽기 전용 샌드박스 + 빈 작업 디렉터리 + 프롬프트에 도구 사용 금지); 타임아웃·동시 실행 1개·일/월 **호출 횟수** 상한(금액 대신, `budget_exceeded`); CLI 없음/로그아웃/한도 초과 → `llm_unavailable` → 수동 모드(이미 구현된 경로). CI는 계속 FakeLlm, 실제 호출 금지.
- **알려진 위험(사용자 확인 필요):** ① ChatGPT 구독 계정을 서드파티 앱의 백엔드 호출에 쓰는 것이 OpenAI 이용약관상 허용되는지는 **확인되지 않음** — 개인·로컬 사용으로 한정하고 사용자가 약관을 확인. ② 같은 계정의 사용량 한도를 Codex 리뷰어(Sol)와 공유 → 개발 중에는 리뷰 한도에 영향. ③ Codex CLI 업그레이드로 플래그가 바뀔 수 있음 → 어댑터가 `codex --version`을 기록하고 계약 테스트(녹화 fixture)로 고정.
- **동의 고지(05 §12):** 최초 사용 시 "ChatGPT 계정으로 OpenAI에 전송", 전송 범위(Intake 입력·단계 정보, 허용 노트 구간), 마스킹은 최선 노력(이름·주소·계좌번호 등 미보장)을 표시, 철회 시 수동 모드.

## 운영·일정 결정 (2026-11-11 사용자)
- **GD-3 보류:** 홈서버 배포 없음. 배포 대상은 당분간 이 노트북 로컬(127.0.0.1)만. 홈서버 마련 시 재검토.
- **GU-1 사용자 확인 관문(신규):** M6까지 기존 코어(Vikunja 기반) 위에서 동작이 확인되면, **M7 Native 교체 전에** 사용자가 직접 써볼 수 있도록 로컬 실행 패키지·사용 안내를 제공하고 사용자 확인을 받는다. 사용자 확인 전 Native 교체(M7) 착수 금지.

## ADR-022 제품 LLM 공급자: DeepSeek API (GB-1 최종, 2026-11-11 사용자 결정 — ADR-021 대체)
- **사용자 결정:** "api는 딥시크로 쓰는거로 할게". ADR-021(ChatGPT 계정 + Codex CLI)은 **폐기**(Superseded).
- **결정:** `LlmPort` 어댑터 `DeepSeekLlm` — DeepSeek 공식 API(OpenAI 호환 Chat Completions, base URL은 구현 시점에 공식 문서로 재확인)를 HTTPS로 직접 호출. JSON 출력 모드 + 기존 스키마 검증 → proposal 저장 경로 그대로. 모델명·가격·JSON 모드 지원 여부는 **구현 시점에 공식 문서로 재확인**(본 문서에 단정하지 않음).
- **키·과금(사용자 승인 대상):** 제품용 DeepSeek API 키는 사용자가 직접 발급해 `deploy/secrets/llm.env`(git 제외, 권한 600) 또는 `LLM_API_KEY_FILE`로만 주입. 개발 워커용 OpenCode(opencode-go) 자격증명은 **제품에 재사용하지 않음**. 키는 로그·DB·응답에 절대 기록하지 않음(09 §6–§7). 예산은 `user.settings.llm.budget`(일/월 금액 상한, 토큰 사용량×단가로 계산) — 초과 시 `budget_exceeded` → 수동 모드. 기본 상한은 사용자 확정 전까지 보수적 값으로 두고 설정에서 변경.
- **안전 장치:** 마스킹(ADR-019, Sol 승인) + 입력 크기 제한(FU-49) 통과 후에만 전송; 타임아웃 30s·재시도 2회(429/5xx만, 05 §8); 동의 고지(05 §12)에 "DeepSeek(중국 소재 사업자)의 서버로 전송", 전송 범위, 마스킹은 최선 노력(이름·주소·계좌번호 등 미보장) 명시, 철회 시 수동 모드. CI는 계속 FakeLlm(실제 호출 금지); 실제 호출 스모크는 키가 있을 때만 수동 실행.
- **ADR-021에서 유지:** GD-3 보류(노트북 로컬), GU-1(M6 후 M7 전 사용자 직접 사용 확인)은 그대로 유효.
- **ADR-022 보강(2026-11-11, 사용자):** "오픈코드 go deepseek 4.1 flash medium을 쓸거고, … api key는 … deepseek_api_key.txt로 넣어놨어."
  - 공급자 = **OpenCode Go 게이트웨이**(OpenAI 호환), base URL `https://opencode.ai/inference/go/openai/v1`(로컬 `~/.cache/opencode/models.json` 메타데이터 기준), 모델 `deepseek-v4.1-flash`, `reasoning_effort=medium`. 단가 메타데이터: 입력 $0.15 / 출력 $0.6 per 1M tokens, cache read $0.003 [메타데이터 값, 공식 가격표 미확인].
  - 키: 사용자가 둔 `<repo root>/deepseek_api_key.txt`(git 무시, 권한 600). 제품은 `LLM_API_KEY_FILE=<절대 경로>`로만 읽음. **워커·리뷰어는 이 파일을 읽거나 출력하거나 다른 위치로 복사하지 않는다**(AGENTS.md 규칙). 실제 호출 스모크는 orchestrator가 합성 입력으로만 수동 실행.
  - 주의: 개발 워커(OpenCode, opencode-go)와 같은 OpenCode Go 계정 사용량을 공유할 수 있음.
- **ADR-022 보강 2(2026-11-11 15:15, 사용자 결정):** 실호출 스모크에서 OpenCode Go가 `x-opencode-session` 헤더를 요구(400 MissingSessionID)했고, 문서는 "designed for OpenCode and other coding agents… Traffic is monitored for abuse"라고 명시. 사용자에게 선택지(Go 유지 / DeepSeek 공식 API / OpenCode 종량제)를 제시 → **사용자 선택: OpenCode Go 그대로**. 감수 위험: 설계 용도 밖 사용으로 남용 감시 대상이 될 수 있음, 개발 워커와 같은 월·5시간·주간 한도 공유. 조치: 대화(Intake 세션)별 HMAC 파생 세션 ID를 `x-opencode-session`으로 전송(원 ID·키 미포함), 개인·로컬 사용 한정, 호출량 상한 유지. 문제가 생기면 base URL·키 교체만으로 DeepSeek 공식 API로 전환 가능하도록 어댑터 유지.

## ADR-023 웹 클라이언트 사용자 전환 = 하드 리셋 (M4-UIc BLOCKED 후 재설계, 2026-11-11)
- **맥락:** M4-UI 리뷰 4회 연속으로 사용자 전환 경합 HIGH(진행 중 요청의 늦은 응답이 이전 사용자 상태를 현재 화면·저장소에 씀; 인증 저장소·동의/예산·탭 간 전환·격리 재시도). 상태 조각마다 epoch 가드를 붙이는 방식은 누락이 반복됨.
- **결정:**
  1. **어떤 경로든 사용자가 바뀌면**(로그인으로 다른 사용자, 로그아웃, 다른 탭의 storage 이벤트, `/me`가 저장된 사용자와 다름) → 현재 epoch의 모든 작업 AbortController 중단 → 이전 사용자 영구 저장소(namespace)는 그대로 보존 → **`window.location.reload()`로 하드 리셋**(로그인 직후에는 새 사용자 홈으로 이동). 메모리 상태(Pinia 스토어·컴포넌트 캐시·작업 체인)는 새로 시작하므로 이전 사용자 값이 남을 수 없음.
  2. 새로 로드된 페이지는 `/me`로 사용자를 확인한 뒤에만 그 사용자의 namespace를 연다. 확인 전에는 세션·저널·설정 UI를 렌더링하지 않음(로딩 상태).
  3. Focus 저널 재전송과 격리 재시도는 **하나의 소유자별 직렬 잠금**(Web Locks API `navigator.locks`, 미지원 시 탭 내 mutex + 탭 간 BroadcastChannel)으로만 실행. 격리 재시도는 스냅샷 전체를 지우지 않고 **재대기열에 성공한 항목만** 원자적으로 제거.
- **결과:** epoch 바인딩은 하드 리셋 직전까지의 늦은 쓰기를 막는 방어선으로 유지하되, 사용자 간 상태 정합성의 근거는 하드 리셋이다.
