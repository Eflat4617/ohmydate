# M1 마일스톤 요약 — Vikunja 기반 단일 사용자 Task CRUD 수직 슬라이스 (2026-11-11)

## 결과: G4 통과
- E2E-1 (Playwright, 실제 web → API(PROVIDER=vikunja) → Vikunja v2.8.0 + PostgreSQL 18): 로그인 → 빠른 추가 → Vikunja API로 존재 확인 → 수정 → 두 번째 컨텍스트 수정 → 서버 412 충돌 대화상자 → 덮어쓰기 → 완료 → Vikunja 완료 확인; 키보드 전용 흐름; 오프라인 변경 차단; axe critical/serious 0. 리뷰어 5회 + 통합 브랜치 1회 모두 4/4 통과.
- 통합 브랜치 `torgal/ohmydate` 전체 ci: 809 pass / 27 env-gated skip (DB+live Vikunja 포함) + web 68, 경계 위반 0.

## 들어간 것
| 영역 | 내용 |
|---|---|
| 기반 | pnpm 모노레포, TS strict, 경계 검사기(AGPL upstream 격리), lint/test/ci |
| 계약 | domain 타입/포트, TypeBox→OpenAPI 3.1, 헤더 매트릭스(If-Match+Idempotency-Key), problem+json 코드 14종 |
| 저장소 | TaskRepository 공통 계약 스위트(버그 주입 28종 검출), InMemory, Vikunja 어댑터(ADR-016 최선노력 CAS, 변경 피드, 반복 완료 기록), PG 영속 저장소(0003), Inbox kind(ADR-018, 0002) |
| API | Fastify, argon2id 세션/CSRF/레이트리밋, 멱등 저장 규칙(2xx/409/422), 동시 동일키 409, 503 매핑, outbox |
| 웹 | Vue3 인박스/프로젝트, 412 충돌 복구, 오프라인 읽기전용, 접근성, MSW 모의 |
| 선행(M2/M3) | LLM 패키지(LlmPort·스키마·프라이버시·예산·FakeLlm)+Intake 상태기계, 스케줄러 검증기(ADR-017 DST 분할) |

## 운영 사실
- 리뷰: Sol(GPT-6.1) 사용량 한도(~03:00) 이후 사용자 승인 정책대로 Opus 5.5 xhigh 대체 리뷰. 동시성·스케줄러 영역은 Sol 복귀 후 사후 리뷰(FU-08).
- 보류(BLOCKED)→재설계 2건(M3-01→ADR-017 M3-01b, M1-06/M2-01→범위축소 재작업), 모두 해결.
- 조정자 실수 1건(잘못된 send) 즉시 정리, 영향 없음.

## 미결/다음
- 진행 중: FU-24(실 LLM 공급자 게이트), FU-28(재조정기 기본 ON), FU-29(0004 is_inbox), M3-02(생성기).
- 다음: FU-30(/api/v1 접두사), M2 Intake API·Planning Wizard UI(FakeLlm), M3 Plan API·비교 UI.
- 사용자 결정 대기: **GB-1 제품 LLM 공급자·월 예산**(FU-24 승인 후 실제 호출 가능), GD-2 포크 원격, GD-3 홈서버 배포.
