# 02. 저장소·환경·업스트림 감사

> 조사일: 2026-11-11 · 방법: 로컬 읽기 전용 명령 + 공식 웹 문서 조회. 설치·빌드·테스트·다운로드는 수행하지 않음.

## 1. 로컬 저장소 [확인]

| 항목 | 값 | 근거 |
|---|---|---|
| 작업 경로 | `/home/torgal/orca/workspaces/oh_my_date/ohmydate` (git worktree) | `orca worktree current --json` |
| 원 저장소 | `/home/torgal/orca/projects/oh_my_date` | `orca repo list --json` (repoId `dde48ef6-…`) |
| 현재 브랜치 | `torgal/ohmydate` @ `d7e6abf` "Initial commit" | `git log` |
| 기본 브랜치 | 로컬 `master` (시스템 안내의 `main`과 다름) | `git branch -a` |
| 원격 | **없음** (`git remote -v` 출력 없음) | push 대상 부재 → push는 원천적으로 불가 |
| 기존 파일 | `ORCA_ADAPTIVE_PLANNER_MASTER_SPEC.md` 단 1개 | `find` |
| 기존 `AGENTS.md`/`CLAUDE.md` | 저장소 내 없음. 상위 `/home/torgal/AGENTS.md`는 다른 프로젝트(REA/Wallpaper) 기록이며 본 프로젝트와 무관 | 파일 확인 |
| 명세가 언급한 `ORCA_OPUS_BOOTSTRAP_PROMPT.md` | 저장소에 없음 (사용자 첫 메시지가 그 역할) | `find` |

## 2. 개발 기기 [확인 / 일부 추정]

| 항목 | 값 | 함의 |
|---|---|---|
| CPU | 20 논리코어 (`nproc`) | 병렬 빌드 여유 |
| RAM | 총 ~14GiB, 측정 시점 가용 ~3GiB (`free -g`) | **동시 워커 2 + 리뷰어 1이 상한**. Vikunja Go 빌드·pnpm 설치·Playwright 동시 실행 시 OOM 위험 [추정] |
| 디스크 | `/` 196G 중 114G 여유 | 충분 |
| Node | v24.21.0 (`~/.local/bin/node`) | Vikunja frontend `engines.node >=24` 충족 |
| Go / pnpm / psql | **미설치** | Vikunja 소스 빌드·Postgres 로컬 실행 불가 → D1 설치 승인 필요(GD-1) |
| Docker | `/usr/bin/docker` 존재, 사용자 `torgal`은 `docker` 그룹 **아님**, 소켓 접근 거부 | 보안상 좋음. 그러나 컨테이너 기반 테스트에 rootless 방식 결정 필요(GD-1) |
| sudo 그룹 | 소속 | 에이전트가 sudo를 쓰지 않도록 정책 명시(PERMISSION 정책) |

## 3. Orca 및 에이전트 CLI → `docs/orchestration/ORCA-RUNTIME-AUDIT.md`, `MODEL_BINDINGS.md` 참조

## 4. Vikunja 업스트림 [확인: 2026-11-11 웹 조회]

