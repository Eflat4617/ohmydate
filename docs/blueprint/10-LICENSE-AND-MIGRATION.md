# 10. Vikunja → 자체 제품 전환과 라이선스

> **법률 고지:** 아래는 엔지니어링 위험 분석이며 법률 자문이 아니다. 공개 서비스·상용 출시 전 **법률 전문가 검토 필수**(게이트 GL-1).

## 1. 확인된 라이선스 사실 (2026-11-11)
- Vikunja 루트·frontend: `AGPL-3.0-or-later`; `desktop/`: `GPL-3.0-or-later`; 배경 이미지: Unsplash License. 출처: 저장소 LICENSE·README·frontend/package.json.
- CLA/DCO 없음(CONTRIBUTING.md).

## 2. 위험 등록부
| ID | 위험 | 영향 | 완화 | 잔여/검토 |
|---|---|---|---|---|
| L1 | 포크(수정 Vikunja)를 네트워크로 제공 | AGPL §13: 상호작용 사용자에게 **수정 소스 제공 의무** | 포크를 공개 원격 저장소(사용자 승인 후)로 유지하거나 서비스 내 소스 링크 제공. 개인 단독 사용 단계에서도 원칙 준수 | 개인용 범위의 의무 범위 해석 → 법률 검토 |
| L2 | 자체 코드(apps/web, services/api)가 Vikunja의 "파생물"로 간주될 가능성 | 자체 코드에 AGPL 적용 요구 가능 | 별도 프로세스·공개 HTTP API로만 통신, Vikunja 코드/스타일/아이콘/문구 **복사 금지**, 경로 검사 CI, 클린룸 작성 기록 | 별도 프로세스 경계가 독립성을 **자동 보장하지 않음** |
| L3 | Vikunja 프런트 수정 | 수정본은 AGPL | "폐기 구역"으로 지정, 패치 최소화 | — |
| L4 | 서드파티 패키지 라이선스 | 상용 배포 제약 | `license-checker` allowlist(MIT/Apache-2.0/BSD/ISC 등), GPL 계열 신규 의존 시 리뷰 차단 | Rust 크레이트는 §9 |
| L5 | Vikunja Pro 기능 경계 | Pro 기능 의존 시 계약/비용 | 시간기록·감사·관리 기능은 **자체 구현**, Vikunja Pro 코드 사용 안 함 | 게이팅 방식 [미확인] |
| L6 | 상표 "Vikunja" | 혼동 | 제품명·로고에 사용 안 함, 출처 표기만 | — |
| L7 | LLM 공급자 약관 | 데이터 이용·보존 | GB-1 결정 시 약관 확인, 학습 사용 거부 옵션 | — |
| L8 | 자체 코드 라이선스 선택 | 상용화 전략 | **[미결정] GL-2**: (a) 처음부터 AGPL-3.0로 공개(위험 최소) (b) 독점/미정(현재 기본, 공개 안 함) | — |

## 3. 디렉터리·라이선스 구역
- `upstream/vikunja/**` — AGPL zone, 업스트림 라이선스 유지, `PATCHES.md`에 모든 패치(목적·파일·업스트림 제출 여부·폐기 시점).
- `packages/provider-vikunja/**` — 자체 코드, 공개 API 문서(OpenAPI)만 참조해 작성. **Native 전환 후 폐기.**
- 그 외 `[OWN]` — 장기 보존. CI: `upstream/` import 금지, Vikunja 소스 문자열 지문(예: 특정 파일 헤더) 검출 시 실패 [가정 구현].

## 4. 3단계 전환
| 단계 | 상태 | 기술적 산출 | 종료 조건 |
|---|---|---|---|
| 초기(M1–M3) | Vikunja가 task core SoR, 자체 UI가 주 UX, Vikunja UI는 폴백 | VikunjaTaskRepository, mapping, 재조정 | 계약 테스트 통과, E2E 통과 |
| 중간(M4–M6) | 자체 API/UI가 우선, Vikunja는 저장소 1개 구현 | NativeTaskRepository 병행 개발, 동일 계약 테스트 | Native가 계약 테스트 100% |
| 후기(M7) | Native로 freeze-and-import, Vikunja 제거 | 이전 도구, 검증 리포트 | 리허설 2회 성공 + 사용자 승인 |

## 5. 데이터 이전 설계 (M7)
- **방식 선택: freeze-and-import** (단일 사용자, 짧은 다운타임 허용). 이중쓰기는 다중 사용자·무중단 요구 시에만(트리거).
- 순서: ① 쓰기 동결(api 읽기 전용 모드) ② `vikunja dump` + planner DB 백업 ③ projects → labels → tasks → relations → reminders → attachments → comments(필요 시 노트로) 순 import ④ mapping으로 planner UUID 유지(**ID 불변**이 핵심 — 이미 자체 ID 사용) ⑤ 검증 ⑥ provider 스위치(config) ⑦ 동결 해제.
- 무결성 검증: 엔티티별 행 수, 필드 정규화 후 SHA-256 체크섬, 첨부 sha256·크기, 반복 규칙 전개 결과(향후 90일 발생 시각) 비교, 시간대 필드 비교, 권한(단일 사용자) 확인.
- 롤백: provider 스위치를 되돌리고 동결 해제(Vikunja 데이터는 동결 시점 그대로) — 이전 후 7일간 Vikunja 컨테이너 보존(읽기 전용).
- 다운타임 목표: < 30분 [초기 목표].

