# OhMyDate web — screens and behaviour

The visual system was replaced on 2026-11-13 (UI-REDESIGN). It is recorded in
[`DESIGN.md`](../../DESIGN.md) and the product record is
[`PRODUCT.md`](../../PRODUCT.md). In one line: the app is a page from a
ten-minute study planner. Cool white paper, a ruled grid, pen-black ink,
highlighter fills for state and for time, no cards, no shadows, no pills.
This page keeps what `DESIGN.md` does not: how the stylesheet is laid out,
the rules for new UI, and how each feature area behaves.
The screen spec is `docs/blueprint/07-ADAPTIVE-UI-SPEC.md` §1–§6.

## Stylesheet layers

`src/styles.css` imports these in order, and each layer may only use the ones
above it:

| Layer | File | Holds |
|---|---|---|
| Tokens | `src/styles/tokens.css` | every raw colour, font name, size, edge width, duration and z-index |
| Base | `src/styles/base.css` | reset, type defaults, `:focus-visible`, selection, utilities (`.visually-hidden`, `.hl`, …) |
| Primitives | `src/styles/primitives.css` | button, field, pen-box checkbox and radio, switch, section (`.card`, `.section-head`), badge, banner, figures, table, meter, empty state, skeleton, lists, dialog and sheet, toast |
| Shell | `src/styles/shell.css` | nav rail, bottom nav and More sheet, page frame, adaptive frame, calm (Focus) mode |
| Screens | `src/styles/screens/NN-*.css` (indexed by `src/styles/screens.css`) | one file per group of screens: layout and screen-specific pieces only |

Rule: **no colour and no font name outside `tokens.css`**, and no raw length in
`padding`, `margin` or `gap`. Vue files have no `<style>` blocks. Screens get
their look from primitives and tokens.

The comment block at the top of `src/styles.css` is the Hallmark stamp
(`scripts/sloplint.mjs` reads it). It is repeated at the top of
`src/styles/screens.css` and in `src/styles/screens/00-stamp.css` because the
linter reads one stamp per folder of CSS; change the three together.

## Primitives (`src/components/ui`)

| Component | Use |
|---|---|
| `UiButton` | `variant` primary / secondary / ghost / danger / danger-ghost, `size` sm/md/lg, `icon`, `iconOnly`, `block`, `busy` (spinner + `aria-busy`; the caller still owns `disabled`). One primary per screen or dialog |
| `UiField` | label + help + error for any control in its slot. Wires `aria-describedby` (`<id>-help <id>-error`) and `aria-invalid` |
| `UiCard` | a section of the page, not a box: no edge and no fill. An `h2` first in it sits on the 2px rule. `sunken` is the one tinted well |
| `UiBadge` | a highlighted word. `tone` neutral/accent/success/warn/danger/info/offline/outline (`dot` renders nothing: the word carries the state) |
| `UiBanner` | a highlighted line across the page. `tone` info/success/warn/error/offline/conflict/accent; the live `role` is opt-in so existing live regions are not duplicated |
| `UiEmptyState` | what is missing and the next action, as plain text |
| `UiSkeleton` / `UiSpinner` | loading. Skeletons are decorative and always come with a status message |
| `UiDialog` | modal `dialog` or bottom `sheet` (see below) |
| `ToastHost` | toasts set in ink, with an action and a dismiss button |
| `UiIcon` | inline SVG icon set (`icons.ts`), always `aria-hidden` |

CSS-only primitives: `.section-head`, `.stat-grid`, `.data-table`, `.meter`
(set `--value` 0..1 and `--cells`), `.switch` with `.switch-row`, `.hl`.

### UiDialog (closes FU-09)

While mounted it:

- moves focus to `[data-autofocus]`, or to the first enabled control if that
  target is disabled;
- traps Tab and Shift+Tab, and pulls back any focus that escapes (`focusin`);
- makes the rest of the page `inert`, leaving alone regions that were already
  inert and live regions that opt out;
- treats Escape as `close` when `dismissible` (ConflictDialog: Escape = *Keep
  editing*), and the backdrop click only when `closeOnBackdrop`;
- stops single-key global shortcuts from reaching `window` listeners;
- gives focus back to the opener on close.

