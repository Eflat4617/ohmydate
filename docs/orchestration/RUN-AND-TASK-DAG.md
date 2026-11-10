# Run and Task DAG — 실행 절차

> 모든 명령은 로컬 Orca 1.4.255 help/skill에서 확인한 형태. `ORCA` = `orca`. `<…>`는 receipt 값으로 치환. D1 승인 전 실행 금지.

## 1. Run
```bash
orca status --json                                   # ready 확인, 아니면 BLOCKED: ORCA_RUNTIME
orca orchestration run-list --json                   # 진행 중 Run 재사용 우선(현재: legacy만)
orca orchestration run-create --objective "M0-M1: bindings, Vikunja probe, Task CRUD vertical slice" --json
```
마일스톤마다 새 Run을 만들지 않고, 큰 단계(M0–M1, M2–M3, …) 단위 Run 1개 [가정]. 이전 Run 명령은 `--run <id>` 명시.

## 2. Task 등록 (불변 패킷 파일 사용)
```bash
orca orchestration task-create --task-title "M0-02 P1 DeepSeek binding probe" --spec-file docs/orchestration/packets/M0-02-P1.md --json
orca orchestration task-create --task-title "M0-02 P2 Sol binding probe"      --spec-file docs/orchestration/packets/M0-02-P2.md --json
orca orchestration task-create --task-title "M0-03 Vikunja API v2 probe"      --spec-file docs/orchestration/packets/M0-03.md --deps '["<P1>"]' --json
orca orchestration task-create --task-title "M0-03R review"                   --spec-file docs/orchestration/packets/M0-03R.md --deps '["<M0-03>","<P2>"]' --json
orca orchestration task-create --task-title "M1-01 monorepo scaffold"         --spec-file docs/orchestration/packets/M1-01.md --deps '["<P1>"]' --json
orca orchestration task-create --task-title "M1-01R review"                   --spec-file docs/orchestration/packets/M1-01R.md --deps '["<M1-01>","<P2>"]' --json
# M1-02 이후는 선행 R이 APPROVE + merge(Integration Task 완료) 된 뒤 등록하여 base SHA를 패킷에 고정
orca orchestration task-list --ready --brief
```
패킷 파일은 `14-IMPLEMENTATION-HANDOFF.md`에서 추출해 `docs/orchestration/packets/`에 커밋(불변). `--deps`의 json 배열은 Task ID.

## 3. Dispatch
```bash
# DeepSeek 구현 워커 (모델/effort는 저장소 opencode.jsonc로 고정; 플래그 없음)
orca orchestration worker-start --task <TASK_ID> --worktree new-child --name m1-01-monorepo --agent opencode --setup run --json
# Sol 리뷰어: 정산된 구현 worktree에 읽기 전용으로
orca orchestration worker-start --task <REVIEW_TASK_ID> --worktree "id:<repoId>::<impl worktree path>" --agent codex --model gpt-6.1-sol --effort high --json
```
- 시작 후 **턴 종료**. Orca가 `worker_done`/`question`/`escalation`으로 깨움. 폴링 스크립트 금지.
- receipt에 `next`가 있으면 따름. 실패 시 재실행 금지 → `failedStage` 확인 후 `FAILURE-AND-RECOVERY.md`.
- 시작 직후 `orca orchestration worker-show --dispatch <D> --json`으로 agent/model/effort 기록(ledger).

## 4. 깨어났을 때 (coordinator loop)
1. 채팅으로 온 메시지는 그대로 처리. `check` 명령이 안내되면 그것을 실행:
   `orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json`
2. batch 전체 처리 후 `orca orchestration check --ack <DELIVERY_ID> …` (명세 C.4 규칙). 처리 결과는 ledger에 `taskId+dispatchId+deliveryId`로 멱등 기록. 이미 기록된 deliveryId는 무시.
3. `worker_done`:
   - dispatchId가 해당 Task의 **최신 시도**가 아니면 무시(기록만).
   - `failed` → 재시도 정책.
   - `succeeded`(구현) → 증빙 확인(diff 범위가 allowed paths 안인지 `git diff --name-only base...head`) → 리뷰 Task ready.
   - `succeeded`(리뷰) → VERDICT 파싱: APPROVE → Integration; REQUEST_CHANGES → 수정 루프; BLOCKED → 게이트/ADR.
