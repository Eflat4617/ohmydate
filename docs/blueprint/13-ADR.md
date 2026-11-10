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