ConflictDialog, Help, Search, LLM consent, Notifications, Proposal preview,
Shrink, the Availability conflict and the bottom-nav More sheet all use it.

## Layout (07 §2, §4)

| Width | Shell | Content |
|---|---|---|
| < 640px | 5-slot bottom nav (Today, Inbox, ＋ New task, Plan, More). The More sheet holds the rest | one column; plan candidates swipe sideways inside their own scroller |
| 640–1023px | bottom nav | wider single column, two-column forms where they fit |
| ≥ 1024px | nav rail of words (Daily / Planning / Settings) with shortcut hints | pages start at the left margin; forms in columns; New plan and Commitments put their form beside the list |
| ≥ 1280px | rail | Today shows its block list beside the day time table, with the context panels in a row below; Focus shows the timer beside one column of panels; Availability puts its settings beside the week grid |

Today's time table (`DayTimetable`, `src/domain/dayTimetable.ts`) draws the
day's blocks on hour rows of six ten-minute cells. A row in the list and its
run on the table share a highlighter; the next block is always yellow.
Today's 약속 are drawn on it too, as hatched taken time (CAL-01), and under the
block list Today lists *오늘 약속* and *오늘 마감* (tasks due today that are not
done) when there are any.

## 한달 (CAL-01)

`/month` (route `month`, key `m`, rail under 오늘, first item of the phone's
More sheet; the bottom bar's own slots are unchanged) is a month page of the
planner. The month is in the URL (`/month?m=2026-11`; plain `/month` is the
current month in the availability time zone, and a month the URL cannot mean is
dropped). The grid (`src/domain/monthGrid.ts`) has one Monday-first row per
week that touches the month (4 to 6) and places, in the owner's zone, approved
blocks (planned and done; a block over midnight on both days), every
occurrence of every 약속 whatever its `source`, and the deadlines of tasks that
are not done. It reads all pages of the three lists for the visible range only
(`src/composables/usePlannerRange.ts`: owner-keyed, `ownerFenced`, at most 20
pages a list, a note when that cuts the list). The grid is one tab stop
(`role="grid"`, roving `tabindex`): arrows move by day and week, Home/End to
the week's ends, PageUp/PageDown change the month (focus follows into another
month), Enter/Space select. Each cell is named like *11월 14일 토요일, 오늘, 블록
2개, 약속 2개, 마감 1개*; its visible lines are `aria-hidden`. The picked day
(today at first) lists times, kinds and titles that lead to the task (blocks,
deadlines) or to `/commitments` (약속), with *오늘 보기* on today. States: a
skeleton in the shape of the grid, an error with retry (a failed re-read keeps
the last data and says so), one line for a month with nothing planned, and an
offline line when nothing was read yet. The screen only reads.

Focus has a **calm mode**: the shell steps back (no rail, no bottom nav), the
timer is set in display type, and the planned time shows under it as
ten-minute cells that fill. Calm mode only lasts while the timer runs. When
the session completes, or is no longer loaded, it switches off on its own, so
the review sheet and the state after the review always show *Back to Today*
and the navigation. Escape or the toggle also leave it.

A 360px viewport never scrolls the page sideways. Wide content (week
calendar, candidate table) scrolls inside its own labelled region.

## State conventions

| State | Pattern |
|---|---|
| Loading | `UiSkeleton` shaped like the content, plus a visually hidden status |
| Empty | `UiEmptyState`: what is missing, and the next action |
| Error | `UiBanner tone="error"` (boxed in red pen), with retry where possible |
| Offline | `OfflineBanner`, i.e. `UiBanner tone="offline"` (dashed, grey) with a *saved locally* hint |
| Conflict | `ConflictDialog` (`UiDialog role="alertdialog"`): Keep editing / Reload / Overwrite |
| Saved / version | `UiBadge tone="success"` next to the primary action |

## Rules for new UI

1. Build from primitives. A one-off button, section or notice needs a new
   primitive variant first.
2. Use only tokens. Need a new value? Add a token, and a dark override if it
   is a colour.
3. Do not change `data-*` hooks, accessible names or keyboard paths without
   updating `apps/web/test` and `e2e/**` in the same commit.
