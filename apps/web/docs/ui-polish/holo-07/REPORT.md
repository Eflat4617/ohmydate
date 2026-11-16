# HOLO-07 — the phone: report

Branch `torgal/holo-07-phone`, on top of `ff18543`. Nine commits, the tree is clean.

## Commits

| # | Commit | What |
|---|---|---|
| 1 | `f3f8f1b` | **Slice 1.** Installable, and clear of the device's edges |
| 2 | `ab035f8` | **Slice 2.** The 할 일 canvas, the capture sheet and the planner under a finger |
| 3 | `01c1f18` | **Slice 2.** Schedules, dialogs and the rest of the loop under a finger |
| 4 | `04baf21` | **Slice 2.** Two faults in the canvas's own touch handling, found by the walk |
| 5 | `f425b69` | **Slice 3a.** An address that is no folder says so |
| 6 | `c4eaaea` | **Slice 3b.** 폴더 만들기 takes what is picked |
| 7 | `a12e1ab` | **Slice 3c.** An available-hours cell is 24px tall under every pointer |
| 8 | `a463136` | **Slice 3d.** The core's mock serves nineteen operations |
| 9 | `0c54b01` | **Addendum (e).** The owner chooses what the app calls them |

## 1. What installing gives, and how it was checked

- `public/manifest.webmanifest`: name and short name OhMyDate, opens `/overview` (개요), `display: standalone`, `orientation: portrait`, background and theme colour `#070a08` — the dark ground of `tokens.css` as hex.
- Icons rendered from the product's own mark by `scripts/render-app-icons.mjs` (it reads the shapes out of `BrandMark.vue`, the stroke out of `shell.css`, the three colours out of `tokens.css`; nothing is drawn or downloaded): 192, 512, a maskable 512, an Apple touch icon 180 and the tab's SVG. `--check` fails when the mark or its colours changed since the render.
- `index.html`: the manifest and icon links and a `theme-color` tag in one marked block. `theme.ts` keeps the tag on the scheme's ground, so the browser's bar follows the owner's theme and its switch (dark `#070a08`, light `#f0f4ef`; 시스템 follows the system).
- `viewport-fit=cover` with the insets as tokens (`--safe-top/right/bottom/left`; only `tokens.css` reads `env()`): the shell pads by them; the phone's nav, sheets, dialogs, toasts, the canvas's selection bar, the sticky save bar, Focus calm mode and the login page stand clear of them.
- `interactive-widget=resizes-content`: the keyboard takes its space from the page. The phone's nav steps away while a text field has the caret in a window that short.
- Behind a sheet or a dialog the page does not scroll or pull-to-refresh (coarse pointer). Every field's text is 16px at least under a coarse pointer (no zoom on focus). Zoom itself is never disabled.
- **No service worker, no cache.** A test fails any `serviceWorker.register` or cache use in `src/`, and pins what `public/` holds.
- **The desktop bundle carries none of it**: `config/installHead.ts` cuts the block out before Vite reads the document; that bundle has no public directory.
- `docs/user/폰에서-접속-Tailscale.md` says how to add it to the home screen (Android Chrome, iPhone Safari) and what to expect.

Checked by: 26 unit tests (`holo-phone-install.spec.ts`, `holo-phone-theme-color.spec.ts`); both builds (`dist/` holds `manifest.webmanifest` and `icons/`; `desktop/dist/` holds `assets` and `index.html` only, with no install tag); the dev server answering the manifest as `application/manifest+json`; in phone emulation on Chromium and WebKit the theme tag following the switch, the nav rising by a `--safe-bottom` set by hand, the root locked while a sheet is open; and looking at the rendered icons.

**One thing to know.** An installed app that is started with no network shows the browser's own "no connection" page, not the app's offline state: showing the app there would need the cache the task rules out. Losing the network while the app is open shows the app's own offline banner as before (walked).

## 2. What a finger found

Walked by `scripts/touch-walk.mjs`: a phone emulated with touch, 390×844 and 360×780, dark and light, Chromium and WebKit. 144 steps on each engine, none failing.

