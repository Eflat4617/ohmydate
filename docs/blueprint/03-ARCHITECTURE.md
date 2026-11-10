# 03. 아키텍처

> 상태: D0 설계안. 결정 근거는 `13-ADR.md`.

## 1. 전체 구조 (모듈러 모놀리스 + 교체 가능한 Task Provider)

```text
 ┌──────────────── Clients (Win/Linux browser, Android PWA) ─────────────────┐
 │ apps/web (Vue 3 + TS + Vite + Pinia)                                       │
 │  Context Observer → Layout Policy → Component Registry → Renderer          │
 │  generated API client (from packages/contracts OpenAPI)                    │
 └──────────────────────────────┬─────────────────────────────────────────────┘
                                │ HTTPS (Tailscale), cookie session + CSRF
 ┌──────────────────────────────▼─────────────────────────────────────────────┐
 │ services/api  (Node 24, Fastify, TypeScript) — 유일한 논리 API              │
 │  ├ http: routes, auth, idempotency, ETag/If-Match, problem+json            │
 │  ├ application: use-cases (Intake, Planning, Approval, Today, Session…)    │
 │  ├ domain (packages/domain): 순수 타입·규칙, I/O 없음                         │
 │  ├ scheduler (packages/scheduler): 결정론적 생성기 + 독립 검증기             │
 │  ├ planner-ai (packages/llm): LlmPort, 프롬프트 버전, 스키마 검증, 프라이버시   │
 │  ├ knowledge: 노트/첨부/FTS 검색, 근거 선택                                  │
 │  ├ ports: TaskRepository, Clock, IdGen, Notifier, BlobStore, LlmPort        │
 │  ├ adapters: provider-vikunja (API v2) | provider-native (Postgres)         │
 │  └ jobs: outbox dispatcher, reconciler, reminders (in-process, PG lease)    │
 └───────┬───────────────────────────────┬────────────────────────────────────┘
         │ SQL (planner DB)              │ HTTP /api/v2 (service token)
 ┌───────▼────────┐              ┌───────▼──────────────────┐
 │ PostgreSQL 18  │              │ Vikunja v2.8.0 (fork tag)│──► PostgreSQL (vikunja DB)
 │ db: planner    │              │ 기본 UI = 관리/폴백        │
 └────────────────┘              └──────────────────────────┘
 외부: LLM API (동의·마스킹 후), Web Push 서비스(브라우저 벤더)
```

## 2. 명세 §4.1 서비스 경계 후보 → 배치 결정

| 후보 | 배치 | 이유 |
|---|---|---|
| planner-client | `apps/web` 독립 앱 | 장기 보존 UI, Vikunja 프런트 코드 비복사 |
| application-api | `services/api` | UI의 유일한 API |
| task-provider-vikunja | `packages/provider-vikunja` (api 프로세스 내부 어댑터) | 별도 프로세스 불필요 |
| planner-core | `packages/llm` + `services/api/src/application/intake` | 같은 트랜잭션 경계 필요 |
| schedule-engine | `packages/scheduler` (순수 라이브러리) | 순수 함수 → property test 용이, 장래 분리 가능 |
| knowledge | api 내부 모듈 + PG FTS | 초기 벡터DB 불필요 [가정] |
| worker | api 프로세스 내 job runner (PG advisory lock 리더) | 16GB 서버, 브로커 불필요 |
| data | PostgreSQL 18 단일 인스턴스, DB 2개(`planner`, `vikunja`) | 운영 단순성 |

## 3. 모놀리스 vs Python 서비스 vs 다수 서비스 (명세 §4.1 필수 비교)

| 항목 | **TS 모듈러 모놀리스(선택)** | + Python 서비스 1개 | 다수 독립 서비스 |
|---|---|---|---|
| 컨테이너 수 [추정] | api 1 + vikunja 1 + pg 1 + proxy 1 = 4 | 5 | 8+ (+브로커) |
| 상주 메모리 [추정] | api 200–350MB | +250–500MB(Python+OR-Tools) | +1–2GB |
| 언어/툴체인 | TS 단일(클라이언트와 타입 공유) | TS+Python | 다수 |
| 장애 지점 | 적음 | 중간(IPC 계약·버전) | 많음 |
| 1인 운영 부담 | 낮음 | 중간 | 높음 |
| 워커 분할 용이성 | 패키지 단위 소유권으로 충분 | 언어 경계로 명확 | 과잉 |
| CP-SAT 필요 시 | 재평가 트리거(ADR-006) 충족 시 Python 사이드카 추가 | 즉시 | — |

