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

### 6.1 설명·위반 코드 (2026-11-11 확정, FU-62)
- `explanation[]`(영문 템플릿 문장)은 로그·호환용으로 **그대로 유지**한다. 같은 위치의 `explanationItems[i] = { code, params }`가 `explanation[i]`의 안정 표현이며 두 배열의 길이는 항상 같다(생성기는 문장과 코드를 한 단위로만 만든다). 후보(`PlanCandidate`)와 재계획 후보(`ReplanCandidate`)에 실린다.
- 검증기 위반(`Violation`)과 입력 문제(`InputIssue`)는 `code`(H-종류) 외에 `messageCode` + `params`를 가진다. 메시지 템플릿 1개 = 코드 1개이며, 코드 접두사는 H-종류(`h1_*`는 H1)와 같다. 계약(`Violation.messageCode`/`params`)은 선택 필드이고 FU-62 이후 API가 만드는 모든 위반에 채워진다.
- **닫힌 열거형**: 아래 표가 전부이며 단일 소스는 `packages/scheduler/src/codes.ts`와 `packages/contracts/src/explanation.ts`(패리티 테스트, 이 표와의 일치 테스트 포함). 알 수 없는 코드는 타입 오류다.
- **params**: 숫자(분·개수·상한) 또는 불투명 토큰(task ID, UTC ISO instant, `YYYY-MM-DD` 날짜, 닫힌 enum 값)만. 작업 제목·노트·사용자 입력 문자열은 절대 싣지 않는다(계약 패턴 `^[A-Za-z0-9_.:+-]{1,100}$`). 이름은 클라이언트가 ID로 찾는다. `…At` 키는 UTC instant, 분 단위 키는 `…Min`.
- FU-62 이전에 저장된 후보/제안은 `explanationItems: []`로 직렬화되고 클라이언트는 원문(`explanation[]`)을 보여 준다.

**생성기 설명 코드**

| 코드 | params | 영문 원문(요지) |
|---|---|---|
| `policy_summary` | `policy`, `policyVersion` | Policy … v…: 요약 |
| `placement_summary` | `placedMin`, `requiredMin`, `blockCount`, `retainedCount` | Placed … of … required minutes … |
| `constraints_satisfied` | — | All hard constraints H1-H8 satisfied. |
| `infeasible_summary` | `violationCount` | Infeasible with N hard violation(s): … |
| `heuristic_insufficient_available_time` | — | Heuristic reason: insufficient_available_time. |
| `heuristic_no_contiguous_window` | — | Heuristic reason: no_contiguous_window. |
| `heuristic_estimate_not_grid_aligned` | — | Heuristic reason: estimate_not_grid_aligned. |
| `heuristic_estimate_below_grid` | — | Heuristic reason: estimate_below_grid. (방어용 분기, 현재 입력으로는 도달하지 않음) |
| `heuristic_session_bounds_infeasible` | — | Heuristic reason: session_bounds_infeasible. |
| `unplaced_minutes` | `deficitMin` | Unplaced minutes (H7 shortfall): … min. |
| `capacity_deficit` | `capacityDeficitMin` | Capacity deficit: … min. |
| `replan_bound_exceeded` | `changedBlocks`, `bound`, `affectedExistingBlocks` | Replan change bound exceeded: … |
| `input_rejected` | `issueCount` | Input rejected before generation: … |

**입력 문제 코드**(`validateInput`; 입력 거부 후보의 설명 줄 `<issue code>: <message>`에도 실림)