4. Never use colour alone to carry meaning. Pair it with an icon, text or a
   pattern.
5. Keep touch targets at `--hit-target` (44px) or larger on coarse pointers.
6. Never hard-code copy. Every user-visible string, accessible name and
   live-region message comes from the catalog (`t()` / `tp()`, see below);
   dates, times, durations and money go through `src/i18n/format.ts`.
7. Yellow highlighter means now: the current, next or selected thing, and
   planned time on the calendars. Mint is done or ok, pink is caution, sky
   is information, red pen is danger.

## Language (UI-I18N)

The UI is Korean (`<html lang="ko">`). All copy lives in one bundled catalog,
`src/i18n/messages/ko.ts`; nothing is fetched at runtime.

- **Keys are typed.** `t('today.slackChip', { duration })` only compiles when
  the key exists and every `{placeholder}` gets a value; `tp(key, count)`
  picks a plural form through `Intl.PluralRules` (Korean always resolves to
  `other`, the API is ready for `one`/`few`/…). Another locale is a
  `Messages` object (the same key tree) registered in `src/i18n/index.ts`,
  so a locale that misses a key fails the typecheck.
- **Markup inside a message** uses `<I18nT keypath>` with named slots
  (e.g. a `<strong>` version number), never `v-html`.
- **Glossary.** 오늘 · 인박스 · 작업 · 프로젝트 · 알림 · 약속 (commitment) · 가용 시간 ·
  집중 / 집중 세션 · 몰입 모드 (calm mode) · 계획 세우기 / 계획 마법사 · 일정안 / 후보 ·
  블록 · 여유 (slack) · 위험도 · 축소 / 재배치 · 제안 · 확정 (plan) / 승인 (draft,
  proposal) · 회고 (session review) · 직접 작성 모드 (manual mode) · 재계획 (replan) ·
  재계획 요청 (user-requested replan) · 고정된 블록 (locked block) · 내 패턴
  (personal estimation profile) · 기록 (estimation feedback item). Messages use
  polite 해요체; buttons and labels stay short.
- **Formatting** (`src/i18n/format.ts`, `Intl` in the user's or plan's IANA
  zone): `11월 14일 (토)`, `오후 7:00`, `오후 7:00~8:30`, `오전 10:30~오후 1:30`,
  `11월 16일 (월) ~ 11월 22일 (일)`; durations `1시간 30분`, `11일 10시간`,
  `+11일 10시간`, `−35분`, `1분 미만`, `0분`; money `$0.20` / `$0.0035`.
  No screen shows raw minutes.
- **Server text.** Problem responses are shown by `code` (every code of the
  exhaustive map has a Korean message); the English `detail` never reaches
  the screen. Known server codes inside free-form fields (Today risk reasons,
  type-detection reasons, conservative intake assumptions, plan block errors,
  diversity notes) are translated in `src/i18n/server.ts`. Scheduler
  diagnostics without a code stay available as original text, marked
  `lang="en"` (plan cards: *계산 근거 (원문)*).
- **Guards.** `test/i18n-catalog.spec.ts` checks the catalog (non-empty,
  Hangul, placeholders, every contract enum and problem code) and scans every
  `.vue` template and UI script for English copy; `test/i18n-format.spec.ts`
  covers the formatters (0, negative, more than a day, DST days).

## Replanning and 내 패턴 (M5-03)

- **Entry points.** Today shows a calm `UiBanner` when proposals are pending
  (count, the reason in Korean, *제안 확인하기* / *모든 제안 보기*). It only
  links; approving always happens on the detail screen. A detected proposal's
  notification (`replan_proposal:<id>`) gets a *제안 보기* link. The nav rail
  (Planning group) and the More sheet list *재계획 제안* and *내 패턴*.
