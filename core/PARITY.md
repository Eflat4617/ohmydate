# 패리티 원장 (PARITY)

> 초판 2026-11-16 · Task RC-10A · 계획: `docs/blueprint/15-DESKTOP-RUST-CORE.md` §7.5, 전환 관문 §7.7 #6.

TypeScript 코어의 테스트 파일마다 한 줄. Rust 코어가 그 테스트가 지키던 것을 어떻게 지키는지, 아직이면 어느 Task가 맡는지 적는다.

| 상태 | 뜻 | 셋째 칸에 적는 것 |
|---|---|---|
| 옮김 | 같은 경우들을 Rust 쪽 테스트가 본다 | `→` 뒤에 테스트가 있는 파일(`core/…` 또는 `tests-core/…`), 필요하면 `파일::테스트_이름` |
| 대체 | 같은 것을 다른 방법으로 지킨다(구조가 달라져 테스트 모양이 다르다) | `→` 뒤에 무엇이 대신하는지 |
| 해당 없음 | 데스크톱 코어에 그 대상이 없다 | 사유 |
| 아직 | 그 영역이 포팅되지 않았다 | 맡을 Task(`RC-…`) |

한 파일에 성격이 다른 건이 섞여 있으면 가장 큰 쪽으로 분류하고 나머지를 같은 줄에 적는다.

**이 파일은 검사된다.** `tests-core/ledger.test.ts`(`corepack pnpm run core:ledger`, `core:parity`에도 들어 있다)가 다음에서 실패한다: 아래 디렉터리에 있는 `*.test.ts`·`*.spec.ts` 파일이 원장에 없을 때, 원장의 파일이 사라졌을 때, 같은 파일이 두 번 나올 때, 상태가 넷 중 하나가 아닐 때, `옮김`·`대체`가 가리키는 파일이나 테스트 이름이 없을 때, `아직`이 남은 Task를 가리키지 않을 때(끝난 Task를 가리키면 그 줄을 고쳐야 한다), 합계 표가 줄들과 다를 때, Task 목록이 계획 §10과 다를 때, `core` 대상에서 도는 E2E spec의 목록(`e2e/targets/core-specs.json`)이 아래 `e2e/tests` 표와 어긋날 때. TypeScript 테스트 파일을 더한 사람은 여기에 한 줄을 더한다. Task를 끝낸 사람은 그 Task를 "끝난 Task"로 옮기고 자기 `아직` 줄을 전부 바꾼다.

<!-- tasks:start -->
- 끝난 Task: RC-00, RC-10A, RC-10B, RC-20, RC-30, RC-31, RC-32, RC-33
- 남은 Task: RC-05, RC-40, RC-50, RC-60, RC-70a, RC-70b, RC-80, RC-90, RC-100a, RC-100b, RC-110a, RC-110b
<!-- tasks:end -->

## 합계

<!-- totals:start -->
| 위치 | 파일 | 옮김 | 대체 | 해당 없음 | 아직 |
|---|---|---|---|---|---|
| `services/api/test` | 107 | 7 | 10 | 34 | 56 |
| `packages/scheduler/test` | 21 | 19 | 1 | 1 | 0 |
| `packages/llm/test` | 20 | 0 | 0 | 3 | 17 |
| `packages/domain/test` | 11 | 5 | 0 | 1 | 5 |
| `packages/provider-native/test` | 4 | 0 | 3 | 1 | 0 |
| `packages/provider-vikunja/test` | 15 | 0 | 1 | 14 | 0 |
| `packages/contracts/test` | 19 | 0 | 0 | 19 | 0 |
| `packages/testkit/test` | 2 | 0 | 0 | 2 | 0 |
| `e2e/tests` | 15 | 3 | 0 | 2 | 10 |
| 합계 | 214 | 34 | 15 | 77 | 88 |

"아직"을 맡은 Task별 파일 수: RC-40 9 · RC-50 10 · RC-60 9 · RC-70a 16 · RC-70b 29 · RC-80 6 · RC-90 9
<!-- totals:end -->

