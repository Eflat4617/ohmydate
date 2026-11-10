# 14. 구현 핸드오프 — 첫 실행 패킷

> 이 문서의 패킷은 **승인 후** `orca orchestration task-create --spec-file`로 등록되는 불변 원본이다. 등록 후 수정 시 새 버전 파일(`…-v2`)을 만들고 ledger에 기록한다.
> 공통 워커 계약: `docs/orchestration/WORKER-AND-REVIEW-CONTRACT.md` (패킷 spec 맨 앞에 전문 삽입).

---

## PRE: M0-01 Bootstrap (Opus 직접 수행, 워커 아님)
1. 본 docs를 `torgal/ohmydate`에 커밋(사용자 승인 = 커밋 허용).
2. 통합 브랜치 = `torgal/ohmydate`(이 코디네이터 worktree; 별도 dev 브랜치 없음), 이후 워커 worktree는 `--worktree new-child`(현재 worktree 자식)로 생성.
3. 저장소 루트 `opencode.jsonc` 추가(ADR-014, `MODEL_BINDINGS.md` §4의 내용), `.gitignore`(node_modules, .env*, deploy/secrets).
4. `orca orchestration run-create --objective "M0-M1: bindings, Vikunja probe, Task CRUD vertical slice" --json` → ledger 기록.

## PRE: M0-02 Binding probes (Opus 감독, 각 1 dispatch)
- P1 DeepSeek: `worker-start --task <P1> --worktree new-child --name probe-deepseek --agent opencode --json` (모델 플래그 없음: 저장소 설정 사용). 스펙: "`probe/deepseek.txt`에 `opencode debug config`의 model/variant 관련 출력과 현재 세션 모델 식별자를 기록하고 worker_done". 판정: 기록값 = `opencode-go/deepseek-v4.1-flash` + effort high, 그리고 `worker-show` 의 launch 정보가 opencode.
- P2 Sol: `worker-start --task <P2> --worktree new-child --name probe-sol --agent codex --model gpt-6.1-sol --effort high --json`. 판정: receipt의 requested/effective model·effort 일치.
- 불일치 → 해당 역할 BLOCKED_MODEL_UNAVAILABLE, 사용자 보고(대체 모델 자동 선택 금지).

---

# TASK PACKET: M0-03 — Vikunja v2.8.0 API v2 capability probe
- Run ID / milestone / priority: `<RUN_ID>` / M0 / P0
- Owner model & agent CLI (verified): DeepSeek V4.1 Flash high via OpenCode (`opencode-go/deepseek-v4.1-flash`) — P1 통과 전제
- Objective & user-visible acceptance: Vikunja v2.8.0 공식 릴리스 바이너리(linux amd64)를 sqlite로 **로컬 임시 실행**하여 `/api/v2/openapi.json`을 저장하고, M1–M7에 필요한 기능 지원 여부 표를 작성한다.
- Related: 02 §4.1, 04 §4, 08 §6, ADR-004
- Dependencies / base: M0-02 P1 통과, base = `torgal/ohmydate` HEAD
- Worktree / branch / allowed paths: new-child worktree, 브랜치 `w/m0-03-vikunja-probe`. 쓰기 허용: `docs/blueprint/vendor/**`, `scripts/probe/vikunja/**`
- Forbidden: 다른 모든 경로, `upstream/`, 전역 설치, sudo, docker, 포트 3456 외 바인딩, 실사용자 데이터, 외부 서비스 계정 생성
- Inputs/outputs:
  - `scripts/probe/vikunja/run.sh` — 릴리스 zip 다운로드(**GitHub release URL만**), 공식 checksum 파일로 sha256 검증, 스크래치 디렉터리에서 `VIKUNJA_DATABASE_TYPE=sqlite`, `VIKUNJA_SERVICE_INTERFACE=127.0.0.1:3456`로 실행, 테스트 사용자 생성(CLI), 종료 시 프로세스·임시 데이터 정리
  - `docs/blueprint/vendor/vikunja-v2.8.0-openapi.json` (원본 그대로)
  - `docs/blueprint/vendor/vikunja-v2.8.0-capabilities.md` — 표: 기능 | v2 경로·메서드 | 요청/응답 핵심 필드 | ETag/If-Match | 비고. 항목: tasks CRUD, projects, labels, task relations(종류 전체), reminders, repeat(필드·모드), attachments, comments, webhooks(v2 관리 경로 유무, 이벤트 목록), API token scopes(이름 목록), 변경 조회(updated since/필터 가능 여부), 페이지네이션, 시간대 표현, 휴지통 동작
