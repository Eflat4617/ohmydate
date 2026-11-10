# 12. 로드맵·백로그·승인 게이트

> 시간 약속 없음. 순서는 의존성·조기 가치·검증 가능성 기준. 각 마일스톤 종료 = 사용 가능한 수직 기능 1개 이상 + G4 통과.

## 1. 승인 게이트 목록 (사용자 결정 필요)
| ID | 결정 | 권고안 | 차단 범위 |
|---|---|---|---|
| **GA-1** | 초기 방식 B(얇은 포크 + 자체 UI) 채택 — "UI 대수정"을 자체 앱으로 실현 | B | M1 전체 |
| **GM-1** | 모델 바인딩: DeepSeek effort를 Orca 플래그가 아닌 저장소 `opencode.jsonc` 고정으로 적용 + 프로브 검증 | 승인 | 모든 워커 dispatch |
| **GD-1** | 개발용 런타임 설치: pnpm(corepack), Go 1.27(포크 빌드 시만), PostgreSQL 실행 방식(rootless Docker/Podman vs 네이티브 PG) | rootless Podman 또는 rootless Docker + corepack pnpm | M1-04 이후 통합 테스트, M0-03 |
| GD-2 | Vikunja 포크 원격 저장소 생성(GitHub, 공개 여부) | 개인 비공개로 시작, 공개 서비스 전 공개(L1) | M7 전 |
| GD-3 | 홈서버 배포·포트/DNS | M4 이후 별도 요청 | 배포 |
| GB-1 | 제품 LLM 공급자·월 예산 상한 | M2 착수 전 결정 | M2 실제 LLM 연동(FakeLlm 개발은 무관) |
| GB-2 | 오프사이트 백업 비용 | M7 | 백업 |
| GL-1 | 공개/상용 전 법률 검토 | 필수 | 공개 배포 |
| GL-2 | 자체 코드 라이선스 | M7 전 | 공개 |

## 2. 마일스톤

### M0 — 설계·바인딩 검증·업스트림 프로브
- 목표: 본 설계 승인(G0), 모델 바인딩 실측, Vikunja v2.8.0 API v2 실제 기능 확정.
- 비목표: 제품 코드.
- 산출: 승인된 docs, `MODEL_BINDINGS.md` VERIFIED 갱신, `docs/blueprint/vendor/vikunja-v2.8.0-capabilities.md` + 저장된 OpenAPI.
- DoD: 프로브 P1/P2 launch 실효값 일치, 캡빌리티 문서 리뷰 APPROVE.
- 티켓: M0-01(Opus 직접: 부트스트랩 커밋·dev 브랜치·opencode.jsonc), M0-02(프로브), M0-03(Vikunja 프로브, DeepSeek), M0-03R(Sol 리뷰).

### M1 — 단일 사용자 Task CRUD + Vikunja 동기화 기초
- 사용자 시나리오: 자체 UI에서 로그인→작업 추가/수정/완료, Vikunja UI에서도 보임, 동시 수정 충돌 처리.
- 컴포넌트: monorepo, domain/contracts, TaskRepository(InMemory/Vikunja), planner DB(user, project, task, mapping, idempotency, outbox, audit), api(auth, tasks, projects), web(Inbox, Project), dev compose 명세.
- DoD: 계약 테스트(InMemory+Vikunja) 통과, E2E-1, 타입/린트 0 오류, Sol APPROVE.
- 위험: Vikunja API v2 필드 부족(→ M0-03에서 조기 발견), 노트북 RAM.
- 보류: Calendar, 노트, 알림.

### M2 — Intake·유사 유형·단계 분해 (수동 승인)
- 시나리오 A(1–4)/B. FakeLlm 우선, GB-1 후 실제 공급자 어댑터.
- 컴포넌트: Intake 상태 기계, 템플릿/fingerprint, LlmPort, 스키마 레지스트리, Planning Wizard UI.
- DoD: 상태 전이 전수 단위 테스트, LLM 실패 주입, E2E-2, AI 평가 세트 1차.