- **Detail (`/replan/:id`).** Why (trigger + reason chip + affected tasks +
  candidate flags as warn banners), key metrics in a table (deadline slack and
  planned focus now → proposed, changed blocks / bound, deficit), then *only the
  changed blocks* (옮김 / 줄어듦 / 늘어남 / 추가 / 빠짐 with `<del>` before and
  `<ins>` after times). Locked blocks are listed separately as unchanged with a
  lock icon and *고정됨* text; untouched blocks are a count. The scheduler's
  reasons and 422 findings render through `ExplanationList` (FU-62 coded
  `explanationItems` / violation `messageCode` in Korean); rows persisted
  before FU-62 keep the original lines under *계산 근거 (원문)* (`lang="en"`).
  The diff and the metrics come only from the server (FU-70, M5-03R-1 H1):
  `candidate.blocks` against `proposal.before.blocks` (every block of the base
  plan that approval replaces or keeps, over the whole horizon, locked flag
  included) and `candidate.metrics` against `before.metrics` (same rules).
  The web never queries a calendar window to rebuild the before side. A
  proposal persisted without a snapshot shows its candidate blocks only, with
  a notice that the comparison is unavailable — never a guessed diff.
- **Actions.** *승인* sends `If-Match: W/"availability:<n>"` (the proposal's
  snapshot) plus a UUIDv7 `Idempotency-Key`; 412 opens an `alertdialog`
  (*새로 고침* / *지금 상태로 다시 계산*), 409 `proposal_state_conflict` re-reads
  and shows the read-only state. *거절* first explains the 24 h same-reason
  suppression (with the end time) in a dialog whose focus starts on *취소*.
  *재계획 요청* shows `409 replan_suppressed` as a wait (`1일 뒤(11월 15일 (일)
  오후 6:40)`) from `Retry-After`. Every action keeps its Idempotency-Key across
  network loss and transient answers (`idempotency_in_progress`,
  `approval_in_progress`, 5xx) and only takes a fresh key after a stored final
  result (2xx or a stored 409/422 such as `replan_suppressed`) —
  `isStoredFinalResult` in `src/api/idempotency.ts` (M5-03R-1 M1). Approved / rejected / expired / superseded
  proposals are read-only. Outcomes are announced in a polite live region and
  focus moves to the state summary.
- **Plan id.** Proposals carry `planId` and `basePlanVersion` (FU-70). The
  request button uses the proposal's plan on its detail page, the plan's own id
  on an active plan page, and the newest proposal's `planId` on Today and the
  list; nothing is remembered on the device.
- **내 패턴 (`/patterns`).** Summary (counted records, confidence as
  낮음/보통/높음 + %), the cold-start rule (template, else AI ×1.3 with low
  confidence) and the shrinkage/outlier rules in Korean, one card per task type
  (prior 1배 · personal mean · applied P50/P90 correction · record count ·
  confidence), and the feedback list with an *통계에 포함* switch per item
  (`PATCH /estimation/feedback/{id}` with `If-Match`). Resets (all, or one
  template) use an `alertdialog` that states how many records go and that it
  cannot be undone. Only minutes and ratios are shown — never review notes.

## Adaptive layout (M6-02)

The layout of Today, Focus, the planning pages and Notes follows the user's
context (07 §2). The pipeline is `Context Observer → ui-policy → LayoutSpec →
registry → renderer`:

- **Policy (`packages/ui-policy`).** Pure TypeScript, no clock or DOM: the
  caller passes the instant in. `ui.layout.v1` is a TypeBox schema with a
  closed component registry and closed props (ids and small integers only —
  no HTML, script, URL or style strings). The validator also requires one page
  component in `primary`, unique components and both `NavRail` and `BottomNav`
  pinned. `decideMode` follows 07 §2.2 in order: lock → active session →
  planning route → deadline risk not acknowledged today → review window
  (20:00–24:00 local [가정]) with an unreviewed session → notes route →
  overview. `policyVersion` is `ui-policy@0.1.0`.
- **Stability (07 §2.3).** After an automatic switch the layout holds for
  10 minutes. Switches wait while a field has focus, during a drag, or while
  a panel is pressed or has a dialog open. The user's own navigation (and
  answers such as *확인했어요*) apply at once. An automatic step never moves
  the user off a Focus screen they are on (the review sheet stays). One undo
  step restores the previous layout and turns that context down (the same
  session does not switch back). Lock and *자동 전환 끄기* stop automatic
  switches. An invalid spec is never applied or rendered: the previous one
  stays.
