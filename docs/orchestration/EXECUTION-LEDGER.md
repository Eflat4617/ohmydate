# Execution Ledger

> 재개 가능한 실행 원장. 오케스트레이터만 추가 기록(append-only). 정정은 새 행으로.
> 멱등 키: `taskId + dispatchId + deliveryId`.

## 1. 상태 요약
| 항목 | 값 |
|---|---|
| Phase | **D1 자율 개발 (2026-11-11 사용자 승인: GA-1·GM-1·GD-1, 설치 전권)** |
| Run | `run_d9c785e909e0` (M0–M1) |
| 통합 브랜치 | `torgal/ohmydate` (base `d7e6abf`) |
| 마지막 Accepted merge | bfdc39e (FU-39), 053363f (FU-37), b0c565a (M3-02+M3-02c), 9344caa (FU-32), 543cbee (FU-35), df4244c (M2-02), af25b39 (FU-33), 194b747 (FU-28, 재조정기 기본 ON), 08512de (FU-24), M1-08 (E2E, **M1 G4 PASS**), eba45ea (FU-23), 49bf2a3 (FU-27), 1111794 (M1-10), 1e56bec (FU-18), 804c981 (M2-01+01c), ed38b31 (FU-14), 3db53ad (M1-06+06c), 10f8260 (FU-09), 3aa02bd (M1-05), 4264b54 (M3-01b), de307fc (M1-07), e49d336 (M1-03), 1e9b641 (M1-04), ce31fff (FU-01), M1-02, M1-01, 88f61e9 (M0-03) |
| 열린 게이트 | GB-1(제품 LLM), GD-2, GD-3, GL-1, GL-2 |

