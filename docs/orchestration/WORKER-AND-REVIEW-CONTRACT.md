# Worker and Review Contract

> 이 문서의 §1(워커 공통 서문)과 §3(리뷰 출력 형식)은 각 패킷 spec 맨 앞에 **전문 그대로** 삽입한다(워커는 저장소 문서를 못 읽을 수도 있다고 가정).

## 1. 워커 공통 서문 (spec에 삽입)
```text
You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets, calling paid external APIs other than your own model.
3. Commit your work on your branch with Conventional Commits; include "Task: <taskId>" in the body.
4. Run every command in "Exact tests" and paste the real exit codes and tail output. Never claim a test passed
   that you did not run. If you could not run something, say SKIPPED + reason.
5. Send heartbeat if Orca's preamble asks for it.
6. Finish with EXACTLY ONE:
   orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> \
     --outcome succeeded|failed --files-modified "<csv>" --body "<report>" --json
   (if your Orca preamble gives a different exact worker_done form, the preamble wins)
REPORT (body)
- taskId, dispatchId, worktree path, branch, commit SHA(s)
- changed paths (git diff --name-only <base>...HEAD) and 3–8 line diff summary
- requirement checklist: each acceptance item -> met / not met
- tests: command -> exit code -> key output lines
- risks, unverified items, new contracts needed by dependents, rollback method
```

## 2. 오케스트레이터 수신 검증 (G1 확인)
1. dispatchId = 최신 시도인지.
2. `git -C <wt> diff --name-only <base>...<head>` ⊆ allowed paths.
3. 테스트 명령이 패킷과 동일하고 exit code 기록 존재. 의심 시(모순·누락)만 직접 재실행(skill 지침: 증빙 요약, 갭/모순 시에만 재검사).
4. 테스트 파일 삭제/`skip`/assert 완화 diff 검출(`git diff -- '*.test.ts' | grep -E '^-.*(expect|it\\(|test\\()|\\.skip|\\.only'`).
5. 통과 → 리뷰 Task ready, 실패 → 수정 지시(리뷰 없이).

## 3. Sol 리뷰 출력 형식 (spec에 삽입)
```text
REVIEW VERDICT: APPROVE | REQUEST_CHANGES | BLOCKED
Findings (most severe first):
  [CRITICAL|HIGH|MEDIUM|LOW] <title>
    Evidence: <file>:<line> + reproduction or test output
    Required change | Suggestion
Contract / license / security / migration impact: <text or "none">
Missing tests: <list>
Verification actually executed: yes|no — exact commands + exit codes
git status --porcelain after review: <must be empty>
Residual risks: <list>
```
판정 규칙:
- CRITICAL/HIGH 1개 이상 → REQUEST_CHANGES(또는 설계 문제면 BLOCKED).
- MEDIUM은 Required로 표시된 경우만 차단. LOW/스타일은 비차단 제안.
- 테스트를 직접 실행하지 않았으면 APPROVE 불가(→ BLOCKED with reason).
- 리뷰어가 파일을 수정했으면 리뷰 무효, 재리뷰.

## 4. 리뷰 체크리스트 (Sol)
정확성(패킷 AC 대조) · 계약 준수(contracts/ADR) · 경계(domain I/O, upstream import) · 보안(입력 검증, 인증·owner 범위, 로그 민감정보, XSS) · 동시성(version/If-Match, 멱등, TX) · 시간대 · 오류 모델(problem+json code) · 테스트 충분성(네거티브 포함, 테스트 약화 여부) · 의존성 라이선스 · 성능 회귀 위험 · 롤백 가능성.

## 5. 완료 상태 정의
`worker_done succeeded` ≠ Accepted. **Accepted** = G1 확인 + Sol APPROVE + G3 통합 테스트 통과 + merge SHA 기록. ledger와 Task 상태 모두 갱신.