## 6. 계약 테스트로 교체 비용 검증
`packages/testkit/task-repository.contract.ts` — 동일 스위트를 `InMemory`, `Vikunja`(실제 인스턴스), `Native`(PG) 3구현에 실행. 항목: CRUD, 버전 충돌, 멱등 생성, 소프트 삭제, 의존성, 시간대 보존, 페이지네이션, owner 격리, listChangedSince. **M3 종료 시 "provider 교체로 변경되는 파일 수" 지표 측정**(목표: 설정 1개 + 어댑터 패키지 외 0).

## 7. Native 전환 기술 트리거 (하나 이상 충족 시 M7 앞당김 검토)
1. Vikunja API v2로 필요한 필드/쿼리 불가(예: 추정 구간, 의존성 종류) → 우회 비용 > 패치 비용
2. 업스트림 병합 비용 > 분기당 1인일 [가정]
3. v1 제거/v2 파괴적 변경으로 어댑터 재작성 필요
4. 다중 사용자·테넌트 요구
5. 자체 코드 라이선스 목표(GL-2)가 AGPL 구성과 충돌
6. 성능: 재조정 지연/부하가 UX 목표 미달

## 8. 업스트림 갱신 전략
포크 브랜치 `ohmydate/v2.8.0-patches` = 태그 + 패치. 신규 릴리스 시 패치 리베이스 → 계약 테스트·E2E → 승격. 보안 릴리스는 즉시 검토.

## 9. Rust 코어의 의존성 라이선스 (RC-00, 2026-11-13, ADR-025)

> ADR-025로 이 문서의 §2 L1–L3·L5·L6, §3–§8(Vikunja 포크·전환)은 전환이 끝나면 대상이 없어진다. 전환 계획은 `15-DESKTOP-RUST-CORE.md` §8이 대신한다. Vikunja 코드는 Rust 코어로 복사하지 않는다(규칙 유지).

규칙(AGENTS.md): MIT / Apache-2.0 / BSD / ISC는 검토 없이 쓰고, 그 밖은 사용자에게 올린다. 아래는 `core/Cargo.lock` 기준, 리눅스 대상 의존 그래프 전체(`cargo metadata --filter-platform x86_64-unknown-linux-gnu`)다.

| 라이선스 표기 | 크레이트 수 | 판단 |
|---|---|---|
| MIT OR Apache-2.0 (표기 변형 포함) | 76 | 허용 |
| MIT | 37 | 허용 |
| Apache-2.0 | 2 | 허용 |
| Unlicense OR MIT — `jiff`, `jiff-core`, `jiff-tzdb`, `memchr`, `aho-corasick` | 5 | 허용(MIT로 사용) |
| MIT AND BSD-3-Clause — `matchit` | 1 | 허용 |
| BSD-2-Clause OR Apache-2.0 OR MIT — `zerocopy` | 1 | 허용 |
| Apache-2.0 OR BSL-1.0 — `ryu-js` | 1 | 허용(Apache-2.0으로 사용) |
| **Zlib — `foldhash`** | 1 | **사용자 확인.** 허용적(고지 의무도 MIT보다 가볍다). `hashbrown`을 거쳐 `rusqlite`·`jsonschema`가 쓴다 |
| **MIT-0 — `borrow-or-share`** | 1 | **사용자 확인.** MIT에서 고지 조건을 뺀 것. `jsonschema`의 URI 처리가 쓴다 |
| **(MIT OR Apache-2.0) AND Unicode-3.0 — `unicode-ident`** | 1 | **사용자 확인.** 유니코드 데이터 표 라이선스(허용적). proc-macro가 빌드 때만 쓰고 배포 바이너리에 들어가지 않는다 |
| 합계 | 126 | |

크레이트가 아닌 포함물:

| 포함물 | 어디서 | 라이선스 | 판단 |
|---|---|---|---|
| SQLite 소스 | `libsqlite3-sys`의 `bundled` 기능이 함께 컴파일 | 퍼블릭 도메인 | **사용자 확인**(목록 밖이지만 제약 없음) |
| IANA 시간대 데이터베이스 | `jiff-tzdb` | 퍼블릭 도메인 | **사용자 확인**(같음) |

직접 의존은 11개다: `axum`, `tokio`, `rusqlite`, `jsonschema`, `serde_json`, `sha2`, `getrandom`, `jiff`, `ryu-js`, `tracing`, `tracing-subscriber`. 나머지 115개는 이들이 끌어온다. GPL·LGPL·MPL·AGPL 계열은 없다.

아직 정하지 않은 것: HTTPS 클라이언트의 TLS 라이브러리(RC-70a). 후보에 따라 허용 목록 밖 라이선스(예: OpenSSL 계열 조항)가 들어올 수 있어, 고르기 전에 후보별 표를 사용자에게 올린다(15 §11 Q4). Tauri 셸의 의존성은 RC-100a에서 같은 방식으로 표를 만든다.

점검 방법: 의존성을 더하거나 올린 Task는 위 표를 다시 뽑아 이 절을 갱신한다. 자동 검사(`cargo-deny` 등 도구 추가)는 RC-10에서 정한다.
