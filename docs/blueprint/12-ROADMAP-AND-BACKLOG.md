# 12. 로드맵·백로그·승인 게이트

> 시간 약속 없음. 순서는 의존성·조기 가치·검증 가능성 기준. 각 마일스톤 종료 = 사용 가능한 수직 기능 1개 이상 + G4 통과.

## 1. 승인 게이트 목록 (사용자 결정 필요)
| ID | 결정 | 권고안 | 차단 범위 |
|---|---|---|---|
| **GA-1** | 초기 방식 B(얇은 포크 + 자체 UI) 채택 — "UI 대수정"을 자체 앱으로 실현 | B | M1 전체 |
| **GM-1** | 모델 바인딩: DeepSeek effort를 Orca 플래그가 아닌 저장소 `opencode.jsonc` 고정으로 적용 + 프로브 검증 | 승인 | 모든 워커 dispatch |
| **GD-1** | 개발용 런타임 설치: pnpm(corepack), Go 1.27(포크 빌드 시만), PostgreSQL 실행 방식(rootless Docker/Podman vs 네이티브 PG) | rootless Podman 또는 rootless Docker + corepack pnpm | M1-04 이후 통합 테스트, M0-03 |
| GD-2 | Vikunja 포크 원격 저장소 생성(GitHub, 공개 여부) | **대상 없음(ADR-025: Vikunja 제거)** | — |
| GD-3 | 홈서버 배포·포트/DNS | **대상 없음(ADR-025: 데스크톱 앱)** | — |
| GB-1 | 제품 LLM 공급자·월 예산 상한 | M2 착수 전 결정 | M2 실제 LLM 연동(FakeLlm 개발은 무관) |
| GB-2 | 오프사이트 백업 비용 | M7 | 백업 |
| GL-1 | 공개/상용 전 법률 검토 | 필수 | 공개 배포 |
| GL-2 | 자체 코드 라이선스 | 배포 전 | 공개 |
| **GR-1** | RC 프로그램의 사용자 결정 5건(15 §11 Q1–Q5): 셸 빌드용 시스템 패키지 설치, Google OAuth 클라이언트 종류, 배포 형식·자동 업데이트, 허용 목록 밖 라이선스 확인, 옛 데이터 보관 기간 | 15 §11의 권고안 | Q1은 RC-100a, Q2는 RC-90, Q4는 RC-70a, 나머지는 RC-110b |

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

### M7 — RC 프로그램: 리눅스 데스크톱 앱 + Rust 코어 (2026-11-13 변경, ADR-025)
- 예전 M7("Native 백엔드 교체 리허설")을 대체한다. Vikunja 어댑터를 Native 어댑터로 바꾸는 대신, 코어 전체를 Rust로 옮기고 Vikunja·PostgreSQL·docker를 없앤다.
- **GU-1 해제:** "M7 전에 사용자가 써 보고 확인한다"는 관문은 사용자의 2026-11-13 결정으로 해제한다. 사용자 확인은 전환 관문(15 §7.7 #10)으로 옮긴다.
- 목표: 아이콘을 눌러 실행하는 앱 하나. 사용자 한 명, 설치할 서버 없음. 지금 웹 화면과 계약을 그대로 쓴다.
- 비목표: 다른 OS, 다중 사용자, 홈서버 배포(GD-3는 대상이 없어진다), 계약 변경.
- 계획·수용 기준·위험: `15-DESKTOP-RUST-CORE.md`. Task DAG는 15 §10.
- DoD(전환 관문, 15 §7.7): 유지 operation 80/80 패리티, 스케줄러 차분 10,000건 불일치 0, 속성 17개 × 10,000회, 마스킹 차분 불일치 0, 패리티 원장 100% 분류, 해당 E2E 전부 통과, 실제 데이터 가져오기 드라이런에 설명되지 않은 차이 0, 사용자 승인.
- TypeScript 코어(`services/api`, `packages/*`)는 2026-11-13부터 기능 동결(버그 수정만). 예외: 전환용 내보내기 v2(RC-110a).

| Task | 내용 | 의존 | 레인 |
|---|---|---|---|
| RC-00 | 계획, ADR-025, 골격(owner·프로젝트·작업), 패리티 하네스, 오라클 내보내기 | — | 완료 |
| RC-05 | 지금 E2E를 WebKit 엔진으로 돌려 보기 | — | B |
| RC-10 | 작업 마무리·설정·웹 정적 서빙·E2E `core` 대상·패리티 원장 | RC-00 | A |
| RC-20 | 가용 시간·약속 | RC-10 | A |
| RC-30 → 31 → 32 → 33 | 스케줄러 포팅: 시간·슬롯 → 검증기 → 생성기 → 재계획 | RC-00 | B |
| RC-40 | 계획(생성·편집 미리보기·승인·블록 고정) | RC-20, RC-32 | A |
| RC-50 | Today·세션·알림 | RC-40 | A |
| RC-60 | 재계획·추정 | RC-50, RC-33 | A |
| RC-70a / 70b | LLM 크레이트(마스킹·예산) / 키링·인테이크·말로 적기 | RC-33 / RC-70a, RC-40 | B / A |
| RC-80 | 노트 | RC-70b | A |
| RC-90 | Google 캘린더 | RC-50, RC-70b | A |
| RC-100a / 100b | 셸 스파이크 / 트레이·알림·자동 시작·백업 | RC-10 + 사용자 준비 / RC-50 | B |
| RC-110a / 110b | 내보내기 v2·드라이런 / 가져오기·전환 | RC-40 / 전부 | A |

병렬 폭은 구현 2(A·B 레인) + 리뷰 1. 노트북 메모리 때문에 cargo 빌드·테스트 명령은 한 번에 하나, `CARGO_BUILD_JOBS=4`.

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
