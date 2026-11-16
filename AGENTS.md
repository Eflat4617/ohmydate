# AGENTS.md — OhMyDate coding rules (promoted from docs/AGENTS-DRAFT.md on 2026-11-11)

## 프로젝트
OhMyDate: 적응형 AI 개인 플래너. 기준 명세 `ORCA_ADAPTIVE_PLANNER_MASTER_SPEC.md`, 설계 `docs/blueprint/`.

## 구조와 경계
- `packages/domain`: 순수 TS. I/O·Node 내장·프레임워크 import 금지.
- `packages/contracts`: TypeBox 스키마가 API의 단일 소스. 변경 시 `openapi.json` 재생성 커밋.
- `packages/scheduler`: 순수 함수, 결정론(시드), validator는 생성기와 별도 구현.
- `services/api`: Fastify. 라우트 → application use-case → domain/ports. 라우트에서 DB 직접 접근 금지.
- `apps/web`: Vue 3 `<script setup lang="ts">`, Pinia, Vue Query. `v-html` 금지(sanitize 컴포넌트만).
  화면은 `apps/web/DESIGN.md`(2026-11-13 밤 재디자인, 어두운 대시보드 시스템)와 `apps/web/docs/ui-polish/README.md`의 규칙을 따른다: 색·글꼴은 `tokens.css`에만, 카드가 기본 단위, 화면당 채워진(라임) 버튼 하나, 다크 기본 + 라이트 테마.
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
  단, 2026-11-14 사용자 지시("원본을 따르려고 할 필요는 없어. 창의성을 발휘할 수 있도록 해")로 화면·구조·이름·경로를 새로 설계해도 된다. 의도적으로 바꾼 동작의 테스트는 새 동작에 맞게 다시 쓴다(같거나 더 넓은 범위, skip 금지). 데이터 안전·소유자 격리·멱등/충돌·오프라인 재생·보안을 지키는 테스트는 그대로 둔다.
- 커밋: Conventional Commits, 본문에 `Task: <id>`.
- 의존성 추가 시 라이선스 확인(MIT/Apache-2.0/BSD/ISC 외는 리뷰 필요).

## 명령 (M1-01 이후 확정)
`corepack pnpm run ci` = typecheck + lint + test + check:api-client + check:boundaries + build smoke.
`run`을 빼면 안 된다: pnpm 12에서 `pnpm ci`는 node_modules를 지우고 다시 설치하는 내장 명령이다.
DB가 필요한 테스트는 `DATABASE_URL`(planner_test)과 `VIKUNJA_URL`이 없으면 건너뛴다.

## Rust 코어 `core/` (ADR-025, 계획: `docs/blueprint/15-DESKTOP-RUST-CORE.md`)
리눅스 데스크톱 앱의 백엔드. TypeScript 코어(`services/api`, `packages/*`)는 전환 전까지 기준 구현이고 기능 동결(버그 수정만)이다.
- **경계** (Cargo 의존 방향이 곧 규칙): `server → app → {store, scheduler, recurrence, llm} → domain`.
  - `crates/domain`: 표준 라이브러리만. I/O·serde·외부 크레이트 금지.
  - `crates/scheduler`: 순수 함수. I/O·시계·전역 상태 금지, 워크스페이스의 다른 크레이트에 의존 금지. TypeScript 스케줄러와 출력이 바이트 단위로 같아야 한다(오라클 테스트). 정렬은 `sort_by`(안정)만, 문자열 순서는 `compare_utf16`, 수를 글자로 바꿀 때는 `js_number`/`js::number_to_string`, `Math.max`·`Math.min`·`Math.round`는 `js::max`·`js::min`·`js::round`(`f64`의 같은 이름 함수는 NaN과 절반 처리가 다르다). `HashMap`·`HashSet`과 `sort_unstable*`는 이 크레이트의 `clippy.toml`이 막는다 — 삽입 순서를 지키는 구조를 쓴다.
  - `crates/recurrence`: 반복 약속의 전개(`services/api/src/application/rrule.ts` 포팅, 15 §6.1). 순수 함수 — I/O·시계·전역 상태 금지, `jiff` 말고는 의존 금지(워크스페이스 크레이트도). 같은 입력에 기준 구현과 **같은 발생**(같은 시각, 같은 표기, 같은 종류의 거부)을 내야 한다: `tests/oracle.rs`가 기준 구현이 쓴 팩과 건별로 대조하고 불일치 허용은 0이다. 외부 RRULE 크레이트를 쓰지 않는다. 오류 문구에 규칙의 글자를 되풀이하지 않는다.
  - `crates/store`: SQL과 엔터티만. HTTP·업무 규칙 금지. 스키마 변경은 새 마이그레이션 파일(배포된 파일 수정 금지).
  - `crates/app`: 유스케이스. 규칙 검사와 쓰기는 같은 트랜잭션(`App::read` / `App::mutate_idempotent`).
  - `crates/server`: HTTP만. 경로·헤더 규칙·요청 검증은 `packages/contracts/openapi.json`에서 온다. operation은 `handlers::table()`에 등록하고 `tests-core/support/routes.ts`에 한 줄을 추가한다. 계약에 없는 경로를 만들지 않는다 — 예외는 코어 자신의 것 넷뿐이다: `/healthz`, `/readyz`, `/__boot`, 그리고 `--web-dir`의 정적 파일. `/api…`와 `/__…`는 코어가 예약한다.
