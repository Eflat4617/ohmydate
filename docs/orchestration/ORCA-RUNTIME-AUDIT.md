# Orca Runtime Audit

> 조사일: 2026-11-11, 읽기 전용. 대상: https://www.onorca.dev/ 의 Orca.

## 1. 실행 파일·버전 [VERIFIED]
| 항목 | 값 | 근거 명령 |
|---|---|---|
| CLI | `/home/torgal/.config/orca/linux-orca-cli-shim/orca` (`ORCA_CLI_COMMAND`), `orca-ide`도 `~/.local/bin`에 존재 | `command -v orca`, env |
| 버전 | Orca **1.4.255** (`ORCA_APP_VERSION`, `orca --version`) | |
| 런타임 | `state: ready`, `reachable: true`, `connectionState: connected`, app running, graph ready | `orca status --json` |
| 오케스트레이션 capability | `orchestration.contract.v1`, `worker-auto-release.v1`, `worker-keep-open.v1`, `worker-start-implicit-run.v1`, `worker-turn-stop-reports.v1`, `ask-returns-at-once.v1`, `worker-launch-preferences.v1`, federation 계열 | status capabilities |
| 원격 업데이트 | `manual-service-update-required` (자동 업데이트 아님) | status |

## 2. 스킬 [VERIFIED]
- `orca skills list`: `orchestration`, `orca-cli`, `orca-computer-use`, `orca-jira`, `orca-linear`, `linear-tickets`, `orca-emulator(-android)`, `orca-per-workspace-env`, `orca-plugin-authoring`.
- `orca skills get orchestration --full`(296줄, references 5종 번들)와 `orca skills get orca-cli` 전문을 읽음. 로컬 `~/.claude/skills/orchestration` 존재. 이 Claude 세션의 Skill 도구 목록에는 `orchestration`이 노출되지 않아 **CLI로 가이드를 직접 로드**함(명세 C.1 허용 경로).

## 3. 기존 Run 상태 [VERIFIED]
- `run-list`: `run_legacy_local`("Legacy orchestration state (inspect only)", legacy) 1개뿐. `run-current`: `null`.
- 결론: 진행 중 Run 없음 → D1에서 새 Run 1개 생성. 레거시 Run은 건드리지 않음(reset 금지).

## 4. 명령 표면 (로컬 `orca orchestration --help`) [VERIFIED]
사용: `run-create, run-use, run-current, run-list, run-show, send, check, reply, inbox, task-create, task-list, task-update, worker-start, worker-show, worker-read, worker-stop, worker-abandon, worker-release, worker-keep-open, worker-list, dispatch, request-show, dispatch-show, ask, gate-create, gate-resolve, gate-list, reset`.
Retired(사용 금지): `coordinator-start`, `coordinator-stop`(help에 Retired 표기), `orchestration run`/`run-stop`(온라인 문서 retired).

## 5. 로컬 CLI vs 온라인 문서 차이 (로컬 우선)
| 항목 | 로컬 1.4.255 help | 온라인 문서 | 채택 |
|---|---|---|---|
| OpenCode `--model` | "requires an existing worktree, a verified execution-host CLI, and an available model" | 지원 | 로컬: new-child와 조합 불가로 취급 |
| OpenCode `--effort` | **"effort is unsupported"** | 지원으로 서술 | 로컬: 미지원 → 저장소 설정으로 고정(ADR-014) |
| 보존 명령 | `worker-keep-open` | `worker-retain` | 로컬 |
| DeepSeek Harness | `--agent` 예시에 없음, 바이너리 `dsh` 미설치 | `dsh-tui` 프로필로 지원 | 사용 안 함 |
| Experimental 토글 | CLI 정상 동작(run-list 응답) | Settings → Experimental 필요, 패널 일시 비가용 | 런타임 응답으로 활성 판단 |

## 6. 운영 의미
- `worker-start`는 `--spec` + 바인딩 Run 없음이면 Run을 암묵 생성 → **반드시 run-create 후 `--task`로 시작**해 Run 남발 방지.
- `check`를 스크립트로 폴링 금지(메일 소실). 워커 시작 후 턴 종료, Orca가 깨움.
- new-child/new-top-level 워커는 keep-open 기본 → 정산 후 `worker-release` 필수.
- 3회 시작 실패 시 circuit-break → 사용자 보고(새 Task로 우회 금지).
- 중첩 워커 depth 기본 4(문서) → 워커 패킷에서 "하위 워커 생성 금지" 명시.
- Agent 권한: 온라인 문서상 Orca는 Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`를 기본 prefill(Yolo). **로컬 설정값 [UNVERIFIED]** (CLI로 조회 경로 미발견) → PERMISSION 정책 참조.
- OpenCode 기본 `build` 에이전트 권한: `"*": allow`, `external_directory: ask`, `doom_loop: ask` (`opencode debug agent build`) → external_directory ask가 무인 실행을 멈출 수 있음 → 저장소 `opencode.jsonc`에서 명시(MODEL_BINDINGS §4).

## 7. BLOCKED 항목
없음(ORCA_RUNTIME 정상). 부분 제약은 MODEL_BINDINGS 참조.
