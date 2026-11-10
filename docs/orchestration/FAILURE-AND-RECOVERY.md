# Failure and Recovery

## 1. 재시도 정책
| 상황 | 자동 처리 | 한도 | 초과 시 |
|---|---|---|---|
| 워커 `worker_done failed`(구현 실패) | 원인 요약 + 수정 지시 `send` | 수정 2회/Task | Task `blocked`, gate |
| Sol REQUEST_CHANGES | Required만 `send` | 2회/Task | blocked + Opus가 패킷/ADR 재검토 |
| 동일 원인 2회 반복 | 즉시 | — | blocked |
| `worker-start` 실패 | **재실행 금지**, `failedStage` 확인 → `--retry-of <dispatch>` | Orca circuit breaker 3회 | Task failed, 사용자 보고. 새 Task/Run으로 우회 금지 |
| 설계 불일치·계약 변경 필요 | 자동 수정 금지 | — | ADR 갱신, 영향 Task 재평가 |
| 모델 사용 불가·한도 | 자동 전환 금지 | — | `BLOCKED_MODEL_UNAVAILABLE` |
| 같은 파일 충돌(병합 시) | 병합 중단 | — | 소유권 재배치, 후행 Task rebase 지시 |
| 테스트 삭제/완화 감지 | 리뷰 전 반려 | 1회 | 반복 시 blocked |

재시도 명령:
```bash
orca orchestration worker-start --task <TASK_ID> --retry-of <DISPATCH_ID> --worktree <same placement> --agent <same agent> [--model … --effort …] --json
```

## 2. 침묵·불확실 상태
침묵, 타임아웃, `unverifiable` liveness는 종료 증거가 아니다. 자동 stop/abandon/retry/release 금지.
`orca orchestration worker-list --run <RUN_ID> --include-remote --json` → 각 워커 `next` 따름 → `worker-show`, `worker-read --source auto`로 확인 → 불명확하면 사용자 보고.

## 3. 코디네이터 재시작 복구 절차
1. `orca status --json` (ready 확인).
2. `orca orchestration run-list --json` → `run-use --run <RUN_ID>` (ledger에 기록된 Run).
3. `orca orchestration task-list --json`, `worker-list --run <RUN_ID> --include-remote --json`.
4. `orca orchestration inbox --terminal run:<RUN_ID> --limit 50` → ledger와 대조, 미처리 delivery만 처리(멱등 키 `taskId+dispatchId+deliveryId`).
5. `dispatched` Task: worker-show로 실제 상태 확인. 살아 있으면 대기, 종료 증거 있으면 결과 수거, 불명확하면 대기 + 보고. **중복 dispatch 금지.**
6. ledger의 마지막 Accepted merge SHA와 `git log torgal/ohmydate` 비교 → 불일치 시 ledger 우선 조사, 미완료 Task만 재스케줄.

## 4. 정리
- 정산된 워커: `worker-release --dispatch <D>`; `release_pending`/`release_unknown`은 receipt의 복구 지시만 따름(`terminal close` 금지).
- 보존 필요(디버깅·사용자 관찰): `worker-keep-open --dispatch <D>`.
- 사용자 명시 취소 시에만 `worker-stop`; `stop_unknown`이면 worker-show 후 보고.
- `orca orchestration reset` 및 runtime-global 삭제 명령 **절대 실행 금지**.

## 5. 노트북 전원·세션 한계
노트북 절전/종료 시 에이전트 실행이 계속된다고 가정하지 않는다. 장시간 무인 실행은 상시 호스트(홈서버 Orca serve + environment pairing) 설계 후 별도 승인. 재개는 §3 절차.

## 6. 실패 영수증 기록
각 실패: ledger에 `{time, taskId, dispatchId, stage, error, decision, nextAction}`.
