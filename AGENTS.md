# AGENTS.md — OhMyDate coding rules (promoted from docs/AGENTS-DRAFT.md on 2026-11-11)

## 프로젝트
OhMyDate: 적응형 AI 개인 플래너. 기준 명세 `ORCA_ADAPTIVE_PLANNER_MASTER_SPEC.md`, 설계 `docs/blueprint/`.

## 구조와 경계
- `packages/domain`: 순수 TS. I/O·Node 내장·프레임워크 import 금지.
- `packages/contracts`: TypeBox 스키마가 API의 단일 소스. 변경 시 `openapi.json` 재생성 커밋.
- `packages/scheduler`: 순수 함수, 결정론(시드), validator는 생성기와 별도 구현.
- `services/api`: Fastify. 라우트 → application use-case → domain/ports. 라우트에서 DB 직접 접근 금지.
- `apps/web`: Vue 3 `<script setup lang="ts">`, Pinia, Vue Query. `v-html` 금지(sanitize 컴포넌트만).
  화면은 `apps/web/DESIGN.md`(2026-11-13 재디자인, 텐미닛 플래너)와 `apps/web/docs/ui-polish/README.md`의 규칙을 따른다: 색·글꼴은 `tokens.css`에만, 카드·그림자·알약 배지 없음, 화면당 채워진 버튼 하나.
- `upstream/vikunja`: AGPL 구역. 다른 코드에서 import·복사 금지. 수정은 `PATCHES.md` 기록.
- `core/`: Rust 코어(아래 "Rust 코어" 절). `tests-core/`: 그 블랙박스 패리티 하네스(pnpm 워크스페이스 패키지가 아니다 — lockfile을 바꾸지 않는다).

## 규칙
- TypeScript strict, ESM, Node ≥24, `corepack pnpm` 사용.
- ID는 UUIDv7, 시간은 UTC `Instant` + IANA tz. `Date` 직접 연산 대신 시간 유틸 사용(`Clock` 포트 주입).
- 모든 변경 API: `If-Match` + `Idempotency-Key`. 오류는 problem+json `code` enum.
- LLM 출력은 proposal로만 저장, 스키마 검증 후 사용. 테스트는 FakeLlm.
- 로그에 노트 본문·프롬프트·토큰·비밀 금지.
- 비밀 파일(`*api_key*.txt`, `deploy/secrets/**`, `*.key.txt`)을 읽기·출력·복사·커밋 금지. 제품은 `LLM_API_KEY_FILE` 경로로만 키를 읽고, 테스트는 FakeLlm/녹화 fixture만 사용.
- 테스트: 새 동작마다 단위 테스트 + 네거티브 1개 이상. 테스트 삭제·skip·assert 완화 금지.
- 커밋: Conventional Commits, 본문에 `Task: <id>`.
- 의존성 추가 시 라이선스 확인(MIT/Apache-2.0/BSD/ISC 외는 리뷰 필요).

## 명령 (M1-01 이후 확정)
`corepack pnpm run ci` = typecheck + lint + test + check:api-client + check:boundaries + build smoke.
`run`을 빼면 안 된다: pnpm 12에서 `pnpm ci`는 node_modules를 지우고 다시 설치하는 내장 명령이다.
DB가 필요한 테스트는 `DATABASE_URL`(planner_test)과 `VIKUNJA_URL`이 없으면 건너뛴다.

## Rust 코어 `core/` (ADR-025, 계획: `docs/blueprint/15-DESKTOP-RUST-CORE.md`)
리눅스 데스크톱 앱의 백엔드. TypeScript 코어(`services/api`, `packages/*`)는 전환 전까지 기준 구현이고 기능 동결(버그 수정만)이다.
- **경계** (Cargo 의존 방향이 곧 규칙): `server → app → {store, scheduler, llm} → domain`.
  - `crates/domain`: 표준 라이브러리만. I/O·serde·외부 크레이트 금지.
  - `crates/scheduler`: 순수 함수. I/O·시계·전역 상태 금지, 워크스페이스의 다른 크레이트에 의존 금지. TypeScript 스케줄러와 출력이 바이트 단위로 같아야 한다(오라클 테스트). 정렬은 `sort_by`(안정)만, 문자열 순서는 `compare_utf16`, 수를 글자로 바꿀 때는 `js_number`, `HashMap` 순회 금지.
  - `crates/store`: SQL과 엔터티만. HTTP·업무 규칙 금지. 스키마 변경은 새 마이그레이션 파일(배포된 파일 수정 금지).
  - `crates/app`: 유스케이스. 규칙 검사와 쓰기는 같은 트랜잭션(`App::read` / `App::mutate_idempotent`).
  - `crates/server`: HTTP만. 경로·헤더 규칙·요청 검증은 `packages/contracts/openapi.json`에서 온다. operation은 `handlers::table()`에 등록하고 `tests-core/support/routes.ts`에 한 줄을 추가한다. 계약에 없는 경로를 만들지 않는다.