## services/api/test

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `action-routes.test.ts` | 옮김 | → `core/crates/server/src/contract.rs::unknown_methods_actions_and_paths_do_not_resolve`, `core/crates/server/src/contract.rs::paths_resolve_to_operations_with_their_parameters`, `core/crates/server/src/contract.rs::every_contract_path_resolves_to_its_own_operation` |
| `auth-session-persistence.test.ts` | 해당 없음 | 로그인 세션이 없다. 실행 토큰이 대신한다(15 §1.3) |
| `auth.test.ts` | 대체 | → `core/crates/server/src/security.rs`(실행 토큰·Host·Origin), `core/crates/server/tests/http.rs::me_is_the_local_owner_with_a_conditional_etag`, `tests-core/settings.test.ts`(설정의 헤더 규칙, 모르는 시간대 400), `tests-core/web.test.ts`(실행 쿠키). 로그인·로그아웃·CSRF·로그인 rate limit·"다른 owner에게 304를 주지 않는다" 6건은 해당 없음(계정이 없다) |
| `auth-timing.test.ts` | 해당 없음 | 비밀번호 검증의 시간 균등화 — 비밀번호가 없다. 토큰 비교의 상수 시간은 `core/crates/server/src/security.rs` |
| `block-lock.test.ts` | 아직 | RC-40 |
| `cli.test.ts` | 해당 없음 | `create-user` CLI — 계정이 없다 |
| `commitment-parse-api.test.ts` | 아직 | RC-70b |
| `commitment-parse.test.ts` | 아직 | RC-70b |
| `config.test.ts` | 아직 | RC-70b — 키 읽기(0600, 한 번만, 설정 객체 밖)는 키링과 파일 대체로 옮긴다. trust proxy·`PROVIDER_MAX_CALL_MS` 2건은 해당 없음 |
| `conformance.test.ts` | 대체 | → `tests-core/parity.test.ts` — operation마다 같은 경우를 계약에서 뽑아 돌린다(CSRF 없음 → 다른 출처의 Origin) |
| `create-user-args.test.ts` | 해당 없음 | `create-user` 인자 |
| `daily-conformance.test.ts` | 아직 | RC-50 — 하네스 표(`tests-core/support/routes.ts`)에 operation을 넣으면 대체된다 |
| `daily-services.test.ts` | 아직 | RC-50(알림 dedupe·dismiss, 로그). 푸시 구독 1건은 해당 없음, 내보내기 1건은 RC-110b |
| `db/agent-run-cancelled-schema.test.ts` | 아직 | RC-70b(`agent_run`) |
| `db/auth-session-schema.test.ts` | 해당 없음 | `auth_session` 테이블 제외(15 §3.3) |
| `db/constraints.test.ts` | 대체 | → `core/crates/store/src/tasks.rs::rows_that_break_the_schema_rules_are_refused`, `core/crates/store/src/idempotency.rs`, `core/crates/store/src/owner.rs` — SQLite 스키마의 같은 제약(자기 의존 금지, 키 하나에 기록 하나, 양수 version). owner 사이 제약·`external_provider_mapping`·`job` 5건은 해당 없음(그 컬럼과 테이블이 없다) |
| `db/date-parser.test.ts` | 해당 없음 | node-pg의 `date` 파서 |
| `db/google-calendar-schema.test.ts` | 아직 | RC-90 |
| `db/inbox-migration.test.ts` | 대체 | → `core/crates/app/src/app.rs::a_new_data_file_gets_one_owner_and_an_inbox` — Inbox는 데이터 파일과 함께 생긴다. 기존 데이터의 Inbox는 가져오기(RC-110b)가 옮긴다 |
| `db/intake-schema.test.ts` | 아직 | RC-70b |
| `db/jsonb.test.ts` | 해당 없음 | Kysely + node-pg의 JSONB 쓰기 규약 |
| `db/migrate.test.ts` | 대체 | → `core/crates/store/src/migrate.rs` — 러너가 다르다: 전진 전용, 체크섬, 새 스키마의 파일 거부, 올리기 전 사본 |
| `db/notes-schema.test.ts` | 아직 | RC-80 |
| `db/planning-schema.test.ts` | 아직 | RC-40 — 계획·후보·블록·승인 테이블. RC-20에서 이미 옮긴 부분: 약속·가용 규칙·예외·availability version의 제약(`core/crates/store/src/commitments.rs`, `core/crates/store/src/availability.rs`: 창의 순서, extra의 창, 가져온 약속의 외부 참조, version 단조 증가 트리거) |
| `db/replanning-schema.test.ts` | 아직 | RC-60 |
| `db/today-sessions-schema.test.ts` | 아직 | RC-50 |
| `db/types.test.ts` | 해당 없음 | Kysely 타입 ↔ `information_schema` |
| `dist-artifact.test.ts` | 해당 없음 | Node dist 산출물 |
| `e2e-login-rate-limit-reset.test.ts` | 해당 없음 | 로그인 rate limit |
| `entry-guard.test.ts` | 해당 없음 | Node 진입점 판별 |
| `error-handling.test.ts` | 대체 | → `core/crates/server/src/problem.rs::storage_failures_are_reported_without_details`, `core/crates/server/tests/http.rs::stored_and_unstored_failures_follow_the_storage_rule`. provider 503 3건은 해당 없음(Vikunja 없음) |
| `estimation-learning.test.ts` | 아직 | RC-60 |
| `estimation-profile-bound.test.ts` | 아직 | RC-60 |
| `explanation-codes.test.ts` | 아직 | RC-40 |
| `fake-llm-scenarios.test.ts` | 아직 | RC-70b — E2E용 가짜 LLM 시나리오와, 그것을 운영 빌드에서 켤 수 없게 하기 |
| `fu-53-hardening.test.ts` | 아직 | RC-50 |
| `fu-53-jobs.test.ts` | 해당 없음 | 리더 잠금 — 프로세스가 하나다(15 §3.2). 알림·청소 작업 자체는 RC-50·RC-110b의 테스트가 본다 |
| `fu-96-autosplit.test.ts` | 아직 | RC-40(`schedulingSessionBounds`; 재계획·Today 경로는 RC-60·RC-50) |
| `global-setup.test.ts` | 해당 없음 | API dist 테스트 준비 |
| `goals.test.ts` | 아직 | RC-70b |
| `google-config.test.ts` | 아직 | RC-90 |
| `google-conformance.test.ts` | 아직 | RC-90 |
| `google-export.test.ts` | 아직 | RC-90 |
| `google-http.test.ts` | 아직 | RC-90 |
| `google-import.test.ts` | 아직 | RC-90 |
| `google-logging.test.ts` | 아직 | RC-90 |
| `google-oauth.test.ts` | 아직 | RC-90 |
| `google-sync-job.test.ts` | 아직 | RC-90 |
| `health.test.ts` | 옮김 | → `core/crates/server/tests/http.rs::health_and_readiness_need_no_token`, `core/crates/server/tests/http.rs::unknown_routes_and_unported_operations_are_distinguished`(계약 경로는 `/api/v1` 밖에 없다), `tests-core/parity.test.ts`. "Vikunja가 닿지 않으면 503" 1건은 해당 없음 |
| `http-timeouts.test.ts` | 해당 없음 | Fastify 요청·연결 타임아웃 — 들어오는 연결이 loopback의 웹뷰뿐이다 |
| `idempotency.test.ts` | 옮김 | → `core/crates/app/src/app.rs`(재생, 불일치 422, pending 409, 저장되는 422, 풀리는 키), `core/crates/server/tests/http.rs::an_idempotency_key_replays_the_first_response`, `core/crates/server/tests/http.rs::stored_and_unstored_failures_follow_the_storage_rule`. 동시 요청·owner별 범위 2건은 해당 없음(쓰기 트랜잭션 하나, owner 하나) |
| `inbox-lazy.test.ts` | 대체 | → `core/crates/app/src/app.rs::reopening_keeps_the_owner_and_ignores_new_defaults` — 지연 생성이 없어 경합도 없다 |
| `intake-detection.test.ts` | 아직 | RC-70b |
| `intake-hardening.test.ts` | 아직 | RC-70b |
| `intake-live.test.ts` | 해당 없음 | 살아 있는 Vikunja에 대한 승인. 승인 규칙은 `intake.test.ts`·`intake-hardening.test.ts`와 함께 RC-70b가 옮긴다 |
| `intake-long-ai-calls.test.ts` | 아직 | RC-70b |
| `intake-output-language.test.ts` | 아직 | RC-70b |
| `intake.test.ts` | 아직 | RC-70b |
| `llm-prompt-limits.test.ts` | 아직 | RC-70b |
| `llm-settings.test.ts` | 아직 | RC-70b — 첫 건(동의·예산 저장)은 RC-10A에서 옮겼다: `tests-core/settings.test.ts`, `core/crates/app/src/settings.rs`. 나머지 8건은 동의·예산 관문 |
| `locked-blocks.test.ts` | 아직 | RC-40 |
| `logging.test.ts` | 대체 | → `core/crates/server/tests/http.rs::request_logs_hold_ids_and_codes_but_no_user_text_or_secrets` — 가릴 필드의 목록 대신, 로그에 헤더·본문·주소를 아예 넣지 않는다 |
| `log-url-redaction.test.ts` | 대체 | → `core/crates/server/tests/http.rs::request_logs_hold_ids_and_codes_but_no_user_text_or_secrets`, `tests-core/web.test.ts`(진짜 바이너리의 stderr) — 요청 로그에 경로도 쿼리도 없다 |
| `m4-02r-regressions.test.ts` | 아직 | RC-50 |
| `m4-config.test.ts` | 해당 없음 | 푸시 키 설정 — Web Push 제외 |
| `main.test.ts` | 해당 없음 | pg 풀 |
| `notes-intake.test.ts` | 아직 | RC-80 |
| `notes-service.test.ts` | 아직 | RC-80 |
| `notes.test.ts` | 아직 | RC-80 |
| `outbox.test.ts` | 해당 없음 | outbox 제외 — 읽는 쪽이 없었다(15 §4.1) |
| `pg-session-store.test.ts` | 해당 없음 | 로그인 세션 저장소 |
| `plan-diversity-note.test.ts` | 아직 | RC-40 |
| `planning.test.ts` | 아직 | RC-40 — 계획 만들기·고치기·승인. RC-20에서 이미 옮긴 2건: 같은 버전에서 낸 두 PUT 중 하나만 이긴다(`tests-core/availability.test.ts`), 약속의 CRUD가 반복을 전개하고 availability version을 올린다(`tests-core/commitments.test.ts`) |
| `pool-connection-drop.test.ts` | 해당 없음 | pg 풀 |
| `pool-timeout-disposal.test.ts` | 해당 없음 | pg 풀 |
| `production-timeouts.test.ts` | 해당 없음 | 프록시 뒤 서버의 HTTP 타임아웃 |
| `project-service.test.ts` | 옮김 | → `core/crates/app/src/projects.rs` |
| `project-update.test.ts` | 옮김 | → `tests-core/projects.test.ts`, `core/crates/server/tests/http.rs::a_project_is_renamed_and_archived_and_the_inbox_only_renamed` |
| `readyz-timeout.test.ts` | 해당 없음 | 원격 DB의 응답 기한 — SQLite는 같은 프로세스 안이다 |
| `replan-before-snapshot.test.ts` | 아직 | RC-60 |
| `replan-detection.test.ts` | 아직 | RC-60 |
| `replanning-locks-races.test.ts` | 아직 | RC-60 |
| `replanning.test.ts` | 아직 | RC-60 |
| `rrule.test.ts` | 옮김 | → `core/crates/recurrence/tests/rrule.rs` — 12건을 같은 순서, 같은 입력, 같은 기대값으로(RC-20). 더한 것: 시계 변경 3건(통째로 건너뛴 날, 자정의 전환과 30분 전환, 길이는 흐른 시간). 전개 전체는 기준 구현이 쓴 팩과 건별로 대조한다: `core/crates/recurrence/tests/oracle.rs::the_committed_sample_matches_the_reference`(규칙 645개, 전개 449건, 불일치 0), 그 팩이 지금의 기준 구현과 같은지는 `tests-core/recurrence.test.ts` |
| `scripted-fake-llm.test.ts` | 아직 | RC-70b |
| `sessions.test.ts` | 아직 | RC-50 |
| `session-store-contract.test.ts` | 해당 없음 | 로그인 세션 저장소 계약 |
| `session-sweep-job.test.ts` | 해당 없음 | 로그인 세션 스윕 |
| `shutdown-drain.test.ts` | 아직 | RC-70b — 드레인 예산은 긴 호출이 생길 때 시험한다. 지금은 `tests-core/lifecycle.test.ts`가 정상 종료(코드 0, ready 파일 삭제)를 본다 |
| `shutdown-mutation-recovery.test.ts` | 아직 | RC-70b — 끊긴 변경의 pending 키. 시작할 때의 해제는 이미 있다(`core/crates/store/src/idempotency.rs::a_restart_frees_pending_keys_but_keeps_completed_ones`) |
| `shutdown-settlement-regressions.test.ts` | 아직 | RC-70b |
| `shutdown-settlement.test.ts` | 아직 | RC-70b |
| `smoke.test.ts` | 해당 없음 | 패키지 이름 상수 |
| `task-parse-api.test.ts` | 아직 | RC-70b |
| `task-parse.test.ts` | 아직 | RC-70b |
| `task-service.test.ts` | 해당 없음 | "삭제가 Vikunja 변경 피드를 훑지 않는다" — 피드가 없다 |
| `tasks.test.ts` | 옮김 | → `core/crates/server/tests/http.rs`(작업의 일생, 헤더 표, 계약 검증, 목록), `core/crates/app/src/tasks.rs`, `tests-core/parity.test.ts`(Inbox 하나, `kind`를 보낼 수 없음, 형을 바꿔 읽지 않음). "다른 owner는 404" 1건은 해당 없음(15 §2.3 ⑨) |
| `today-api.test.ts` | 아직 | RC-50 |
| `today-reschedule-locked.test.ts` | 아직 | RC-50 |
| `trust-proxy.test.ts` | 해당 없음 | 프록시 신뢰 설정 |
| `user-service.test.ts` | 대체 | → `core/crates/app/src/app.rs::a_new_data_file_gets_one_owner_and_an_inbox` |
| `vikunja/api-smoke.test.ts` | 해당 없음 | Vikunja 제거(결정 4) |
| `vikunja/pg-contract.test.ts` | 해당 없음 | Vikunja 제거 |
| `vikunja/reconciler-liveness.test.ts` | 해당 없음 | Vikunja 제거 |
| `vikunja/reconciler.test.ts` | 해당 없음 | Vikunja 제거 |
| `vikunja/stores.test.ts` | 해당 없음 | Vikunja 제거 |
| `vikunja/wiring.test.ts` | 해당 없음 | Vikunja 제거 |

