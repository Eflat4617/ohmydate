# 06. 일정 최적화 엔진 명세 (`packages/scheduler`)

## 1. 설계 결정 (ADR-006)
- MVP: **결정론적 슬롯 기반 그리디 + 국소 개선** (순수 TS, I/O 없음, 시드 고정).
- 생성기(generator)와 **독립 검증기(validator)**를 분리. 모든 후보는 validator 통과 시에만 반환.
- "최적"이라는 용어 금지. 보장 범위: ① 하드 제약 위반 0 (validator로 보증) ② 정책별 목적함수에 대한 **휴리스틱 개선**(전역 최적 보장 아님) ③ 동일 입력·시드 → 동일 출력(재현성).
- CP-SAT 도입 트리거(하나라도 충족 시 ADR 갱신, 병렬 구현 금지): (a) golden/실사용 케이스에서 가능 해가 있는데 그리디가 불가능 판정한 비율 > 2% (b) 작업 > 100개·기간 > 8주 계획이 정기 사용 (c) 목적함수 차이가 사용자 평가에서 유의미.

## 2. 입력 (`ScheduleInput`)
```ts
interface ScheduleInput {
  now: Instant; timeZone: IanaTz; horizon: { start: Instant; end: Instant };
  tasks: Array<{ id; dueAt?: Instant; earliestStartAt?: Instant; estimate: { p50Min; p90Min }; remainingMin?;
                 splittable: boolean; minSessionMin; maxSessionMin; priority: 1|2|3|4; dependsOn: Id[];
                 bufferBeforeDueMin?: number; preferredWindows?: WindowKind[] }>;
  availability: Array<{ weekday; startLocal; endLocal; kind: 'work'|'focus' }>;   // 로컬 벽시계
  exceptions: Array<{ date; kind: 'off'|'extra'; startLocal?; endLocal? }>;
  commitments: Array<{ start: Instant; end: Instant }>;    // 반복은 호출 전에 전개
  lockedBlocks: Array<{ taskId; start; end }>;              // 승인·잠금 블록(이동 불가)
  existingBlocks?: Array<{ taskId; start; end }>;           // 재계획 시 변경 최소화 기준
  prefs: { maxDailyFocusMin; breakAfterMin; breakMin; riskLevel: 'p50'|'p90'; dayStartLocal; dayEndLocal };
  seed: number;
}
```

## 3. 제약
**하드(H)** — validator가 검사, 위반 시 후보 폐기
- H1 블록 간 겹침 없음, commitment·locked와 겹침 없음
- H2 블록은 가용 구간(availability − exceptions(off) + exceptions(extra)) 내부
- H3 의존성: 선행 task의 마지막 블록 end ≤ 후행 task 첫 블록 start
- H4 `earliestStartAt` ≤ 첫 블록 start, 마지막 블록 end ≤ `dueAt − bufferBeforeDueMin`
- H5 세션 길이 ∈ [minSessionMin, maxSessionMin] (splittable=false면 1블록 = 전체)
- H6 일일 집중 합계 ≤ maxDailyFocusMin; 연속 집중 breakAfterMin 초과 시 breakMin 휴식 확보
- H7 배치 합계 = 정책 위험수준 추정(P50 또는 P90)의 remaining, 부족 시 후보는 `feasible=false` + `deficitMin`
- H8 모든 시각은 IANA tz로 로컬↔UTC 변환(DST 경계 포함), 블록은 분 단위 정렬(기본 5분 그리드 [가정])

**소프트(S)** — 목적함수 항
S1 조기 완료, S2 일일 분산(분산 최소), S3 선호 시간대 적합, S4 context switch 수, S5 기존 블록 유지(재계획), S6 마감 여유(min slack) 최대화

## 4. 세 정책 (가중치 공개, `scheduler/policies.ts`, 버전 관리)

| 정책 | 목적 | 가중치(S1,S2,S3,S4,S5,S6) [가정] | 기대 효과 | 부작용 | 추천 조건 |
|---|---|---|---|---|---|
| `front_loaded` | 가능한 빨리 끝냄 | (1.0, 0.1, 0.2, 0.3, 0.5, 0.6) | 마감 여유 최대 | 초반 과부하 | 불확실성 큼, 마감 임박 |
| `balanced` | 매일 고르게 | (0.2, 1.0, 0.3, 0.3, 0.5, 0.4) | 일일 부담 평탄 | 마감 여유 감소 | 장기, 일상 병행 |
| `focus_blocked` | 긴 집중 블록, 전환 최소 | (0.3, 0.3, 0.8, 1.0, 0.5, 0.4) | 몰입·전환비용↓ | 큰 블록 확보 어려움 | 깊은 작업, 집중 시간대 명확 |

알고리즘 개요: ① 가용 슬롯 집합 계산(로컬→UTC) ② 위상정렬 + 정책별 우선순위 키(EDF/priority/slack) ③ 정책별 슬롯 선택 규칙으로 배치 ④ 국소 개선(인접 스왑·병합, 반복 상한 N=200) ⑤ validator ⑥ 지표 계산.