- **Pages are never replaced.** On planning and notes pages the routed page
  stays the primary component and only the panels around it change. On the
  daily workspace the URL follows the page: the focus layout lives at
  `/focus/:id`, every other mode at `/today`.
- **Registry (`src/layout/registry.ts`).** Page components are the routed
  view (`TodayPlan`, `FocusTimer`, `PlanningWorkspace`, `NotesWorkspace`).
  Panels: `NextUp`, `RelatedNotes` (M6-03, see below), `CurrentTaskCard`,
  `DeadlineRiskPanel`, `ReviewPrompt`, `ActiveSessionCard`.
- **Renderer (`AdaptiveFrame`).** One CSS grid with stable keys; the page
  keeps one key, so a switch never remounts it. Below 1280px the regions
  stack (primary first, then the two context regions side by side from
  640px). From 1280px the workspace shows primary · secondary · tertiary next
  to the rail. Plan pages keep their own wide grids, with the context row
  below. Only opacity animates; `prefers-reduced-motion` turns it off. Calm
  mode keeps only the timer. NavRail and BottomNav stay in AppShell in every
  mode.
- **Change feedback.** An automatic switch shows the toast *레이아웃이
  바뀌었어요* with *되돌리기* and a link-style *자동 전환 끄기*. A polite live
  region says which layout is now shown. Focus stays where it was, or moves
  to the same place in the same panel, or to the primary region — never to
  `<body>`.
- **Settings (`/settings/layout`).** Auto switching on/off and locking the
  last layout shown, saved per owner on this device. The page also lists the
  rule order. Opening a page the lock cannot show moves the lock to that page.
- **AI suggestions** (`llm.layout_suggestion.v1`) are accepted by the policy
  only at the lowest priority (fixture-tested). The web does not request any
  yet.

## Notes (M6-03)

Notes are planner-owned Markdown (07 §3.5, §7; 08 §2.7). They are never
synced to the task tool.

- **Workspace (`/notes`, `/notes/new`, `/notes/:id`, page `NotesWorkspace`).**
  One view: a list with server search (`q`, prefix match per word), *더 보기*
  paging and empty / no-results / loading / error / offline states, beside the
  editor from 1024px. Below 1024px the list and the open note are separate
  steps, with *노트 목록으로*. Notes pages use the frame's stacked variant
  (like planning), so the context panels sit below the page. *노트* is in
  the rail (Daily group) and the More sheet.
- **Editor.** Title, Markdown body with *편집 / 미리보기 / 나란히* (side by
  side only from 1024px; a radio group, keyboard-native), a code-point counter
  against 65,536 (an over-long body cannot be saved), sensitivity *P2 일반
  노트 (기본) / P1 개인 일정 정보*, and the *AI에 보내기 허용* switch. It is
  off by default and says what is sent (related sections of a linked plan, at
  most 6 KB per call) and that masking is best-effort, with a warning for P1
  notes. Saves send `If-Match` (note version) and a UUIDv7
  `Idempotency-Key`. A 412 opens an `alertdialog` with *서버 내용 불러오기* /
  *내 내용을 사본으로 저장* / *계속 편집*. Delete is a soft delete behind an
  `alertdialog` whose focus starts on *취소*. Leaving with unsaved changes
  asks first. Ctrl/⌘+S saves, and the save state is announced in a polite
  live region.
- **Safe preview (`components/notes/markdown.ts`).** markdown-it 15.0.3
  (MIT, pinned) only parses (`html`, `linkify` and `typographer` off). The
  token stream becomes Vue VNodes through an allowlist; there is no `v-html`
  or `innerHTML`. Raw HTML stays visible text. A link is its text, then the
  address as text. Only `http:`, `https:` and `mailto:` addresses also get a
  separate *열기* link (`target="_blank"`, `rel="noopener noreferrer
  nofollow"`, `referrerpolicy="no-referrer"`), and any other scheme is marked
  *열 수 없는 주소*. Images are never loaded: alt text and address are shown
  as text, so a tracking pixel cannot report a read. Headings move two levels
  down. Past markdown-it's nesting limit, which would silently drop text, the
  note is shown verbatim.
