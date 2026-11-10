# 04. 도메인 모델과 데이터베이스

> DB: PostgreSQL 18, DB `planner` (Vikunja DB와 분리, 직접 쓰기 금지). 마이그레이션: `services/api/migrations/NNNN_name.sql` 전진 전용 + 검증된 down 스크립트(ADR-003).

## 1. 공통 규약
- PK: `id uuid` **UUIDv7**(앱 생성). 외부 ID는 `external_provider_mapping`에만.
- 모든 사용자 데이터 테이블: `owner_id uuid not null` (단일 사용자라도 필수, 장래 테넌트 격리·RLS 대비).
- 타임스탬프: `created_at`, `updated_at timestamptz` (UTC 저장). 사용자 표시 시간대는 `user.time_zone`(IANA). 반복/가용 규칙은 **로컬 벽시계 + IANA tz**로 저장해 DST에 안전.
- 동시성: `version integer not null default 1`, 갱신 시 `where id=$1 and version=$2` → 0행이면 412. HTTP ETag = `W/"<version>"`.
- 삭제: 기본 soft delete `deleted_at` (30일 후 하드 삭제 job). 계정 삭제는 하드 삭제 + 감사 기록만 남김(개인정보 제외).
- 개인정보 등급: `P0` 일반, `P1` 개인 일정, `P2` 노트 본문/첨부(LLM 전송 시 동의 필요).

## 2. ERD (요약)

```text
user 1─* goal 1─* project? ; project 1─* task ; task *─* task (task_dependency)
user 1─* commitment_event ; user 1─* availability_rule ; availability_rule 1─* availability_exception
task 1─* estimate 1─* estimate_evidence
task_template 1─* task_type_fingerprint ; intake_session 1─* intake_answer ; intake_session *─1 task_template?
plan 1─* plan_candidate ; plan 1─* plan_version 1─* schedule_block *─1 task ; plan_version 1─1 schedule_approval
task 1─* work_session ; work_session 1─0..1 task_completion_review ; task 1─* estimation_feedback
context_document 1─* document_link (→ goal|project|task) ; context_document 1─* attachment_metadata
agent_run 1─* agent_proposal ; agent_run 1─* agent_event
notification, audit_event, outbox_event, inbox_event, idempotency_record, job
external_provider_mapping (entity_type, entity_id) ↔ (provider, external_id)
```

## 3. 테이블 명세 (MVP 통합 방침 포함)

| 테이블 | 책임 | 핵심 컬럼 | 인덱스/제약 | 보존·삭제 | 마일스톤 |
|---|---|---|---|---|---|
| user | 계정·설정 | email, password_hash(argon2id), time_zone, locale, settings jsonb, llm_consent jsonb | uniq(email) | 계정 삭제 시 하드 | M1 |
| goal | 목표 | title, target_date, status | (owner_id,status) | soft | M2 |
| project | 묶음 | title, goal_id?, archived | (owner_id) | soft | M1 |
| task | **planner 측 작업 확장** (core 필드는 provider) | project_id, title_cache, status_cache, due_at, splittable bool, min_session_min, max_session_min, priority, earliest_start_at, provider_etag | (owner_id,status_cache), (due_at) | soft | M1 |
| task_dependency | DAG | task_id, depends_on_task_id, kind(`finish_to_start`) | pk(task,dep), 사이클 검사는 앱(도메인) | cascade | M2 |
| commitment_event | 고정 약속 | title, start_at, end_at, rrule?, tz, source(manual/caldav/vikunja) | gist(tstzrange) | soft | M3 |
| availability_rule | 요일별 가용 | weekday, start_local, end_local, tz, kind(work/focus/rest) | (owner_id,weekday) | 하드 | M3 |
| availability_exception | 휴일/예외 | date, kind(off/extra), start_local?, end_local? | (owner_id,date) | 하드 | M3 |
| task_template | 재사용 템플릿 | name, steps jsonb(ordered, deps), stats jsonb, source(user/system), confidence | (owner_id) | 사용자 삭제 가능 | M2 |
| task_type_fingerprint | 유사도 키 | template_id, tags text[], keywords tsvector, meta jsonb, false_positive_count | gin(keywords) | 템플릿과 함께 | M2 |
| intake_session | 인터뷰 상태기계 | state, goal_id?, input jsonb, detected_type jsonb, template_id?, round, error | (owner_id,state) | 90일 후 요약만 [가정] | M2 |
| intake_answer | 질문·응답 | session_id, question_key, question_text, answer jsonb, skipped bool | (session_id) | 세션과 함께 | M2 |
| estimate | 추정 구간 | task_id, p50_min, p90_min, method(prior/template/personal/llm), confidence, is_current | (task_id,is_current) | 이력 보존 | M2 |
| estimate_evidence | 근거 | estimate_id, kind, ref, summary | — | 함께 | M2 |
| plan | 계획 컨테이너 | scope(goal/tasks), status(draft/active/superseded), current_version_id | (owner_id,status) | soft | M3 |
| plan_candidate | 후보(비승인) | plan_id, policy, blocks jsonb, metrics jsonb, input_hash, generator_version, feasible bool, deficit_min | (plan_id) | 30일 후 삭제 [가정] | M3 |
| plan_version | 승인된 스냅샷 | plan_id, seq, candidate_id, reason, created_by(user/replan) | uniq(plan_id,seq) | 보존 | M3 |
| schedule_block | 시간 블록 | plan_version_id, task_id, start_at, end_at, locked bool, status(planned/done/skipped/moved) | gist(owner_id, tstzrange) **EXCLUDE 겹침 금지(활성 블록)** | 보존 | M3 |
| schedule_approval | 승인 기록 | plan_version_id, approved_at, idempotency_key, availability_version | uniq(idempotency_key) | 보존 | M3 |
| work_session | 실제 수행 | task_id, block_id?, started_at, ended_at, focused_sec, paused_sec, state, client_id | **partial uniq(owner_id) where state='active'** | 보존 | M4 |
| task_completion_review | 종료 피드백 | session_id, outcome(done/partial/not_done), reason_chips text[], note | — | 보존 | M4 |
| estimation_feedback | 학습 입력 | task_id, estimated_p50, actual_focus_min, quality(ok/outlier/excluded) | (owner_id,created_at) | 사용자 초기화 가능 | M5 |
| context_document | 노트 | title, body_md, body_tsv tsvector, sensitivity(P1/P2), llm_allowed bool | gin(body_tsv) | soft | M6 |
| document_link | 연결 | document_id, target_type, target_id, anchor? | (target_type,target_id) | 함께 | M6 |
| attachment_metadata | 첨부 | document_id?, task_id?, blob_key, mime, size, sha256, scan_status | uniq(sha256,owner_id) | soft + blob GC | M6 |
| agent_run | LLM 호출 단위 | purpose, prompt_id@version, model, provider, tokens_in/out, cost_usd, latency_ms, status, redaction_report jsonb | (owner_id,created_at) | 90일 [가정], 본문 미저장 | M2 |
| agent_proposal | 제안 액션 | run_id, kind, payload jsonb, schema_ok, policy_ok, constraint_ok, decision(pending/approved/rejected/expired) | (decision) | 보존 | M2 |
| agent_event | 개입 이벤트 | kind(trigger), suppressed bool, reason | — | 90일 | M5 |
| notification | 알림 | kind, dedupe_key, scheduled_at, sent_at, channel, state | **uniq(owner_id,dedupe_key)** | 30일 | M4 |
| push_subscription | 기기 구독 | endpoint, p256dh, auth(암호화), device_label | uniq(endpoint) | 해지 시 삭제 | M4 |
| audit_event | 감사 | actor(user/system/agent), action, entity, entity_id, diff_summary(민감정보 제외) | (entity,entity_id) | 1년 [가정] | M1 |
| outbox_event | 트랜잭셔널 아웃박스 | topic, payload, available_at, attempts, processed_at | (processed_at null, available_at) | 처리 7일 후 삭제 | M1 |
| inbox_event | 외부 이벤트 중복 제거 | provider, event_hash, received_at | uniq(provider,event_hash) | 30일 | M1 |
| idempotency_record | 멱등 키 | key, route, request_hash, response jsonb, status | uniq(owner_id,key) | 24h | M1 |
| job | 작업 큐 | kind, run_at, lease_until, attempts, unique_key | uniq(unique_key) where pending | 7일 | M1 |
| external_provider_mapping | 외부 ID 맵 | entity_type, entity_id, provider('vikunja'), external_id, external_etag, last_synced_at | uniq(provider,entity_type,external_id), uniq(entity_type,entity_id,provider) | 이전 완료 후 보존(감사) | M1 |

