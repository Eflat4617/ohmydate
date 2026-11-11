# OhMyDate web — design system (UI-POLISH)

The aim is a calm, focused, trustworthy personal planner: warm paper
background, green-grey ink, one deep-forest accent. It should feel like a
notebook, not an admin console. This page records the rules the screens follow.
The visual spec is `docs/blueprint/07-ADAPTIVE-UI-SPEC.md` §1–§6.

## Stylesheet layers

`src/styles.css` imports these in order, and each layer may only use the ones
above it:

| Layer | File | Holds |
|---|---|---|
| Tokens | `src/styles/tokens.css` | every raw colour, size, radius, shadow, duration and z-index |
| Base | `src/styles/base.css` | reset, typography defaults, `:focus-visible`, utilities (`.visually-hidden`, …) |
| Primitives | `src/styles/primitives.css` | button, field, card, badge, banner, empty state, skeleton/spinner, key/value list, dialog/sheet, toast |
| Shell | `src/styles/shell.css` | nav rail, bottom nav + More sheet, page frame, calm (Focus) mode |
| Screens | `src/styles/screens.css` | screen layout only (grids, columns, calendar geometry) |

Rule: **no hex, `rgb()` or raw font sizes outside `tokens.css`.** Vue files
have no `<style>` blocks. Screens get their look from primitives and tokens.
Only hairline geometry (1–3px borders, calendar stripe widths) uses literal px.

## Tokens

- **Colour, neutrals:** `--color-bg`, `--color-surface{,-raised,-sunken,-hover}`,
  `--color-border{,-strong,-control}`, `--color-text{,-muted,-subtle}`, `--color-overlay`.
- **Colour, accent:** `--color-accent{,-hover,-soft,-text}`, `--color-on-accent`.
- **Colour, semantic:** `success`, `warn`, `danger`, `info` and `offline`, each
  with a base colour for text and icons plus `-soft` (fill) and `-border`.
  Conflict notices use the `warn` family.
- **Calendar:** `--color-cal-*`. Commitments get a diagonal stripe as well as
  a fill, so the meaning is never carried by colour alone.
- **Light and dark:** one variable set, overridden inside
  `@media (prefers-color-scheme: dark)`. Components never branch on the scheme.
- **Focus:** `--focus-ring` (3px, `--color-focus`, offset 2px) on
  `:focus-visible` everywhere.
- **Spacing:** 4px base, `--space-0-5 … --space-16`.
- **Type:** Korean-first system stack (`Pretendard` → `Apple SD Gothic Neo` →
  `Noto Sans KR` → `Malgun Gothic` → system). No network fonts. Sizes run
  `--text-2xs` (dense calendar labels only) through `--text-display` (Focus
  timer). `--leading-normal: 1.6` gives Hangul room to breathe, and headings
  use `--leading-tight`.
- **Radius:** `xs 4 · sm 6 · md 10 · lg 14 · xl 20 · pill`.
- **Elevation:** `--shadow-1` (cards), `--shadow-2` (popovers, toasts),
  `--shadow-3` (dialogs), `--shadow-bar` (bottom nav).
- **Motion:** `--duration-{fast,base,slow}` with `--ease-standard` and
  `--ease-out`. Under `prefers-reduced-motion: reduce` every duration is 0ms
  and the skeleton shimmer stops.
- **Sizing:** `--control-height` is 44px (07 §4 touch target), with `-sm` 36
  and `-lg` 52. Nav width, content max widths and the z-index ladder are
  tokens too.

### Contrast (WCAG 2.2 AA)

These ratios are computed from the token values. Text needs at least 4.5:1;
control edges and focus rings need at least 3:1.

| Pair | Light | Dark |
|---|---|---|
| `text` on `bg` | 14.52 | 15.52 |
| `text-muted` on `surface` | 6.88 | 7.49 |
| `text-subtle` on `surface-sunken` | 4.54 | 6.91 |
| `accent-text` on `accent-soft` | 7.32 | 7.68 |
| `on-accent` on `accent` (primary button) | 7.85 | 9.16 |
| `success` on `success-soft` | 5.93 | 7.70 |
| `warn` on `warn-soft` | 6.11 | 8.39 |
| `danger` on `danger-soft` | 6.32 | 7.63 |
| `info` on `info-soft` | 6.53 | 7.86 |
| `offline` on `offline-soft` | 7.43 | 8.47 |
| `border-control` on `surface` (non-text) | 3.30 | 3.57 |
| `focus` on `bg` (non-text) | 5.05 | 9.21 |

axe-core also checks the rendered screens on every sweep (see Evidence below).

## Primitives (`src/components/ui`)

