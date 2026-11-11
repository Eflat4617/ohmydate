# Model Bindings

> 조사일 2026-11-11. 상태: `VERIFIED`(로컬 근거로 확인) · `UNVERIFIED`(근거 부족, 실호출 미실시) · `BLOCKED`.
> D0에서는 **유료 호출·실제 dispatch를 하지 않았으므로** 모든 "실행 효과(launch.effective)"는 UNVERIFIED이며 M0-02 프로브에서 확정한다.

## 1. 요약
| 역할 | 요청 | CLI / 버전 | provider 모델 ID | effort 적용 방법 | 카탈로그 | 실행 효과 |
|---|---|---|---|---|---|---|
| orchestrator | Claude Opus 5.5 · xhigh | Claude Code 2.1.322 | `claude-opus-5-5` | 세션 설정 | 모델 VERIFIED(세션 시스템 정보) / xhigh **UNVERIFIED** | 현재 세션 |
| worker-* | DeepSeek 4.1 Flash · high | OpenCode 1.19.5 | `opencode-go/deepseek-v4.1-flash` | 저장소 `opencode.jsonc` (Orca `--effort` 미지원) | VERIFIED(`opencode models`: status active, variants low/high/max) | UNVERIFIED → P1 |
| reviewer | GPT-6.1 Sol · **medium** (2026-11-11 09:25 사용자 지시로 high→medium; 토큰 소모) | Codex CLI 0.167.0 | `gpt-6.1-sol` | `worker-start --model gpt-6.1-sol --effort medium` | VERIFIED(`~/.codex/models_cache.json`: effort low…ultra 포함 high) | UNVERIFIED → P2 |

## 1.1 직접 CLI 호출 프로브 (2026-11-11, 사용자 요청) — Orca 경유 아님
| 역할 | 명령 | 결과 | 실효값 근거 |
|---|---|---|---|
| DeepSeek | `opencode run -m opencode-go/deepseek-v4.1-flash --variant high --format json "<prompt>"` (스크래치 디렉터리) | exit 0, 응답 정상 | `opencode export <session>` assistant 메시지: `providerID=opencode-go, modelID=deepseek-v4.1-flash, variant=high`. 추론 문제 비교: high 추론 토큰 합 158 vs low 86 (단일 표본, 참고치). 비용 합 ≈ $0.0025 (OpenCode 보고값) |
| Sol | `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high --sandbox read-only --skip-git-repo-check --json "<prompt>"` | exit 0, 응답 "OK" | 롤아웃 `~/.codex/sessions/2026/11/11/rollout-…-01a1c650-….jsonl` `turn_context`: `model=gpt-6.1-sol, effort=high`, sandbox read-only |

→ 두 모델·effort 조합은 **CLI 수준에서 호출 VERIFIED**. 남은 확인: Orca `worker-start` 경유 실효값(P1/P2). 특히 OpenCode는 Orca가 `--effort`를 못 넘기므로 저장소 `opencode.jsonc` 고정이 실제 적용되는지 P1에서 같은 `opencode export` 방법으로 검증한다. 제공자 측에서 reasoningEffort를 실제로 어떻게 처리하는지는 클라이언트 기록으로만 확인됨(서버 측 증거 없음).

## 2. 근거
- **Claude:** `claude --version` = 2.1.322. 세션 모델 ID `claude-opus-5-5`. Claude 설정(`$ORCA_CLAUDE_CONFIG_DIR/settings.json`, `~/.claude/settings.json`)은 `{}` — effort 영속 설정 없음. Orca agent launch 설정의 effort는 CLI 조회 경로 미발견. → **xhigh 적용 여부 미검증.** 해결: 사용자 확인(Orca 새 에이전트 설정 또는 Claude `/model`·effort 표시) 또는 승인 후 코디네이터를 `orca agent launch --agent claude --model claude-opus-5-5 --effort xhigh`로 재기동해 receipt 확인. 미확인 상태로도 D1 진행 가능 여부는 사용자 결정(승인 요청에 포함).
- **DeepSeek:** `opencode auth list` → "OpenCode Go api" 자격 1개(값 미출력). `opencode models` → `opencode-go/deepseek-v4.1-flash`(유료, 카탈로그 단가 in $0.15 / out $0.6 per 1M tok, cache read $0.003 — 카탈로그 표기 값, 청구 실측 아님), `opencode/deepseek-v4.1-flash-free`(무료 변형 — **사용 금지**: 데이터 보존/약관 미검토, 요청 모델과 동일성 미확인), `opencode-go/deepseek-v4-pro`(다른 모델 — 대체 금지). `opencode debug agent build` → 에이전트에 model 미지정(기본값 의존) → **고정 필수**.
- **Orca 제약:** `worker-start --help`: "OpenCode model selection requires an existing worktree, a verified execution-host CLI, and an available model; effort is unsupported." → `--effort high` 전달 불가, new-child와 `--model` 조합 불가.
- **DeepSeek Harness:** `dsh`/`deepseek` 바이너리 없음 → 사용 안 함(설치는 별도 승인 사항이며 필요 없음).
- **Codex:** `~/.codex/config.toml` 기본 `model = "gpt-6-sol"`, `model_reasoning_effort = "high"` → **기본값은 6.1이 아님**. 반드시 `--model gpt-6.1-sol --effort high` 명시. 카탈로그에 `gpt-6.1-sol` 존재, supported efforts: low, medium, high, xhigh, max, ultra.