| Where | Under a finger it did this | Now |
|---|---|---|
| 할 일, a to-do | A tap opened the detail and it closed again at once: the browser's follow-up mouse events moved the focus off the card. When the card landed under the finger, the follow-up click pressed whatever of the card was there. | The touch the surface answered is ended without those events. The detail opens and stays. |
| 할 일, picking several | No touch way: picking needed Shift or a lasso, and a finger on the water scrolls. | A long press that goes nowhere picks. While something is picked a tap picks and unpicks. A tap on the water lets go. |
| 할 일, moving | Press, hold 280ms, drag already worked; a swipe that starts on a to-do scrolls the page. | Unchanged, now tested with touch. The hold ticks where the device can vibrate. A line over the surface says the gestures. |
| 할 일, a resting finger | When the lists were read again under it, the surface was laid out again and the long press was taken for a drag. | Movement is measured in the window, not on the surface. |
| 할 일, the selection bar | A touch whose end never reached the surface could leave a mark that swallowed the next tap's click on 폴더로 옮기기. This was a fault in my own first version, caught on WebKit. | The mark is cleared on every press. |
| 담기, the sheet | With the keyboard up the drafts scrolled and 담기 was under them. | The button rides the sheet's foot. |
| 계획, a schedule's block | A swipe that started on a block could not scroll, and dragged the block. | On a phone a finger does not drag a block: the week scrolls from it, a tap opens its card (더 일찍, 더 늦게, 짧게, 길게), and the hint says 끌어서 고치기는 넓은 화면에서 돼요. |
| 플래너 | The week on a phone is narrow columns. | A phone that arrives at `/planner` gets the day; 주 in the view switch is still the week. |
| A tall dialog | A toast lay over the buttons it ends in. | Below 1024px toasts stand at the top while any dialog is open. |
| The account menu | The theme marks shrank to dots beside their words. | They keep their size. |
| Targets under 44px | The top bar's mark (30px), account button and now-pill start (36px); fields and selects (40px); links standing alone (21 to 23px, under the 24px floor); row titles (26px); disclosures; one-letter weekday chips; next-step links (24px). | All take the 44px hit target on a coarse pointer (`styles/touch.css`, nothing in it reaches a mouse). |

Walked and found right as they were: 개요 (next block, 집중 시작, the timetable scrolls), the focus timer, 완료 and the one-tap review, the task picker, 더 보기 and its dismissal on the scrim, the notifications panel, folders folding and their menu, 폴더로 옮기기, the 목록 switch, painting 가용 시간 and scrolling from its time column, the three schedules stacking.

Still under 44px, at the 24px floor: a block of the week grid (its height is its length in time) and a half-hour cell of the available-hours grid.

Not changed: a dialog that is not a sheet (the 약속 dialog) does not close on a tap outside. It holds a form, and that is its design.

One edge seen and left, cause not pinned down: on Chromium a long press made right after filing that same to-do sometimes did not leave it picked. Waiting for the lists to settle before the press made it reliable (three runs in a row, then every run since). My reading is that the selection is pruned when the refreshed lists arrive, which would not be touch-specific, but I did not confirm it.

## 3. The loose ends

- **a)** `/projects/<id>` for a removed (archived) or unknown folder shows "이 폴더는 없어요" with 할 일로 돌아가기 as its one filled button. While the folder list is loading or cannot be read nothing is called missing.
- **b)** With to-dos picked the head's button reads "고른 N개로 폴더 만들기"; the dialog says they will go in; the new folder takes them and the selection ends. A to-do the folder could not take stays picked.
- **c)** The row of the available-hours grid is 1.5rem (24px) under every pointer. The settings sweep is clean on WebKit and Chromium at all four widths, dark and light (it failed at 1024px on WebKit before).
- **d)** `rc-10b-not-ready.spec.ts` models nineteen served operations and tests the model itself. The not-ready rules were tested through the hours lookup, which is served now; they stay tested by taking that operation back out (`likeTheCore({ notYet })`). 21 tests became 25; none was removed or weakened.

None was dropped.

## 4. Addendum (e): what the app calls the owner

**Where the field is: 설정 › 화면, the first card, "이름" — one field labelled "앱이 나를 부르는 이름" with its own 저장.** On a phone: 더 보기 → 설정 → 화면. It is typed once per device.