4. `question` → 패킷/ADR로 답 가능하면 `orca orchestration reply --id <msg> --body "…"`; 아니면 사용자 게이트.
5. `escalation`(stopReason) → `send`로 조정 또는 재시도 또는 보고.
6. `orca orchestration task-list --ready --brief` → 동시성 한도 내에서 ready Task 시작 → 턴 종료.
7. 길을 잃으면 `orca orchestration inbox --terminal run:<RUN_ID> --limit 50`.

## 5. 수정 루프
```bash
orca orchestration send --to dispatch:<IMPL_DISPATCH> --subject "Review fixes for <ID> (attempt n/2)" --body-file?  # body는 아래 형식
```
- `send` 본문: Sol 리뷰의 Required changes만(제안 사항 분리), 파일:라인, 재현, 기대 테스트. 정산된 워커에는 follow-up Task로 전달되고 `worker_done`으로 보고됨(skill 확인).
- `send`에 `--body-file` 옵션 유무는 [UNVERIFIED] → `--body "<text>"` 사용.
- 수정 후 새 head SHA로 리뷰 Task 재생성(`…R2`) — 이전 리뷰 결과 재사용 금지.
- 수정 2회 초과 또는 동일 원인 반복 → Task `blocked` + gate.

## 6. Integration (오케스트레이터)
```bash
# 통합 worktree(= 이 코디네이터 worktree 또는 dev 전용 worktree)에서
git fetch . w/<branch>   # 같은 저장소의 로컬 브랜치
git merge --no-ff w/<branch> -m "merge <ID>: <title>"
corepack pnpm ci         # G3: 전체 타입·린트·단위·계약
```
- 실패 시 merge revert, 원 Task에 수정 지시. 통과 시 ledger에 merge SHA, 의존 Task의 base SHA 갱신.
- 통합 후 `orca orchestration worker-release --dispatch <D> --json`(구현·리뷰 모두).

## 7. Decision gate
```bash
orca orchestration gate-create --task <TASK_ID> --question "…" --options '["approve","reject"]' --json
orca orchestration gate-list --json
orca orchestration gate-resolve --id <GATE_ID> --resolution "<user answer>" --json
```
사용자 결정이 필요한 게이트(12 §1)는 gate-create로 Task를 막고 사용자에게 한 번에 묶어 질문. 응답 전까지 독립 Task만 진행.

## 8. 초기 DAG (Task ID 자리표시)
| Task | deps | 워커 | 병렬 그룹 |
|---|---|---|---|
| P1 | — | opencode | A |
| P2 | — | codex | A |
| M0-03 | P1 | opencode | B |
| M1-01 | P1 | opencode | B |
| M0-03R | M0-03, P2 | codex | C |
| M1-01R | M1-01, P2 | codex | C (리뷰어 1명 → 순차) |
| INT-M1-01 | M1-01R=APPROVE | orchestrator | — |
| M1-02 | INT-M1-01 | opencode | D |
| M1-03, M1-04 | M1-02 merged (M1-04는 GD-1) | opencode×2 | E |
| M1-05 | M1-03 merged, M0-03R | opencode | F |
| M1-06 | M1-03, M1-04 merged | opencode | F |
| M1-07 | M1-02 merged | opencode | E/F (동시성 2 유지) |
| M1-08 | M1-05..07 merged | opencode | G |
| M1-09 | GD-1 | opencode | 여유 슬롯 |

> **주의(2026-11-11 확인):** `orca orchestration inbox`는 `--full` 없이 본문을 ~280자로 자른다. 리뷰 보관·claims 추출은 반드시 `inbox --full`.