| 코드 | params | 영문 원문(요지) |
|---|---|---|
| `input_invalid_time_zone` | — | Invalid IANA time zone |
| `input_invalid_horizon_instant` | — | Horizon contains an invalid instant. |
| `input_horizon_not_increasing` | — | Horizon end must be after horizon start. |
| `input_horizon_too_long` | `maxDays` | Horizon spans more than … days |
| `input_invalid_now` | — | now is not a valid instant. |
| `input_duplicate_task` | `taskId` | Task id … is duplicated. |
| `input_invalid_estimate` | `taskId`, `maxMin` | estimate is not a whole number of minutes |
| `input_invalid_buffer` | `taskId`, `maxMin` | bufferBeforeDueMin is not a whole number of minutes |
| `input_invalid_session_minutes` | `taskId`, `maxMin` | session bound is not a whole number of minutes |
| `input_invalid_session_bounds` | `taskId` | invalid session bounds |
| `input_invalid_task_window_instant` | `taskId` | invalid window instant |
| `input_task_window_empty` | `taskId` | earliestStartAt at or after its due window |
| `input_invalid_preference` | `field`(`maxDailyFocusMin`\|`breakAfterMin`\|`breakMin`), `maxMin` | prefs.… must be a whole number of minutes |
| `input_unknown_dependency` | `taskId`, `dependencyId` | depends on unknown task |
| `input_dependency_cycle` | — | Task dependencies contain a cycle. |
| `input_invalid_weekday` | — | Availability weekday … is outside 1-7. |
| `input_invalid_availability_window` | `weekday` | Availability window … is invalid. |
| `input_invalid_exception_date` | — | Exception date … is invalid. |
| `input_exception_partial_window` | — | Exception … must have both start and end or neither. |
| `input_invalid_exception_window` | — | Exception window … is invalid. |
| `input_commitment_invalid_instant` | — | commitment has an invalid instant. |
| `input_commitment_end_before_start` | — | commitment ends before it starts. |
| `input_commitment_too_long` | `maxDays` | Commitment spans more than … days |
| `input_unknown_block_task` | `taskId` | Block references unknown task |
| `input_invalid_block_instant` | `taskId` | Block … has an invalid instant. |
| `input_block_sub_millisecond` | `taskId` | Block … has sub-millisecond precision. |
| `input_block_off_grid` | `taskId` | Block … is not on the 5-minute grid. |
| `input_block_end_before_start` | `taskId` | Block … ends before it starts. |
| `input_block_too_long` | `taskId`, `maxDays` | Block … spans more than … days |

**검증기 위반 코드**(`Violation.messageCode`; 불가능 후보 설명 줄에도 실림. H0은 API에서 422 `validation_failed`로 바뀌어 공개 위반으로는 나가지 않음)

| 코드 | H | params | 영문 원문(요지) |
|---|---|---|---|
| `h0_unknown_task` | H0_unknown_task | `taskId` | Block references unknown task |
| `h0_outside_horizon` | H0_horizon | `taskId`, `startAt`, `endAt` | outside the planning horizon |
| `h1_same_task_overlap` | H1 | `taskId` | Blocks for task … overlap. |
| `h1_tasks_overlap` | H1 | `taskId`, `otherTaskId` | Blocks for tasks … and … overlap. |
| `h1_commitment_overlap` | H1 | `taskId`, `startAt`, `endAt` | overlaps a commitment |
| `h1_active_block_overlap` | H1 | — | **API 전용**: 승인 시 저장소 EXCLUDE 제약(동시 승인 경합)으로 거부 |
| `h2_outside_availability` | H2 | `taskId`, `startAt`, `endAt` | outside availability |
| `h3_dependency_order` | H3 | `taskId`, `dependencyId` | starts before dependency … finishes |
| `h4_before_earliest_start` | H4 | `taskId`, `earliestStartAt` | starts before earliestStartAt |
| `h4_inside_due_buffer` | H4 | `taskId`, `dueAt`, `bufferMin` | ends inside its pre-due buffer |
| `h4_after_due` | H4 | `taskId`, `dueAt` | ends after its due time |
| `h5_unsplittable_no_remaining` | H5 | `taskId` | no remaining minutes and must not have a block |
| `h5_unsplittable_required_out_of_bounds` | H5 | `taskId`, `requiredMin`, `minSessionMin`, `maxSessionMin` | requires … minutes, outside [min, max] |
| `h5_unsplittable_single_block` | H5 | `taskId`, `requiredMin` | must be one block covering … minutes |
| `h5_session_out_of_bounds` | H5 | `taskId`, `durationMin`, `minSessionMin`, `maxSessionMin`, `startAt`, `endAt` | …-minute session outside [min, max] |
| `h6_daily_focus_exceeded` | H6 | `date`, `totalMin`, `maxDailyFocusMin` | Daily focus on … is … minutes, above … |
| `h6_break_missing` | H6 | `date`, `breakAfterMin`, `breakMin` | Continuous focus … without a …-minute break |
| `h7_deficit` | H7 | `taskId`, `shortMin` | short by … minutes (deficit) |
| `h7_overallocated` | H7 | `taskId`, `excessMin` | overallocated by … minutes |
| `h8_invalid_time_zone` | H8 | — | Invalid IANA time zone |
| `h8_invalid_horizon` | H8 | — | Horizon contains an invalid instant. |
| `h8_invalid_instant` | H8 | `taskId` | Block … has an invalid instant. |
| `h8_sub_millisecond` | H8 | `taskId` | sub-millisecond precision |
| `h8_off_grid` | H8 | `taskId` | not aligned to the 5-minute grid |
| `h8_end_before_start` | H8 | `taskId` | ends before it starts |