- Rules: trimmed, inner white space collapsed, control characters dropped, at most 30 characters counted as code points. **Too long is cut at 30, not refused**, and the field shows the name as it was kept. Plain text only.
- Empty or white space is the e-mail's part again. The desktop bundle has no address: there the chosen name is the only name, and without one it names nobody, as today.
- Kept per owner on the device in a new owner slot (`chosenName`, key `ohmydate.owner.name:<owner id>`, the name only).
- Read reactively: 개요's greeting, the account chip and the avatar's initial change at once on every open screen.
- No request, no log, nothing the AI reads: a test pins the only four files that read it.
- **One deliberate difference from the addendum's wording.** The write is bound to the owner the screen was made for, not to the binding captured at the press. The owner-switch sweep showed why: captured at the press, a save on the old screen after another user signed in wrote the name into that user's storage. Bound to the screen, it stores nothing.
- Tests: 25 in `holo-chosen-name.spec.ts` (the rules with negatives, another owner never sees it, an owner change drops the write, the field, the greeting and chip following, markup shown as letters, the desktop bundle) and a case in the owner-switch sweep. Every name in code, tests and docs is made up.

## 5. Tests, with exit codes

Run one at a time, with `DATABASE_URL` and `VIKUNJA_URL` set as given.

| Command | Exit | Result |
|---|---|---|
| `corepack pnpm --filter @ohmydate/web lint` | 0 | |
| `corepack pnpm --filter @ohmydate/web test` | 0 | 100 files, 1595 tests; then the sweep shards: 6 files, 284 tests |
| `corepack pnpm run typecheck` | 0 | |
| `corepack pnpm run lint` | 0 | |
| `corepack pnpm run check:boundaries` | 0 | 749 files, 0 violations |
| `corepack pnpm --filter @ohmydate/web build` | 0 | `dist/` holds the manifest and the icons |
| `corepack pnpm --filter @ohmydate/web build:desktop` | 0 | `desktop/dist/` holds neither, and no install tag |
| `corepack pnpm run e2e e2e/tests/e2e-1.spec.ts e2e/tests/e2e-9-folders.spec.ts e2e/tests/e2e-a11y-screens.spec.ts` | 0 | 6 passed (the stack was up) |
| `node scripts/touch-walk.mjs` | 0 | 144 steps, 0 failing |
| `node scripts/touch-walk.mjs --browser webkit` | 0 | 144 steps, 0 failing |
| `node scripts/ui-screenshots.mjs --report-only` (Chromium, all flows) | 0 | 444 checks, 0 failing |
| `corepack pnpm run core:ledger` | 0 | no spec file was added under `e2e/tests` |

Web unit tests went from 1777 to 1879 (1497 + 280 before, 1595 + 284 now). `e2e-a11y-screens.spec.ts` was changed for the phone's day view (it now also asserts the day on arrival and the week after 주); nothing was skipped, deleted or weakened.

**NOT RUN: `corepack pnpm run e2e:core`.** This worktree has no built core, and it is not in the task's list. `e2e-a11y-screens.spec.ts` is one of the specs that target runs, and the desktop bundle shares the CSS, the viewport tag, the canvas's touch handling, the planner's phone entry and the 이름 card. It is worth one run after the merge.

## 6. What could not be checked without a real phone

- That Chrome on Android offers 설치 and makes the home-screen app, and how the launcher cuts the maskable icon. The manifest, the icons and the HTTPS address are what it asks for; nothing here can mint one.
- The real safe-area insets. The layout was checked by setting the `--safe-*` tokens by hand.
- The on-screen keyboard. Its space was stood in for by a shorter window, which is the same thing on Chrome for Android with `interactive-widget=resizes-content`. iOS Safari does not resize the page for its keyboard, so there the capture sheet's foot can still be under it.
- The browser's long-press menu and the vibration tick on a held to-do, pull-to-refresh, and rubber-banding: the rules are in place, their effect on a device is not seen.
- WebKit's own scroll arbitration. On WebKit a tap is real, but a long press, a drag and a swipe are the pointer events of one finger handed to the page: the page's handling ran there, the browser's did not. On Chromium the gestures went through the browser's own input pipeline.
- A thumb. 44px is the rule; a hand is the test.
