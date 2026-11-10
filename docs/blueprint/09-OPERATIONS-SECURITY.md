# 09. 운영·보안·데이터 보호

> 자원 수치는 모두 **[추정]** (실측 없음). M1 종료 시 `docker stats`로 실측 후 갱신.

## 1. 환경 구분
| 환경 | 위치 | 목적 | 데이터 |
|---|---|---|---|
| dev | Ubuntu 노트북(Orca 워커 worktree) | 구현·단위/계약 테스트 | 합성 fixture만 |
| local-e2e | 노트북, rootless 컨테이너 또는 네이티브 프로세스(GD-1) | Vikunja 연동·E2E | 합성 |
| staging | 홈서버 별도 compose project `ohmydate-stg` | 배포 리허설·복구 테스트 | 익명화 사본 |
| prod(개인) | 홈서버 `ohmydate` | 실제 사용 | 실데이터 |
| prod(상용) | 별도 단계(M8+) | 공개 서비스 | 별도 정책 |

빌드 흐름: 워커 worktree → dev 브랜치 통합(G3) → 태그 → 이미지 빌드(노트북, 다이제스트 고정) → 홈서버 pull(**배포는 사용자 승인 GD-3**).

## 2. Docker Compose 구성 (개인 prod, 16GB 예산)
| 서비스 | 이미지 | 메모리 limit [추정] | CPU | 스토리지 |
|---|---|---|---|---|
| proxy (Caddy) | caddy:2 (다이제스트 고정) | 64MB | 0.25 | 설정·인증서 SSD |
| web (정적) | proxy가 서빙 | — | — | — |
| api | ohmydate/api | 512MB | 1.0 | 없음(stateless) |
| vikunja | vikunja/vikunja:2.8.0 (cosign 검증) | 256MB | 0.5 | files → HDD |
| postgres | postgres:18 | 2GB (shared_buffers 512MB) | 2.0 | SSD |
| backup (cron) | 자체 스크립트 컨테이너 | 128MB | 0.25 | HDD + 오프사이트 |
| (선택) ollama | — | 8GB+ | — | **기본 비활성** (GPU 없음, 성능 미검증) |
합계 ≈ 3GB + OS/캐시 → 16GB에서 여유 큼. 로컬 LLM만이 예산을 압박.

네트워크: `internal` 브리지(PG·vikunja·api), proxy만 호스트 포트 바인딩. **PG·Vikunja 포트 비공개.** Docker 소켓을 어떤 컨테이너에도 마운트 금지.

## 3. 스토리지
- SSD: OS, Docker, PG 데이터, 설정. HDD(2TB): 첨부/vikunja files, 로컬 백업 사본.
- **HDD 1개는 백업이 아님.** 3-2-1 목표: 로컬 HDD + 외부 1곳(암호화, 예: restic → 외부 디스크/클라우드 — 비용 발생 시 GB-2 승인).
- 백업: `pg_dump -Fc` 매일 + WAL 아카이브(M7), `vikunja dump` 주 1회, 첨부 rsync/restic. 보존 7일/4주/6개월 [가정].

## 4. RPO/RTO 제안 [초기 목표]
개인 prod: RPO 24h(M7에 WAL로 15분), RTO 2h. 검증 시나리오: ① 빈 서버에 최신 백업 복원 후 체크섬/행 수 비교 ② PG 손상 시 PITR ③ 첨부 일부 손실 복구. 분기 1회 복구 리허설.

## 5. 외부 접속
- 초기: **Tailscale(tailnet 전용)**, proxy는 tailnet 인터페이스에만 바인딩, MagicDNS + Tailscale 인증서 또는 내부 CA. 공유기 포트 개방 없음.
- 상용 전환(M8+): 도메인·공인 TLS·WAF/rate limit·OIDC·보안 헤더·취약점 점검 → 별도 승인(GD-3).
- SSH·DB·Docker 소켓 직접 공개 금지.

## 6. 인증·권한
- 단일 사용자: planner 로컬 계정(argon2id), 세션 14일 슬라이딩 [가정], 로그인 rate limit.
- Vikunja: 사용자 1명 + planner 서비스용 **API 토큰(최소 권한 scope)**, api 컨테이너 env/secret 파일로만 주입. Vikunja 회원가입 비활성(`service.enableregistration=false`).
- 비밀: `deploy/secrets/*.env`(git 제외, 권한 600), Docker secrets. 회전: LLM 키·Vikunja 토큰 90일 [가정], 회전 절차 runbook.
- 다중 사용자 대비: 모든 쿼리 owner 범위, 장래 PG RLS.

