# Permission and Cost Policy

## 1. 사실
- Orca는 새 에이전트 실행 시 각 CLI의 권한 우회 플래그를 기본 prefill(온라인 문서: Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`; Settings → Agents → Agent Permissions에서 Yolo/Manual). **이 기기의 현재 설정값은 [UNVERIFIED].**
- Git worktree는 샌드박스가 아니다. 워커는 사용자 `torgal` 권한(sudo 그룹 소속)으로 실행된다.
- `torgal`은 docker 그룹이 아님(소켓 접근 거부) — **유지**.

## 2. 정책
| 항목 | 정책 |
|---|---|
| 권한 모드 | 무인 진행을 위해 워커 bypass 모드는 허용하되, 아래 보완책을 패킷 규칙과 리뷰·통합 검사로 강제. 사용자가 Manual을 원하면 워커 진행이 질문마다 멈춤(트레이드오프 보고) |
| sudo | 워커·리뷰어 사용 금지. 필요 작업은 사용자 게이트 |
| docker 그룹 | 가입 금지(ADR-013). rootless 런타임만 |
| 비밀 | 워커 env에 제품 비밀 없음. LLM 제품 키·Vikunja 토큰은 M1에서 합성 테스트 값만. `deploy/secrets/`는 git 제외 |
| 네트워크 | 허용: 패키지 레지스트리, GitHub release 다운로드(패킷 명시 URL), 자기 모델 API. 금지: 홈서버 접속, 임의 외부 API, 공개 포트 바인딩(127.0.0.1만) |
| Git | 워커: 자기 브랜치 커밋만. push 금지(원격 없음). 통합은 오케스트레이터 |
| 데이터 | 실사용자 데이터 접근 금지(D1 전 구간). 파괴적 마이그레이션은 사용자 승인 |
| 하위 워커 | 생성 금지(depth 1) |
| 홈서버/배포/DNS/포트 | 사용자 사전 승인(GD-3) |

## 3. 비용
| 자원 | 단가/한도 | 상태 | 통제 |
|---|---|---|---|
| DeepSeek V4.1 Flash (OpenCode Go) | in $0.15 / out $0.6 / cache read $0.003 per 1M tok (카탈로그 표기) | 요금제 한도 UNVERIFIED | Task당 토큰 기록(가능 시 OpenCode 세션 통계), 이상 시 중단 기준: Task당 $2 [가정] 초과 시 일시정지·보고 |
| Sol (Codex 구독) | 구독 한도 | UNVERIFIED | 리뷰 1회/변경, 리뷰 동시 1 |
| Opus (Claude 구독) | 구독 한도 | UNVERIFIED | 코디네이터 1 |
| 제품 LLM API | 미정 | GB-1 | 개발 중 FakeLlm, 실제 호출은 승인 후 예산 상한 설정 |
| 외부 유료 서비스(백업 스토리지 등) | — | GB-2 | 승인 전 사용 금지 |

비용·사용량은 각 공급자 대시보드 값이 정본. ledger에는 Task별 추정치와 출처를 기록한다. 측정 불가 시 "미측정"으로 기록하고 추정치를 사실처럼 보고하지 않는다.

## 4. 사용자 승인이 필요한 것 (이 외 일상 작업은 자율)
모델·도구 제한 변경, 사용자 데이터 삭제, 공개 배포, 비밀키/과금 권한, 중대한 아키텍처 변경(ADR 결정 뒤집기), 설치(GD-1 범위 밖), 홈서버 접근.
