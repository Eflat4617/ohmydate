# UI-I18N report

- taskId: task_0a003ce6f1ca · dispatchId: ctx_9e59b2ae082c
- worktree: /home/torgal/orca/workspaces/oh_my_date/ui-i18n-ko · branch: torgal/ui-i18n-ko
- commit: e46f0af (base 22988ff) — not pushed
- changed: 141 files (+4871/−1290): 82 source/test/doc files (apps/web/**, e2e/**) + 59 PNGs + sweep-report.json in apps/web/docs/ui-polish/after-ko/

## Diff summary
1. New `apps/web/src/i18n/`: `messages/ko.ts` (bundled ko catalog with a glossary), `types.ts` (dot-path key/placeholder types, branded plural forms), `index.ts` (`t`, `tp` on Intl.PluralRules, `Messages` contract for another locale, `setLocale` → `<html lang>`), `format.ts` (Intl date/time/range, duration, USD, percent), `problem.ts` (code → Korean message), `server.ts` (server codes → Korean), `I18nT.ts` (slot interpolation, no v-html).
2. Every view/component/store/composable/focus-queue message goes through the catalog; `index.html` is `lang="ko"`. Server `detail` is no longer shown anywhere.
3. New `LlmDisclosure.vue` shared by consent dialog + AI settings: provider OpenCode Go (DeepSeek 모델 · deepseek-v4.1-flash), 보내는 데이터, 마스킹 최선 노력(이름·주소·계좌번호 미보장), 언제든 철회.
4. Raw minutes replaced everywhere (plan metrics, Today slack/planned/blocks, Focus planned/progress/announcement, proposal badges, review feedback, risk reasons); budgets as `$0.20`/`$0.0035`.
5. Plan cards: English scheduler diagnostics moved out of the select button into a collapsed `계산 근거 (원문)` (lang="en"); Korean policy summaries added; known diversity notes translated.
6. Synthetic MSW seed titles translated (mocks only) and the mock Today risk reason switched to the real API code `daily_focus_cap_exceeded:310`.
7. Unit + e2e selectors moved to Korean accessible names (no flow changes); e2e `plan-edit.ts` gained `koreanDateLabel`/`koreanClock`/`dateFromKoreanLabel` for the Korean calendar labels and week heading.
8. CSS: disclosure layout, explanation toggle, candidate summary, hour rail 3.5rem → 4rem (Korean hour labels); review outcome label shortened (일부만) to avoid wrapping on 390px.

## Requirement checklist
1. i18n layer — met: ko default, no runtime fetch, typed keys (missing key/param = vue-tsc error; `@ts-expect-error` probes in test/i18n-catalog.spec.ts), plural API (`tp`/`selectPluralForm`, tested with en-style `one`), another locale typed as `Messages` (partial locale = type error), html lang="ko".
2. Translate all copy — met: views, components, nav, buttons, empty/error/offline/conflict states, toasts, notifications, all 19 problem codes + unknown, aria labels/live text, consent + AI settings with the 4 required statements. Guarded by a template/script scanner test (no English copy in any .vue template or UI script).
3. Intl formatting — met: `11월 14일 (토)`, `오후 7:00`, `오후 7:00~8:30` / `오전 10:30~오후 1:30`, date ranges, shared duration formatter (`1시간 30분`, `11일 10시간`, `+11일 10시간`, `−35분`, `1분 미만`, `0분`), USD 2–4 decimals, user tz (plan/today/user.timeZone).
4. Tests — met: unit + e2e selectors Korean (assertions kept or strengthened), test/i18n-format.spec.ts (0, negative, >1 day, DST spring-forward/fall-back), test/i18n-catalog.spec.ts (completeness, enums, problem codes, English-copy scan), test/i18n-problem.spec.ts; FU-60 fixed (m4-today current-plan test waits on the real shrink/approve/getToday/reschedule requests and the settled UI).
5. Evidence — met: apps/web/docs/ui-polish/after-ko/ (59 PNGs at 390×844 and 1440×900, light + dark Today/Focus, -full for long pages); MSW axe sweep 130 visits, 0 overflow, 0 critical/serious.

## Tests (real runs)
- `corepack pnpm --filter @ohmydate/web test` → exit 0 → `Test Files 32 passed (32)`, `Tests 240 passed (240)` (was 193; +47 new)
- `corepack pnpm --filter @ohmydate/web build` → exit 0 → `✓ built in 1.53s`
- `DATABASE_URL=…/planner_test VIKUNJA_URL=http://127.0.0.1:3456 corepack pnpm run ci` → exit 0 → root `Tests 1521 passed | 29 skipped (1550)`, web `240 passed`, `Boundary check passed: 368 file(s), 0 violations`, build-smoke `/healthz 200`, check:api-client clean
- same env `corepack pnpm run e2e` → exit 0 → `23 passed (3.7m)` (first full run: 20 passed, 1 failed, 2 not run; E2E-2 still asserted the English server question prompt — fixed to the Korean prompt, E2E-2 re-run 3/3, then the full suite re-run 23/23)
- `node scripts/ui-screenshots.mjs --label after-ko` → exit 0 → `130 visits · 0 with overflow or critical/serious axe violations`

## Risks / unverified
- Server-generated free text without a code (scheduler explanation lines, violation messages, unknown diversity notes, LLM-written detection reasons, user answers) is still shown as original (lang="en"); a full Korean experience there needs server-side codes/i18n (suggested follow-up).
- The wizard scenario-B unit test also raced at base (failed in the untouched baseline run under load); its template-name assertion now sits inside the existing waitFor (same assertion, no timing).
- Problem `detail` is hidden; generic code messages are less specific than some English details (e.g. validation_failed).
- Mock seed titles changed to Korean (tests use the exported constants; none hardcoded except the updated ones).
- Two pre-existing unused locals remain (FocusView `sessionJournal`, wizard `draftIssues`); untouched.

## New contracts for dependents
- New UI copy must go through `t()`/`tp()` keys in `src/i18n/messages/ko.ts`; the catalog scan test fails on English template text/attributes.
- Calendar block aria-label format is now `<task>, <M월 D일 (요일)> <오전/오후 H:MM>~<…> (<GMT±N>)`; e2e uses `calendarBlockSelector` from e2e/helpers/plan-edit.ts.

## Rollback
Delete branch `torgal/ui-i18n-ko` (single commit e46f0af on top of 22988ff).