- 코드 추가·삭제는 위 표, `codes.ts`, `explanation.ts`, 웹 ko 카탈로그(`explain.*`)를 함께 바꾸며 OpenAPI·웹 클라이언트를 재생성한다(테스트가 어긋남을 잡는다). 기존 코드의 의미·params 변경은 새 코드로 한다.

## 7. 재계획 (M5)
- 트리거: 실측 지연으로 slack<0, 새 commitment 충돌, 사용자 요청.
- 범위: 영향받는 task와 그 후행만 해제, `locked`/과거/오늘 진행 중 블록 고정.
- 목적함수에 S5(기존 유지) 가중 3배, 결과 `changedBlocks` 표시. 변경 블록 ≤ 영향 범위 + 2 [가정].
- 하루 제안 ≤2, 동일 사유 24h 억제(05 §11).

### 7.1 과거·진행 중 블록 계약 (2026-11-11 확정, M3-02R2)
- `now` 이전에 시작한 기존 블록은 **이력**이다: 시간을 점유(H1 겹침 금지, H6 일일 부하·휴식 계산에 포함)하지만 H2/H4/H5 감사 대상이 아니며 `remainingMin`에서 차감하지 않는다(`remainingMin` = 앞으로 필요한 분). 이후 가용성/예외가 바뀌어도 과거 블록 때문에 후보가 불가능해지지 않는다.
- **이력 전용 위반 면제(2026-11-11 확정, M3-02cR):** H1은 감사 대상 블록(새·미래·잠금 블록)이 관여한 겹침에만, H6(일일 합계·연속 휴식)은 감사 대상 분이 하루 또는 연속 구간에 하나라도 포함된 경우에만 위반으로 본다. 이력끼리 또는 이력과 commitment/locked가 겹치거나, 이미 지난 날의 이력이 바뀐 설정을 넘더라도 후보는 불가능해지지 않는다(이력은 사실 기록). 단, 감사 대상 블록이 포함된 날의 H6 합계에는 이력 분을 계속 포함한다.
- **영향 범위 계약(2026-11-11 확정, FU-41R-1):** 재계획의 영향받는 작업 = (a) 트리거(새/변경 commitment·잠금 충돌, 실측 지연)에 블록이 걸린 작업 (b) 의존 관계가 추가·삭제·변경된 간선의 **양 끝 작업** (c) (a)(b)의 모든 후행 작업. 나머지 작업의 미래 블록은 고정(이동 금지). 고정 때문에 영향받는 작업을 배치할 수 없으면(부족 분 > 0) 그 작업의 **선행 작업을 단계적으로 영향 범위에 추가**해 재시도하고(최대 의존 깊이), 그래도 불가능할 때만 설명이 붙은 불가능 후보를 반환한다. 변경 상한 = 블록 단위 대칭차 ≤ 2×(영향받는 기존 블록)+2; 확장으로 상한을 넘으면 후보에 명시(조용히 초과 금지). **호출자 계약(M5 전 필수, FU-41R2):** `ScheduleInput`에는 이전 의존 그래프가 없으므로, 삭제된 간선·이미 순서가 맞는 새 간선은 스케줄러가 감지할 수 없다 → 재계획 호출자는 `affectedTaskIds`(또는 이전 간선 목록)를 명시해 전달해야 한다(FU-59).
- **빈틈 맞춤 분할(2026-11-12 확정, FU-69):** 위 "배치할 수 없으면"은 균등 분할 세션이 들어갈 연속 구간이 없다는 뜻이 아니다. 분할 가능한 작업은 고정 블록·commitment 사이 빈틈에 `[minSessionMin, maxSessionMin]` 세션으로 나누어 **전부** 배치할 수 있으면 배치 가능이다(재계획에서는 그 작업 자신의 아직 유효한 미래 블록을 먼저 그대로 두고 남은 분만 채운다). 이 분할 탐색은 결정론적이고 평가 횟수 상한이 있는 깊이 우선 탐색이다(FU-69R-1): 빈틈마다 다음 세션의 시작으로 H6가 구분하는 세 경우(빈틈의 첫 칸, 앞 집중 구간에서 breakMin만큼 떨어진 첫 칸, 뒤 집중 구간과 이어져도 breakAfterMin을 넘지 않는 첫 칸)를 모두, 긴 세션부터 시도하고, 정책 순서로 못 찾으면 시간 순서로 한 번 더 찾는다. 세션은 한 로컬 날짜 안의 빈틈에서만 찾으며, 상한 안에서 완전한 분할을 찾지 못하면 균등 분할의 부분 배치·부족 분을 그대로 보고하고 선행 작업 확장으로 넘어간다. 분할 때문에 변경 상한을 넘으면 위와 같이 후보에 명시한다. 같은 이유로 후행 작업이 있는 작업은 후행 작업의 남은 분이 그 마감 전 빈 시간에 들어갈 수 있는 가장 늦은 시각(필요조건)까지만 배치한다: 해제된 선행 작업을 정책이 기간 끝에 놓아 후행 작업이 들어갈 자리가 없어지는 것을 막기 위함이며, 어차피 들어갈 수 없는 후행 작업은 선행 작업을 제약하지 않는다. 두 보정은 보정 없는 정책 그리디 배치가 불가능할 때에만(남은 분이 배치 가능한 시간 총량을 확실히 넘는 입력은 제외) 시도하므로 보정 없이 가능한 배치는 바뀌지 않으며(재계획은 선행 작업을 해제하기 전 단계에서 먼저 성공할 수 있다), 보정 결과는 가능해지거나 H7 부족 분·위반 수가 더 작을 때만 쓴다. 위 시각은 H6를 보지 않는 필요조건이므로, 보정 후에도 후행 작업이 부족하면 후행 작업 자리 앞에 breakMin을 한 번 더 비우고 작업 자신의 기존 블록을 유지하지 않은 채 다시 분할하는 보정을 한 번만 더 시도한다(FU-69R-1). 그래도 여러 작업이 얽힌 H6·경합까지 보장하지는 않는다(휴리스틱). 따라서 "같은 정책으로 새로 생성하면 가능한 입력은 재계획도 가능"이라는 성질은 고정을 지키는 배치가 존재하는 입력에서만 성립한다: 분할 불가 작업(또는 minSession보다 짧은 빈틈뿐인 경우)은 계약대로 설명이 붙은 불가능 후보가 정답이며, 전체 재계획으로 조용히 넘어가지 않는다.
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