- API/DB/time-zone/privacy: 127.0.0.1만, 합성 데이터만. 타임존은 응답 원문 예시 포함.
- Edge cases & negative tests: If-Match 불일치 시 응답 코드 실측, 존재하지 않는 task 404 problem+json 예시, 토큰 scope 부족 시 403 예시
- Exact tests: `bash scripts/probe/vikunja/run.sh --check` 종료코드 0; capabilities.md의 모든 행에 "실측 요청 예시(curl)" 또는 "미지원 근거(openapi 경로 부재)" 존재
- Expected review evidence: 스크립트 전체, 실행 로그 tail, openapi sha256, 실측 curl 출력 발췌
- worker_done: succeeded = 두 산출물 + 스크립트 커밋. 실행 불가(다운로드 실패 등)는 failed + 원인
- Retry: 2회, 같은 원인 반복 시 BLOCKED. 질문은 `orca orchestration ask`
- Rollback/clean-up: 브랜치 폐기로 충분. 스크래치 디렉터리·프로세스 종료 확인(`ss -ltn | grep 3456` 결과 없음)

---

# TASK PACKET: M1-01 — Monorepo scaffold
- Run / milestone / priority: `<RUN_ID>` / M1 / P0
- Owner: DeepSeek V4.1 Flash high via OpenCode
- Objective: pnpm workspace 모노레포 골격. 사용자 가시 기능 없음. `pnpm -r typecheck && pnpm -r lint && pnpm -r test` 가 빈 패키지에서 통과.
- Related: 03 §4, 11 §1, ADR-002/005/015
- Dependencies / base: M0-02 P1, `torgal/ohmydate` HEAD
- Worktree / branch / allowed: new-child, `w/m1-01-monorepo`. 허용: 루트(`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.dependency-cruiser.cjs`, `vitest.workspace.ts`, `.npmrc`, `.editorconfig`, `.nvmrc`), `apps/web/package.json`+`tsconfig.json`, `services/api/package.json`+`tsconfig.json`, `packages/{domain,contracts,scheduler,llm,ui-policy,provider-vikunja,provider-native,testkit}/{package.json,tsconfig.json,src/index.ts,test/smoke.test.ts}`, `scripts/check-boundaries.mjs`
- Forbidden: `docs/**`(읽기만), `upstream/**`, `opencode.jsonc`, 전역 설치(`npm -g`, `corepack enable`), sudo
- Requirements:
  - pnpm은 `corepack pnpm@<package.json packageManager>`로만 실행(버전은 실행 시점의 최신 pnpm 안정판을 확인해 고정하고 근거를 worker_done에 기록)
  - Node `>=24`, TS strict(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM
  - 경계 규칙: `packages/domain`은 node 내장·외부 I/O 라이브러리 import 금지; 어떤 패키지도 `upstream/` import 금지; `apps/web`은 `services/*` import 금지
  - 루트 스크립트: `typecheck`, `lint`, `test`, `check:boundaries`, `ci`(= 전부)
- Edge/negative: 경계 위반 fixture 파일을 임시 생성해 `check:boundaries`가 실패하는지 확인 후 삭제(로그 제출)
- Exact tests: `corepack pnpm install --frozen-lockfile=false` 후 `corepack pnpm ci` 종료코드 0; 위반 fixture 시 non-zero
- Review evidence: `git diff --stat`, 명령 출력, lockfile 존재, 의존성 라이선스 목록(`pnpm licenses list --json` 요약)
- worker_done: succeeded/failed + 커밋 SHA
- Retry 2 / ask 경유
- Rollback: 브랜치 폐기

---

# TASK PACKET: M1-02 — Domain types + Contracts (TypeBox → OpenAPI)
- Run / milestone / priority: `<RUN_ID>` / M1 / P0
- Owner: DeepSeek V4.1 Flash high via OpenCode
- Objective: M1 범위 도메인 타입·규칙과 HTTP 계약 스키마, OpenAPI 3.1 생성 스크립트.
- Related: 04 §1–§6, 08 §1, §2.1–2.2, §6, ADR-003/004/005
- Dependencies / base: M1-01 Accepted(merged into `torgal/ohmydate`)
- Worktree / branch / allowed: new-child, `w/m1-02-domain-contracts`. 허용: `packages/domain/**`, `packages/contracts/**`
- Forbidden: 다른 패키지, 루트 설정 변경(필요 시 ask), `docs/**`
- Requirements:
  - `packages/domain`: `Id`(UUIDv7 브랜드 타입), `Instant`, `IanaTimeZone`, `Task`, `TaskStatus`, `Project`, `ExternalProviderRef`, `Version`; 오류 클래스 `NotFoundError`, `VersionConflictError`, `ValidationFailedError`, `ProviderUnavailableError`; `TaskRepository` 인터페이스(08 §6 그대로); 순수 함수 `assertAcyclic(deps)`; `Clock`, `IdGenerator` 포트
  - `packages/contracts`: TypeBox 스키마 `TaskCreate/TaskPatch/Task/Project/ProjectCreate/Page<T>/Problem`; 오류 `code` enum(08 §1 전체); 헤더 스키마(`If-Match`, `Idempotency-Key`); `scripts/generate-openapi.ts` → `packages/contracts/openapi.json`(M1 엔드포인트 2.1–2.2 경로 포함, 핸들러 없이 스키마만)
  - 외부 DTO에 Vikunja 필드명/ID 노출 금지
- Edge/negative tests: 사이클 3종(자기참조, 2-cycle, 긴 cycle), 빈 제목 422 스키마 거부, 잘못된 tz 문자열 거부, 추가 속성 거부(additionalProperties false), If-Match 형식 `W/"<n>"` 검증
- Exact tests: `corepack pnpm --filter @ohmydate/domain test`, `--filter @ohmydate/contracts test`, `corepack pnpm --filter @ohmydate/contracts generate && git diff --exit-code packages/contracts/openapi.json`(두 번째 실행 diff 0), 루트 `corepack pnpm ci` 0
- Review evidence: diff, 테스트 출력, openapi.json 요약(경로·스키마 수)
- worker_done / retry / rollback: 위와 동일

---

## 리뷰 패킷 템플릿 (각 구현 Task 뒤 `…R`)
```markdown
# REVIEW PACKET: <ID>R — Independent review of <ID>
- Reviewer: GPT-6.1 Sol high via Codex (`--model gpt-6.1-sol --effort high`)
- Target: worktree <selector>, branch <w/...>, base <integration SHA>, head <worker commit SHA>
- Read-only: 파일 수정·커밋·push 금지. 리뷰 종료 시 `git status --porcelain` 빈 출력 증빙
- Inputs: 원 패킷 전문, worker_done 본문, `git diff <base>...<head>`
- Must run: 패킷의 Exact tests 전부(직접 실행, 출력 첨부)
- Output: WORKER-AND-REVIEW-CONTRACT §3 형식(REVIEW VERDICT …)
- worker_done: succeeded = 리뷰 완료(판정과 무관), body에 VERDICT 첫 줄
```