## packages/scheduler/test

계획 §5.5의 표를 옮긴 것이다(RC-30~33에서 끝났다). 건별 대응과 단계별 수치는 §5.5에 있다.

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `explain.test.ts` | 옮김 | → `core/crates/scheduler/tests/explain.rs` |
| `explanation-codes.test.ts` | 옮김 | → `core/crates/scheduler/tests/codes.rs`(validator·입력 절반), `core/crates/scheduler/tests/generate_codes.rs`(생성기 절반) |
| `fu39r.test.ts` | 옮김 | → `core/crates/scheduler/tests/hardening.rs` |
| `fu41.test.ts` | 옮김 | → `core/crates/scheduler/tests/fu41.rs` |
| `fu43.test.ts` | 옮김 | → `core/crates/scheduler/tests/hardening.rs` |
| `fu59.test.ts` | 옮김 | → `core/crates/scheduler/tests/replanning.rs` |
| `fu64-68.test.ts` | 옮김 | → `core/crates/scheduler/tests/generate_codes.rs` |
| `fu69.test.ts` | 옮김 | → `core/crates/scheduler/tests/fu69.rs` |
| `fu96.test.ts` | 옮김 | → `core/crates/scheduler/tests/fu96.rs`. "모르는 이유 문자열은 무시" 1건은 타입이 enum이라 쓸 수 없는 입력이다 |
| `generate.property.test.ts` | 옮김 | → `core/crates/scheduler/tests/generate_properties.rs` |
| `generate.test.ts` | 옮김 | → `core/crates/scheduler/tests/generate.rs`. 가중치·해시 3건은 `core/crates/scheduler/src/policies.rs`, `core/crates/scheduler/src/input_hash.rs` |
| `golden.test.ts` | 옮김 | → `core/crates/scheduler/tests/golden.rs`(기준 패키지의 fixture 15개를 그대로 읽는다) |
| `history-exemption.test.ts` | 옮김 | → `core/crates/scheduler/tests/replanning.rs` |
| `performance.test.ts` | 대체 | → `core/crates/scheduler/tests/performance.rs` — 같은 입력의 벽시계 측정. 기준 테스트의 CPU 시간 보정과 그 자체 검사 3건은 옮기지 않았다(여기 측정에는 보정이 없다) |
| `property.test.ts` | 옮김 | → `core/crates/scheduler/tests/properties.rs`(속성 7개를 `proptest`로) |
| `replanning.test.ts` | 옮김 | → `core/crates/scheduler/tests/replanning.rs` |
| `replan.property.test.ts` | 옮김 | → `core/crates/scheduler/tests/replan_properties.rs` |
| `slots.test.ts` | 옮김 | → `core/crates/scheduler/tests/slots.rs`, `core/crates/scheduler/tests/validate_slots.rs` |
| `smoke.test.ts` | 해당 없음 | 패키지 이름 상수 |
| `transitions.test.ts` | 옮김 | → `core/crates/scheduler/tests/transitions.rs`, `core/crates/scheduler/tests/validate_slots.rs`, 전환 4096개 상한은 `core/crates/scheduler/src/time.rs` |
| `validate.test.ts` | 옮김 | → `core/crates/scheduler/tests/validate.rs` |

