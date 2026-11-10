# Execution Ledger

> 재개 가능한 실행 원장. 오케스트레이터만 추가 기록(append-only). 정정은 새 행으로.
> 멱등 키: `taskId + dispatchId + deliveryId`.

## 1. 상태 요약
| 항목 | 값 |
|---|---|
| Phase | **D1 자율 개발 (2026-11-11 사용자 승인: GA-1·GM-1·GD-1, 설치 전권)** |
| Run | `run_d9c785e909e0` (M0–M1) |
| 통합 브랜치 | `torgal/ohmydate` (base `d7e6abf`) |
| 마지막 Accepted merge | — |
| 열린 게이트 | GB-1(제품 LLM), GD-2, GD-3, GL-1, GL-2 |

## 2. 결정 기록
| 시각(KST) | 결정 | 근거 | 주체 |
|---|---|---|---|
| 2026-11-11 | D0 읽기 전용 감사 + 설계 문서 작성 | 사용자 지시 | orchestrator |
| 2026-11-11 | ADR-001~015 Proposed | 13-ADR | orchestrator |
| 2026-11-11 | 사용자 승인: GA-1, GM-1, GD-1 + 필요한 설치 전권 | 사용자 메시지 | user |
| 2026-11-11 | 동시 Orca 세션 상한 5 (DeepSeek ≤3, Sol ≤2) | 사용자 메시지 | user |
| 2026-11-11 | 통합 브랜치 = `torgal/ohmydate` (dev 브랜치 대신) | 코디네이터 worktree가 해당 브랜치, new-child 부모 | orchestrator |
| 2026-11-11 | rootless 컨테이너 불가(AppArmor userns 제한) → sudo docker를 오케스트레이터만 사용, 워커 금지, docker 그룹 미가입 | sysctl, sudo -l | orchestrator |
| 2026-11-11 | DeepSeek 워커는 `scripts/orca/start-deepseek-worker.sh`(Orca 주입 XDG/OPENCODE_DB 해제 + v1 TUI + worker-start --terminal)로 시작 | P1 첫 시작 실패 원인 분석 | orchestrator |

## 3. 실행 이벤트
| 시각 | 종류 | taskId | dispatchId | deliveryId | 결과 | 증빙 | 다음 |
|---|---|---|---|---|---|---|---|
| 2026-11-11 | audit | — | — | — | orca status ready, v1.4.255 | ORCA-RUNTIME-AUDIT | — |
| 2026-11-11 | audit | — | — | — | 모델 카탈로그 확인(Sol 6.1 high, DeepSeek v4.1 flash high variant) | MODEL_BINDINGS | P1/P2 프로브 |
| 2026-11-11 | probe(직접 CLI, 사용자 요청) | — | — | — | DeepSeek v4.1 flash variant=high 호출 성공(opencode session ses_e39b06377ffenptIcWkMdW18lU), Sol gpt-6.1-sol effort=high 호출 성공(codex thread 01a1c650-…) | MODEL_BINDINGS §1.1 | Orca 경유 P1/P2 |

| 2026-11-11 | infra | — | — | — | deploy/dev compose up: postgres:18@e3d24f69, vikunja:2.8.0@35d937ba (127.0.0.1:55432, :3456) | /api/v1/info v2.8.0 | — |
| 2026-11-11 | commit | — | — | — | 18291c3 bootstrap | git | — |
| 2026-11-11 | task-create | P1 task_3b12a4c68c8a, P2 task_0a7a6727258b, M0-03 task_335cc20e045b, M1-01 task_82c33d48c649 | — | — | — | task-list | — |
| 2026-11-11 | start-failed | task_3b12a4c68c8a | ctx_f9894930a13e | — | agent_readiness: OpenCode v1 on v2-migrated managed DB | worker-show | released |
| 2026-11-11 | start | task_3b12a4c68c8a | ctx_a0d01de6fab8 | — | ready (retry-of, terminal TUI shows DeepSeek V4.1 Flash · high) | receipt | wait |
| 2026-11-11 | start | task_0a7a6727258b | ctx_f116332c5795 | — | ready, receipt model=gpt-6.1-sol effort=high | receipt | wait |
| 2026-11-11 | worker_done | task_0a7a6727258b | ctx_f116332c5795 | msg_327e5cc0a6f1 | succeeded: MODEL=gpt-6.1-sol EFFORT=high (rollout turn_context), git status clean → **Sol binding VERIFIED via Orca** | worker body | — |
| 2026-11-11 | worker_done | task_3b12a4c68c8a | ctx_a0d01de6fab8 | msg_71759f786956 | succeeded: session export opencode-go/deepseek-v4.1-flash/high. **주의:** worktree가 d7e6abf 기준이라 opencode.jsonc 부재 → 값은 OpenCode 최근 사용 상태에서 옴. 런처에 `--base-branch torgal/ohmydate`, `-m` 명시, config 존재 가드, 사후 세션 variant 검사 추가 | probe/deepseek-binding.md@01ac119 | 매 dispatch 사후 검사 |
| 2026-11-11 | worker_done | task_82c33d48c649 | ctx_e548a8f20576 | msg_6776d8e03010 | M1-01 succeeded @36fab0a, G1 OK(scope, 70 msgs deepseek high) | reports/M1-01-worker-report.md | M1-01R ctx_6f6f892fea31 |
| 2026-11-11 | worker_done | task_eab04c36ebab | ctx_61cb3abfa0ad | msg_64680378889f | M0-03R REQUEST_CHANGES | reviews/M0-03R-1.md | fix sent |

## 4. 리뷰 판정
| Task | 리뷰 dispatch | head SHA | VERDICT | 차단 이슈 | 후속 |
|---|---|---|---|---|---|
| M0-03 | ctx_61cb3abfa0ad | a861de8 | REQUEST_CHANGES | MEDIUM×2: probe 전제 실패 시 ok:true, 동시성 보장 과대기술 (Gap 사실 4건 CONFIRMED) | fix 1/2 → ctx_616a4a8a9d08 (task_72901241b3bd) |

## 5. 비용·사용량
| Task | 모델 | 토큰/비용 | 출처 |
|---|---|---|---|

## 6. 실행하지 않은 것 (D0)
설치, 다운로드, 소스 변경, 테스트/빌드, git commit/push, run-create/task-create/worker-start, 유료 모델 호출, 배포.