## 2. 결정 기록
| 시각(KST) | 결정 | 근거 | 주체 |
|---|---|---|---|
| 2026-11-11 | D0 읽기 전용 감사 + 설계 문서 작성 | 사용자 지시 | orchestrator |
| 2026-11-11 | ADR-001~015 Proposed | 13-ADR | orchestrator |
| 2026-11-11 | 사용자 승인: GA-1, GM-1, GD-1 + 필요한 설치 전권 | 사용자 메시지 | user |
| 2026-11-11 08:45 | **FU-42R2 REQUEST_CHANGES (Sol) → FU-42 BLOCKED**(수정 2회 소진): HIGH — 클라이언트가 끊긴 수정 요청은 소켓 기반 추적에서 빠져, 종료가 exit 0으로 보고되지만 원격 적용·needs_reconcile=false·멱등 pending으로 남음. 쿼리 비밀 로그·파이프라이닝은 해결 확인. → 좁은 재설계 **FU-42c**(핸들러 작업 Promise 기반 추적, 미정리 시 exit 1, DB는 마지막에 종료), 기존 브랜치 위 | reviews/FU-42R2.md | orchestrator |
| 2026-11-11 08:35 | **M3-03R-1 REQUEST_CHANGES (Sol)**: HIGH 2(minSlackMin 정수/≥0 정의가 스케줄러의 부호·소수 출력과 불일치, plan에 horizon 미저장), MEDIUM 3(H0 편집 위반 공개 매핑 없음, current_version_id가 같은 소유자의 다른 plan 참조 가능, lockfile 범위), LOW(scheduler devDep). 헤더 규칙 11개 경로 전부 일치·EXCLUDE·롤백 확인. 수정 1/2 → M3-03 워커. 결정: H0는 서버 사전 검증 422 validation_failed(/editedBlocks/i), lockfile 범위 확장 승인 | reviews/M3-03R-1.md | orchestrator |
| 2026-11-11 08:26 | **FU-42R-1 REQUEST_CHANGES (Sol)**: MEDIUM 2(시한 초과 중단 후 DB가 먼저 파괴돼 멱등 예약 pending·needs_reconcile 누락, 강제 종료 로그가 비등록 경로의 원문 URL(쿼리 비밀) 기록) + LOW(barrel). 파이프라이닝 재현·keep-alive·다중 요청은 해결 확인. 수정 1/2 → FU-42 워커(정리 예산 후 DB 종료, 경로 템플릿만 로그). runWithAbortSignal barrel 내보내기 범위 확장 승인 | reviews/FU-42R-1.md | orchestrator |
| 2026-11-11 07:50 | **M2-03R2 REQUEST_CHANGES (Sol) → M2-03 BLOCKED** (수정 2회 소진). 해결 확인: 일반 실패 재시도 6개, 다른 키 동시 200/409, PATCH 경합, H2/H4/H5/H6. 남은 HIGH 3: 결과 불명 복구·리스 인계 시 중복(7·12개), cancel/manual이 승인 획득과 비원자적, dueAt 답변 전부 거부(형식 미등록). MEDIUM 2(고아 채택 의존 미기록, 없는 goalId 500), LOW 1. → **ADR-020**(세션별 PG advisory 잠금, 인계 없음) + 좁은 Task **M2-03c**(기존 브랜치 위) | reviews/M2-03R2.md | orchestrator |
| 2026-11-11 07:46 | **FU-38R2 REQUEST_CHANGES (Sol) → FU-38 BLOCKED** (수정 2회 소진): HIGH 2 — 혼합 RRN 창이 뒤 RRN 시작 건너뜀(뒤 7자리 노출), 짧은 전화번호 대체가 다음 전화번호 건너뜀(통째 노출). 종류 혼합 인접 12k 중 13건 회귀. 공통 원인 → **ADR-019** 재설계, FU-38c 새 worktree(FU-32 기준). 브랜치 fu-38-redaction-lows 병합 안 함 | reviews/FU-38R2.md | orchestrator |
| 2026-11-11 07:42 | **FU-39R-1 REQUEST_CHANGES (Sol, FU-08 겸)**: 독립 감사 12,691회 생성·16,043 가능 후보에서 하드 제약 위반 0, G12 3,172회 바이트 동일, 성능 p95 412ms. MEDIUM: 중첩 이력에서 생성기 H6 휴식 누락, 독립 H1 기준 약화(H1 끈 변이 생존), bufferBeforeDueMin 미검증으로 마감 우회, 거부 결과에 Infinity 지표, 재계획 변경 범위(기존 결함→FU-41). LOW 비정상 horizon. 수정 1/2 → FU-39 워커 | reviews/FU-39R-1.md | orchestrator |
| 2026-11-11 07:19 | **FU-38R-1 REQUEST_CHANGES (Sol)**: HIGH — LOW-2 구간 확장이 뒤따르는 RRN 시작을 건너뜀(2-토큰 2,000건 중 1,734 재현 회귀, 뒤 7자리 노출). LOW 각주/지수 과잉 마스킹. 수정 1/2 → ctx_85ad043dda40(원래 끝 이후로 스캔 이동 금지 또는 LOW-2 되돌림, 2-토큰 퍼징, 혼합 위첨자+일반 숫자 마스킹 시도). **GB-1 준비 상태 재평가:** 이 HIGH 해결 전에는 실제 제공자 연결 불가 | reviews/FU-38R-1.md | orchestrator |
| 2026-11-11 07:18 | **FU-37R-1 REQUEST_CHANGES (Sol)**: MEDIUM 3(시간 초과 클라이언트가 풀로 재사용됨, 느린 본문이 종료를 15s 강제 종료까지 붙잡음, connectionTimeout 10s가 정상적인 긴 핸들러를 끊음) + LOW(DB 없으면 빌드 점검 건너뜀). 크래시 자체는 수정 확인. 수정 1/2 → ctx_089b3d67a2cc (클라이언트 폐기, 수신 시간 제한과 핸들러 분리, closeAllConnections 드레인) | reviews/FU-37R-1.md | orchestrator |
| 2026-11-11 07:16 | **M2-03R-1 REQUEST_CHANGES (Sol)**: HIGH 6(승인 중복·부분 실패, 거부된 PATCH 덮어쓰기, 부분 답변 500, 답변 값 미검증, 오류 로그 답변 노출, 생성 실패 시 수동 경로 접근 불가), MEDIUM 4, LOW 1. 수정 라운드 1/2 → ctx_0fc03d38c6d8. 설계 결정: 0006 intake_approval(+step) 리스 + 단계별 사전 배정 plannedId(TaskRepository.create opts, ADR-016 마커 복구), 생성 실패는 201 수동 세션으로 강등, pause는 도메인 지원 전이만, FU-40(title/description) 포함. **범위 MEDIUM 근거:** M2-02R 계약 수정·빌드 목록 수정은 orchestrator가 07:00/07:03 send(msg_64892027fc9d 등)로 승인한 범위 확장 | reviews/M2-03R-1.md | orchestrator |
| 2026-11-11 07:13 | M2-04 worker_done (a162ae4, web 84 tests, build OK). 리뷰 보류: M2-03 계약 변경 병합 + FU-40(title/description 계약 공백) 반영 후 Sol 리뷰. 워커는 follow-up용으로 유지 | worker report | orchestrator |
| 2026-11-11 07:03 | **Sol 복귀 확인**: `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high` → 헤더 model: gpt-6.1-sol / reasoning effort: high, 응답 SOL_OK. 이후 신규 리뷰는 Sol(MODEL_BINDINGS §1). 진행 중인 M3-02cR(Opus)은 유지. M2-03 worker_done(de1af71..957017c, DeepSeek-high 136) → 리뷰 전 통합본 병합 + 빌드 목록에 llm 추가 지시 | codex probe | orchestrator |
| 2026-11-11 06:38 | **호스트 재부팅** (uptime 4분 확인). Orca 데스크톱 앱 재기동(ready). 진행 중 Dispatch 5개 자동 abandoned → Task ready: FU-32R, FU-35R, M2-02R, M3-02cR(리뷰), M2-03(작업 트리 거의 빈 상태). dev 컨테이너 정지 → `restart: unless-stopped` 추가 후 재기동. 리뷰 4건 Opus 대체로 재시작(ctx_00974a8b4db0, ctx_56d39c548ab8, ctx_e2f20910c6eb, ctx_1af22cce1c49), M2-03은 기존 worktree로 재개(resume-deepseek-worker.sh). 중복 dispatch 없음 | uptime, worker-list, task-list | orchestrator |
| 2026-11-11 | **Orca 런타임 장애 및 복구:** 06:10경 그래픽 세션 종료(GDM greeter)로 Orca 앱 런타임 소실 → CLI runtime_unavailable(BLOCKED: ORCA_RUNTIME). 데몬·워커 프로세스는 생존. `xvfb-run -a dbus-run-session -- orca serve --bind 127.0.0.1 --no-pairing --refuse-public`로 로컬 전용 헤드리스 런타임 기동 → ready(ws://127.0.0.1:6768), Run/Task/Dispatch 상태 보존, 대기 중이던 worker_done 3건 정상 수신. 직전 부하 평균 206 급증(동시 테스트+시스템 업데이트) 관측 | orca status, serve log | orchestrator |
| 2026-11-11 | M3-02 체인 BLOCKED(R3 HIGH: 진행 중 비분할 작업 remainingMin=0 표현 불가) → 범위 축소 M3-02c | M3-02R-3 | orchestrator |
| 2026-11-11 | 라이선스 기록: @axe-core/playwright·axe-core = MPL-2.0, E2E 개발/테스트 전용(배포 안 함) → 허용. 루트 devDependencies 2개(@playwright/test, @axe-core/playwright) 추가는 e2e 스크립트에 필수라 범위 초과 승인 (M1-08R LOW-5/6) | M1-08R-1 | orchestrator |
| 2026-11-11 | 성능 단언 best-of-5 전환 승인: 임계값 동일, 2차 시간 회귀는 5회 모두 실패하므로 약화 아님; 부하 플레이크 제거 목적 (FU-24R-2 LOW) | FU-24R-2 | orchestrator |
| 2026-11-11 | M1-10R HIGH(FU-22 미배선) 처리: M1-10은 재조정기 기본 OFF로 노출 제거, CAS 호출 배선은 이미 배정된 FU-23이 담당(같은 파일 동시 편집 회피). FU-23 병합 후 재조정기 기본 ON 재검토 | M1-10R-1 | orchestrator |
| 2026-11-11 | M1-06 체인 BLOCKED (R3 HIGH = 마지막 수정의 1줄 회귀). 재작업은 해당 회귀+테스트로만 범위를 좁힌 M1-06c로 배정, 집중 리뷰 1회 | M1-06R-3 | orchestrator |
| 2026-11-11 | M3-01 수정 체인 BLOCKED, ADR-017(전환-구간 분할)로 재설계 Task 신설: 같은 결함의 반복 원인이 가정 자체였으므로 알고리즘을 명세해 재배정(우회 아님) | M3-01R-3 | orchestrator |
| 2026-11-11 | Sol 사용 불가 시 리뷰어 = Claude Opus 5.5 xhigh (MODEL_BINDINGS §6) | 사용자 메시지 | user |
| 2026-11-11 | 리뷰 수렴 기준: 수정 2회 소진 후 남은 MEDIUM 중 경계검사기 같은 '방어 도구'의 엣지 케이스는 HIGH가 아니면 잔여 위험 이슈로 기록하고 Accept(사용자 승인 없이 가능한 일상 판단). HIGH/CRITICAL은 blocked | 무한 리뷰 루프 방지(명세 C.7) | orchestrator |
| 2026-11-11 | inbox 본문 절단 발견 → 리뷰 재보관, 이전 review packet의 WORKER CLAIMS는 절단본이었음(리뷰어는 diff 직접 검토로 영향 제한) | d9a839b | orchestrator |
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
| 2026-11-11 | start | task_703f7ee4b9a0 (M0-03R2) | ctx_c05d3e80f1ac | — | Sol re-review aa37289 | receipt | — |
| 2026-11-11 | start(stacked on torgal/m1-01-monorepo) | task_0bf1447e4351 (M1-02), task_7b97f47eff42 (M3-01) | — | — | 병렬 앞당김: 소유 경로 분리(packages/domain,contracts / packages/scheduler) | receipts | M1-01 수정 후 rebase 필요 여부 확인 |
| 2026-11-11 | start(stacked on m1-02) | task_3c3f4f8cbace (M1-04 DB) | — | — | DeepSeek | receipt | — |
| 2026-11-11 | worker_done | task_3c3f4f8cbace (M1-04) | ctx_a9b437096fe4 | msg_3de5d2e896bc | succeeded @0a6b9a7, G1 OK (36 msgs deepseek high), vikunja DB 미변경 | — | M1-04R queued task_cc41df1f767d |
| 2026-11-11 | start(stacked on m1-02@5615a58) | M1-03 (contract suite+InMemory), M1-07 (web skeleton) | — | — | RAM 5.3GB 가용 | receipts | — |
| 2026-11-11 | start | task_cc41df1f767d (M1-04R) | ctx_2fedeb4fd139 | — | Sol | receipt | — |
| 2026-11-11 | worker_done | FU-01 task_3890df099700 | ctx_a5bd7b57d8d7 | msg_bfa4f02ee9b6 | 1de2357, scope OK | — | FU-01R ctx_0d5bc4ea57b1 |
| 2026-11-11 | start | M1-04R2 | ctx_cb9c19e723e4 | — | Sol | — | — |
| 2026-11-11 | worker_done | M1-07 task_dacdef4c3561 | ctx_b52da46e9f73 | msg_36a7d0d56e52 | 0500f2c, scope OK(+vue-demi 승인 1줄), 111 msgs high; escalation(미읽은 메일 후속 불가)은 이미 반영된 base-update로 무해 | — | M1-07R ctx_5655f519c769 |
| 2026-11-11 | worker_done | M1-05 (+재검증 task_bdc0d5a6c286) | ctx_2be6d1c4651e | msg_efb140d4e7c1 | f089d89, 강화 계약 live 47 pass/3 capability skip | — | M1-05R ctx_bf4bfacdf49a |
| 2026-11-11 | **Sol usage limit** (Codex: "You've hit your usage limit … try again at 7:02 AM") | task_87877bc154df, task_297a57a4fe96, task_e988e15bcae0 | ctx_0c05ac2af0f9, ctx_845c1bce9bdc, ctx_cb81bd362c6f | escalations errored | worker-stop → retry-of with Opus fallback (MODEL_BINDINGS §6) | receipts model=claude-opus-5-5 effort=xhigh | ctx_bbaaf9ea56c5, ctx_39b1519531fa, ctx_8337a614cdd8; Sol 복귀 시 고위험(동시성·스케줄러) 사후 리뷰 목록: M1-05, M3-01b |
| 2026-11-11 | worker_done | M3-01b task_7cde7b7b21d7 | ctx_f23d56990f05 | msg_fda7b73041c5 | ab97a14 | — | review (fallback) |
| 2026-11-11 | worker_done | M1-05 fix task_06ffda7bb45a | ctx_7426991abf9c | msg_aff5299da89b | 538eeba | — | review (fallback) |
| 2026-11-11 | worker_done | M1-06 task_82dc7265e91d | ctx_33b924c589dc | msg_fbf1b5aec3d2 | e41237c, scope OK, db frozen | — | M1-06R ctx_4a10ac2847dc (opus) |
| 2026-11-11 | worker_done | M2-01 task_d8fe2f69911a | ctx_6526c3d73a59 | msg_61ebc6bf0a68 | ba591bb, scope OK, no SDK | — | M2-01R ctx_c674a13ed126 (opus) |
| 2026-11-11 | **coordinator error** | task_adc90e846e3e ("unused") | ctx_a76e5f68b5c1 | — | 스크립트 실수로 종료된 M1-06 워커에 빈 메시지 전송 → 후속 Task 생성. 즉시 취소 메시지, 터미널 종료, abandon(failed). m1-06-api HEAD c2bd70b·작업트리 변경 없음 확인 | worker-show/git | 재발 방지: send는 명시 dispatch만, `|| true` 패턴 금지 |

## 4. 리뷰 판정
| Task | 리뷰 dispatch | head SHA | VERDICT | 차단 이슈 | 후속 |
|---|---|---|---|---|---|
| M1-01 | ctx_a0837db2027a | 4630821 | **APPROVE** | 잔여 MEDIUM 2(FU-01,02) | **Accepted, merged 521e11a**, G3 pnpm run ci 0 |
| M1-02 | ctx_367875c2a89f | b235fc2 | **APPROVE** | — | **Accepted, merged 974f2a3**, G3: frozen install 0, ci 0, openapi 재생성 diff 0 |
| M1-06 | ctx_97b005396cc8 (opus-fallback) | 959ad54 | REQUEST_CHANGES | R1 전부 해결; MEDIUM: 수정 커밋이 traceId 등 테스트 삭제(AGENTS.md 위반) | **fix 2/2 FINAL** |
| FU-39 | ctx_c0dd9361ca01 (sol, R2; FU-08 겸) | 98049a7 | R2 MEDIUM/LOW만 → 수렴 규칙으로 Accepted. 독립 감사 12,259 생성 하드 위반 0, H1 변이 저장소 테스트로 제거, p95 206ms | FU-43 | **Accepted, merged bfdc39e**; ci 1095 pass/27 skip + web 69 |
| FU-37 | ctx_2fa1e6cb31e8 (sol, R2) | 00a363d | R2 MEDIUM만(파이프라인 종료) → 수렴 규칙으로 Accepted | FU-42 | **Accepted, merged 053363f**; ci 1063 pass/27 skip + web 69, build smoke 200/exit 0 |
| M3-02c | ctx_1af22cce1c49 (opus-fallback) | 61597c2 | **APPROVE** (스케줄러 전체 병합 판정) | MEDIUM(이력 전용 H1/H6) → 06 §7.1 확정 + FU-39 | **Accepted, merged b0c565a**; ci 1040 pass/27 skip + web 69 |
| FU-32 | ctx_00974a8b4db0 (opus-fallback) | 072678f | **APPROVE** | LOW 4 → FU-38; **GB-1 마스킹 관문 완료** | **Accepted, merged 9344caa**; ci 992 pass, DB 마이그레이션 테스트 1건 부하(16) 5s 타임아웃 — 단독 14/14 통과, FU-37에서 timeout 조정 |
| FU-35 | ctx_56d39c548ab8 (opus-fallback) | 8e8b6f8 | **APPROVE** | MEDIUM(사용 중 연결 소켓 단절 시 크래시, 기존 결함) → FU-37 즉시 착수 | **Accepted, merged 543cbee**; ci 942 pass/27 skip (1차 부하 타임아웃 2건, 재실행 통과) |
| M2-02 | ctx_e2f20910c6eb (opus-fallback) | 2972a81 | **APPROVE** | 계약 MEDIUM 4건 → M2-03 범위 확장으로 처리 | **Accepted, merged df4244c**; G3 935 pass/27 skip + web 69, ci 0 |
| FU-33 | ctx_035d58e4be6f (opus-fallback) | cc49314 | **APPROVE** | FU-36 | **Accepted, merged af25b39**; G3 920 pass/27 skip + web 69, ci 0 |
| FU-30 | ctx_469f7ad52705 (opus-fallback) | 86a4629 | **APPROVE** | FU-35 | **Accepted, merged**; G3 916 pass/27 skip + web 69, ci 0; e2e 4/4 |
| M3-02 | ctx_9bf783255b42 (opus-fallback) | 8577453 | REQUEST_CHANGES | R2 HIGH 해결; HIGH: 비분할 진행 중 작업 H5 불가; MEDIUM: deficit 이력 포함, 성능 단언 게이팅=약화 | **체인 BLOCKED** → M3-02c |
| FU-28 | ctx_5edc8b1d55db (opus-fallback) | 881384f | **APPROVE** (기본 ON GO) | FU-33 | **Accepted, merged 194b747**; G3 900 pass/27 skip + web 68, ci 0 |
| FU-24 | ctx_17d53a27d228 (opus-fallback) | 257b328 | **APPROVE** | FU-32 (GB-1 마지막 게이트) | **Accepted, merged 08512de**; G3 891 pass/27 skip + web 68, ci 0 |
| M1-08 | ctx_58ac44891763 (opus-fallback) | bf5b686 | **APPROVE — M1 마일스톤 G4 통과** | FU-30/31 | **Accepted, merged**; 통합 브랜치에서 ci 0 (809+68) + `pnpm run e2e` 4/4 passed; lint ignore 수정(오케스트레이터) |
| FU-23 | ctx_cfa6c44246e6 (opus-fallback) | ad77219 | **APPROVE** | FU-29 (0004 is_inbox) | **Accepted, merged eba45ea**; G3 809 pass/27 skip + web 68, ci 0 |
| FU-24 | ctx_6ce821f74ee1 (opus-fallback) | 605dd76 | REQUEST_CHANGES | R1 전부 해결, 6개 공격 형태 선형; HIGH: +cc 대체 탐색 2차 시간(1MB 9.6분) | **fix 2/2 FINAL** |
| FU-27 | ctx_dc236be881a5 (opus-fallback) | ec42c69 | **APPROVE** | FU-28 | **Accepted, merged 49bf2a3**; G3 783 pass/33 skip + web 68, ci 0 |
| M3-02 | ctx_4bc9ce4ac53c (opus-fallback) | d0244a6 | REQUEST_CHANGES | R1 전부 해결; HIGH: 시드 재계획이 H3/H5로 불가능(11~51%); MEDIUM: 과거 블록 계약, heavy property 실효성 | 06 §7.1 계약 확정 + **fix 2/2 FINAL** |
| FU-23 | ctx_a2f5adb00de2 (opus-fallback) | 5a805ff | REQUEST_CHANGES | HIGH: 기본 프로젝트 없는 계정에서 getInbox가 JWT 전용 PATCH에 의존해 영구 503; MEDIUM×3 (P10 planner 필드, 재조정 stale 재기록, 토큰 권한 문서) | 문서 09 §13 오케스트레이터 작성 + fix 1/2 |
| FU-24 | ctx_ce9adf251800 (opus-fallback) | dcea051 | REQUEST_CHANGES | HIGH: shorterEnd/키 패턴 2차 시간 DoS; MEDIUM: 전각 키 재현율 회귀 | fix 1/2 |
| M1-10 | ctx_07698d9d1733 (opus-fallback) | 0212d04 | **APPROVE** | FU-26/27 | **Accepted, merged 1111794**; G3 773 pass/33 skip + web 68, ci 0 |
| M1-10 | ctx_ea51210611f1 (opus-fallback) | f1467b7 | REQUEST_CHANGES | HIGH: 백그라운드 재조정기가 FU-22 CAS 없이 local_version 역행 | 결정: 재조정기 기본 OFF + CAS 배선은 FU-23 담당(중복 편집 방지); fix 1/2 |
| FU-18 | ctx_85ddda68a802 (opus-fallback) | 5e8f5d4 | **APPROVE** | FU-23, FU-25 | **Accepted, merged 1e56bec** (domain index additive conflict resolved); G3 733 pass/22 skip + web 68, ci 0 |
| M2-01c | ctx_4d77b6bde034 (opus-fallback) | c67b23c | **APPROVE** (M2-01 전체) | FU-24(실 공급자 게이트) | **Accepted, merged 804c981**; G3 721 pass/18 skip + web 60, ci 0 |
| FU-18 | ctx_a92131369f50 (opus-fallback) | 82fb9ee | REQUEST_CHANGES | HIGH×2: testkit kind 무조건 단언(Vikunja live 실패), 가입 Inbox가 실제 서빙 저장소에 없음; MEDIUM×2 | fix 1/2 |
| M3-02 | ctx_dea84d7169d1 (opus-fallback) | 117bffb | REQUEST_CHANGES | HIGH×2: now 무시(과거 배치), 변경 최소화 무효; MEDIUM×5 | fix 1/2 |
| FU-14 | ctx_1f6ebc759984 (opus-fallback) | fa3aad2 | **APPROVE** | FU-22 | **Accepted, merged ed38b31**; 첫 G3 실패=dev Vikunja noauth 429(인프라) → 한도 상향 후 357 pass/18 skip + web 60, ci 0 |
| FU-14 | ctx_9fad715a07e7 (opus-fallback) | 379a7f5 | REQUEST_CHANGES | FU-14..17 해결 확인; HIGH: dependsOn 생성 시 지문 순서로 유령 v2 | fix 1/2 |
| M2-01 | ctx_854c1bd3462e (opus-fallback) | 6d3f87e | REQUEST_CHANGES | HIGH: 정규화 경로 성능 회귀로 전체 ci 실패(100KB 테스트 >200ms); MEDIUM: 치환 루프 2차 시간, 경계 회귀 | **체인 BLOCKED** → 범위 축소 M2-01c |
| M1-06c | ctx_21fc4d80beb9 (opus-fallback) | 0c20d15 | **APPROVE** (M1-06 전체 병합 가능 판정) | FU-21 | **Accepted, merged 3db53ad**; G3 DB+live Vikunja 342 pass/18 skip + web 60, ci 0 |
| M1-06 | ctx_aa0fa6d2208e (opus-fallback) | c2bd70b | REQUEST_CHANGES | HIGH: c2bd70b가 만든 503→500 회귀 (R2 항목 전부 해결) | **체인 BLOCKED** → 범위 축소 Task M1-06c |
| M2-01 | ctx_b51bf23eb06e (opus-fallback) | 7292b4e | REQUEST_CHANGES | R1 전부 해결; MEDIUM: 질문 플래너 오래된 가정·exhausted; 제안(정규화 마스킹, costUsd 강제) 승격 | **fix 2/2 FINAL** |
| FU-09 | ctx_ee65fb65a235 (opus-fallback) | 2580131 | **APPROVE** | ADR-018 → FU-18, FU-19 | **Accepted, merged 10f8260**; G3 269+60 tests, ci 0 |
| M1-05 | ctx_c944b22c95d2 (opus-fallback) | 5ee225e | **APPROVE** | FU-14..17 (즉시 Task), Sol 사후 FU-08 | **Accepted, merged 3aa02bd** + lockfile repair; G3 with DB+live Vikunja: 290 pass/18 gated skip + web 45, ci 0 |
| M3-01b | ctx_39b1519531fa (opus-fallback) | ab97a14 | **APPROVE** | FU-12/13; Sol 사후 리뷰 FU-08 | **Accepted, merged 4264b54** (lockfile conflict: ours + --fix-lockfile); G3: 224+45 tests, ci 0 |
| M2-01 | ctx_c674a13ed126 (opus-fallback) | ba591bb | REQUEST_CHANGES | HIGH: 전화번호 마스킹 누락; MEDIUM×4: 이메일 정규식 ReDoS, 예산 fail-open, abort 재시도, 미응답 필드 누락 | fix 1/2 |
| M1-06 | ctx_4a10ac2847dc (opus-fallback) | e41237c | REQUEST_CHANGES | HIGH: 동시 동일키 500; MEDIUM×4: :action 라우트, 409/422 저장 규칙, 로그인 타이밍, 오류 코드 | 오케스트레이터 계약 변경(문제 코드 3종, 403/404/409 선언) + fix 1/2 ctx_28f5becc0d93 |
| M1-07 | ctx_bbaaf9ea56c5 (opus-fallback) | f63af71 | **APPROVE** | FU-09..11 | **Accepted, merged de307fc** + lockfile repair; G3: 164+45 tests, build 0, ci 0 |
| M1-05 | ctx_8337a614cdd8 (opus-fallback) | 538eeba | REQUEST_CHANGES | R1 6건 해결; HIGH: 결과 불명 쓰기(적용 후 5xx) 미재조정·반복완료 기록 유실; MEDIUM: epoch 변경 후 full resync 누락 | **fix 2/2 FINAL** ctx_f08ed070e742 |
| M1-03 | ctx_5f2d362794c9 | 6c0e433 | **APPROVE** | FU-05..07 | **Accepted, merged e49d336**, G3: 164 pass/9 gated skip, ci 0 |
| M1-05 | ctx_bf4bfacdf49a | f089d89 | REQUEST_CHANGES | HIGH×3: 재시작 후 커서 변경 유실, 부분 실패 시 버전 없는 변경, 반복 완료 기록 없음; MEDIUM×3 | 오케스트레이터 도메인 포트 변경(CursorInvalidatedError, completedOccurrenceAt) + fix 1/2 |
| M3-01 | ctx_c474514565eb | 0798bba | REQUEST_CHANGES | HIGH×2 Goose_Bay 자정 역행 (H6, H2), MEDIUM slots | **체인 BLOCKED (수정 2회 소진)** → ADR-017 재설계 Task M3-01b |
| M1-07 | ctx_5655f519c769 | 0500f2c | REQUEST_CHANGES | HIGH×2: :complete MSW 경로, 멱등 키 액션 간 누출; MEDIUM×7 (offline, 충돌 초안, overwrite, complete/delete 412, CI 미포함, 컬렉션 ETag, 순환) | fix 1/2 ctx_44641e5005d1 (root package.json/vitest.config 승인) |
| M1-04 | ctx_49ac5989ebcb | 6f6613f | **APPROVE** | — | **Accepted, merged 1e9b641**, G3 with DB: 105 tests, ci 0 |
| FU-01 | ctx_0d5bc4ea57b1 | 1de2357 | **APPROVE** | 잔여 FU-04 | **Accepted, merged ce31fff**, G3 ci 0 |
| M1-04 | ctx_cb9c19e723e4 | 4f09dc7 | REQUEST_CHANGES | MEDIUM: JSONB 쓰기 직렬화 | fix 2/2 ctx_1d79c130c1b5 |
| M1-03 | ctx_a30129007d8d | 9c36ae4 | REQUEST_CHANGES | HIGH: list/changefeed 소유자 누출 미검출; MEDIUM×5 (변경 피드 증분, project 참조, 멱등 재생, 날짜 rollover, complete 버전) | fix 1/2 ctx_7f124dd2068d |
| M3-01 | ctx_12655286e961 | a47a4fb | REQUEST_CHANGES | HIGH×3: Santiago 자정 DST, 미지정 taskId, ns 정밀도; MEDIUM×2 | **fix 2/2 (FINAL)** ctx_53234dfd4033 — HIGH 잔존 시 blocked |
| M1-04 | ctx_2fedeb4fd139 | 0a6b9a7 | REQUEST_CHANGES | HIGH: mapping unique에 owner_id 혼입; MEDIUM×2 Kysely 타입 | fix 1/2 ctx_663e7bb9699b |
| M1-02 | ctx_2a5ed3085bbb | 5615a58 | REQUEST_CHANGES | MEDIUM×1: GET /me 400 누락 | fix 2/2 ctx_b4b90a3fcfdb |
| M3-01 | ctx_bf050ebe6e4d | d7c6d7e | REQUEST_CHANGES | HIGH×4: H2 샘플링 구멍, H6 자정 리셋, DST gap/fold, horizon 미검사; MEDIUM×3 | fix 1/2 ctx_43ff9356ae7d |
| M1-02 | ctx_e7931ee43f78 | 2c9878e | REQUEST_CHANGES | HIGH×2: 헤더 매트릭스 누락, 재귀 DAG 스택 오버플로; MEDIUM×3 problem+json media, 경로별 상태, tz offset 허용 | 08 헤더 규칙 확정(86746b2 이전 커밋), fix 1/2 ctx_901b490652f1 |
| M1-01 | ctx_dfcf394615e9 | d5d055a | REQUEST_CHANGES | MEDIUM×2: .d.ts/JS config 미검사, 절대경로 import 분류 오류 (R1 4건은 해결 확인) | fix 2/2(최종) ctx_30b8cf248c31 |
| M1-01 | ctx_6f6f892fea31 | 36fab0a | REQUEST_CHANGES | MEDIUM×4: boundary checker type-only 오분류, ImportTypeNode 누락, root config 미검사, .npmrc 무시(pnpm 12) | fix 1/2 → ctx_1857942db605 (task_72e09948c5ab) |
| M0-03 | ctx_c05d3e80f1ac | aa37289 | REQUEST_CHANGES | MEDIUM: --self-test exit semantics | fix 2/2 ctx_fefd2539a203 |
| M0-03 | ctx_a5ad8b6c94da | 39d976c | **APPROVE** | — | **Accepted, merged 88f61e9**, G3: probe --check 0, --self-test 0 |
| M0-03 | ctx_61cb3abfa0ad | a861de8 | REQUEST_CHANGES | MEDIUM×2: probe 전제 실패 시 ok:true, 동시성 보장 과대기술 (Gap 사실 4건 CONFIRMED) | fix 1/2 → ctx_616a4a8a9d08 (task_72901241b3bd) |

## 5. 비용·사용량
| Task | 모델 | 토큰/비용 | 출처 |
|---|---|---|---|

## 6. 실행하지 않은 것 (D0)
설치, 다운로드, 소스 변경, 테스트/빌드, git commit/push, run-create/task-create/worker-start, 유료 모델 호출, 배포.