| 항목 | 값 | 출처 |
|---|---|---|
| 최신 안정 릴리스 | **v2.8.0** (2026-11-05), 직전 v2.7.1 (2026-10-20). 1페이지 내 pre-release 없음 | https://github.com/go-vikunja/vikunja/releases |
| 구조 | 단일 저장소: Go 백엔드(`pkg/`, `main.go`, `magefile.go`), `frontend/`(Vue), `desktop/`(Electron 추정) | https://github.com/go-vikunja/vikunja |
| 백엔드 스택 | Go `1.27.0`(go.mod), echo v5, xorm, pgx/mysql/sqlite 드라이버 | go.mod |
| 프런트 스택 | Vue 3.5, Pinia 4, vue-router 5, TanStack Vue Query 5, TipTap 3, Vite 8, TS 6, Vitest 5, Tailwind 4, Playwright, `@hey-api/openapi-ts`; `packageManager: pnpm@12.16.1`, `engines.node >=24` | frontend/package.json |
| 문서 불일치 | CONTRIBUTING은 pnpm 10.x, 개발 문서는 Node ≥20·Go ≥1.21 표기 → **package.json/go.mod 값을 우선** | 비교 |
| DB | sqlite(기본), MySQL 8+/MariaDB 10.2+, PostgreSQL 12+ (CI는 PG18) | config-raw.json, 설치 문서 |
| API v2 | 2.4.0부터 `/api/v2`. 신규 통합은 v2 권장. v1은 2.4.0에서 동결, 3.0에서 deprecated, 4.0에서 제거 예정(best-effort 일정). OpenAPI 3.1 `/api/v2/openapi.json`, RFC 9457 오류, ETag/If-Match, 목록 envelope, 422 검증 오류 | https://vikunja.io/docs/api-v2/ |
| 웹훅 | v1 경로로만 확인. HMAC-SHA256 `X-Vikunja-Signature`. **재시도 없음("delivered once")**. 사설/loopback 대상 기본 거부 | https://vikunja.io/docs/webhooks |
| 인증 | 로컬 로그인(JWT), API 토큰 `tk_` + 권한 범위(목록 미확인), OIDC, LDAP, OAuth2 서버 | 문서 |
| CalDAV | `service.enablecaldav` 기본 true, Basic auth. 엔드포인트 세부 [미확인] | 문서 |
| 백업 | `vikunja dump` / `restore`; 2.8.0부터 휴지통 30일 | 문서 |
| 계정 삭제 | `service.enableuserdeletion`, `vikunja user delete` | 문서 |
| 컨테이너 | `vikunja/vikunja`, `ghcr.io/go-vikunja/vikunja`, v2.7.1부터 cosign 서명, 포트 3456, UID 1000 | 설치 문서 |
| Pro | README: "admin panel, audit logs or time tracking" 은 Vikunja Pro. 단 OSS 저장소에 관련 코드와 changelog 항목 존재 → **게이팅 메커니즘 [미확인]** | README |
| 라이선스 | 루트·frontend `AGPL-3.0-or-later`, `desktop/` `GPL-3.0-or-later`, 배경 이미지 Unsplash License. `frontend/LICENSE` 본문 조회 실패(503) | LICENSE 파일들 |
| 기여 정책 | CLA/DCO 없음, 기능은 이슈 선행, AI 보조 기여 공개 의무 | CONTRIBUTING.md |

### 4.1 미확인 → M0-03 프로브 태스크에서 확인할 항목
1. API v2의 Task/Project/Relation(종류)/Reminder/Attachment/Comment/Label/Repeat 엔드포인트 실제 목록 (`/api/v2/openapi.json` 저장·분석).
2. API 토큰 권한 범위 이름 목록과 v2 경로 적용 여부.
3. v2 웹훅 관리 경로 존재 여부와 이벤트 전체 목록.
4. 시간 기록(time tracking) 기능의 OSS/Pro 경계 → **우리는 자체 `WorkSession`으로 구현하므로 비의존** [결정].
5. 반복 작업 표현(`repeat_after`, `repeat_mode` 등)과 시간대 처리.
6. 보안 권고(예: GHSA-8pm4-w983-mx58 OIDC 폴백) 외 v2.8.0 기준 공개 취약점 → `govulncheck`/`pnpm audit`은 D1에서 실행.

## 5. 초기 구현 방식 비교 (명세 §3)

| 기준 | A. 포크 후 프런트·백엔드 광범위 수정 | **B. 얇은 포크 + 어댑터 + 자체 앱/AI 서비스** | C. 무수정 Vikunja + 외부 클라이언트 |
|---|---|---|---|
| 사용자 의도(포크·UI 대수정) | 가장 직접적 | 포크 유지 + UI는 자체 앱으로 대수정 | 포크 없음(의도 불일치) |
| 업스트림 병합 비용 | 높음(Vue/Go 전역 충돌, 월 1회 이상 릴리스 추세) | 낮음(패치 예산 관리) | 없음 |
| 교체 가능성(→Native) | 낮음: 로직이 Vikunja 내부에 흩어짐 | 높음: 포트/어댑터, 계약 테스트 | 높음 |
| 라이선스 | 수정본 네트워크 제공 시 AGPL §13 소스 제공 의무가 제품 전체 UI에 파급 가능 | 포크 부분은 AGPL 의무 유지, 자체 코드는 별도 판단 여지(**법률 검토 필요**) | 동일하나 포크 없음 |
| 초기 속도 | 중간(기존 UI 재사용) | 중간(새 앱 골격 필요) | 빠름 |
| AI/스케줄러 구현 언어 자유도 | Go 강제 | 자유 | 자유 |

**[결정 제안] B — ADR-001.** 포크는 v2.8.0 태그에 고정하고 패치 예산(초기 0개, 브랜딩·SSO·필드 노출 등 필요 시만)을 둔다. "UI 대수정"은 **자체 `apps/web`에서 전면 신규 UI로 실현**하고 Vikunja 기본 UI는 관리/폴백 용도로 남긴다. 이 선택은 사용자 의도의 재해석이므로 승인 게이트 **GA-1**로 분리한다.