## packages/llm/test

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `budget.test.ts` | 아직 | RC-70a |
| `commitment-parse.test.ts` | 아직 | RC-70a |
| `contract-eval.test.ts` | 해당 없음 | 평가 도구 — 프롬프트·스키마와 함께 TypeScript에 남는다(15 §4.1) |
| `dispatch-hook.test.ts` | 아직 | RC-70a |
| `fake-llm.test.ts` | 아직 | RC-70a |
| `fu54-abort-usage.test.ts` | 아직 | RC-70a |
| `injection-eval.test.ts` | 해당 없음 | 평가 도구 — TypeScript에 남는다 |
| `injection.test.ts` | 아직 | RC-70a |
| `note-context.test.ts` | 아직 | RC-70a |
| `openai-compatible-llm.test.ts` | 아직 | RC-70b(HTTP 클라이언트) |
| `output-contract.test.ts` | 아직 | RC-70a |
| `privacy-gate.test.ts` | 아직 | RC-70a |
| `privacy.test.ts` | 아직 | RC-70a(마스킹 — 오라클 팩으로도 대조한다) |
| `prompt-limits.test.ts` | 아직 | RC-70a |
| `question-planner.property.test.ts` | 아직 | RC-70a |
| `registry.test.ts` | 아직 | RC-70a |
| `run-structured.test.ts` | 아직 | RC-70a |
| `smoke.test.ts` | 해당 없음 | 패키지 이름 상수 |
| `spend-ledger.test.ts` | 아직 | RC-70a |
| `task-parse.test.ts` | 아직 | RC-70a |

