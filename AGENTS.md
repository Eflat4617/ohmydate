# AGENTS.md — OhMyDate coding rules (promoted from docs/AGENTS-DRAFT.md on 2026-11-11)

## 프로젝트
OhMyDate: 적응형 AI 개인 플래너. 기준 명세 `ORCA_ADAPTIVE_PLANNER_MASTER_SPEC.md`, 설계 `docs/blueprint/`.

## 구조와 경계
- `packages/domain`: 순수 TS. I/O·Node 내장·프레임워크 import 금지.
- `packages/contracts`: TypeBox 스키마가 API의 단일 소스. 변경 시 `openapi.json` 재생성 커밋.
- `packages/scheduler`: 순수 함수, 결정론(시드), validator는 생성기와 별도 구현.
- `services/api`: Fastify. 라우트 → application use-case → domain/ports. 라우트에서 DB 직접 접근 금지.
- `apps/web`: Vue 3 `<script setup lang="ts">`, Pinia, Vue Query. `v-html` 금지(sanitize 컴포넌트만).
- `upstream/vikunja`: AGPL 구역. 다른 코드에서 import·복사 금지. 수정은 `PATCHES.md` 기록.

## 규칙
- TypeScript strict, ESM, Node ≥24, `corepack pnpm` 사용.
- ID는 UUIDv7, 시간은 UTC `Instant` + IANA tz. `Date` 직접 연산 대신 시간 유틸 사용(`Clock` 포트 주입).
- 모든 변경 API: `If-Match` + `Idempotency-Key`. 오류는 problem+json `code` enum.
- LLM 출력은 proposal로만 저장, 스키마 검증 후 사용. 테스트는 FakeLlm.
- 로그에 노트 본문·프롬프트·토큰·비밀 금지.
- 테스트: 새 동작마다 단위 테스트 + 네거티브 1개 이상. 테스트 삭제·skip·assert 완화 금지.
- 커밋: Conventional Commits, 본문에 `Task: <id>`.
- 의존성 추가 시 라이선스 확인(MIT/Apache-2.0/BSD/ISC 외는 리뷰 필요).

## 명령 (M1-01 이후 확정)
`corepack pnpm ci` = typecheck + lint + test + check:boundaries.

## Dev infrastructure (orchestrator-managed; workers must not run docker/sudo)
- PostgreSQL 18: `127.0.0.1:55432`, user `ohmydate`, password `ohmydate-dev-only`, DBs `planner`, `planner_test`, `vikunja` (Vikunja-owned; never write).
- Vikunja v2.8.0: `http://127.0.0.1:3456` (API v2 spec: `/api/v2/openapi.json`). Registration enabled; synthetic users only.
- If infra is down: `orca orchestration ask` the coordinator. Never start containers yourself.
