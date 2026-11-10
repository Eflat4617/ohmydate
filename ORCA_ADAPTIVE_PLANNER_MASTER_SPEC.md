# Orca 기반 자율 멀티에이전트 개발 마스터 명세

> **문서 버전:** 2026-11-11 / **대상:** [Orca (onorca.dev)](https://www.onorca.dev/) / **문서 유형:** 총괄 제품·아키텍처·오케스트레이션·개발 수행 명세
>
> **사용법:** 이 파일을 Orca의 주 코디네이터(Claude Opus 5.5)에게 전달하고, 동봉한 `ORCA_OPUS_BOOTSTRAP_PROMPT.md`를 첫 메시지로 보낸다. 이 문서는 작업 명세이며 설치 스크립트나 이미 실행된 설정이 아니다.
>
> **우선순위:** 보안·사용자 승인 경계 > 실제 설치된 Orca `/orchestration` 가이드 > 이 문서의 실행 예시 > 기존 추정. 설치 버전/모델 ID가 다르면 확인된 실제 값을 우선하고 변경 사실을 보고한다.

---

# A. 역할·목적·성공 조건

당신은 **Claude Opus 5.5 (사용자 지정 xhigh)**를 사용하는 **Lead Architect / Technical Lead / Multi-Agent Orchestrator**다. 사용자는 프로젝트의 Product Owner이며, 다른 에이전트 사이의 작업 전달자가 아니다. 당신은 Orca의 감독형 오케스트레이션 기능을 이용해 작업을 분석·설계·분해·배정·검토·재배치·통합·보고한다.

프로젝트의 목적은 **적응형 AI 개인 일정관리 플랫폼**을 개발하는 것이다. 시작은 Vikunja 포크지만, 후일 독자적인 서비스를 출시할 수 있게 독립형 AI Planner·스케줄러·노트 맥락·사용자 학습·자체 UI를 설계한다. 작업 유형별 동적 질문, 과거 유사 작업 템플릿, 실행 가능한 세 가지 일정안, 선택·승인, 매일 체크인·알림, 소요시간 피드백·재계획을 핵심 기능으로 삼는다. 세부 요구사항은 이 문서의 제품 명세에 있다.

**완전자동화 목표:** 사용자는 백로그 티켓을 한 건씩 전달하거나 모델 간 결과를 복사하지 않는다. 오케스트레이터가 Orca Run/Task/Dispatch와 inbox를 운영하며 워커와 리뷰어의 결과를 수집한다. 자동화 실패·안전 게이트·범위 변경에서만 사용자 결정을 요청한다. 단, LLM/CLI의 실행 보존은 실제 런타임 상태에 종속되므로, 장시간 무인 실행을 검증되지 않은 제품 기능처럼 단정하지 않는다.

**최종 성공 조건:**
1. 이 문서의 기능을 기준으로 제품 PRD, 기술 명세, 검증 계획, 마일스톤/작업 DAG를 완성한다.
2. Orca `/orchestration`을 이용해 독립 워커에게 구현 작업을 배정하고 Sol 리뷰어로 검증하며, 결과를 다음 작업에 자동 연결한다.
3. 각 마일스톤에 실행 가능한 수직 기능과 재현 가능한 테스트를 남긴다.
4. Vikunja의 교체가 가능한 도메인 경계와 마이그레이션 계획을 유지한다.
5. 실제 사용 가능한 MVP를 만들되, 작업 완료 주장과 테스트/배포 성공을 구분한다.

# B. 현재 개발 환경 및 모델별 역할

## B.1 개발·배포 환경

- **개발 기기:** Ubuntu 노트북, Orca (onorca.dev) 구동. 사용자 로컬 폴더·Git·현재 브랜치·버전·작업 내용을 먼저 조사한다.
- **Orca 실행 기반:** Orca는 에이전트 CLI를 호스팅하는 개발 환경이다. 실행 호스트의 Orca 및 에이전트 도구 실제 설치 상태를 확인하며, Orca 자체를 LLM 제공자로 취급하지 않는다.
- **배포 목표:** Ubuntu/Linux Docker Compose 홈서버, Intel Core i7-8700(non-K), DDR4 16GB(8×2), GTX 1060 3GB 보유하지만 초기 서버에서는 GPU 제거 가정, 마이크로닉스 600W 파워(정확한 모델·수명 미확인), 2TB HDD, SSD 추가 예정, 메인보드/케이스 아직 결정 전.
- **클라이언트:** Windows, Linux, Android. 반응형 Web/PWA부터 검증하고 필요시 네이티브 앱을 분리한다.
- **접속:** LAN과 외부 접속을 모두 제공. 최초 개인용은 Tailscale 등 VPN 중심, 향후 공개 서비스는 별도 인증·TLS·보안정책.
- **추론:** 제품 내부 AI LLM은 외부 API 허용, 추후 로컬 모델 대체 가능성을 고려. 개발 에이전트의 모델과 제품 런타임 AI 모델은 독립된 결정이다.
- **사용자:** 최초 1명, 미래 다중 사용자·상용화 가능성. 개인 데이터와 일정은 외부 모델 전송 최소화.

## B.2 개발 에이전트의 정확한 의도

| 위치 | 사용자 요청 모델 | 논리적 에이전트 | 기본 책임 | 주의 |
|---|---|---|---|---|
| 코디네이터 | **Claude Opus 5.5 · xhigh** | `orchestrator` | PRD/설계/ADR, 작업 DAG 생성, 배정, 상태관리, 리스크·통합·승인 정책 | xhigh 표기가 실제 CLI effort 옵션과 동일하다고 가정 금지 |
| 구현 | **DeepSeek 4.1 Flash · high** | `worker-frontend`, `worker-backend`, `worker-planner` 등 | 지정된 브랜치/파일에서 구현·테스트·자체 점검 | provider 실제 모델 slug/하네스 지원 여부 확인 |
| 독립 검증 | **GPT-6.1 Sol · high** | `reviewer` | 코드·아키텍처·API·보안·테스트 검증 및 수정 요구 | 워커와 가능하면 별도 컨텍스트/작업공간 |

**모델 바인딩 원칙:** 모델 이름은 사용자의 목표 설정이지 Orca가 반드시 이해하는 CLI 문자열이 아니다. 먼저 실제 Claude Code, OpenCode 또는 사용 중인 DeepSeek Harness, Codex 등 **구동 CLI + provider 모델 ID + effort**를 읽기 전용으로 확인한다. Orca가 제공하는 `--model`은 provider가 수용하는 opaque ID여야 하며, `--effort`는 모델·에이전트가 실제 지원하는 값이어야 한다. `xhigh`→`high` 같은 조용한 강등 금지. `launch.requested`와 `launch.effective` 등 실제 실행 결과를 검사하고 불일치하면 실행 중단 또는 사용자에게 예외 승인을 구한다.

추천 매핑(검증 전 잠정):
- Opus 총괄: **Claude Code** CLI가 해당 모델·설정에 접근 가능할 때 코디네이터로 사용.
- DeepSeek 워커: **OpenCode** 또는 **DeepSeek Harness**에서 요청 모델을 실제 제공하면 해당 에이전트 타입 사용. Orca `worker-start --model`은 모든 agent 타입을 지원하지 않으므로 고정 문자열을 강제로 주입하지 말 것.
- Sol 리뷰어: **Codex**에서 해당 모델·effort를 실제 사용할 수 있을 때 Codex worker로 구성.
- 각 요청 모델의 실제 ID·effort 지원·인증·동시 호출 제한을 테스트 결과와 함께 `docs/orchestration/MODEL_BINDINGS.md`에 기록한다.

## B.3 기본 동시성

초기에는 워커 최대 **2명 동시 구현 + 리뷰어 1명**까지 운영하는 보수적 설정을 제안한다(노트북 메모리/빌드 부하와 구독 한도를 고려한 운영 시작점, 실측 아님). 충분한 검증 후 3~5명 병렬로 확장한다. 10개의 에이전트를 생성했다는 사실만으로 10배의 처리량이 생기는 것은 아니다. 코드 소유 범위·API 계약·CPU/RAM·요금제와 CI 비용을 병목으로 분석한다.

## B.4 에이전트 권한 분리

| 작업 | DeepSeek 워커 | Sol 리뷰어 | Opus 코디네이터 | 사용자 |
|---|---|---|---|---|
| 계약에 따른 브랜치 내부 코드 작성 | 허용(구현 단계) | 원칙적 읽기 전용 | 긴급 수정을 제외하고 위임 | 불필요 |
| 테스트·정적 분석 | 허용 | 허용 | 결과 수집 | 불필요 |
| API/DB 계약 변경 | 제안 | 영향 평가 | ADR/일관성 판정 | 파괴적 범위 변경 시 승인 |
| 리뷰 차단·재작업 요청 | 요청 | 수행 | 최종 처리 | 불필요 |
| 개발 브랜치 통합 | 금지 | 권고 | 자동 검증 통과 시 수행 | 필요시 옵트아웃 |
| 프로덕션 배포·DNS·포트 개방 | 금지 | 금지 | 변경 계획 제시 | 사전 승인 |
| 결제·유료 서비스 결합·비밀키 권한 확대 | 금지 | 금지 | 승인을 요청 | 명시 승인 |
| 데이터 삭제·마이그레이션 파괴적 작업 | 금지 | 금지 | 사전 백업·리허설 및 게이트 | 명시 승인 |

**중요:** Orca는 일부 에이전트를 기본적으로 permission-bypass 인자로 실행할 수 있다. Git worktree 분리는 **OS 샌드박스나 비밀키 보호가 아니다.** 최소 권한, 환경변수 분리, 파일/네트워크 접근 제한, Docker 소켓 접근 차단, 운영 서버 접속 금지를 별도 적용한다. 처음부터 unrestricted/yolo 모드를 신뢰하지 않는다.

# C. `/orchestration` 필수 사용 절차

## C.1 스킬 선택과 공식 참조

대상은 **https://www.onorca.dev/** 의 Orca이다. 이름이 같은 다른 Orca/오케스트레이터의 문서를 사용하지 마라.

사용자가 `/orchestration`을 적극 활용하도록 요구한다. 에이전트 런처에서 `/orchestration`이 유효한 스킬 진입 명령이라면 해당 스킬을 호출하고, **현재 설치 버전의 전체 가이드**를 우선 로드하라. Slash command가 노출되지 않거나 실행되지 않더라도 스킬의 실질 기능을 CLI로 수행하되, 명령 이름을 임의로 가정하지 말 것.

필수 사전 읽기/확인 (읽기 전용; 사용법은 설치된 버전 우선):

```bash
command -v orca || command -v orca-ide || command -v orca-dev
orca status --json
orca skills list
orca skills get orchestration --full
orca skills get orca-cli
```

참고로 Orca는 `ORCA_CLI_COMMAND` 또는 Linux `orca-ide` 등 다른 실행 파일명을 사용할 수 있다. 위 예시가 로컬 명령과 다르면 실제 실행파일을 확인해 동등한 명령으로 실행한다. CLI가 설치되지 않았으면 사용자에게 장애를 보고하고, 임의 바이너리 실행이나 자동 설치를 진행하지 않는다.

스킬이 없을 때의 공식 설치 후보(사용자 승인 후 실행):

```bash
orca skills install --skill orca-cli --skill orchestration
# 또는 안내된 npx skills add https://github.com/stablyai/orca --skill orchestration --global
```

`orca status --json` 실패·Orchestration 기능 비활성 상태면 조용히 다른 시스템을 흉내 내지 말고 **BLOCKED: ORCA_RUNTIME**로 기록한다. 공식 문서에서 오케스트레이션은 실험 기능이며 설정 UI 표시 상황이 버전별로 달라질 수 있다. 실제 지원 여부를 CLI/Runtime에서 확인한다.

**금지된 오래된 명령:** `orca orchestration run`, `run-stop`, `coordinator-start`, `coordinator-stop`은 현재 공식 문서에서 retired로 표시한다. 사용하지 말고 **Run 생성 → Task 생성 → worker-start → check/ack** 흐름을 사용한다. 명령 옵션은 항상 `orca skills get orchestration --full` 결과를 우선한다.

최초에는 `orca skills get orchestration --full`의 전문을 읽고, 아래 운영 계약이 실제 도구와 충돌하면 현재 설치 버전의 스킬에 맞추어 실행 계획을 조정한다. 어떤 명령이 미지원인지 추적할 수 있게 남긴다.

## C.2 Orca의 주요 객체를 정확하게 구분

- **Run:** 지속적인 네임스페이스와 코디네이터 inbox. **Run만 만들었다고 워커가 자동 실행되지 않는다.**
- **Task:** 목표/명세/선행 의존성/검증기준/상태를 보유. 상태는 `pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked` 등을 따른다.
- **Dispatch:** 특정 워커의 특정 시도. 재시도 시 새 시도로 취급. `dispatchId` 없는 완료 메시지를 그대로 신뢰하지 않는다.
- **Messages / Deliveries:** `worker_done`, `status`, `question`, `escalation`, `heartbeat` 등. 코디네이터가 수신·처리한 후 ack한다.
- **Decision Gate:** 동시 변경 충돌·수정 계약·위험 배포 등 결정을 문서화하여 Task 진행을 막는 승인 게이트.
- **Git Worktree:** 작업 충돌을 줄이는 파일 변경 공간. 작업 완료와 코드 통합은 별개의 단계.

## C.3 Run 라이프사이클

1. `docs/blueprint`의 진행상황/백로그를 바탕으로 Run objective를 생성한다. 진행 중인 Run이 이미 있는지 먼저 확인한다. 중복 Run을 남발하지 말라.
2. Run 아래에 Task DAG를 구성한다. 각 Task는 독립 완료 기준과 주관 파일 소유권을 명시한다.
3. `ready` 상태이면서 파일 충돌이 적은 Task를 Worktree에서 워커에게 배정한다.
4. 워커는 구현·테스트·diff·커밋 ID(해당되는 경우)·미검증 사항과 함께 `worker_done`을 **정확히 한 번** 전송한다.
5. 코디네이터가 실제 변경사항/로그/CI 결과를 확인하고 Sol 리뷰 작업을 별도 Task/Dispatch로 시작한다.
6. Sol은 심각도별 이슈, 재현 방법, 파일·라인, 누락 테스트, 보안·설계 위반을 보고한다. 심각 결함이 있으면 작업을 완료로 처리하지 않는다.
7. 실패 시 원래 DeepSeek 담당자에게 리뷰 요지를 주어 수정 작업을 배정한다. 변경된 diff는 다시 검토한다.
8. 테스트·리뷰·계약 검증을 통과한 변경만 integration 브랜치에 병합한다. 병합 후 통합 테스트를 다시 실행한다.
9. 완료한 Task와 의존 작업을 갱신한다. 남은 `ready` 작업을 자동 배정한다.
10. 마일스톤마다 사용자에게 한 페이지 요약을 제공하고 중요한 결정은 게이트로 묻는다.

## C.4 공식 예시 명령 (복사·즉시실행 스크립트가 아님)

아래는 **문법을 이해하기 위한 예시**로서, `<...>`에 실제 ID를 적용하고 설치된 스킬에서 확정한 뒤에만 사용한다. `--agent`/`--model`의 provider가 현 환경에서 매핑됐을 때만 실행한다.

```bash
# 정상 실행 기반 확인
orca status --json
orca skills get orchestration --full

# 새로운 Run 및 Task (첫 승인 후 구현 단계에서만)
orca orchestration run-create --objective "M1: task CRUD and safe MVP slice" --json
orca orchestration task-create --task-title "Task API adapter" --spec "Approved implementation packet ID M1-API-01" --json

# 예시: OpenCode 가 DeepSeek 지정 모델로 실제 구성되었을 때만
orca orchestration worker-start --task <TASK_ID> --worktree new-child --name m1-api --agent opencode --model <VERIFIED_DEEPSEEK_MODEL_ID> --effort <SUPPORTED_LEVEL> --setup run --json

# 코디네이터 메시지 대기, 결과·문의·에스컬레이션 처리 후 ACK
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
orca orchestration check --ack <DELIVERY_ID> --wait --types worker_done,escalation,question --timeout-ms 900000 --json

# Dispatch 상세 및 출력 확인
orca orchestration worker-show --dispatch <DISPATCH_ID> --json
orca orchestration worker-read --dispatch <DISPATCH_ID> --limit 50 --json

# 정상 종료된 감독형 워커의 자원 정리
orca orchestration worker-release --dispatch <DISPATCH_ID> --json
```

실제 `--model`/`--effort` 지원 에이전트 및 CLI 문법은 버전마다 달라진다. `--model`·`--effort`를 기존 terminal 재사용 `--terminal`과 조합할 수 없는 경우가 있다. DeepSeek Harness가 `--model` 옵션을 지원하지 않으면 agent 자체 설정/실행프로필을 검증하여 사용하고, 정확한 모델 매핑이 불가능하면 모델 대체를 자동 결정하지 않는다.

**중요한 ack 규칙:** 한 Delivery에 여러 메시지가 있으면 모두 처리하고 나서 ack한다. 동일한 메시지 재수신·구독 재개에 대비해 처리 결과를 Task ID + Dispatch ID + delivery ID로 멱등 기록한다. 오래된 시도의 `worker_done`이 최신 시도의 결과를 덮어쓰지 못하도록 한다.

## C.5 워커 계약

각 워커는 독립된 구현 패킷을 받고, 패킷 바깥의 파일이나 공유 스키마를 임의 변경하지 않는다.

실행 완료 시 반드시 다음 정보를 포함한다.
- `taskId`, `dispatchId`, 현재 worktree, 변경된 경로 및 주요 diff 요약.
- 요구사항 충족 상태, 실제 실행한 테스트 명령과 결과, 실패/건너뜀 이유.
- 이슈/리스크, 다음 의존 작업에 필요한 새 계약, roll-back 방법.
- Orca의 **정확한 `worker_done`** 성공/실패 메시지(`--outcome succeeded|failed`).
- 장시간 작업 중 필요한 heartbeat를 요청된 간격으로 전송.
- 막힌 결정은 **`orca orchestration ask`**를 사용해 코디네이터에 묻고, 별도 사람 TUI 답변을 기다리지 않음.

**작업 완료는 리뷰 승인과 다르다.** `worker_done succeeded`는 워커의 자기 보고일 뿐, `Accepted`/merged까지의 최종 보증이 아니다.

## C.6 검증자 Sol의 독립성

Sol 리뷰어는 DeepSeek와 가급적 다른 컨텍스트를 사용하고, 코드/요구사항/테스트 출력/변경 전후 diff를 보고 다음 결과를 작성한다.

```text
REVIEW VERDICT: APPROVE | REQUEST_CHANGES | BLOCKED
Severity: CRITICAL | HIGH | MEDIUM | LOW
Evidence: file:line + reproduction / test output
Contract / license / security / migration impact
Required changes vs suggestions
Verification actually executed (yes/no, exact commands)
Residual risks
```

- 변경을 자동 승인하려면 정적 검사·테스트 결과를 먼저 확보한다.
- Sol이 발견한 문제는 DeepSeek 담당 워커에게 별도 패킷/수정 지시로 전달한다.
- 단순 스타일 의견은 차단 사유로 과대평가하지 않는다.
- 모델 리뷰와 테스트가 모두 성공해도 데이터 손실·보안 경계 같은 고위험 작업은 사용자 승인이 필요하다.

## C.7 실패와 재시도

기본 운영 정책 제안:
- 자동 수정 재시도: **태스크당 최대 2회**, 동일 원인 반복 시 BLOCKED.
- 설계 불일치 또는 API 계약 변경: 자동 수정 대신 Opus가 ADR을 갱신하고 영향 태스크의 준비 상태를 재평가.
- 도구 사용량 한도/모델 사용 불가: 다른 모델로 자동 전환하지 않고 **BLOCKED_MODEL_UNAVAILABLE** 기록.
- 독립 워커 2개가 같은 파일 변경: 병합 전에 충돌 발견, 파일 소유권 재배치.
- 무한 루프·워커의 자기 증명·실패를 숨기기 위해 테스트 삭제하는 행위 금지.
- 자원 사용량은 Orca/각 공급자 실제 대시보드로 측정하며 작업별 중단 기준을 갖는다.
- 결과 수신 후 `worker-release`로 자원을 정리하되 보존 필요성이 명시된 경우 `worker-retain` 사용. 실패 영수증의 복구 절차를 따른다.

## C.8 회복·지속성

- 코디네이터 재시작 시 Run/Task/Dispatch/Delivery를 읽어 **현재 실행 중인 워커를 재확인**한 뒤 재배정한다.
- Task가 `dispatched`인데 terminal이 유실됐으면 실제 종료 여부를 runtime scope 및 로그로 검증한다. 중복 dispatch 금지.
- Git commit, immutable task packet, integration status, 리뷰 verdict, 테스트 로그, 결정 이력을 파일 또는 버전관리 시스템에도 남긴다.
- `orca orchestration reset --all` 등 **runtime-global 상태 삭제 명령은 자동화 워크플로에서 절대 실행하지 않는다.**
- 노트북 전원이 꺼져도 에이전트가 실행된다고 가정하지 않는다. 장기 무인 운용은 상시 실행 호스트/원격 런타임을 별도 설계하고 사용자 승인 후 구축한다.
- 복구 시 마지막 확인된 `Accepted` 변경과 현재 작업을 비교하고, 미완료 작업만 다시 스케줄링한다.

## C.9 사용자 승인 게이트와 진행 모드

**Phase D0 — 설계/오케스트레이션 준비(첫 실행, 기본값)**
- 허용: 공식 문서/현재 환경/저장소 읽기, 설계 문서 작성, 모델 바인딩·스킬 가용성의 **읽기 전용 검사**, Task DAG/패킷 생성, Orca 런타임 사전 점검.
- 금지: 의존성 설치·Vikunja 포크 다운로드·소스코드 변경·Docker 실행·테스트 실행·Git 커밋·외부 유료 API 실행 증가·실제 개발 Run/Worker dispatch·배포.
- 출력: 구체적 아키텍처·개발 명세·오케스트레이션 계획·마일스톤과 첫 실행 패킷. **개발 착수라는 한 번의 명시적 사용자 승인**을 기다린다.

**Phase D1 — 승인 후 자율 개발**
- 사용자로부터 개발 시작 승인이 있으면, 검증된 모델·스킬을 이용해 첫 `run-create`, `task-create`, `worker-start`를 수행할 수 있다.
- 마일스톤의 통상 구현/수정/로컬 테스트/리뷰/안전한 dev branch 통합은 사용자 개입 없이 자율적으로 이어간다.
- 변경해야 할 아키텍처 결정, 외부 서비스 비용이 새로 발생하는 작업, 운영 환경 접근, 자격증명, 공개 배포, 파괴적 변경은 사용자 결정 필요.
- 사용자 응답 없이 결정할 수 없는 게이트는 BLOCKED로 유지하고, 독립적인 나머지 작업만 계속한다.

**Phase D2 — 스테이징/프로덕션**
- 개발 배포와 운영 배포를 구분한다. 실제 홈서버에 대한 배포 권한은 별도 승인 후에만 적용한다.
- 공개 상용 서비스·라이선스·법률·보안 위험은 사용자에게 최종 결정을 요청한다.

# D. 아키텍처를 정할 때 준수할 원칙

1. 작업 관련 모든 LLM 결과는 **제안**이며, 일정의 시간 충돌·마감 가능성·기존 약속은 결정론적 검증 엔진이 판단한다.
2. 제품 도메인의 ID/모델/계약은 **Vikunja로부터 독립적**이어야 한다. `VikunjaAdapter` 및 `NativeAdapter`는 동일 계약 테스트를 만족하게 설계.
3. 처음에는 보수적인 모듈러 구조를 선호한다. Docker 홈서버 16GB에 불필요한 분산 구성·Kubernetes를 강제하지 않는다.
4. **사용자 일정 승인 정책**과 **개발 에이전트의 코드 승인 정책**은 다른 시스템이다. 서로 혼동하지 않는다.
5. UI 적응성은 허용된 컴포넌트의 정책 기반 재배치이지, 생성 모델이 임의 JavaScript를 실행하게 하는 것이 아니다.
6. 작업 분해 시 이전 과제 템플릿을 재활용할 수 있지만, 유형 확인·요구사항 변경 확인은 사용자와 인터랙션한다.
7. 3개 계획안은 서로 다른 최적화 전략을 의미해야 하며, 불가능하면 가능한 개수와 이유를 제시한다.
8. 마감·가용 시간·휴식·집중세션 등 하드 제약 위반 0을 목표로 검증 테스트를 설계한다.
9. 1차 제품 개발과 상용화 단계의 데이터 보호·인증·운영 요건을 구분하되, 데이터 이전 경로를 처음부터 남겨둔다.
10. 소스 라이선스와 외부 모델 공급 약관은 제품 아키텍처와 별도의 검토 사항이다.

# E. 프로젝트 단계와 구현 패킷

## E.1 마일스톤

| 단계 | 핵심 산출 | 자율 개발 워커 작업 분할 | 오케스트레이터 검증 |
|---|---|---|---|
| M0 | 요구사항/현행 코드/라이선스 감사, 아키텍처 확정 | 조사 병렬 분업 가능(읽기 전용) | 근거 확인·ADR·승인 게이트 |
| M1 | Vikunja 기반 단일 사용자 작업 CRUD 및 동기화 기초 | Backend/API, Frontend, QA | 공통 계약·실제 UI E2E |
| M2 | 신규/유사 유형 과제 인터뷰와 작업 분해 | Intake, Template Store, UI | 상태기계·LLM 스키마 및 실패 검증 |
| M3 | 3안 일정 스케줄러·승인 반영 | Scheduling, API, Comparison UI | 제약 테스트·원자성·버전 충돌 |
| M4 | Today/Focus/실제시간/알림 | Work session, notification, UI | 실제기록·알림 중복 테스트 |
| M5 | 피드백 학습·지연 감지·재계획 | Estimation, Agent, UI | 일정 안정성·재현성·회귀 테스트 |
| M6 | 노트 맥락·적응형 레이아웃 | Knowledge, UI policy, E2E | 프롬프트 인젝션·접근성 검증 |
| M7 | 자체 백엔드 교체 리허설 및 출시 준비 | Native adapter, migration, ops | 데이터 무결성·라이선스·보안 게이트 |
| 이후 | 공모전 검색·2개월 장기 계획 등 | 별도 독립 에픽 | 데이터 출처·자격요건 정확성 |

위 내용은 출발점이다. 의존성·제품 가치 검증에 따라 ADR로 조정하라. 일괄 코딩을 시작하기 전에 M1의 작은 수직 기능을 먼저 통과시킨다.

## E.2 Worker Implementation Packet 표준

```markdown
# TASK PACKET: <ID> — <title>
- Run ID / milestone / priority:
- Owner model & agent CLI (verified):
- Objective & user-visible acceptance:
- Related PRD / ADR / contracts:
- Dependencies and required base commit:
- Worktree / branch and allowed paths:
- Forbidden paths, operations, files:
- Required inputs/outputs / schema changes:
- API / DB and time-zone / privacy rules:
- Edge cases & negative tests:
- Exact tests and expected assertions:
- Expected review evidence (diff, logs, screenshot if UI):
- Commit/output artifact and worker_done contract:
- Retry limit and escalation route:
- Rollback and clean-up:
```

패킷은 독립 검증이 가능한 크기로 쪼개고, `file ownership`이 겹치지 않게 구성한다. 공통 API/DB 변경이 필요하면 먼저 계약 Task를 완료시키고 의존 태스크가 그 확정본을 기준으로 구현하게 한다.

## E.3 품질 게이트

- **G0 설계:** PRD·도메인·API/DB 모델·라이선스 이슈·오케스트레이션 작동성 검사.
- **G1 워커 내부:** 타입검사·빌드·단위테스트·변경범위·근거.
- **G2 Sol 독립 리뷰:** 정확성·성능·보안·동시성·스키마 위반·누락 테스트.
- **G3 통합:** 브랜치 병합 후 전체 관련 테스트 및 충돌 확인.
- **G4 마일스톤:** 관련 E2E 시나리오 및 실제 사용자 워크플로를 검증.
- **G5 스테이징/운영:** 백업·복구·보안 검증 및 별도 사용자 승인.

테스트 실패를 수리하기 위해 테스트를 삭제하거나 부적절하게 완화하지 말 것. 리뷰어도 실수할 수 있으므로 적어도 정적 검사·정의된 테스트·명세 대조가 독립적인 증거로 남아야 한다.

# F. 파일·문서 관리 및 설계 결과

디자인 단계에서 작성해야 하는 문서 (있는 파일은 무단 덮어쓰기 하지 말고 먼저 상태를 확인):

```text
docs/
  blueprint/
    00-INDEX.md
    01-PRODUCT-REQUIREMENTS.md
    02-REPOSITORY-AUDIT.md
    03-ARCHITECTURE.md
    04-DOMAIN-AND-DATABASE.md
    05-AI-AGENT-SPEC.md
    06-SCHEDULER-SPEC.md
    07-ADAPTIVE-UI-SPEC.md
    08-API-AND-EVENT-CONTRACTS.md
    09-OPERATIONS-SECURITY.md
    10-LICENSE-AND-MIGRATION.md
    11-TEST-AND-EVALUATION.md
    12-ROADMAP-AND-BACKLOG.md
    13-ADR.md
    14-IMPLEMENTATION-HANDOFF.md
  orchestration/
    ORCA-RUNTIME-AUDIT.md
    MODEL_BINDINGS.md
    AGENT-ROLES.md
    RUN-AND-TASK-DAG.md
    WORKER-AND-REVIEW-CONTRACT.md
    FAILURE-AND-RECOVERY.md
    PERMISSION-AND-COST-POLICY.md
    EXECUTION-LEDGER.md
  AGENTS-DRAFT.md
```

각 문서에서 **확인된 사실 / 가정 / 결정 / 미결정 질문**을 구분한다. 실제 실행에 사용할 명령은 최신 로컬 CLI help/skill에서 검증된 것만 작성한다. 설치되지 않은 agent/모델을 설치됐다고 가정하지 않는다. `AGENTS-DRAFT.md`는 코딩 규칙 초안이지 자동 적용 파일이 아니다.

**첫 보고 형식:**
1. 현재 Orca Runtime / 설치된 `/orchestration` skill / 모델 실제 바인딩 현황(`VERIFIED`, `UNVERIFIED`, `BLOCKED`).
2. 제품 핵심 아키텍처와 대안, 선택 근거, Vikunja 교체 가능 경계.
3. 위험 요소 및 사용자 승인이 필요한 최소 핵심 결정.
4. 작성한 문서의 경로·완료도·미검증 사항.
5. M0→M1 우선순위 Task DAG와 첫 2~3개 Worker Packet, reviewer gate.
6. 다음 단계로 넘어가기 위한 단일 승인 요청: **“설계를 승인하고 자율 개발 Run을 시작할까요?”**

질문을 남발하지 않는다. 실제로 조사할 수 없는 사실은 `[미검증]`으로 밝히고 합리적 가정 아래 설계를 완성한다. 초기에 모델 바인딩 실패가 있더라도 제품 설계 자체는 끝낸다.

# G. 공식 문서 우선 참조(2026-11-11 확인 출발점)

- Orca: https://www.onorca.dev/
- Orchestration: https://www.onorca.dev/docs/cli/orchestration
- Skill registry: https://www.onorca.dev/docs/cli/skills
- CLI reference: https://www.onorca.dev/docs/cli/reference
- Supported agents: https://www.onorca.dev/docs/agents/supported
- Vikunja source: https://github.com/go-vikunja/vikunja
- Vikunja docs: https://vikunja.io/docs/

설계 시 반드시 최신 문서와 설치된 버전을 재확인하고, 조사일·출처 URL·실제 커맨드 출력 근거를 남긴다. 이 문서에 기재된 Opus/DeepSeek/Sol 모델의 요청 명칭은 **사용자 환경 설정 목표**이지, 현재 CLI에서 해당 provider ID가 작동한다고 검증한 사실이 아니다.

---

# H. 제품 및 기술 요구사항 상세 원문(새 환경에 맞게 계승)

아래의 제품 요구사항과 컴포넌트/계약 조건은 과거 설계에서 확정된 사용자 의도이며, 위의 Orca 오케스트레이션 운영 계약과 함께 따라야 한다. 구체 구현 기술은 새 저장소 감사 결과에 따라 ADR로 조정할 수 있다.

# 2. 제품 정의와 범위

이 제품은 단순 To-do 앱, 일기장, AI 챗봇이 아니다. 핵심은 **목표 등록 → 맥락 수집 → 작업 분해 → 계획 생성 → 사용자 승인 → 일별 수행 → 실제 시간 확인 → 점진적 개인화 → 필요시 재계획**의 폐회로다.

## 2.1 필수 사용자 시나리오

### 시나리오 A: 처음 등록하는 유형의 과제
1. 사용자가 과제명, 마감일, 설명 또는 과제 파일을 등록한다.
2. AI가 기존 경험과 비교해 새 유형인지 판단한다. 확신도와 판단 근거를 남긴다.
3. 새로운 유형이거나 정보가 부족하면 **이미 제공된 정보를 되묻지 않는 동적 인터뷰**를 시작한다. 과제의 요구사항, 산출물, 선수지식, 현재 진행률, 우선순위, 마감일, 한 번에 몰두 가능한 시간, 요일별 가용 시간 등을 **최소 질문**으로 파악한다.
4. AI가 단계와 하위 작업, 작업 간 선후관계, 추정 시간, 불확실성 및 검수·완충 시간을 제안한다.
5. 일정 엔진이 기존 약속/다른 과제/휴식/집중 세션 한도/마감 시각을 고려하여 **실제로 가능한 세 가지 차별화된 계획**을 생성한다.
6. 사용자는 비교 화면에서 계획을 선택·편집·확정한다. 확정 전에는 실제 일정을 일방적으로 수정하지 않는다.
7. 일일 일정과 알림이 생성된다.

### 시나리오 B: 과거와 유사한 과제
1. AI는 과거 템플릿·설명·수행 기록을 근거로 유사성을 탐지한다.
2. “이전에 했던 유형과 같은가?”를 확인한다. 사용자가 아니라고 하면 새 유형으로 처리한다.
3. 맞으면 과거 단계 구성과 실제 시간 패턴을 제시하되 이번 과제의 요구사항 차이를 묻는다.
4. 기존 템플릿을 무조건 강요하지 않고 최신 요구사항에 맞게 수정·재추정한다.

### 시나리오 C: 일일 실행 및 체크인
1. 하루가 시작되면 당일 작업 2~3개 등 부담이 적은 우선순위 뷰를 보여준다.
2. 사용자는 일일 계획을 수락·축소·재배치할 수 있다.
3. 집중 세션을 시작/중단/완료하고 실제 집중 시간과 총 경과 시간을 구분해서 기록한다.
4. 완료·부분 완료·미완료 시 이유를 **짧고 부담 없는 방식**으로 확인한다.
5. 예상보다 빨리 끝나거나 늦어졌다면 예측을 업데이트하되, 매번 전체 일정을 흔들지 않는다.
6. 마감 위험/충돌이 새롭게 발생할 때만 합리적인 재계획을 제안하고 사용자가 승인한다.

### 시나리오 D: 노트·참고문서 맥락
- 목표/프로젝트/작업에 Markdown 기반 노트, 링크, 이미지/첨부파일, 체크리스트, 결정 사항을 연결한다.
- 노션/옵시디언 같은 맥락 편집을 지향하되 최초 버전에서는 거대한 블록 편집기 전체를 만들지 않는다.
- AI가 특정 작업에 관련된 자료만 검색해서 요약·계획에 사용하며, 어떤 근거를 활용했는지 표시한다.
- 원문 저장, 권한, 요약 인덱스, 검색·삭제·수정 반영을 설계한다.

### 시나리오 E: 적응형 레이아웃
- 계획 중: 계획 후보 비교·시간표·마감 현황 중심.
- 집중 작업 중: 타이머·현재 할 일·관련 노트 중심.
- 마감 위험: 부족 시간·충돌·변경 후보 중심.
- 일반 일상: 오늘 해야 할 최소 행동 중심.
- 사용자가 패널을 고정하거나 수동 배치를 선택할 수 있고 자동 전환을 끌 수 있다.
- 반응형 Windows/Linux/Android UI. 접근성, 키보드, 터치, 화면 크기를 고려한다.

### 시나리오 F: 장기 계획/공모전(후속 단계)
- 관심 분야의 공모전·대외활동을 검색·검증하고, 공고의 마감일·제출물·참가 조건을 원문 출처와 함께 가져온다.
- 참여 여부를 사용자가 결정하면 1~2개월 이상의 장기 계획으로 등록한다.
- 먼 미래는 거친 마일스톤, 가까운 1~2주는 상세 작업으로 계획하는 rolling-wave planning을 지원한다.
- 외부 정보 검색·스크래핑의 합법성/이용 약관/출처 검증은 별도 요건으로 명시한다. **MVP에서는 구현하지 않음.**

## 2.2 반드시 명세할 제품 요구사항

- 작업(Task)과 시간 고정 약속(Event/Commitment), 목표(Goal), 프로젝트(Project), 계획(Plan), 시간 블록(Schedule Block), 실제 수행 세션(Work Session), 노트(Context Document)를 구분한다.
- 임의의 자연어로 일정 생성/변경을 요청하더라도 승인·검증 절차를 거친다.
- 새로운 작업 등록 시 AI 질문이 과도하지 않아야 하며, 건너뛰기·직접 작성 경로를 제공한다.
- LLM 실패, API 비용 초과, 네트워크 끊김에도 이미 저장한 일정 조회와 수동 편집은 계속 가능해야 한다.
- 동기화 실패와 다중 기기 동시 수정의 충돌 정책을 명세한다.
- 알림 중복, 과도한 재계획, UX 깜빡임/급격한 화면 이동을 제한한다.
- 개인화가 잘못된 과거 데이터를 지나치게 신뢰하지 않도록 신뢰도·수동 보정·초기화 기능을 설계한다.
- 사용자 기록이 없는 cold-start 경우에 사용할 기본 템플릿과 보수적 추정 방식을 정의한다.
- **범위 밖(non-goals)**: 초기 다중 사용자 협업, 결제/청구, 자체 LLM 학습, 거대한 문서 에디터 제작, 실시간 음성 에이전트, 공모전 자동 등록/제출.

# 3. 사전 조사: 실제 코드베이스와 외부 제약 검증

설계를 시작하기 전에 아래 사실을 가능한 한 확인하라. 검증 결과는 **확인한 날짜, 정확한 URL 또는 로컬 경로, 버전/커밋, 명령과 근거**를 함께 기록하라.

1. Orca 작업 디렉터리와 로컬 Git 저장소 존재 여부, 읽기 가능한 `AGENTS.md` 및 기존 설정. 단, 사용자 인증정보나 비밀값을 출력하지 않는다.
2. 공식 Vikunja 저장소 `https://github.com/go-vikunja/vikunja`의 **현재 안정 릴리스와 태그**, 디렉터리 구조, 프런트엔드/백엔드 스택, 현재 개발·빌드·테스트 절차. 개발 브랜치가 아닌 **검증된 태그 고정**을 우선 검토.
3. API v2 지원 범위, OpenAPI 접근 방식, Task/Project/Relation/Reminder/Attachment/Comment 관련 실제 지원 API, 웹훅·인증·캘린더·데이터 내보내기 지원.
4. 작업시간 기록·Pro 기능 등 **OSS와 별도 라이선스 기능의 경계**, 직접 구현해야 하는 영역.
5. `AGPL-3.0-or-later`, 데스크톱 또는 서브디렉터리의 별도 라이선스, 프런트엔드 복사/수정과 네트워크 제공의 의무를 원문 기준으로 구분. 라이선스 해석을 법률 확정처럼 단언하지 말고 **출시 전 법률 검토 필요**를 명시.
6. 최신 개발 환경 요구사항. Go/Node/pnpm/Python/PostgreSQL 버전을 확인하고 **검증 없이 특정 버전을 고정하지 말 것**.
7. 의존성 취약점, 알려진 개발상 제약 및 업스트림 갱신 부담.

참고 시작점(사실로 단정하지 말고 최신 내용 검증에 사용):
- Vikunja 저장소: https://github.com/go-vikunja/vikunja
- 공식 개발 문서: https://vikunja.io/docs/development/
- 공식 API v2 문서: https://vikunja.io/docs/api-v2/
- 공식 프로젝트 구조: https://vikunja.io/docs/project-structure/
- Orca 공식 문서: https://www.onorca.dev/docs/cli/orchestration

**비교해야 할 초기 구현 방식:**
A. Vikunja를 직접 포크해 프런트와 백엔드를 광범위하게 수정.
B. Vikunja를 포크하지만 API 어댑터를 거쳐 별도 앱/AI 서비스를 붙임.
C. Vikunja를 거의 수정하지 않고 외부 커스텀 클라이언트를 사용.

사용자의 **실제 의도는 포크와 UI 대수정**이다. 따라서 이를 무시하지 말고, 비용/유지보수/라이선스/이전 가능성을 비교한 후 **초기 포크 계획과 최종 독립 이전을 양립시키는 설계**를 선택하라.

# 4. 아키텍처 설계 원칙

1. **Domain First:** AI, Vue 컴포넌트, Vikunja API가 아닌 제품 고유의 도메인 타입/규칙을 먼저 정의한다.
2. **Vendor/Upstream Isolation:** Vikunja 전용 ID·필드·관계·오류 형식은 `VikunjaAdapter` 및 Anti-Corruption Layer에서 공통 도메인 모델로 변환한다. 자체 비즈니스 로직에서 Vikunja DB에 직접 쓰지 않는다.
3. **Deterministic Core:** LLM은 이해·질문 생성·단계 제안·설명에 사용하고, 시간 충돌·마감 가능성·작업 의존성·분 단위 배분은 검증 가능한 결정론적 일정 엔진이 책임진다.
4. **Human-in-the-Loop:** 일정 생성·삭제·대량 수정·공개 공유·외부 전송은 명시된 정책과 사용자 승인을 따른다. 자동 실행 가능한 범위를 단계별로 정의한다.
5. **Single-User First, Multi-User Ready:** 초기 복잡한 마이크로서비스와 분산 인프라를 피하되, 데이터 모델은 향후 사용자 격리·테넌트·권한을 수용한다.
6. **State & Observability:** 이벤트 로그, 추정값/실측값, 계획 버전, 변경 사유, 에이전트 판단 근거(민감 데이터 최소화)를 저장한다.
7. **Graceful Degradation:** LLM/인터넷/알림 서비스 장애 시 수동 일정관리 기능 보존.
8. **Security/Privacy by Design:** 기본적으로 홈서버의 사적 데이터. 외부 LLM 전송은 최소 범위·동의·비밀값 마스킹·보존 정책 적용.
9. **Replaceability:** 이후 Vikunja → Native backend 전환 시 프런트·AI·스케줄러의 재작성 범위를 최소화한다. **교체 비용을 실제 테스트로 검증**한다.
10. **Operational Simplicity:** i7-8700/16GB 홈서버에서 도커 자원·디스크·백업·복구·모니터링을 감당할 수 있게 설계한다.

## 4.1 서비스 경계 후보

아래를 출발점으로 검토하고 **필요한 경우 통합 또는 분리**하라.
- `planner-client`: Vue 3 + TS, 적응형 대시보드, 작업/노트 편집, 세 계획 비교, 로컬 상태/동기화.
- `application-api`: 공통 DTO와 도메인 서비스, 인증 경계, 승인 절차, UI가 사용하는 유일한 논리적 API.
- `task-provider-vikunja`: Vikunja와의 API 연동, ID 매핑, 업스트림 확장 코드.
- `planner-core`: 작업 분해 및 재사용 템플릿, 추정 모델, LLM 오케스트레이션.
- `schedule-engine`: 하드/소프트 제약 평가, 후보 생성·점수화, 검증·재계획.
- `knowledge`: 노트/첨부파일/검색·관련 문맥 선정.
- `worker`: 체크인, 알림, 백그라운드 작업, 재시도·멱등성.
- `data`: PostgreSQL 및 필요한 스토리지.

**반드시 비교:** Go API에 통합하는 모듈러 모놀리스 vs Python 별도 서비스 1개 추가 vs 다수 독립 서비스. 1인 개발과 홈서버 운영 비용을 수치 또는 구체적인 근거로 비교하고, 초기 단계에서 불필요한 Kubernetes/메시지 브로커를 강제하지 말 것.

# 5. AI 에이전트 세부 명세

아래 항목을 상태 기계, 입출력 JSON Schema, 실패 모드, 사용자 확인 UX를 포함해 명세하라.

- Intake 상태: `created → type_detection → clarification → decomposition → feasibility_check → plan_proposals → awaiting_approval → scheduled` 및 `cancelled/needs_input/failed` 등.
- 유사 유형 탐지: 태그·프로젝트·메타데이터/문서 유사성·과거 템플릿 조합. 유사도 confidence와 explainability, 오탐 시 사용자 교정.
- 동적 질문 전략: 어떤 필드가 필수인지, 질문 수 상한, 누락 요구사항, 사용자가 모른다고 답했을 때 기본값/보수적 추정.
- 단계 생성: 산출물/검수 조건이 있는 작고 실행 가능한 단위, 지나친 세분화 방지, 의존 그래프 DAG, 병렬 가능성, 집중 세션 분할, 준비·검토 단계.
- 시간 추정: 최초 사전분포, 사용자 기록 기반 보정, 예측 구간(단일 추정치만 쓰지 않음), 추정 근거, cold start, 학습 데이터 품질.
- 행동 분리: LLM은 `proposed actions`만 작성, 스키마 검증→권한 검증→제약 검증→사용자 승인 후 실제 반영.
- LLM 모델 교체성: 특정 사업자 SDK의 의존성 격리, token/cost 계측, 재시도·rate limit·timeout·fallback, 프롬프트 버전 관리.
- LLM 환각/프롬프트 인젝션 방어: 첨부 문서나 외부 페이지는 불신 입력으로 취급, 시스템 권한 상승 금지, 실행 명령·URL 자동 접근 제한, 노트 요약 오염 가능성.
- 문맥 메모리: 사용자 명시 설정, 기존 수행 기록, 프로젝트 노트, 사실/추정 분리, 출처와 갱신 시각, 잘못된 기억 교정/삭제.
- 에이전트가 언제 자동으로 개입할지(이벤트), 언제 조용히 있을지(노이즈 제어), 언제 승인을 요청할지 정책.
- 사용자 프라이버시: 어떤 데이터가 LLM에 전달되는지, 외부 전송 동의와 민감정보 제외, 저장·삭제·내보내기.

**최소 3가지 실패 사례와 복구 상태**를 도식화하라. 예: 요구사항 모순, LLM이 존재하지 않는 작업을 참조, API 호출 중간 실패, 사용자가 후보 승인 직전에 기존 일정을 변경.

# 6. 일정 최적화 엔진 상세 명세

일정 제안은 **실제 실행 가능한 후보 3개**가 원칙이며, 충분히 서로 다른 후보를 만들 수 없다면 3개를 억지로 생성하지 말고 가능한 후보 수와 이유를 설명하라.

## 6.1 입력
- 마감일/시각, 시간대, 예상 소요 시간의 분포/신뢰도.
- 작업 DAG, 분할 가능 여부, 최소/최대 세션, 마감 전 검수/버퍼.
- 사용자의 요일별 가용 시간, 수면/식사/고정 일정, 휴식 선호, 집중 시간대.
- 이미 승인된 작업 블록, 이동 불가능한 약속, 일정 변경 비용.
- 우선순위, 리스크 허용 수준, 하루 최대 집중 업무량, 피로/전환 비용의 단순 모델.

## 6.2 제약과 목표
- 하드 제약: 중복 금지, 마감 준수, DAG 선후관계, 시작 가능 시점, 세션·가용 시간 제한, 시간대 처리.
- 소프트 제약: 일일 작업 분산, 조기 완료, 적합 시간대 활용, context switching 감소, 기존 일정 유지, 개인 선호.
- 비현실적 계획 생성 금지: 확보 가능 시간이 부족하면 deficit 계산 및 실제 선택지 제안.
- 세 가지 정책: `front_loaded`(조기 완료), `balanced`(균등 분산), `focus_blocked`(집중 블록). 각 정책의 목적함수, 기대 효과, 부작용, 선택 조건, 가중치 공개.
- 후보 다양성: 서로 다른 목적함수/제약 및 유사도 비교. 단순 색·명칭 차이를 후보로 세지 않는다.
- 결과 설명: 일정별 총 집중 시간, 마감 여유, 예상 일일 부담, 일정 변경량, 부족 시간, 불확실성.
- 장기 계획: rolling-wave planning 및 가까운 작업만 확정.
- 실제 수행 후 재계획: 변경이 필요한 블록만 최소 변경하고 일정 안정성/경고 피로를 고려.

## 6.3 알고리즘과 검증
- MVP는 결정론적 휴리스틱, 필요 시 OR-Tools CP-SAT와 비교. 병렬 구현하지 말고 선택 기준 제시.
- 현실성·최적성의 의미를 정의(완전한 수학적 전역 최적 해를 보장하는지 여부 등). 자의적 “최적” 표현 금지.
- 다양한 입력에 대한 **Golden Test Cases** 최소 12개: 2시간밖에 없는 마감, 주말만 가능, 단계 의존성, 중간 일정 삽입, 하루 최대 집중시간, 시차/서머타임, 시작 시각이 마감보다 늦음, 과대/과소 추정, 반복 일정 충돌, 휴일, 불가능한 일정, 계획 변경 전후 재현성.
- 객관적인 품질 지표: hard constraint violation = 0, 일정 생성 시간 목표, 계획 간 다양성, 마감 여유, 재계획 변경량, 실제 수행률, 과소추정 빈도.

# 7. 적응형 프런트엔드·디자인 시스템 명세

사용자 의도는 단순 반응형 UI가 아니라 **상황에 따라 레이아웃과 정보 우선순위가 적응하는 제품**이다.

- 초기 UI는 Vikunja를 기반으로 시작하지만, 이후 자체 Vue 앱으로 이동할 수 있는 컴포넌트·스토어·API 구조 비교.
- 앱 내 주요 상태: `overview`, `planning`, `focus`, `deadline_risk`, `review`, `notes` 등.
- `Context Observer → Layout Policy → Component Registry → Renderer` 구성을 설계하고, AI는 임의 HTML/JS가 아니라 **검증된 레이아웃 JSON 계약**만 제안 가능.
- 프런트는 허용된 컴포넌트 및 프로퍼티만 렌더링. 사용자 설정/접근성/기기별 한계가 AI 추천보다 우선.
- 핵심 메뉴/내비게이션 고정, 작업 중 패널 갑작스런 제거 금지, 사용자가 고정한 레이아웃 보호, 전환 빈도 제한(hysteresis), undo/원복, fallback.
- Windows/Linux: 키보드·큰 화면·멀티패널. Android: 터치·작은 화면·알림·네트워크 중단.
- UI 구성: Today, Inbox, Calendar, Project, Planning Wizard, Plan Comparison, Focus Mode, Review, Notes, AI Chat, Settings.
- 프로젝트별 노트는 Markdown부터 시작하되 기존 Vikunja 설명란과 별도 지식 시스템 사이의 경계를 명확히 할 것.
- 접근성: 키보드 전용 탐색, 스크린리더 의미론, 대비, 애니메이션 감소, 컴포넌트 안정성.
- 오프라인/동기화: 초기에는 캐시된 읽기 + 명시적 오프라인 제한을 허용하는지, 오프라인 편집 큐까지 만들지 비교 결정. 동시 수정 충돌 전략(낙관적 잠금/버전/ETag 등)과 중복 생성 방지 필수.
- 제품 UI의 기본 원칙: “사용자가 지금 **착수할 하나의 다음 행동**을 쉽게 찾는다.”

각 주요 화면에 대해 상태 전이, 사용자 액션, 서버 요청, 빈 상태, 로딩/오류, 모바일 화면 배치의 텍스트 와이어프레임을 제공하라.

# 8. 데이터 모델·API·이벤트 계약

ERD/테이블 명세와 대표적인 JSON 예시를 작성하라. 최소 객체:

- `User`, `Goal`, `Project`, `Task`, `TaskDependency`, `CommitmentEvent`.
- `TaskTemplate`, `TaskTypeFingerprint`, `IntakeSession`, `IntakeAnswer`.
- `Estimate`, `EstimateEvidence`, `AvailabilityRule`, `AvailabilityException`.
- `Plan`, `PlanCandidate`, `PlanVersion`, `ScheduleBlock`, `ScheduleApproval`.
- `WorkSession`, `TaskCompletionReview`, `EstimationFeedback`.
- `ContextDocument`, `DocumentLink`, `AttachmentMetadata`.
- `AgentRun`, `AgentProposal`, `AgentEvent`, `Notification`, `AuditEvent`.
- `ExternalProviderMapping` 또는 이에 준하는 Vikunja 외부 ID 맵.

모든 객체의 책임, 키, 관계, 삭제·보존, 개인정보 처리, 소유권, 생성/수정 타임스탬프, concurrency version, 인덱스 요구를 정의한다. 지나친 스키마 분해가 부담되면 MVP 통합 테이블을 제안하고 후속 분리 조건을 설명할 것.

다음 API 계약을 반드시 포함하라.
- 새 작업 등록과 인터뷰 시작/응답/중단/재개.
- 유사 작업 확인과 템플릿 선택.
- 작업 분해 초안 조회/수정/승인.
- 일정 후보 3개 생성/비교/선택, 승인 시 원자성·중복 요청(멱등 키)·충돌 감지.
- 오늘 할 일 조회, 세션 시작/일시정지/완료, 완료 피드백.
- 지연 감지·재계획 제안·사용자 승인/거부.
- 노트 CRUD/검색과 AI 문맥 선택.
- UI 레이아웃 정책 조회/사용자 override.
- 알림 상태 및 기기별 구독.
- 백업/데이터 내보내기/계정 삭제.

각 엔드포인트에 대해 HTTP 방식/경로, 인증, 입력·출력 DTO, 상태 코드, 오류 모델, 멱등성, 권한, 타임존, 낙관적 잠금을 명세하라. 프런트와 백엔드 타입 계약의 단일 소스(OpenAPI/스키마 생성 등)를 제안하라.

이벤트 방식(웹훅/내부 큐/DB outbox/주기 재조정)은 **초기 1인 홈서버에 적합한 최소 구성**부터 비교하라. 외부 웹훅이 누락되거나 중복될 수 있음을 전제로 **중복 처리 방지 + 상태 재확인**을 명세하라.

# 9. 배포·운영·보안·데이터 보호

다음 항목을 개인용 운영과 외부 공개 상용 운영으로 명확히 분리해서 제시하라.

1. Ubuntu 노트북 개발환경과 홈서버 운영환경의 구분, 빌드·테스트·이미지 배포 흐름.
2. Docker Compose 구성도: API, Vikunja(초기), DB, planner 서비스, worker, reverse proxy, 알림 등. 컨테이너별 대략적인 메모리·CPU·스토리지 요구 및 16GB 한계 하의 예산. **실측이 아닌 예상은 [추정]으로 표시**.
3. OS/DB/첨부파일 저장 위치: SSD에 OS/DB/컨테이너 상태, HDD에 대용량 데이터. HDD 1개는 백업이 아님. DB 정기 백업과 복구 테스트.
4. 외부 접속: 초기 사설 VPN(Tailscale 등) vs 공개 서비스 TLS/도메인/인증/보안 프록시. SSH·DB·Docker 소켓 직접 공개 금지.
5. 인증·권한: 최초 단일 사용자, 향후 다중 사용자, 서비스 계정, API 토큰, 비밀키 회전, 최소 권한.
6. LLM API 키·민감 노트·로그 보호. 로그에 사용자 노트/비밀을 무차별 저장하지 않음.
7. 보안 위험: prompt injection, CSRF/XSS/SSRF, 취약한 첨부파일, 업로드 제한, 경로 탐색, rate limiting, 테넌트 간 데이터 누출.
8. 장애 대응: 인터넷 단절, LLM 장애, DB 미접속, 디스크 꽉 참, 서버 재부팅, 정전, 백업 실패, 스케줄러 중복 실행.
9. 로그, 메트릭, 알림, 건강검진, Docker 이미지 태그 고정, 의존성 업데이트, 보안 패치와 업스트림 병합 전략.
10. RPO/RTO는 요구사항에 맞는 목표값을 **제안**하고, 실제 검증할 복구 시나리오 정의.
11. 접근 로그·개인 데이터 보존과 삭제, 사용자가 AI 기억을 수정/삭제·내보내기 할 수 있는 기능.
12. 향후 상용화 시 결제·인증·관측성·백업·데이터 정책·운영 인프라 전환 시나리오를 별도 단계로 명세.

# 10. Vikunja → 자체 제품 전환·라이선스 로드맵

이 프로젝트의 최중요 구조적 요구사항이다. 다음을 별도 설계로 만들어라.

- **초기:** Vikunja 포크, 기존 작업 관리 기능 활용, 일부 UI 변경.
- **중간:** 커스텀 클라이언트/API가 우선되고 Vikunja는 교체 가능한 백엔드로 축소.
- **후기:** `NativeTaskRepository`·자체 인증/작업·프로젝트 관리로 교체, 데이터 이전 후 Vikunja 제거.
- 사용자 데이터는 처음부터 자체 표준 ID를 부여하고 Vikunja ID를 `ExternalProviderMapping`에 둔다. 별도 AI 데이터와 핵심 템플릿/이력은 포크 내부 구조에 종속시키지 않음.
- UI를 대수정하더라도 향후 폐기할 영역과 장기 보존할 영역을 코드/디렉터리/라이선스 관리 관점에서 구분.
- 데이터 이전 시 마이그레이션 순서, 매핑, 무결성 체크, 체크섬/행 개수, 첨부파일, 반복 일정, 권한, 시간대, 롤백, 다운타임, 이중쓰기 또는 freeze-and-import의 선택 기준.
- 동일한 TaskRepository 계약에 대해 Vikunja 구현과 Native 구현이 **동일한 계약 테스트**를 통과하도록 설계.
- **라이선스 위험 등록:** Vikunja 포크/프런트엔드 수정/네트워크 제공, 코드 복사/파생성, 서드파티 패키지 라이선스를 분리하여 분석. 독립 개발 코드는 원본 코드 복사 없이 작성하되, 이것만으로 법적 독립성이 자동 보장된다고 주장하지 말 것. 법률 전문가 확인이 필요한 사항을 명시.
- 향후 자체 서비스로 전환해야 할 **기술적 트리거**를 제시: API 한계, 업스트림 병합 비용, 성능 요구, 다중 사용자 요구, 라이선스 목표, 데이터 모델 제약 등.

# 11. 검증 전략 및 성공 지표

설계 문서는 “개발할 것”에서 끝나서는 안 된다. 검증 가능한 지표와 합격 기준을 세워라.

- 단위 테스트: 일정 제약, 예상 시간 보정, DAG, 데이터 모델, 권한.
- 속성 기반 테스트: 어떤 입력에서도 하드 제약 위반이 없도록 검증.
- 통합 테스트: Vikunja API 어댑터, DB 트랜잭션, 승인·취소·재시도.
- 계약 테스트: API 스키마, Vikunja와 Native TaskRepository의 동일 동작.
- E2E 테스트: 신규 과제 등록 → 질문 → 단계 분해 → 3개 일정 비교 → 승인 → 체크인 → 완료 → 재계획.
- AI 평가: 질문 적합성, 단계 누락, 환각, 계획 불가능성 탐지, 문맥 근거, 유사 유형 오탐, 프롬프트 인젝션 방어.
- 성능·운영: 16GB 서버에서 정상 동작, UI 초기 응답, 일정 생성 지연, LLM 비용, 백업/복구.
- 사용자 경험: 계획 승인율, 제때 완료한 작업 비율, 추정 오차, 주간 재계획 횟수, 알림 피로, 일정 편집에 든 노력, 실사용 지속률.
- 개인정보 삭제/내보내기 테스트, 모바일 접근성·오프라인 제한 검증.

성공 지표에 임의의 절대값을 넣었다면 **[초기 목표/가정]**이라고 표시하고 왜 해당 수준을 선택했는지 설명하라. 측정이 불가능한 추상 지표를 피하라.

# 12. 개발 로드맵과 실행 단위

시간 약속을 함부로 하지 말고, **작업 난도·의존성·검증 조건** 중심으로 순서와 범위를 정하라. 각 단계가 끝날 때 실제로 사용 가능한 수직 기능(vertical slice)이 하나씩 늘어나도록 설계한다.

권장 초안:
- `M0`: 현행 코드/라이선스 조사, 제품·아키텍처 결정, 개발환경 계획.
- `M1`: Vikunja 기반 로그인·작업 CRUD·클라이언트 동작, 안전한 개발/운영 Docker 명세.
- `M2`: 과제 등록·동적 질문·유사 유형 확인·단계 분해, 수동 승인.
- `M3`: 세 가지 일정 후보·제약 검증·일정 선택 및 원자적 반영.
- `M4`: Today 뷰, 집중 세션, 종료 피드백, 알림.
- `M5`: 실제 시간 기반 예상 업데이트, 지연/조기 완료 감지, 최소 변경 재계획.
- `M6`: 노트 맥락, 관련 문서 검색, 적응형 UI, 개선된 UX.
- `M7`: 사용자 데이터 이전 리허설, Native 백엔드 대체, 독립 상용화 준비.
- `M8+`: 공모전 검색, 장기 프로젝트, 고급 동기화, 다중 사용자 확대.

위 단계를 무조건 수용하지 말고 **선행 의존 관계와 조기 가치 제공** 관점에서 조정해라.

각 마일스톤마다:
1. 목표/비목표.
2. 완료 후 가능한 사용자 시나리오.
3. 구현해야 할 컴포넌트와 인터페이스.
4. 필수 테스트 및 수락 기준(DoD).
5. 의존하는 선행 작업.
6. 주요 위험/보류할 기능.
7. DeepSeek 워커 및 Sol 리뷰어에게 위임할 **독립 PR/작업 티켓**.

티켓은 가능하면 1~3개의 주요 변경 목표로 작게 분리하고, **대상 디렉터리, 구현 규약, 입력/출력, API/DB 영향, 테스트 명령(확인된 경우), 허용된 파일 수정 범위, 완료 판정, 롤백 방법**을 명시한다.



---

# I. 실행 직전 오케스트레이터 최종 검증

1. 대상 Orca가 정확히 `onorca.dev` 제품인가? `/orchestration` 전체 스킬을 해당 버전으로 읽었는가?
2. 실제 모델/effort와 요청된 세 역할이 정확히 일치하는가? 근거 없는 alias/강등은 없는가?
3. Run이 이미 존재하는지 확인했는가? Run 단독 생성과 워커 실행을 혼동하지 않았는가?
4. 모든 워커 작업에는 명확한 의존관계와 파일 소유권, 테스트, rollback이 있는가?
5. `worker_done`에 taskId와 dispatchId가 있으며 수신 delivery는 ack했는가?
6. 리뷰어가 실제 diff와 테스트를 보았는가? 자기 보고만으로 승인하지 않았는가?
7. 병합 후 통합 테스트를 다시 수행했는가? 테스트 통과 사실을 위조하지 않았는가?
8. 고위험 작업에 대한 사용자 승인 게이트가 존재하는가?
9. 유실된 런타임/세션을 안전하게 복구할 방법과 실행 원장이 있는가?
10. 제품의 작업 분해·세 가지 일정안·유사 템플릿·타임로그·노트 맥락·적응형 UI·장기 계획·Vikunja 교체 요구가 누락되지 않았는가?

**최종 지시:** 첫 실행은 설계·사전 조사·문서화를 수행한다. 그 후 단 한 번의 개발 착수 승인으로 M1부터 다수의 DeepSeek 워커가 구현하고 Sol이 중간 검증하는 감독형 Run을 운영한다. 제품 방향의 최종 결정과 고위험 작업의 권한은 사용자에게 남기되, 모델 간 업무 전달·기본 오류 수정·반복 검증은 오케스트레이터가 직접 수행한다.