**MVP 통합 방침:** `ui_layout_preference`는 `user.settings.layout`에 jsonb로 시작 → 기기별 분리 요구 발생 시 테이블 분리. `estimate_evidence`는 M2 초기에 `estimate.evidence jsonb`로 대체 가능(분리 조건: 근거 검색 필요 시).

## 4. Task core 필드의 SoR (ADR-004)
- **Vikunja 단계:** title, description, done, due_date, project, labels, (repeat) = Vikunja가 SoR. planner `task`는 `*_cache` + planner 전용 필드.
- **Native 단계:** 동일 필드를 planner `task`가 SoR로 보유(`title`, `description_md`, `done_at` 컬럼 추가 마이그레이션).
- 도메인 타입 `Task`는 두 경우 모두 동일하며 `TaskRepository`가 조립한다.

## 5. 대표 JSON 예시

```json
{
  "id": "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55",
  "projectId": "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0001",
  "title": "관련 논문 5편 요약",
  "status": "todo",
  "dueAt": "2026-11-20T23:59:00+09:00",
  "splittable": true,
  "session": { "minMinutes": 30, "maxMinutes": 90 },
  "estimate": { "p50Minutes": 180, "p90Minutes": 300, "method": "template", "confidence": 0.55 },
  "dependsOn": ["0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c54"],
  "version": 3,
  "external": [{ "provider": "vikunja", "externalId": "412" }]
}
```

```json
{
  "planCandidateId": "0193…",
  "policy": "focus_blocked",
  "feasible": true,
  "blocks": [{ "taskId": "0193…c55", "startAt": "2026-11-14T19:00:00+09:00", "endAt": "2026-11-14T20:30:00+09:00" }],
  "metrics": { "totalFocusMinutes": 300, "minSlackMinutes": 1440, "maxDailyLoadMinutes": 150, "changedBlocks": 0, "deficitMinutes": 0, "p90CoverageRatio": 1.0 },
  "inputHash": "sha256:…", "generatorVersion": "scheduler@0.1.0"
}
```

## 6. 무결성 규칙(도메인 테스트 대상)
1. task_dependency는 DAG(사이클 시 422 `dependency_cycle`).
2. 활성 schedule_block은 동일 owner에서 겹침 불가(DB EXCLUDE + 도메인 validator 이중).
3. block은 commitment_event·rest 구간과 겹침 불가(validator).
4. 같은 task의 block 합계 ≤ 추정 P90 × 1.5 [가정] (과다배치 방지).
5. active work_session 1개.