## 5. 후보 다양성
- 후보 간 거리 `d = 1 − |블록 시간 겹침 분| / |총 배치 분|` (task별 합산).
- `d < 0.15` [가정] 인 후보는 중복으로 간주하여 제거, `diversityNote`로 "가능한 서로 다른 안이 N개뿐" 설명.
- 이름·색만 다른 후보 금지.

## 6. 출력·설명 지표
`totalFocusMin, minSlackMin(마감 여유 최소값), maxDailyLoadMin, avgDailyLoadMin, contextSwitches, changedBlocks(재계획), deficitMin, p90CoverageRatio, feasible, explanation[]`(결정론 템플릿 문장; LLM 설명은 선택).

## 7. 재계획 (M5)
- 트리거: 실측 지연으로 slack<0, 새 commitment 충돌, 사용자 요청.
- 범위: 영향받는 task와 그 후행만 해제, `locked`/과거/오늘 진행 중 블록 고정.
- 목적함수에 S5(기존 유지) 가중 3배, 결과 `changedBlocks` 표시. 변경 블록 ≤ 영향 범위 + 2 [가정].
- 하루 제안 ≤2, 동일 사유 24h 억제(05 §11).

### 7.1 과거·진행 중 블록 계약 (2026-11-11 확정, M3-02R2)
- `now` 이전에 시작한 기존 블록은 **이력**이다: 시간을 점유(H1 겹침 금지, H6 일일 부하·휴식 계산에 포함)하지만 H2/H4/H5 감사 대상이 아니며 `remainingMin`에서 차감하지 않는다(`remainingMin` = 앞으로 필요한 분). 이후 가용성/예외가 바뀌어도 과거 블록 때문에 후보가 불가능해지지 않는다.
- **이력 전용 위반 면제(2026-11-11 확정, M3-02cR):** H1은 감사 대상 블록(새·미래·잠금 블록)이 관여한 겹침에만, H6(일일 합계·연속 휴식)은 감사 대상 분이 하루 또는 연속 구간에 하나라도 포함된 경우에만 위반으로 본다. 이력끼리 또는 이력과 commitment/locked가 겹치거나, 이미 지난 날의 이력이 바뀐 설정을 넘더라도 후보는 불가능해지지 않는다(이력은 사실 기록). 단, 감사 대상 블록이 포함된 날의 H6 합계에는 이력 분을 계속 포함한다.
- 재계획 시드: 의존 순서(H3)를 어기는 시드, 남은 분이 minSession 미만으로 남는 시드는 무효로 보고 해당 작업과 후속을 재배치; 시드 후보가 불가능하면 위반 작업 해제 → 시드 없음 순서로 재시도.

## 8. 장기 계획 (rolling-wave, M8)
horizon 14일 상세 블록, 이후는 주 단위 용량 예약(`capacity reservation`)만. 매주 갱신.

## 9. Golden Test Cases (최소 12, `packages/scheduler/test/golden/*.json` + 기대 결과)

| # | 케이스 | 기대 |
|---|---|---|
| G01 | 마감까지 가용 2시간, 필요 3시간 | feasible=false, deficit=60, 0개 가능 후보 사유 |
| G02 | 주말만 가용 | 평일 블록 0 |
| G03 | A→B→C 의존 | 순서 보장(H3) |
| G04 | 기존 계획 중간에 commitment 삽입 후 재계획 | 충돌 블록만 이동, changedBlocks 최소 |
| G05 | 하루 최대 집중 120분 | 일 합계 ≤120 |
| G06 | DST 전환일(예: America/New_York 2026-11-01) + Asia/Seoul 사용자 시차 여행 | 로컬 벽시계 유지, 중복/누락 시간 없음 |
| G07 | earliestStart > dueAt | 입력 검증 오류 `invalid_window` |
| G08 | 과대 추정(실측 50%) 후 재계획 | 남은 블록 축소, 해제된 시간 재배정 없음(제안만) |
| G09 | 과소 추정(실측 200%) | slack<0 → 재계획 제안 트리거 |
| G10 | 반복 commitment(매주 화 14–16)와 충돌 | 화 14–16 블록 0 |
| G11 | 공휴일 예외(off) | 해당일 블록 0 |
| G12 | 동일 입력·시드 2회 실행 | 바이트 동일 출력 |
| G13 | splittable=false 4시간 작업, 최대 연속 가용 3시간 | 불가 사유 `no_contiguous_window` |
| G14 | 세 정책 결과가 사실상 동일한 단순 입력 | 후보 1개 + diversityNote |

## 10. 속성 기반 테스트 (fast-check)
무작위 입력 10,000건(작업 ≤30, 기간 ≤21일, tz 무작위 5종): 반환된 모든 후보가 H1–H8 위반 0. validator를 생성기와 **다른 구현**(구간 트리 vs 정렬 스캔)으로 작성.

## 11. 성능 목표 [초기 목표]
작업 50 / 14일 / 3정책: p95 < 500ms (엔진 단독, 노트북) → API 포함 p95 < 2s (홈서버).