## 3. 강등·대체 금지 규칙
- 프로브 결과 effective ≠ requested 이면 해당 역할 `BLOCKED_MODEL_UNAVAILABLE`, 워커 dispatch 중단, 사용자 승인 없이 다른 모델/effort 사용 금지.
- 사용량 한도 도달 시 동일 처리(자동 전환 금지).
- 매 dispatch 후 `worker-show --dispatch <id> --json`의 launch 정보(model/effort/agent)를 ledger에 기록.

## 4. 저장소 `opencode.jsonc` (M0-01에서 커밋할 초안 — 키 이름 일부 UNVERIFIED)
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // 요청 모델 고정
  "model": "opencode-go/deepseek-v4.1-flash",
  "agent": {
    "build": { "model": "opencode-go/deepseek-v4.1-flash" }
  },
  // effort=high: provider 모델 options로 고정 (카탈로그 variant "high" = {"reasoningEffort":"high"})
  "provider": {
    "opencode-go": {
      "models": { "deepseek-v4.1-flash": { "options": { "reasoningEffort": "high" } } }
    }
  },
  // 무인 실행 중 멈춤 방지 + worktree 밖 접근 차단
  "permission": { "external_directory": "deny", "doom_loop": "deny" }
}
```
검증(P1): 워커 worktree에서 `opencode debug config` 출력에 위 model·options가 병합되어 있는지, 세션 메타데이터의 model 확인. 키가 다르게 해석되면(예: agent `variant` 키 필요) 수정 후 재프로브 — 이는 설정 수정이므로 일상 작업으로 처리, 모델 변경은 아님.

## 5. 동시 호출·한도
- OpenCode Go 요금제 한도·동시성: **UNVERIFIED** (대시보드 확인 필요). 초기 동시 DeepSeek 워커 2.
- Codex(Sol) 구독 한도: **UNVERIFIED**. 리뷰어 동시 1.
- Claude(오케스트레이터) 한도: **UNVERIFIED**. `agent-session.usage-limit-auto-continue.v1` capability 존재 → 한도 도달 시 재개 동작은 런타임 의존.

## 6. 리뷰어 대체 정책 (2026-11-11 사용자 승인)
- **조건:** Sol(`gpt-6.1-sol` high) 사용량 한도 도달/사용 불가가 증거로 확인될 때만(Codex 오류 메시지·usage-limit escalation·worker-start 실패 영수증). 일시적 침묵이나 타임아웃만으로는 전환하지 않음.
- **대체:** Claude Code 워커 `orca orchestration worker-start --task <REVIEW_TASK> --worktree <impl worktree> --agent claude --model claude-opus-5-5 --effort xhigh --json`.
- **독립성:** 대체 리뷰어는 오케스트레이터와 같은 모델 계열이므로 리뷰 패킷·형식·실행 의무는 동일하게 유지하고, 코디네이터 컨텍스트를 공유하지 않는 별도 세션으로 실행. 판정 기록에 `reviewer=opus-fallback` 표기.
- **검증:** 시작 영수증의 model/effort가 `claude-opus-5-5`/`xhigh`인지 확인, 불일치 시 BLOCKED_MODEL_UNAVAILABLE.
- **복귀:** Sol 사용 가능해지면 다음 리뷰부터 Sol로 복귀. 대체 리뷰로 승인된 변경 중 HIGH 위험 영역(동시성·보안·마이그레이션)은 Sol 복귀 후 사후 리뷰 대상 목록에 추가.

## 7. 리뷰 effort 변경 (2026-11-11 09:25, 사용자 지시)
- 사용자: "6.1 sol 리뷰어 medium 으로 추론강도 내려서 진행해. 생각보다 토큰 소모가 빠르군".
- 이후 모든 Sol 리뷰는 `--agent codex --model gpt-6.1-sol --effort medium`. Sol 사용 불가 시 대체는 기존대로 Opus 5.5 xhigh(§6).
- 첫 medium 리뷰 시작 시 Orca worker-start 영수증(model/effort)과 Codex 롤아웃 `turn_context.effort=medium`으로 확인 후 원장 기록.
- 보완: medium에서는 리뷰 패킷의 'Focus asks'를 더 좁고 구체적으로 작성(재현 우선, 탐색 범위 축소).