### M3 — 3안 스케줄러·승인 원자성
- 컴포넌트: scheduler + validator + golden 14 + property, availability/commitment, Plan API, Comparison UI, Calendar.
- DoD: 하드 위반 0(10k), 승인 TX 동시성 테스트, E2E-3, 성능 목표.

### M4 — Today/Focus/실측/알림
- 컴포넌트: work_session, review, notifications(dedupe), Web Push, PWA 캐시, 내보내기 최소.
- DoD: E2E-4, 알림 중복 0, 오프라인 Focus 업로드 멱등.

### M5 — 피드백 학습·지연 감지·최소 변경 재계획
- DoD: estimator 회귀 테스트, G04/G08/G09, 재계획 억제 규칙, E2E-5.

### M6 — 노트 맥락·적응형 레이아웃
- DoD: 인젝션 평가 통과, 레이아웃 hysteresis 단위 테스트, axe 0, E2E-6.

### M7 — Native 백엔드 교체 리허설·출시 준비
- DoD: Native 계약 테스트 100%, 이전 리허설 2회, 복구 리허설, 라이선스 점검, E2E-7. 운영 배포는 GD-3.

### M8+ — 공모전 검색, rolling-wave 장기 계획, 오프라인 편집 큐, 다중 사용자.

## 3. M0→M1 Task DAG (상세는 `docs/orchestration/RUN-AND-TASK-DAG.md`)
```text
M0-01 bootstrap ─► M0-02 probes ─┬─► M0-03 vikunja-probe ─► M0-03R review ─┐
                                 └─► M1-01 monorepo ─► M1-01R ─► M1-02 domain+contracts ─► M1-02R ─┬─► M1-03 repo-port+contract+inmem ─► R ─┐
                                                                                                    └─► M1-04 db+migrations ─► R ───────────┤
                                                    M0-03R ─────────────────────────────────────────────────────────► M1-05 vikunja-repo ◄──┘(M1-03)
                                                    M1-03R + M1-04R ─► M1-06 api tasks/auth ─► R
                                                    M1-02R ─► M1-07 web skeleton+inbox ─► R
                                                    M1-05R + M1-06R + M1-07R ─► M1-08 e2e ─► R ─► M1 milestone gate(G4)
                                                    GD-1 ─► M1-09 dev compose spec ─► R
```
병렬 폭: 최대 2 구현 + 1 리뷰(B.3).

## 4. M1 티켓 요약
| ID | 제목 | 소유 경로 | 의존 | 워커 |
|---|---|---|---|---|
| M1-01 | pnpm monorepo·TS strict·lint·vitest·경계검사 | 루트 설정, `packages/*/package.json` 골격 | M0-02 | worker-backend |
| M1-02 | domain 타입 + contracts(TypeBox, problem+json, OpenAPI 생성) | `packages/domain`, `packages/contracts` | M1-01 | worker-backend |
| M1-03 | TaskRepository 포트·계약 스위트·InMemory | `packages/domain/src/ports`, `packages/testkit` | M1-02 | worker-planner |
| M1-04 | planner DB 스키마·마이그레이션(M1 테이블) | `services/api/migrations`, `services/api/src/db` | M1-02, GD-1 | worker-backend |
| M1-05 | VikunjaTaskRepository(API v2) | `packages/provider-vikunja` | M1-03, M0-03 | worker-backend |
| M1-06 | api: auth·projects·tasks·idempotency·ETag | `services/api/src/{http,application}` | M1-03, M1-04 | worker-backend |
| M1-07 | web: 앱 골격·로그인·Inbox·Project | `apps/web` | M1-02 | worker-frontend |
| M1-08 | E2E-1 Playwright | `e2e/` | M1-05..07 | worker-frontend |
| M1-09 | dev compose 명세(vikunja+pg) | `deploy/dev` | GD-1 | worker-backend |