- **오류:** 라이브러리 코드에서 `unwrap`/`expect`/`todo!`/`dbg!` 금지(clippy가 막는다; 테스트는 허용). `panic!`은 빌드 결함처럼 계속할 수 없는 경우에만 쓰고 `# Panics`에 적는다. 도메인 실패는 `DomainError`, 저장 실패는 `StoreError`, HTTP에서는 `Problem`. 문제 응답과 오류 메시지에 사용자 글을 넣지 않는다.
- **unsafe 금지:** 워크스페이스 lint `unsafe_code = "forbid"`. 예외 없음.
- **시간·id:** `SystemTime::now()`·난수를 직접 부르지 않는다 — `Clock`·`RandomSource`·`IdGenerator`를 받는다(어댑터는 `server::system`뿐). id는 UUIDv7(`domain::Id`), 시각은 UTC 밀리초(`domain::Instant`), 시간대는 IANA 이름 + `jiff`(tzdb는 바이너리에 포함). SQL에 시간 기본값을 두지 않는다.
- **로그:** `tracing` 구조화 로그. id·코드·개수·시간만. 제목·본문·노트·프롬프트·쿼리 문자열·경로·토큰·비밀 금지. `StoreError`는 `kind()`와 `sqlite_code()`만 남긴다. 새 영역은 "사용자 글이 로그에 없다"는 테스트를 함께 넣는다.
- **비밀:** OS 키링(없으면 0600 파일)에만 둔다. DB·로그에 쓰지 않는다. 실행 토큰은 메모리와 `--ready-file`(0600)에만 있고 `Debug` 출력에 나오지 않는다.
- **의존성:** 추가·갱신 시 라이선스를 확인하고 `docs/blueprint/10-LICENSE-AND-MIGRATION.md` §9 표를 갱신한다. MIT/Apache-2.0/BSD/ISC 밖은 사용자 확인. `Cargo.lock`은 커밋한다.
- **테스트:** 새 동작마다 단위 테스트 + 네거티브 1개 이상. 테스트 삭제·`#[ignore]`·assert 완화 금지. 스케줄러·마스킹은 오라클 팩과 불일치 0.
- **명령** (한 번에 하나, `CARGO_BUILD_JOBS=4`, 워커는 `--release` 빌드 금지; `export PATH="$HOME/.cargo/bin:$PATH"`):
  - `corepack pnpm run core:check` = `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + `cargo test`.
  - `corepack pnpm run core:parity` = 바이너리 빌드 + `tests-core/`(블랙박스 계약 패리티, 계획 문서 표 검사).
  - `corepack pnpm run core:oracle -- --count N` = TypeScript 스케줄러로 오라클 팩 다시 만들기.
  - 둘은 아직 `pnpm run ci`에 들어 있지 않다(15 §7.6). RC Task는 "Exact tests"에 적어 돌린다.

## Dev infrastructure (orchestrator-managed; workers must not run docker/sudo)
- PostgreSQL 18: `127.0.0.1:55432`, user `ohmydate`, password `ohmydate-dev-only`, DBs `planner`, `planner_test`, `vikunja` (Vikunja-owned; never write).
- Vikunja v2.8.0: `http://127.0.0.1:3456` (API v2 spec: `/api/v2/openapi.json`). Registration enabled; synthetic users only.
- If infra is down: `orca orchestration ask` the coordinator. Never start containers yourself.