## packages/domain/test

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `brand.test.ts` | 옮김 | → `core/crates/domain/src/id.rs`, `core/crates/domain/src/instant.rs`, `core/crates/domain/src/version.rs`, 시간대 이름은 `core/crates/server/src/contract.rs::the_time_zone_format_knows_iana_names_only`. "브랜드 타입으로 좁힌다" 1건은 타입 시스템이 한다 |
| `dag.test.ts` | 옮김 | → `core/crates/domain/src/dag.rs` |
| `errors.test.ts` | 옮김 | → `core/crates/domain/src/error.rs`, `core/crates/server/src/problem.rs::domain_errors_map_to_the_statuses_of_the_typescript_core` |
| `estimation.test.ts` | 아직 | RC-60 |
| `intake/decomposition.test.ts` | 아직 | RC-70b |
| `intake/questions.test.ts` | 아직 | RC-70b |
| `intake/state-machine.test.ts` | 아직 | RC-70b |
| `notes.test.ts` | 아직 | RC-80 |
| `smoke.test.ts` | 해당 없음 | 패키지 이름 상수 |
| `time.test.ts` | 옮김 | → `core/crates/domain/src/instant.rs` |
| `uuid.test.ts` | 옮김 | → `core/crates/domain/src/id.rs` |

## packages/provider-native/test

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `contract-capabilities.test.ts` | 대체 | → `core/crates/app/src/tasks.rs` — 저장소 포트가 없다(저장소는 SQLite 하나, 15 §1.2 규칙 5). 계약 스위트가 고정하던 규칙은 유스케이스 테스트가 진짜 SQLite로 본다 |
| `in-memory-repositories.test.ts` | 대체 | → `core/crates/app/src/tasks.rs`, `core/crates/app/src/projects.rs`, `core/crates/store/src/tasks.rs`, `core/crates/store/src/projects.rs` |
| `smoke.test.ts` | 해당 없음 | 패키지 이름 상수 |
| `task-repository.contract.test.ts` | 대체 | → `core/crates/app/src/tasks.rs`, `core/crates/store/src/tasks.rs` |