| Component | Use |
|---|---|
| `UiButton` | `variant` primary / secondary / ghost / danger / danger-ghost, `size` sm/md/lg, `icon`, `iconOnly`, `block`, `busy` (spinner + `aria-busy`; the caller still owns `disabled`) |
| `UiField` | label + help + error for any control in its slot. Wires `aria-describedby` (`<id>-help <id>-error`) and `aria-invalid` |
| `UiCard` | `default` / `flat` / `sunken`, `compact`, `interactive` |
| `UiBadge` | chips and status. `tone` neutral/accent/success/warn/danger/info/offline/outline, optional `dot` |
| `UiBanner` | notices. `tone` info/success/warn/error/offline/conflict, default icon per tone; the live `role` is opt-in so existing live regions are not duplicated |
| `UiEmptyState` | title + body + optional action, with a quiet icon |
| `UiSkeleton` / `UiSpinner` | loading. Skeletons are decorative and always come with a status message |
| `UiDialog` | modal `dialog` or bottom `sheet` (see below) |
| `ToastHost` | toasts with a tone stripe, an action and a dismiss button |
| `UiIcon` | inline SVG icon set (`icons.ts`), always `aria-hidden` |

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
| < 640px | 5-slot bottom nav (Today, Inbox, ＋ New task, Plan, More). The More sheet holds the rest | one column; plan candidates swipe horizontally inside their own scroller |
| 640–1023px | bottom nav | wider single column, two-column forms where they fit |
| ≥ 1024px | grouped nav rail (Daily / Planning / Settings) with shortcut hints | multi-column forms |
| ≥ 1280px | rail | multi-panel: Today adds a *Day at a glance* aside; plan comparison shows its candidates side by side with the calendar |

Focus has a **calm mode**: the shell steps back (no rail, no bottom nav), the
timer is set in display type, and planned progress shows under it. Calm mode
only lasts while the timer runs. When the session completes, or is no longer
loaded, it switches off on its own, so the review sheet and the state after
the review always show *Back to Today* and the navigation. Escape or the
toggle also leave it.

A 360px viewport never scrolls the page horizontally. Wide content (week
calendar, candidate cards) scrolls inside its own labelled region.

## State conventions

| State | Pattern |
|---|---|
| Loading | `UiSkeleton` shaped like the content, plus a visually hidden status |
| Empty | `UiEmptyState`: what is missing, and the next action |
| Error | `UiBanner tone="error"`, with retry where possible |
| Offline | `OfflineBanner`, i.e. `UiBanner tone="offline"` with a *saved locally* hint |
| Conflict | `ConflictDialog` (`UiDialog role="alertdialog"`): Keep editing / Reload / Overwrite |
| Saved / version | `UiBadge tone="success" dot` next to the primary action |

## Rules for new UI

1. Build from primitives. A one-off button, card or notice needs a new
   primitive variant first.
2. Use only tokens. Need a new value? Add a token, and a dark override if it
   is a colour.
3. Do not change `data-*` hooks, accessible names or keyboard paths without
   updating `apps/web/test` and `e2e/**` in the same commit.
4. Never use colour alone to carry meaning. Pair it with an icon, text or a
   pattern.
5. Keep touch targets at `--control-height` or larger on coarse pointers.
6. Never hard-code copy. Every user-visible string, accessible name and
   live-region message comes from the catalog (`t()` / `tp()`, see below);
   dates, times, durations and money go through `src/i18n/format.ts`.

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
  free text stays in *계산 근거 (원문)* (`lang="en"`, FU-62). The diff is
  computed client-side (`src/domain/replan.ts`) from `candidate.blocks` against
  the approved blocks from `trigger.detectedAt`.
- **Actions.** *승인* sends `If-Match: W/"availability:<n>"` (the proposal's
  snapshot) plus a UUIDv7 `Idempotency-Key`; 412 opens an `alertdialog`
  (*새로 고침* / *지금 상태로 다시 계산*), 409 `proposal_state_conflict` re-reads
  and shows the read-only state. *거절* first explains the 24 h same-reason
  suppression (with the end time) in a dialog whose focus starts on *취소*.
  *재계획 요청* shows `409 replan_suppressed` as a wait (`1일 뒤(11월 15일 (일)
  오후 6:40)`) from `Retry-After`. Approved / rejected / expired / superseded
  proposals are read-only. Outcomes are announced in a polite live region and
  focus moves to the state summary.
- **Plan id gap.** `ReplanRequest` needs a plan id that neither Today nor a
  proposal carries, so the web remembers the last active plan per owner
  (`src/session/activePlan.ts`: from `PlanVersion.planId` and active plan
  pages). The request button only appears when one is known.
- **내 패턴 (`/patterns`).** Summary (counted records, confidence as
  낮음/보통/높음 + %), the cold-start rule (template, else AI ×1.3 with low
  confidence) and the shrinkage/outlier rules in Korean, one card per task type
  (prior 1배 · personal mean · applied P50/P90 correction · record count ·
  confidence), and the feedback list with an *통계에 포함* switch per item
  (`PATCH /estimation/feedback/{id}` with `If-Match`). Resets (all, or one
  template) use an `alertdialog` that states how many records go and that it
  cannot be undone. Only minutes and ratios are shown — never review notes.

## Evidence

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
```

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

The real API is covered too. `e2e/tests/e2e-a11y-screens.spec.ts` runs the
same axe tags against PostgreSQL + Vikunja on the screens E2E-1..4 do not
scan. Projects, project detail, availability, commitments, AI settings and
notifications are checked at 1280×800 (nav rail) and 390×844 (bottom nav and
More sheet). At both widths the spec also runs Focus, switches calm mode on,
completes and reviews the session without leaving calm mode, and checks that
*Back to Today* and the navigation are visible at each step. The spec waits for finite entrance animations to end
before each scan, because a sheet that is still fading in reports false
contrast failures.
