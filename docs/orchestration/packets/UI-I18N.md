# TASK PACKET: UI-I18N — Korean UI (i18n layer) + human-readable durations
Role: worker-frontend (Opus 5.5 xhigh, MODEL_BINDINGS §8). Base: torgal/ohmydate HEAD (UI-POLISH merged).
User decision (2026-11-11 20:33): the UI must be Korean before the user's hands-on test (GU-1). Keep the calm, polished tone of UI-POLISH; write natural Korean product copy (not literal translation), consistent terms (e.g. 오늘, 집중, 일정안, 가용 시간, 약속, 받은 편지함/인박스 — pick one glossary and use it everywhere), polite 해요체 for messages.
Read: apps/web/docs/ui-polish/README.md (design system), docs/blueprint/07 (Korean wireframes), all views/components, problem code map (apps/web/src/api/errors.ts), LLM consent text (ADR-022 + amendments: OpenCode Go DeepSeek, data sent, best-effort masking limits, revoke anytime).

You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets, calling paid external APIs other than your own model.
3. Commit your work on your branch with Conventional Commits; include "Task: <taskId>" in the body.
4. Run every command in "Exact tests" and paste the real exit codes and tail output. Never claim a test passed
   that you did not run. If you could not run something, say SKIPPED + reason.
5. Send heartbeat if Orca's preamble asks for it.
6. Finish with EXACTLY ONE:
   orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> \
     --outcome succeeded|failed --files-modified "<csv>" --body "<report>" --json
   (if your Orca preamble gives a different exact worker_done form, the preamble wins)
REPORT (body)
- taskId, dispatchId, worktree path, branch, commit SHA(s)
- changed paths (git diff --name-only <base>...HEAD) and 3–8 line diff summary
- requirement checklist: each acceptance item -> met / not met
- tests: command -> exit code -> key output lines
- risks, unverified items, new contracts needed by dependents, rollback method

ALLOWED PATHS: apps/web/** , e2e/** (accessible-name/text updates only, no flow changes).
REQUIRED
1) i18n layer: message catalog (ko default; structure ready for another locale later; no runtime fetch), typed keys (missing key = typecheck or test failure), pluralization not needed for ko but keep an API that allows it; html lang="ko".
2) Translate ALL user-visible copy: views, components, nav, buttons, empty/error/offline/conflict states, toasts, notifications, problem-code messages (every code in the exhaustive map), a11y labels/aria-live text, consent dialog and AI settings (state clearly: 제공자 OpenCode Go(DeepSeek 모델), 보내는 데이터, 마스킹은 최선 노력이라 이름·주소·계좌번호 등은 보장하지 않음, 언제든 철회 가능).
3) Formatting via Intl with the user tz: dates (11월 14일 (토)), times (오후 7:00), ranges, and a shared duration formatter (e.g. 1시간 30분, 11일 10시간; signed values like +11일 10시간 / −35분) replacing every raw-minute display (plan comparison metrics, Today slack, review feedback, budget usage $ amounts with 2–4 decimals).
4) Tests: update unit + e2e selectors to Korean accessible names consistently (no weakened assertions; same coverage); add tests for the duration/date formatters (edge cases: 0, negative, >1 day, DST day) and a catalog completeness test; fix FU-60 (m4-today current-plan test waits on the actual request instead of timing).
5) Evidence: regenerate the after screenshots (apps/web/docs/ui-polish/after-ko/) for the main screens at 390x844 and 1440x900; MSW axe sweep stays at 0 critical/serious.
Run and paste: pnpm --filter @ohmydate/web test ; pnpm --filter @ohmydate/web build ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456) ; same env pnpm run e2e.
Retry limit 2. Rollback: delete branch.