## 7. 로그·민감정보
- 구조화 JSON 로그, 요청 ID. 노트 본문/프롬프트/응답/비밀/토큰 **로깅 금지**(pino redact paths + 테스트).
- agent_run 은 메타데이터만.

## 8. 위협·대응
| 위협 | 대응 |
|---|---|
| Prompt injection | 05 §9, 도구 권한 없음, 출력 검증 |
| XSS | Vue 기본 이스케이프, `v-html` 금지(lint), Markdown은 sanitize(DOMPurify) 후 렌더, CSP `default-src 'self'` |
| CSRF | SameSite=Lax + CSRF 토큰 |
| SSRF | 서버가 사용자 URL을 fetch하지 않음(M1–M6). 링크 미리보기 없음 |
| 악성 첨부 | MIME/확장자 allowlist, 크기 제한, 저장명 UUID, `Content-Disposition: attachment`, 이미지 재인코딩(M6) |
| 경로 탐색 | blob key = UUID, 사용자 파일명은 메타데이터로만 |
| Rate limiting | 로그인·LLM 엔드포인트 토큰 버킷 |
| 테넌트 누출 | owner 범위 강제 + 계약 테스트(타 owner 접근 404) |
| 공급망 | lockfile, `pnpm audit`, 이미지 다이제스트, Renovate(수동 승인) |

## 9. 장애 대응
| 장애 | 감지 | 대응 |
|---|---|---|
| 인터넷 단절 | LLM/push 실패 | 수동 모드, 알림 지연 큐 |
| LLM 장애 | 5xx/타임아웃 | 2회 재시도 → 수동 모드 |
| DB 미접속 | readiness | api 503, web 캐시 |
| 디스크 풀 | 80% 경보 | 로그 로테이션, 오래된 candidate/agent_run 정리 |
| 재부팅/정전 | `restart: unless-stopped`, PG fsync | 기동 후 job lease 만료 회수, 누락 알림 "늦은 알림" 1건으로 합침 |
| 백업 실패 | 백업 잡 결과 알림 | 다음 시도 + 사용자 알림 |
| 스케줄러 중복 실행 | advisory lock | 리더 1개 |

## 10. 관측·업데이트
`/healthz`(liveness), `/readyz`(PG·Vikunja), 메트릭 최소(요청 지연, 잡 실패, LLM 비용) → M7에 Prometheus 여부 재결정. 이미지 태그+다이제스트 고정, 월 1회 의존성 업데이트, Vikunja 업스트림은 **분기 1회 + 보안 릴리스 즉시** 패치 리베이스(10 참조).

## 11. 데이터 권리
내보내기(JSON+Markdown+첨부 zip), AI 기억(템플릿 통계·추정 피드백) 조회/수정/초기화, 계정 삭제(planner DB + Vikunja 사용자 삭제 + 백업은 보존기간 경과 후 소멸 고지).

## 12. 상용화 전환 (별도 단계)
결제·다중 테넌트 인증(OIDC)·관측성 스택·관리형 DB/오브젝트 스토리지·개인정보 처리방침·약관·DPA·보안 점검. **모두 사용자 승인 및 법률 검토 대상.**

## 13. Vikunja 서비스 토큰 (2026-11-11 추가, FU-23R)
- planner가 소유자별로 쓰는 Vikunja API 토큰은 **projects/tasks 권한 + `other:user`**(기본 프로젝트 = Inbox 조회용 `GET /user`)가 필요하다. `other:user`가 없으면 프로젝트 조회가 401 → 현재는 503 `provider_unavailable`로 보인다.
- `PATCH /user/settings/general`(기본 프로젝트 지정)은 **JWT 전용**이라 토큰으로는 불가 → planner는 기본 프로젝트 쓰기를 best-effort로 취급(FU-23 수정).
- 토큰 참조는 DB에 `env:VIKUNJA_TOKEN_OWNER_*` 또는 `VIKUNJA_SECRETS_DIR` 내 파일만(FU-27). 회전 절차: 새 토큰 발급(동일 권한) → 시크릿 파일/환경 갱신 → API 재시작 → 구 토큰 폐기. FU-23 배포 시 기존 토큰은 `other:user` 포함으로 재발급 필요.