- **Links (연결 대상).** A project/task picker (a `dialog` with a radio
  list, already-linked targets disabled). Goal links come
  from the planning wizard, because goals have no list endpoint. Link and
  unlink pin `If-Match` to the note version. The editor advances its edit
  base silently only when the newer version changed links or the version
  alone. If title, body, sensitivity or the AI opt-in changed there while I
  have unsaved edits, the reload / keep-mine-as-copy dialog opens instead
  (M6-03R-1 M1). That holds for a link/unlink 412 and for a save 412. A save
  412 caused only by a link change rebases and is sent once more, with a new
  If-Match and so a new Idempotency-Key.
- **AI 근거 사용 이력.** Per note: purpose, status, time, section count and
  hashes, bytes, note version, and *이후 수정됨* when the note changed since.
  The sent text is never stored, so it is never shown.
- **Project 노트 탭.** `/projects/:id?tab=notes`: an ARIA tablist (arrow
  keys, Home/End, roving tabindex) and *이 프로젝트에 새 노트*
  (`/notes/new?link=project:<id>`).
- **Task detail (`/tasks/:id`).** Opened from a task's title. Shows the
  provider description as text only (an inert `DOMParser` document, tags
  dropped), the linked notes, *이 작업에 새 노트*, and *설명을 노트로 승격*
  (`If-Match` on the task version). A 409 opens the note promoted earlier,
  found by following `nextCursor` across the task's notes (M6-03R-1 M2);
  a 412 refreshes the task; a 422 means there is no description.
- **Planning wizard.** *이 계획에 참고할 노트* links notes to the session's
  goal (the only thing decomposition grounds on). Its badges say which notes
  may be sent (*AI 전송 허용* / *AI에 보내지 않음*). The draft step lists
  `evidence` as *사실* / *추론* (an icon and a solid or dashed edge, never
  colour alone), with the statement as quoted plain text, the source note
  title, *구간 #hash*, the note time, *그 뒤 노트가 수정됐어요*, the related
  steps and *노트 열기*. The draft PATCH never sends evidence back.
- **RelatedNotes{limit}.** Notes linked to the current work, newest first,
  at most `limit`, titles only. The current work is, in order: the
  focus/running session's task and its project; the planning session's goal;
  the open note's targets (that note excluded); and on Today, the next
  block's task and its project.
- **Owner scope (ADR-023, M6-03R-1 H1).** Every cache key starts with the
  owner id, and every lookup runs in `ownerFenced` (`composables/notes.ts`).
  That means one OwnerBinding for the whole lookup, all pages included, with
  its AbortSignal on every request. The key's owner must be the bound owner,
  and the binding is re-checked after every await, both before the next page
  and before anything is returned (and so cached). A stale lookup throws
  `OwnerChangedError` and nothing of it is kept or retried. Every write
  captures the binding and drops its continuation after an owner change.

## Evidence

`redesign/` holds the current screens (2026-11-13, every flow, 310 visits, no
overflow and no critical or serious axe finding; its PNGs are reduced to a
256-colour palette to keep the folder small). The other folders named below
were captured before the redesign and show the previous look. The script,
its flows and its checks are unchanged:

```sh
node scripts/ui-screenshots.mjs --label redesign
```

`before/` was captured at the base commit and `after/` on the UI-POLISH
branch (English UI). `after-ko/` is the Korean UI (UI-I18N), captured the same
way with the browser locale set to `ko-KR`. All of them use only synthetic MSW
data (`VITE_MOCK=1`, `src/mocks`) with the clock pinned
to 2026-11-14 Asia/Seoul. There are no real accounts or personal data.

```sh
# from apps/web; starts vite in mock mode on :5199
node scripts/ui-screenshots.mjs --label after-ko
node scripts/ui-screenshots.mjs --label after-ko --only 14-today
# M5-03 screens (22–33) into m5-03/
node scripts/ui-screenshots.mjs --label m5-03 --flows replan,patterns
# M6-02 layout modes (34–41) into m6-02/
node scripts/ui-screenshots.mjs --label m6-02 --flows adaptive
# M6-03 notes screens (42–51) into m6-03/
node scripts/ui-screenshots.mjs --label m6-03 --flows notes
```

