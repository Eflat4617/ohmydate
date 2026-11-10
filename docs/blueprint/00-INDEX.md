# 00. Blueprint Index — OhMyDate Adaptive Planner

> 작성 2026-11-11 · Phase **D0**(읽기 전용 조사 + 설계) · 작성자: orchestrator(Claude Opus 5.5)
> 기준 명세: `/ORCA_ADAPTIVE_PLANNER_MASTER_SPEC.md`

| 문서 | 내용 | 완료도 | 주요 미검증 |
|---|---|---|---|
| [01 PRD](01-PRODUCT-REQUIREMENTS.md) | 시나리오 A–F, AC, NFR, 지표 | 설계 완료 | 지표 수치 = 초기 가정 |
| [02 Repository Audit](02-REPOSITORY-AUDIT.md) | 로컬·환경·Vikunja v2.8.0, A/B/C 비교 | 완료 | Vikunja v2 세부 엔드포인트(M0-03) |
| [03 Architecture](03-ARCHITECTURE.md) | 모듈러 모놀리스, 경계, 흐름, 장애 | 설계 완료 | 메모리 수치 [추정] |
| [04 Domain & DB](04-DOMAIN-AND-DATABASE.md) | ERD, 30여 테이블, 규약 | 설계 완료 | — |
| [05 AI Agent](05-AI-AGENT-SPEC.md) | Intake 상태기계, 스키마, 실패 4종, 프라이버시 | 설계 완료 | 공급자(GB-1) |
| [06 Scheduler](06-SCHEDULER-SPEC.md) | 제약, 3정책, golden 14, property | 설계 완료 | 가중치 [가정] |
| [07 Adaptive UI](07-ADAPTIVE-UI-SPEC.md) | 파이프라인, LayoutSpec, 와이어프레임 | 설계 완료 | — |
| [08 API & Events](08-API-AND-EVENT-CONTRACTS.md) | 엔드포인트, 오류·멱등·잠금, outbox | 설계 완료 | — |
| [09 Ops & Security](09-OPERATIONS-SECURITY.md) | compose 예산, 백업, 위협 | 설계 완료 | 실측 없음 |
| [10 License & Migration](10-LICENSE-AND-MIGRATION.md) | 위험 등록부, 전환 3단계 | 설계 완료 | **법률 검토 필요** |
| [11 Test & Eval](11-TEST-AND-EVALUATION.md) | 계층, E2E, AI 평가 | 설계 완료 | — |
| [12 Roadmap & Backlog](12-ROADMAP-AND-BACKLOG.md) | 게이트, M0–M8, M1 티켓, DAG | 설계 완료 | — |
| [13 ADR](13-ADR.md) | ADR-001~015 (Proposed) | 승인 대기 | — |
| [14 Implementation Handoff](14-IMPLEMENTATION-HANDOFF.md) | M0-01/02, 패킷 M0-03·M1-01·M1-02, 리뷰 템플릿 | 완료 | — |

오케스트레이션: [ORCA-RUNTIME-AUDIT](../orchestration/ORCA-RUNTIME-AUDIT.md) · [MODEL_BINDINGS](../orchestration/MODEL_BINDINGS.md) · [AGENT-ROLES](../orchestration/AGENT-ROLES.md) · [RUN-AND-TASK-DAG](../orchestration/RUN-AND-TASK-DAG.md) · [WORKER-AND-REVIEW-CONTRACT](../orchestration/WORKER-AND-REVIEW-CONTRACT.md) · [FAILURE-AND-RECOVERY](../orchestration/FAILURE-AND-RECOVERY.md) · [PERMISSION-AND-COST-POLICY](../orchestration/PERMISSION-AND-COST-POLICY.md) · [EXECUTION-LEDGER](../orchestration/EXECUTION-LEDGER.md) · 코딩 규칙 초안 [AGENTS-DRAFT](../AGENTS-DRAFT.md)

## 명세 §I 최종 검증 체크
1. 대상 Orca = onorca.dev, 1.4.255, orchestration 가이드 전문 로드 ✔
2. 모델/effort: 카탈로그 일치, 실효값은 프로브 대기(강등·대체 없음) △
3. 기존 Run 확인(legacy만), Run≠워커 실행 구분 ✔
4. 패킷에 의존·소유권·테스트·rollback ✔ (M0-03, M1-01, M1-02)
5. worker_done taskId/dispatchId + ack 규칙 ✔ (실행은 D1)
6. 리뷰어 실제 diff·테스트 실행 의무 ✔
7. 병합 후 통합 테스트 ✔ (절차)
8. 고위험 승인 게이트 ✔
9. 복구 절차·ledger ✔
10. 제품 요구(분해·3안·템플릿·타임로그·노트·적응형 UI·장기 계획·Vikunja 교체) 누락 없음 ✔