## packages/provider-vikunja/test

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `contract.test.ts` | 해당 없음 | Vikunja 제거(결정 4) |
| `smoke.test.ts` | 해당 없음 | 패키지 이름 상수 |
| `unit/client.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/cursor.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/mapping-store.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/marker.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/project-repository.inbox.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/task-repository.conflict.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/task-repository.deleted-dependents.test.ts` | 대체 | → `core/crates/app/src/tasks.rs::deleting_a_task_releases_the_tasks_that_waited_for_it`, `tests-core/parity.test.ts` — FU-81의 동작(지운 작업을 기다리던 작업 풀기)이 네이티브 규칙이 됐다. 어댑터의 한 번만 드러내기·재시도 쪽은 해당 없음 |
| `unit/task-repository.feed.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/task-repository.recovery.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/task-repository.self-touch.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/task-repository.unknown-outcome.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/task-repository.version-race.test.ts` | 해당 없음 | Vikunja 제거 |
| `unit/validation.test.ts` | 해당 없음 | Vikunja 제거 |

## packages/contracts/test

계약 패키지는 TypeScript에 남는다(계약의 단일 소스, 15 §4.1). 이 테스트들은 전환 뒤에도 계약을 지킨다. Rust는 생성된 `openapi.json`을 읽고(`core/crates/server/src/contract.rs`), 두 검증기의 판정 차이는 `core:schema-diff`가 본다.

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `commitment-parse.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `explanation.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `headers.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `intake.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `integrations.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `notes.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `openapi.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `package-scope.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `planning-scheduler-parity.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `planning.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `problem.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `project-kind.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `replanning.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `routes.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `settings.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `smoke.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `task-parse.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `task-schema.test.ts` | 해당 없음 | TypeScript에 남는다 |
| `today.test.ts` | 해당 없음 | TypeScript에 남는다 |

## packages/testkit/test

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `smoke.test.ts` | 해당 없음 | 패키지 이름 상수 |
| `testkit.test.ts` | 해당 없음 | 테스트 도구(가짜 시계, 시드 id, 저장소 계약 스위트) 자체의 테스트. Rust 쪽 도구(`core/crates/app/src/testing.rs`)는 그것을 쓰는 테스트가 시험한다 |

## e2e/tests

E2E는 옮기지 않는다: 같은 spec을 대상만 Rust 코어로 바꿔 돌린다(15 §7.3, `corepack pnpm run e2e:core`). 여기서 상태의 뜻은 이렇다.

- `옮김`: 그 spec이 `core` 대상에서 통과한다 — Chromium과 WebKit 둘 다. `e2e/targets/core-specs.json`에 이름이 있어야 하고, 줄에는 `→` 뒤에 `E2E_TARGET=core`와 그 대상에 없는 부분(해당 없음)을 적는다.
- `아직`: 맡을 Task에서 통과시킨다. 한 spec의 일부 화면만 먼저 `core` 대상에서 도는 경우(여러 영역을 걷는 a11y spec)도 `아직`이고, 그 spec은 목록에 들어 있다 — 도는 화면과 남은 화면을 줄에 적는다.
- `해당 없음`인 spec은 목록에 없다.

`tests-core/ledger.test.ts`가 목록과 이 표가 어긋나면 실패한다.

| TypeScript 테스트 | 상태 | 대응 · 사유 |
|---|---|---|
| `e2e-1.spec.ts` | 옮김 | → `E2E_TARGET=core`에서 4건 모두 통과(RC-10B, Chromium·WebKit). 기록 확인은 Vikunja 대신 코어를 실행 토큰으로 직접 읽는다(`e2e/helpers/driver.ts`의 `record`). 해당 없음: 로그인 폼을 Tab·Enter로 지나기(부팅 인계가 대신한다), 로그인 화면의 axe(그 자리에서 "앱에서 다시 열어 주세요" 화면을 검사한다) |
| `e2e-10-hours-appointments.spec.ts` | 옮김 | → `E2E_TARGET=core`에서 3건 모두 통과(RC-20, Chromium·WebKit) — 시작 안내의 첫 두 걸음(가용 시간 빠른 선택, 약속 손으로 넣기), 설정 › 가용 시간(저장, 다시 불러오기, 다른 곳에서 바뀐 뒤의 412 `availability_changed`), 플래너 › 목록(주간 약속 손으로 넣기 → 규칙이 주는 주마다 보임 → 자기 대화상자에서 이름 바꾸기 → 삭제). RC-20에서 쓴 spec이고 두 대상에서 같은 파일이 돈다 |
| `e2e-2-wizard.spec.ts` | 아직 | RC-70b |
| `e2e-3-plan.spec.ts` | 아직 | RC-40 |
| `e2e-4-today.spec.ts` | 아직 | RC-50 |
| `e2e-5-owner-reset.spec.ts` | 해당 없음 | owner 전환·교차 탭 로그인 — owner가 하나이고 로그인이 없다 |
| `e2e-5r-replan.spec.ts` | 아직 | RC-60 |
| `e2e-6-layout.spec.ts` | 아직 | RC-50(집중 세션을 시작해야 한다) |
| `e2e-6-notes.spec.ts` | 아직 | RC-80 |
| `e2e-7-nl-commitments.spec.ts` | 아직 | RC-70b |
| `e2e-8-nl-tasks.spec.ts` | 아직 | RC-70b |
| `e2e-9-folders.spec.ts` | 옮김 | → `E2E_TARGET=core`에서 통과(RC-10B, Chromium·WebKit) — 폴더의 한살이(만들기·넣기·이름 바꾸기·없애기·되돌리기). 해당 없음: Vikunja의 보관 상태 확인 — 대신 코어의 목록을 본다: 보관한 프로젝트가 `archived: true`로 남는다(15 §2.2의 차이, `driver.listsAsLive`) |
| `e2e-a11y-screens.spec.ts` | 아직 | RC-40 — 화면마다 필요한 영역을 적어 두었고(`screen(name, needs, …)`) 그 영역이 포팅되면 그 화면이 `core` 대상에서 돈다. 지금 도는 것(Chromium·WebKit): 담기, 할 일(캔버스·상세·목록·폴더 화면), 설정 › 화면(RC-10B), 설정 › 가용 시간, 플래너 › 목록의 약속과 그 대화상자(RC-20 — 씨앗 데이터도 영역별로 나눠 심는다). 남은 것: 한달·플래너 주/일 RC-40(블록) · 개요·집중·알림·회고 RC-50 · 다시 맞추기·분석 RC-60 · 계획 세우기 RC-40/RC-70b · AI 설정 RC-70b · 캘린더 연동 RC-90 |
| `e2e-ai-wait.spec.ts` | 아직 | RC-70b |
| `plan-edit-helpers.spec.ts` | 해당 없음 | 서버를 쓰지 않는 헬퍼의 단위 테스트 — 대상이 무엇이든 그대로 돈다 |