`--flows month` (CAL-01) captures the month page on the mock's seeded
November (`seedMonth` in `src/mocks/db.ts`, on by default in mock mode; seed
`window.__OHMYDATE_MOCK__ = { month: 'none' }` to leave it out): this month
with today picked (52, light/dark, full), another day picked (53, full), the
next month (54) and a month with nothing planned (55). Run with
`--flows month,daily` to see Today's 약속 and 오늘 마감 too (14).

`m6-03/` holds the notes screens: the list (42, light/dark; on desktop beside
an open note), the editor with the side-by-side preview (43, light/dark, full
page with links and AI usage), the link picker (44), the AI usage history
(45), the 412 conflict dialog (46), the delete confirmation (47), the
project notes tab (48), the task detail with *설명을 노트로 승격* (49), the
wizard's reference notes with fact/inference evidence (50, light/dark, full)
and RelatedNotes in the focus layout (51, mock seed
`window.__OHMYDATE_MOCK__ = { notes: 'focus' }`).

`m6-02/` holds one capture per layout mode: overview (34, light/dark, full),
focus right after *집중 시작* with the undo toast (35, light/dark), the undone
layout (36), planning (37), deadline risk (38, mock seed
`window.__OHMYDATE_MOCK__ = { today: 'risk' }`, full), review at 20:30 with an
unreviewed session (39, full), notes (40) and the layout settings (41).

`m5-03/` holds the M5-03 screens: Today with a pending proposal (22), the
notifications link (32), the proposal detail (23, light/dark, full page), the
reject confirmation (24), the list with history (25), an expired proposal (26),
the 412 conflict dialog (33), the approved state (27), a suppressed request
(28, full page), 내 패턴 learned (29, light/
dark, full page), its reset confirmation (30) and the cold start (31). The
mock seeds them with `window.__OHMYDATE_MOCK__ = { replan: 'history' }` /
`{ estimation: 'cold' }` (`src/mocks/replan.ts`).

The script visits every screen at 390×844, 1440×900 and 360×780 (the last is
checked but not captured), in light and dark. It keeps PNGs for all light
screens plus dark Today and Focus, and `-full` captures for the long pages. On
every visit it runs axe-core (`wcag2a/aa`, `wcag21a/aa`, `wcag22aa`) and a
horizontal-overflow check. It exits 1 on any critical or serious violation, or
on any overflow. Results are in `<label>/sweep-report.json`:

| | Visits | Failing | Issues |
|---|---|---|---|
| before | 120 | 14 | plan comparison: page overflow at 390/360 and `target-size` (serious); review: overflow at 390/360; availability: `aria-required-children` (critical) in all viewports |
| after | 130 | 0 | none. The 10 extra visits are the Focus calm-mode screen |
| after-ko | 130 | 0 | none (Korean copy, same screens; the 360px checks pass with the longer Korean labels) |
| m5-03 | 72 | 0 | none (M5-03 screens only: `--flows replan,patterns`) |
| m6-02 | 48 | 0 | none (M6-02 layout modes only: `--flows adaptive`) |
| m6-03 | 60 | 0 | none (M6-03 notes screens only: `--flows notes`) |

The real API is covered too. `e2e/tests/e2e-a11y-screens.spec.ts` runs the
same axe tags against PostgreSQL + Vikunja on the screens E2E-1..4 do not
scan. Projects, project detail, availability, commitments, AI settings and
notifications are checked at 1280×800 (nav rail) and 390×844 (bottom nav and
More sheet). At both widths the spec also runs Focus, switches calm mode on,
completes and reviews the session without leaving calm mode, and checks that
*Back to Today* and the navigation are visible at each step. The spec waits for finite entrance animations to end
before each scan, because a sheet that is still fading in reports false
contrast failures. `e2e/tests/e2e-6-notes.spec.ts` (M6-03) scans the notes
screens on the real stack at 1280×860 and 390×844: the empty list, the new
note, the preview, the link picker, the wizard's note picker and draft
evidence, a note with AI usage, the focus layout with RelatedNotes, search,
the delete confirmation, the project notes tab and the task detail.
