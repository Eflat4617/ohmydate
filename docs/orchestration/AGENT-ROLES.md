# Agent Roles

| 논리 에이전트 | 바인딩 | 책임 | 쓰기 권한 | 금지 |
|---|---|---|---|---|
| `orchestrator` | Claude Code · claude-opus-5-5 (xhigh 목표) | Run/Task DAG, 패킷 작성, dispatch, inbox 처리·ack, Sol 리뷰 배정, 통합(merge to `torgal/ohmydate`), ledger, ADR, 사용자 보고·게이트 | docs/**, 통합 브랜치(`torgal/ohmydate`) merge, 긴급 수정(ledger에 사유) | 프로덕션 배포, 비밀 권한 확대, reset, 모델 대체 |
| `worker-backend` | OpenCode · deepseek-v4.1-flash high | api, db, provider, contracts | 패킷 허용 경로만 | 범위 밖 파일, 공유 스키마 임의 변경, 하위 워커 생성, sudo, docker 그룹, push |
| `worker-frontend` | 동일 | apps/web, e2e | 패킷 허용 경로 | 동일 |
| `worker-planner` | 동일 | domain 규칙, scheduler, llm, ui-policy, testkit | 패킷 허용 경로 | 동일 |
| `reviewer` | Codex · gpt-6.1-sol high | 독립 리뷰: 정확성·보안·동시성·계약·테스트 누락·라이선스 경계 | 없음(읽기 전용, 테스트 실행만) | 코드 수정, 커밋, 리뷰 대상 테스트 변경 |
| 사용자(PO) | — | 게이트 결정, 마일스톤 수락 | — | 작업 전달 역할 아님 |

논리 역할 구분은 패킷의 `allowed paths`와 패킷 서두 역할 문구로 구현한다(Orca에 별도 역할 객체 없음).

## 컨텍스트 분리
- 리뷰어는 구현 워커와 다른 CLI·모델·세션. 리뷰 패킷에는 워커의 자기 평가를 "주장"으로 표시하여 전달.
- 리뷰어는 구현 worktree를 읽되(정산 후) 수정하지 않으며, 리뷰 종료 시 `git status --porcelain` 빈 출력을 증빙.

## 동시성 (B.3)
초기 구현 워커 ≤2 + 리뷰어 ≤1 동시. 확대 조건: 3개 마일스톤 Task 연속 무충돌 + 노트북 가용 RAM ≥ 6GB 측정 + 사용량 한도 여유 확인 → 3명. 5명 이상은 원격 런타임(별도 승인) 이후.
