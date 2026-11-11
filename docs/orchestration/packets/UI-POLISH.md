# TASK PACKET: UI-POLISH — unify and refine the visual design of every web screen (before GU-1)
Role: worker-frontend / product designer (Opus 5.5 xhigh, MODEL_BINDINGS §8). Base: torgal/ohmydate HEAD (M4 merged).
User intent: before trying the app themselves (GU-1), the user wants the screens' design unified and polished; they like Opus's aesthetic sense. This is a craft task: aim for a calm, focused, trustworthy personal-planner look (Korean UI text stays), not a generic admin template.
Read: docs/blueprint/07-ADAPTIVE-UI-SPEC.md (§1 tokens via CSS variables, §2 adaptive layout, §3 wireframes, §4 devices, §5 a11y acceptance, §6 offline); current apps/web (all views in src/views, components in src/components, src/styles.css); FOLLOW-UPS FU-09, FU-56 (UI-related open items).

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

ALLOWED PATHS: apps/web/** only (styles, components, views markup/classes, small presentational components). NO changes to API calls, stores' behaviour, routing semantics, contracts or e2e selectors used by tests (data-* test hooks and accessible names must keep working; if you must rename an accessible label, update the affected tests in apps/web/test and e2e/** in the same commit and say so).
REQUIRED
1) Design system: one token layer in CSS variables (color incl. semantic success/warn/danger/info, light + dark via prefers-color-scheme, spacing scale, type scale with Korean-friendly font stack and line-height, radius, elevation, focus ring, motion with prefers-reduced-motion). Replace ad-hoc values across all screens with tokens.
2) Consistent primitives (build or refine): Button (primary/secondary/ghost/danger, busy/disabled), TextField/Select/Textarea with label/help/error, Card, Badge/Chip, Banner/Notice (info/warn/error/offline/conflict), EmptyState, Skeleton/Spinner, Dialog/Sheet with focus trap (also closes FU-09 ConflictDialog focus trap + Escape), Toast. Use them on every screen.
3) Screens: Login, Inbox, Projects/Project detail, Planning Wizard (stepper), Plan new / comparison (candidate cards + metrics + calendar), Availability, Commitments, Today (cards, slack/risk), Focus (large timer, calm full-screen mode), Review sheet, Notifications panel, AI settings + consent dialog, NavRail/BottomNav/AppShell. Coherent hierarchy, spacing rhythm, alignment; states for loading/empty/error/offline/conflict are visually consistent.
4) Responsive: mobile (<640px) bottom nav + single column; tablet; desktop (>=1280px) rail + multi-panel per 07 §4. No horizontal scrolling at 360px width.
5) Accessibility kept or improved: axe zero critical/serious on every screen (extend the existing web axe-lite checks + E2E axe), visible focus, contrast >= WCAG AA in light and dark, keyboard paths unchanged.
6) Evidence: capture before/after screenshots of each screen at 390x844 and 1440x900 (light, plus dark for Today/Focus) with Playwright into apps/web/docs/ui-polish/ (PNG, committed; synthetic data only) and add a short apps/web/docs/ui-polish/README.md describing the system (tokens, primitives, rules).
Run and paste: pnpm --filter @ohmydate/web test ; pnpm --filter @ohmydate/web build ; pnpm run ci (DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456) ; same env pnpm run e2e.
Retry limit 2. Rollback: delete branch.