- **availability version:** 가용 시간이나 약속을 바꾸는 쓰기는 같은 트랜잭션에서 `app::availability::bump`를 부른다(약속의 만들기·고치기·삭제가 그렇게 한다; RC-90의 가져오기도 그래야 한다). 계획의 승인은 그 버전을 `If-Match: W/"availability:<n>"`로 가리킨다 — 올리지 않은 변경은 낡은 계획의 승인을 막지 못한다.
- **글자:** 사용자 글을 저장하는 필드는 `domain::ensure_no_nul`을 지난다. 스키마는 U+0000을 글자로 받지만 SQLite의 글자 함수는 거기서 멈춘다 — 막지 않으면 CHECK 실패(500)가 된다.
- **오류:** 라이브러리 코드에서 `unwrap`/`expect`/`todo!`/`dbg!` 금지(clippy가 막는다; 테스트는 허용). `panic!`은 빌드 결함처럼 계속할 수 없는 경우에만 쓰고 `# Panics`에 적는다. 도메인 실패는 `DomainError`, 저장 실패는 `StoreError`, HTTP에서는 `Problem`. 문제 응답과 오류 메시지에 사용자 글을 넣지 않는다.
- **unsafe 금지:** 워크스페이스 lint `unsafe_code = "forbid"`. 예외 없음.
- **시간·id:** `SystemTime::now()`·난수를 직접 부르지 않는다 — `Clock`·`RandomSource`·`IdGenerator`를 받는다(어댑터는 `server::system`뿐). id는 UUIDv7(`domain::Id`), 시각은 UTC 밀리초(`domain::Instant`), 시간대는 IANA 이름 + `jiff`(tzdb는 바이너리에 포함). SQL에 시간 기본값을 두지 않는다.
- **로그:** `tracing` 구조화 로그. id·코드·개수·시간만. 제목·본문·노트·프롬프트·쿼리 문자열·경로·토큰·비밀 금지. `StoreError`는 `kind()`와 `sqlite_code()`만 남긴다. 새 영역은 "사용자 글이 로그에 없다"는 테스트를 함께 넣는다.
- **비밀:** OS 키링(없으면 0600 파일)에만 둔다. DB·로그에 쓰지 않는다. 실행 토큰은 메모리와 `--ready-file`(0600)에만 있고 `Debug` 출력에 나오지 않는다. 요청 로그에 경로와 쿼리를 넣지 않는다(`/__boot?token=…`의 쿼리가 토큰이다).
- **쿠키:** 코어가 내는 쿠키에 `Secure`를 붙이지 않는다. 데스크톱 웹뷰(WebKit)는 `http://127.0.0.1`이 준 `Secure` 쿠키를 저장하지 않는다. 실행 쿠키는 `omd_launch=<토큰>; Path=/; HttpOnly; SameSite=Strict` 그대로이고 테스트가 글자까지 고정한다(15 §1.3).
- **웹 서빙:** `--web-dir <디렉터리>`가 있을 때만 `core/crates/server/src/web.rs`가 빌드된 웹을 같은 출처로 서빙한다. 경로 규칙(문서로 대신할 것 / 404 / 예약 경로)과 CSP는 그 파일과 15 §1.3이 정본이다. CSP를 넓히려면 이유를 그 주석과 15 §1.3에 적고, 웹이 그 정책 아래서 도는지 진짜 빌드로 확인한다.
- **웹의 데스크톱 번들:** 코어가 서빙하는 웹은 `vite build --mode desktop`으로 만든 것이다(`apps/web/desktop/dist`; 서버 번들의 `apps/web/dist`와 섞지 않는다 — `local:start`가 `dist`를 서빙한다). 무엇이 다른지는 `apps/web/src/platform/mode.ts`와 15 §7.3이 정본이다: 로그인·로그아웃·푸시 UI 없음, `/me` 401은 "앱에서 다시 열어 주세요", 501은 "준비 중"(`platform/notReady.ts` — 재시도하지 않고, 경고로 말하지 않고, 던지지 않는다). 데스크톱에서만 다른 동작은 `isDesktop()`·`isNotReady()` 뒤에 두고, 서버 번들에서 그대로임을 보이는 네거티브 테스트를 함께 넣는다. 실행 중에 모드를 바꾸는 스위치(주소, 저장소, 응답, `VITE_` 변수)를 만들지 않는다. 새 operation을 포팅했으면 그 화면이 "준비 중"에서 벗어났는지 E2E `core` 대상으로 본다.
- **테스트 시계:** `--clock-offset-ms`와 `system::ShiftedClock`은 cargo feature `test-clock`(기본 꺼짐)에만 있다. 패키징되는 빌드에 이 feature를 넣지 않는다. `test-clock` 뒤에 두는 것은 시계뿐이다 — 다른 테스트 전용 동작을 여기에 얹지 않는다.
- **의존성:** 추가·갱신 시 라이선스를 확인하고 `docs/blueprint/10-LICENSE-AND-MIGRATION.md` §9 표를 갱신한다. MIT/Apache-2.0/BSD/ISC 밖은 사용자 확인. `Cargo.lock`은 커밋한다.
- **테스트:** 새 동작마다 단위 테스트 + 네거티브 1개 이상. 테스트 삭제·`#[ignore]`·assert 완화 금지. 스케줄러·마스킹은 오라클 팩과 불일치 0.
- **명령** (한 번에 하나, `CARGO_BUILD_JOBS=4`, 워커는 `--release` 빌드 금지; `export PATH="$HOME/.cargo/bin:$PATH"`):
  - `corepack pnpm run ci:core` = `core:check` + `core:parity`. RC Task의 "Exact tests"에 이것을 적는다. `pnpm run ci`에는 들어 있지 않다(15 §7.6).
  - `corepack pnpm run core:check` = `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + `cargo test`, 그리고 서버 크레이트는 테스트 빌드(`--features test-clock`)로 clippy와 test를 한 번 더.
  - `corepack pnpm run core:build` = 테스트용 바이너리 빌드(`cargo build -p ohmydate-server --features test-clock`). 하네스와 E2E가 쓰는 바이너리다.
  - `corepack pnpm run core:dev` = 브라우저에서 Rust 코어로 화면을 쓰는 개발 실행(15 §7.3). 코어를 빌드해(`core:build`와 같은 바이너리) 임시 데이터 디렉터리로 띄우고, Vite를 데스크톱 모드로(`vite --mode desktop`) 띄운다. `http://127.0.0.1:5173`을 연다 — 로그인이 없다. 옵션은 `--` 뒤에: `--data-dir <디렉터리>`(데이터를 남긴다; 없으면 끝날 때 지운다), `--port <n>`(Vite 포트 = 코어가 허용하는 출처), `--time-zone`, `--locale`, `--skip-build`. Ctrl-C가 둘 다 끝낸다. 실행 토큰은 코어의 ready 파일(0600)에만 있다: 런처는 그 **경로**만 Vite에 넘기고(`OHMYDATE_CORE_READY_FILE`), Vite의 `/api` 프록시(`apps/web/config/coreProxy.ts`)가 코어로 가는 요청에만 붙인다 — 인자·환경 변수·브라우저 번들·터미널 출력에 넣지 않는다. 개발 전용이다: 그 포트에 닿는 누구에게나 프록시가 토큰을 붙여 준다.
  - `corepack pnpm run e2e:core` = 같은 Playwright spec을 Rust 코어에 돌린다(`core:build` + `E2E_TARGET=core`; WebKit은 `-- --browser=webkit` — 출력의 줄마다 `[webkit]`이 붙어야 WebKit으로 돈 것이다). 데스크톱 번들을 빌드하고 코어를 새 데이터 디렉터리로 띄워 그 번들을 서빙하게 한다 — PostgreSQL·Vikunja가 필요 없다. 도는 것은 `e2e/targets/core.spec.ts`와 `e2e/targets/core-specs.json`의 spec이다. 영역을 포팅한 Task는 그 spec을 목록에 더하고(Chromium·WebKit 둘 다 통과), `e2e/helpers/driver.ts`의 `CORE_SERVES`에 영역을, `core/PARITY.md`에 줄을 고친다. 헬퍼 규칙은 `e2e/README.md`. `pnpm run ci`·`ci:core`에 들어 있지 않다(브라우저가 필요하다).
  - `corepack pnpm run core:parity` = `core:build` + `tests-core/`(블랙박스 계약 패리티, 웹 서빙·`/__boot`·수명 주기, 계획 문서 표 검사).
  - `corepack pnpm run core:ledger` = 패리티 원장 `core/PARITY.md`와 계획 문서 표 검사(코어 프로세스 없이 1초 안). TypeScript 테스트 파일(`services/api/test`, `packages/*/test`, `e2e/tests`)을 더하면 원장에 한 줄을 더한다. RC Task를 끝내면 원장에서 그 Task를 "끝난 Task"로 옮기고 자기 `아직` 줄을 전부 `옮김`·`대체`·`해당 없음`으로 바꾼다. 합계 표는 `LEDGER_WRITE_TOTALS=1 corepack pnpm run core:ledger`가 다시 쓴다.
  - `corepack pnpm run core:schema-diff` = 두 검증기(Ajv ↔ 코어의 `jsonschema`)의 판정 대조(15 §2.4). 계약의 요청 스키마마다 표본을 만들어 양쪽에 묻고, 판정이 갈리는데 결정이 없는 것이 있으면 실패한다. 계약(`packages/contracts`)을 바꿨으면 이것을 돌린다. 새 차이는 코어를 고치거나, `tests-core/support/schema-differences.ts`와 15 §2.4에 결정을 적는다. 계약에 새 `format`·`pattern`·키워드가 생기면 `tests-core/support/samples.ts`에 그 표본을 더한다. 보고서: `core/target/schema-diff/report.md`.
  - `corepack pnpm run core:oracle -- --count N` = TypeScript 스케줄러로 오라클 팩 다시 만들기(인자 없이 = 커밋하는 `sample.json`).
  - `corepack pnpm run core:diff` = 기준 테스트의 입력을 모으고(`core:harvest`) 시드 2,000건과 함께 팩을 `core/target/oracle/`에 만들어(커밋하지 않는다) Rust 스케줄러와 층별로 대조. `ORACLE_COUNT`·`ORACLE_SEED`로 개수·시드를 바꾼다. 불일치 허용 0. 스케줄러(`packages/scheduler/src` 또는 `core/crates/scheduler`)를 건드린 Task는 이것을 돌린다. 생성기 코드를 일부러 틀리게 해도 이것과 테스트가 통과하면, 그 코드가 결과를 가르는 입력을 내보내기의 `pathCases()`에 더하고 `core:oracle`로 `sample.json`을 다시 만들어 함께 커밋한다(15 §5.3).
  - `corepack pnpm run core:rrule-oracle` = 반복 전개의 팩 다시 만들기(인자 없이 = 커밋하는 `core/crates/recurrence/tests/oracle/sample.jsonl`). 생성기는 `tests-core/support/recurrence-oracle.ts`. 팩이 지금의 기준 구현과 같은지는 `core:parity`의 `tests-core/recurrence.test.ts`가 본다 — 생성기를 고쳤거나 Node의 tzdata가 바뀌어 그것이 실패하면 팩을 다시 만들어 함께 커밋하고 `cargo test -p ohmydate-recurrence`를 돌린다.
  - `corepack pnpm run core:rrule-diff` = 큰 팩(시드 20,000건, 2020–2030년의 시계 변경)을 `core/target/recurrence-oracle/`에 만들어(커밋하지 않는다) 대조. `RRULE_ORACLE_COUNT`·`RRULE_ORACLE_SEED`로 개수·시드를 바꾼다. 불일치 허용 0. `core/crates/recurrence`나 기준의 `rrule.ts`를 건드린 Task는 이것을 돌린다. 포팅을 일부러 틀리게 해도 커밋된 팩이 통과하면, 그 코드가 결과를 가르는 입력을 생성기의 `handCases()`에 더한다.
  - `corepack pnpm run core:shrink -- --pack <팩> --case <건 id>` = 불일치 건의 입력을 최소로 줄여 `core/crates/scheduler/tests/oracle/regressions/`에 건 하나짜리 팩으로 쓴다(15 §5.3). 스케줄러 불일치를 고칠 때는 그 팩을 함께 커밋한다.
  - 속성 테스트 횟수는 `SCHED_PROPERTY_RUNS`(기본 1,000, 관문 10,000), 시드는 `SCHED_PROPERTY_SEED`.
  - 이 명령들은 `pnpm run ci`에 들어 있지 않다(15 §7.6). RC Task는 "Exact tests"에 `ci:core`를 적어 돌리고, 스케줄러를 건드렸으면 `core:diff`를 더한다.
  - `ohmydate-core`의 옵션: `--data-dir`, `--port`, `--ready-file`, `--time-zone`, `--locale`, `--allow-origin`(개발 서버의 출처), `--web-dir`(빌드된 웹), 그리고 테스트 빌드에만 `--clock-offset-ms`. 두 번째 바이너리 `schema-verdict`는 판정 대조 도구의 코어 쪽이다.

## Dev infrastructure (orchestrator-managed; workers must not run docker/sudo)
- PostgreSQL 18: `127.0.0.1:55432`, user `ohmydate`, password `ohmydate-dev-only`, DBs `planner`, `planner_test`, `vikunja` (Vikunja-owned; never write).
- Vikunja v2.8.0: `http://127.0.0.1:3456` (API v2 spec: `/api/v2/openapi.json`). Registration enabled; synthetic users only.
- If infra is down: `orca orchestration ask` the coordinator. Never start containers yourself.