Go 단일 모놀리스(Vikunja와 동일 언어)도 검토했으나: ① 프런트와 타입 공유 불가 ② Vikunja 코드 재사용 유혹 → 라이선스·결합 위험 ③ 개발 머신에 Go 미설치. → **기각**(ADR-002).

## 4. 디렉터리 구조와 라이선스 구역 (ADR-015)

```text
ohmydate/
  apps/web/                    # [OWN] 자체 UI (장기 보존)
  services/api/                # [OWN] 애플리케이션 API + jobs
  packages/
    domain/                    # [OWN] 도메인 타입/규칙 (I/O 금지)
    contracts/                 # [OWN] TypeBox 스키마 → OpenAPI 3.1, 오류 모델, 이벤트
    scheduler/                 # [OWN] 결정론적 엔진 + validator
    llm/                       # [OWN] LlmPort, prompt registry, privacy filter, fakes
    ui-policy/                 # [OWN] 레이아웃 계약/정책 엔진 (web과 api 공용)
    provider-vikunja/          # [OWN, 폐기 예정] Vikunja API v2 어댑터 (코드 비복사)
    provider-native/           # [OWN] Native TaskRepository
    testkit/                   # [OWN] 계약 테스트 스위트, fixtures, fake clock
  upstream/vikunja/            # [AGPL zone] 포크 서브모듈 (v2.8.0 고정, 패치 예산)
  deploy/                      # compose, proxy, backup 스크립트
  docs/
```

규칙: `[OWN]` 코드는 `upstream/` 경로에서 **코드 복사·import 금지** (CI 경로 검사로 강제). 단, 이것만으로 법적 독립성이 보장되지 않음 → `10-LICENSE-AND-MIGRATION.md`.

## 5. 핵심 흐름

### 5.1 신규 과제 → 3안 → 승인
```text
web ─POST /intake-sessions──► api: IntakeSession(created)
api ─LlmPort.detectType──► proposal(type, confidence) ─schema─► IntakeSession(type_detection→clarification)
web ◄─questions[]── (이미 제공 필드 제외 필터: 결정론적)
web ─answers──► api ─LlmPort.decompose──► DecompositionDraft (proposed)
web ─PATCH/approve draft──► api: Tasks 생성(TaskRepository) + Estimates
web ─POST /plans:generate──► scheduler.generate(policies×3) → validator → PlanCandidate[≤3]
web ─POST /plans/{id}/approve (Idempotency-Key, If-Match: availabilityVersion)──►
     api TX: 재검증(최신 commitments) → ScheduleBlocks insert → Plan.version++ → outbox(notifications.schedule)
```

### 5.2 Vikunja 동기화 (ADR-007)
- 쓰기: api → `VikunjaTaskRepository` (If-Match ETag) → 성공 시 mapping upsert. 실패 시 로컬 트랜잭션 롤백, 사용자에게 오류(재시도 가능).
- 외부 변경(Vikunja UI/CalDAV): 웹훅은 **힌트**로만 처리(재시도 없음 [확인]) + 주기 재조정(기본 5분 [가정]) + 앱 포커스 시 온디맨드 재조정.
- 중복 처리: `inbox_event(provider, external_event_hash)` 유일 제약, 처리 후 원본 상태 재조회.

## 6. 장애 시 동작 (Graceful Degradation)

| 장애 | 동작 |
|---|---|
| LLM 장애/비용 초과 | Intake는 "수동 분해" 모드로 전환, 기존 기능 정상. 배지 표시 |
| Vikunja 다운 | Task 읽기: planner 캐시(read model)로 제공, 쓰기는 503 + 재시도 안내. ScheduleBlock/WorkSession은 planner DB이므로 계속 가능 |
| PG 다운 | api readiness fail, web은 PWA 캐시 읽기 전용 |
| 네트워크 단절(클라이언트) | 캐시 읽기 + 명시적 "오프라인: 편집 불가" (ADR-010). 단, Focus 타이머는 로컬에서 계속, 복귀 시 세션 업로드(멱등 키) |
| 작업 중복 실행(재부팅/다중 인스턴스) | PG advisory lock 리더 + job lease + 멱등 키 |

## 7. 장기 교체 경로 요약
초기(Vikunja SoR for task core) → 중간(자체 UI·API 우선, Vikunja는 TaskRepository 구현 1개) → 후기(NativeTaskRepository로 freeze-and-import, Vikunja 제거). 상세 `10-LICENSE-AND-MIGRATION.md`.
